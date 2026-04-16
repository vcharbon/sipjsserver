# Surprises & time wasters — OPTIONS/INFO end-to-end relay session (2026-04-16)

Session scope: convert in-dialog OPTIONS from "locally respond 200" to full
end-to-end transparent relay, add the same behavior for INFO, and factor
the shared logic out. The work itself was mechanical; the time cost came
from code that lied about what it did or silently ignored wrong inputs.

Each item below describes what bit me, why it wasted time, and the
concrete fix.

---

## P0 — Correctness-adjacent, hidden for a long time

### 1. `relay-options` rule name was a lie

**File:** [src/b2bua/rules/defaults/RelayRules.ts](../../src/b2bua/rules/defaults/RelayRules.ts)

Before this session, the rule `id: "relay-options"`, `name: "Relay OPTIONS"`
produced `[{ type: "respond", status: 200, reason: "OK" }]` — it *terminated*
OPTIONS locally and did not relay anything. The docstring said "Respond 200
OK to in-dialog OPTIONS". The name said relay.

This cost me my first round-trip with the user: I read the rule, the
docstring, and [docs/AdvancedCallModel.md:174](../AdvancedCallModel.md)
(which listed `relay-options | OPTIONS request | respond 200`) and concluded
the local-200 behavior was by design. User then clarified that OPTIONS must
be relayed end-to-end — which is what the name implied all along.

**Todo:**
- Establish a naming invariant: a rule whose `id` / `name` starts with
  `relay-` emits `relay-to-peer`. Rules that terminate locally should be
  named `absorb-`, `answer-`, or `terminate-`.
- Audit existing rule names for the same trap (none found in this session,
  but worth a sweep).

**Why:** A rule's ID appears in span events (`rule.id` attribute), CDR,
coverage reports, and mutation-testing output. A rule called `relay-foo`
that doesn't relay poisons every one of those surfaces.

**Priority:** P0 — the rename lives inside a layer that other engineers
will read when adding rules; silent misdirection compounds.

---

### 2. No rule matched INFO at all → silent drop

**File:** [src/b2bua/B2buaCore.ts:54-59](../../src/b2bua/B2buaCore.ts)

There was no `relay-info` rule. In-dialog INFO requests fell through the
entire rule chain to `noopFallback`, which logs `Unhandled` and returns the
call unchanged. From the sender's perspective: INFO sent, transaction
eventually times out, no response ever arrives.

This was not discovered by any test — the closest was `indialog-unknown-reject`
which only tested *unknown*-dialog INFO (→481 via a different code path).
The happy-path in-dialog INFO was untested and silently broken.

**Todo:**
- Add a test that exercises *every* standard in-dialog method the B2BUA is
  expected to handle (ACK, BYE, INVITE, OPTIONS, INFO, UPDATE, PRACK,
  MESSAGE, REFER?) through the rule chain, asserting the expected
  disposition (relay / local-answer / reject). A coverage matrix, not a
  collection of ad-hoc scenarios.
- Consider a default-deny fallback for unrecognized in-dialog methods that
  replies 501 (Not Implemented) instead of silently noop'ing. Silent drops
  are the worst possible default for a SIP intermediary.

**Priority:** P0 — silent message drop is a production bug class.

---

## P1 — Cost real time during this session

### 3. `inboundPendingReInvites` / `PendingReInvite` / `addPendingReInvite` are misnamed

**File:** [src/call/CallModel.ts:30-47, 571-590](../../src/call/CallModel.ts)

The struct and its three helpers are perfectly generic — they snapshot
`{ outboundCSeq, inboundCSeq, sourceVias, sourceCallId, sourceFrom,
sourceTo, direction }` for any relayed in-dialog request so the response
can be rebuilt. I ended up reusing them verbatim for OPTIONS and INFO.

But every name contains "ReInvite". When I first searched for a
re-usable pending-request mechanism, I dismissed these helpers twice
(thinking they were INVITE-specific) before reading the struct and
realizing they were already generic. Probably 20 minutes wasted on
"what's the right pending abstraction for OPTIONS?" before the lightbulb.

**Todo:**
- Rename to `inboundPendingRequests` / `PendingRequest` /
  `addPendingRequest` / `findPendingRequest` / `removePendingRequest`.
  Single atomic rename across schema + helpers + call sites
  (ActionExecutor, CornerCaseRules).
- Migration: the Schema field is persisted to Redis via
  `CallStateCache` — verify if old entries in Redis would decode under the
  new field name; if yes, gate with a rename-compat alias for one deploy.

**Priority:** P1 — continued misnaming actively misleads the next engineer
who needs to extend pending-relay tracking.

---

### 4. `buildRelayedReInvite` hardcoded `INVITE` in CSeq despite taking a method-agnostic request

**File:** [src/sip/MessageFactory.ts:1044-1075](../../src/sip/MessageFactory.ts) (before change)

`buildRelayedReInvite(origInvite, ...)` was reused by the `default:` case
of `ActionExecutor.relayRequest` as "generic request relay — use re-INVITE
builder as it preserves body/headers" (per the comment). But the builder
hardcoded `h("CSeq", `${cseq} INVITE`)` and called `makeRequest("INVITE", …)`.
So the comment was aspirational — for any non-INVITE method, the relayed
message came out with method `INVITE` and CSeq `"N INVITE"` regardless of
the source method. A latent bug waiting for an OPTIONS or INFO to flow
through.

The comment actively admits the misuse ("use re-INVITE builder *as it
preserves body/headers*") — the author knew it was wrong and used it
anyway. Fixed this session by introducing `buildRelayedRequest(method, …)`
and making `buildRelayedReInvite` delegate.

**Todo:**
- Remove `buildRelayedReInvite` entirely; callers pass `"INVITE"` to
  `buildRelayedRequest`. The re-INVITE-specific logic (pending tracking,
  `lastInviteCSeq` bump) lives in `ActionExecutor`, not the builder.
- Grep for other `buildRelayedX` functions that might contain hardcoded
  method strings.

**Priority:** P1 — delegation shim works but creates two names for one
concept.

---

### 5. `default:` case in `ActionExecutor.relayRequest` had wrong tag logic for a-leg targets

**File:** [src/b2bua/rules/framework/ActionExecutor.ts:494-498](../../src/b2bua/rules/framework/ActionExecutor.ts) (before change)

```typescript
default:
  relayed = buildRelayedReInvite(req, targetLeg.callId,
    targetLeg.fromTag, targetDialog.toTag, ...)
```

Compare with the `INVITE` case immediately above, which does:
```typescript
const reInvFromTag = targetLeg.legId === "a"
  ? (b2buaTag(state.call, "a") ?? "")
  : targetLeg.fromTag
const reInvToTag = targetLeg.legId === "a"
  ? (remoteTag(state.call, "a") ?? "")
  : targetDialog.toTag
```

The `default:` case used leg-native tags directly, which is correct for
b-leg targets (B2BUA is UAC) but wrong for a-leg targets (where B2BUA's
own a-leg tag lives in `dialog.toTag`). In practice this branch was
unreachable before this session because no rule emitted `relay-to-peer`
for a non-INVITE/ACK/BYE/PRACK method — but the moment one does, the
tags on a-leg-bound relays are wrong.

**Todo:**
- Extract the B2BUA-vs-remote tag selection into a single helper:
  `directionalTags(call, targetLeg, targetDialog) → { fromTag, toTag }`.
  Use from INVITE, ACK, BYE, and the transparent `default:` case.
- Rule: if a `default:` branch ever ships in a handler, it should be the
  most-correct path, not the laziest.

**Priority:** P1 — latent correctness bug that would have bitten the next
transparent-method addition.

---

### 6. `HeaderOverrides` silently ignores unknown top-level keys

**File:** [tests/e2e/framework/types.ts:114-123](../../tests/e2e/framework/types.ts) + [message-builder.ts:484-531](../../tests/e2e/framework/message-builder.ts)

```typescript
interface HeaderOverrides {
  readonly cseq?: number
  readonly from?: string
  readonly to?: string
  readonly contact?: string
  readonly headers?: Record<string, string>
  ...
}
```

Writing `overrides: { "Content-Type": "application/dtmf-relay" }` does
nothing — `Content-Type` is not a known top-level key, and `applyOverrides`
only iterates `overrides.headers`. No error, no warning, just silently
dropped. The test failed with `Predicate returned false` and I had to add a
`console.log` debug to see the Content-Type was `application/sdp` (the
default fallback), not the override I wrote.

TypeScript doesn't catch this because `interface HeaderOverrides` allows
excess properties via the way these options get merged through multiple
record spreads.

**Todo:**
- Convert `HeaderOverrides` to a strict type (no excess properties) —
  either via `Exact<T>` helper, or by renaming the interface and giving it
  a nominal brand so misspelled keys are rejected at the type level.
- Alternative: inside `applyOverrides`, `Object.keys(overrides)` and
  `logWarning` any key that isn't `cseq`/`from`/`to`/`contact`/`headers`/
  `extraHeaders`/`body`/`cseq`. Runtime safety net for cases the type
  system can't catch.
- Documentation: the test README's "send/expect" section should have a
  single explicit example of `overrides.headers` vs top-level fields.

**Priority:** P1 — this is a test-framework UX cliff. Any contributor
writing a new scenario will fall off it at least once.

---

### 7. `pendingCSeqMap` on Dialog: declared, zero readers

**File:** [src/call/CallModel.ts:65](../../src/call/CallModel.ts)

```typescript
/** outbound CSeq → inbound CSeq mapping for response correlation */
pendingCSeqMap: Schema.Record(Schema.String, Schema.Int),
```

Declared with a docstring describing *exactly* what I needed for this
session (response correlation by CSeq). I grep'd to see how it was used
and found… no readers. It's written as `{}` in two places (both `init`
paths) and never read anywhere. I nearly built on top of it before the
grep result came back empty.

Dead code that looks load-bearing is worse than no code at all.

**Todo:**
- Either implement it (delete `inboundPendingReInvites` in favor of
  this — `pendingCSeqMap` is a lighter-weight representation if all we
  need is CSeq correlation), or delete it. Do not ship both.
- Schema deletion requires a Redis rename-compat pass; worth the cleanup.

**Priority:** P1 — dead schema fields rot into false signals for future
work.

---

## P2 — Nits that compound over time

### 8. `docs/AdvancedCallModel.md` rule table was out of sync with code

**File:** [docs/AdvancedCallModel.md:162,174](../AdvancedCallModel.md)

The table said:
- `relay-options | OPTIONS request | respond 200`  ← stale
- `absorb-options-200 | 200 OK for OPTIONS | cancel keepalive-timeout`  ← too-broad

Both descriptions reflected 2025-era behavior. No process forces these
tables to stay synced with `RelayRules.ts` / `DialogRules.ts`.

**Todo:**
- Consider generating the rule table from the rule definitions at build
  time (each rule has `id`, `name`, `defaultPriority`, and a matches
  predicate — we could emit a `docs/rule-reference.generated.md` during
  `npm run build` and fail CI if the committed copy is stale).
- Or: add a test that iterates `defaultRules` and fails if any rule's
  `id` or `name` isn't referenced in `AdvancedCallModel.md`.

**Priority:** P2 — drift is inevitable, mechanizing the sync is the only
lasting fix.

---

### 9. Rule-chain semantics ("first match wins", "lower priority = earlier")

**File:** [src/b2bua/rules/framework/RuleExecutor.ts:79,148](../../src/b2bua/rules/framework/RuleExecutor.ts)

The executor sorts ascending and stops on the first matching rule that
returns non-undefined. This is stated in the module-header comment but I
still had to re-derive it when designing the absorb-vs-relay priority
interaction (absorb-options-200 at 830 needs to run *before* relay-non-
invite-200 at 927, or vice versa, depending on intent).

**Todo:**
- Add a one-page "rule priority bands" reference either in the executor
  header or in AdvancedCallModel.md. Name each band:
  - 800s: terminating-state intercepts
  - 830–860: corner cases (retransmits, crossings, pending-match absorbers)
  - 890: glare
  - 900–930: default relay + lifecycle
  - 999: terminating catch-all
- Enforce in `createRuleRegistry`: fail startup if two rules share the
  same priority and could potentially match the same event (detection by
  running all rules against a fixed catalog of synthetic events).

**Priority:** P2 — once internalized, it's fine; the cost is onboarding
time for new contributors.

---

### 10. CLAUDE.md doesn't mention the existence of transparent-request pending snapshots

**File:** [CLAUDE.md](../../CLAUDE.md)

The "Layered processing pipeline" and "Key design decisions" sections
describe call resolution, tracing, rule framework, MutableHashMap — but
not the pending-request snapshot mechanism that makes response
correlation work. A contributor adding a new transparent method needs to
know: "you must record a pending snapshot in relayRequest; otherwise the
response will be rebuilt from stale leg headers."

**Todo:**
- Add a bullet under "Key design decisions": "**Pending-request snapshots:**
  every transparently-relayed in-dialog request records a snapshot on the
  target leg's dialog so its response can be rebuilt with the original
  Vias / From / To / Call-ID / CSeq. See
  `src/call/CallModel.ts` (`PendingRequest`) and
  `ActionExecutor.relayResponseMsg`."

**Priority:** P2 — low volume of writers touching this, but the failure
mode (wrong Vias/CSeq on relayed responses) is opaque to debug.

---

## Meta: what would have saved the most time

1. **Treat rule names as load-bearing.** A single rename from
   `relay-options` (that respond-200'd) to `absorb-options-locally` would
   have told me *at first read* that the code matched the docs, and my
   first-round interpretation of the user's request would have been
   correct.
2. **Delete dead schema fields aggressively.** `pendingCSeqMap` cost me a
   grep round-trip and a design detour. If it had been deleted three
   months ago, the `inboundPendingReInvites` reuse would have been
   obvious.
3. **Fail loudly on unknown override keys.** `HeaderOverrides` silent-drop
   is the single most expensive ergonomic cliff in the test framework.
