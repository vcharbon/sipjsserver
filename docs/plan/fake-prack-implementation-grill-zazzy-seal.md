# Fake PRACK — `relayFirst18xTo180` strategy `"fake-prack"`

## Context

Today the B2BUA exposes two strategies on the `relayFirst18xTo180` policy
([src/b2bua/rules/custom/relayFirst18xTo180.ts](../../src/b2bua/rules/custom/relayFirst18xTo180.ts)):

- `drop-sdp` — first 18x relayed as bare 180 (no SDP, no `100rel`/`Require`/`RSeq`); subsequent 18x suppressed; PRACK 200 OK absorbed
- `keep-sdp` — first 18x relayed with body intact

Neither strategy is sufficient when the calling network must **never** receive
early-media SDP from Bob (the called party), but Bob requires reliable
provisional responses (`Require: 100rel`). Today, with `drop-sdp`, Bob's
reliable 1xx is downgraded to a bare 180 toward Alice — but Bob still expects
a PRACK that will never arrive (Alice was never told `100rel` was negotiated),
so Bob retransmits and eventually gives up.

The new strategy `"fake-prack"` is the third variant: same Alice-facing
behavior as `drop-sdp` (bare 180 first, suppress subsequent), **plus** the
B2BUA originates the PRACK locally toward Bob, caches Bob's SDP per b-leg
dialog, locally answers any UPDATE Bob sends (with an answer derived from
Alice's INVITE SDP), and injects the cached SDP into the 200 OK delivered to
Alice. End result: Alice sees a clean offer/answer at 200 OK, Bob sees a
fully RFC-3262-compliant peer.

The fake-prack vs `drop-sdp` vs `keep-sdp` choice is driven by the HTTP
call-control backend (per-call decision).

## Behavioral contract

### Trigger and scope (per b-leg)
| Bob's 18x | Action under `fake-prack` |
|---|---|
| 18x **with** `Require: 100rel` (with or without SDP) | Originate PRACK locally toward Bob within the b-leg dialog. If SDP present, cache it on the b-leg dialog. |
| 18x **without** `100rel`, **with** SDP | No PRACK needed. **Do not cache** — Bob will repeat SDP in 200 OK. |
| 18x **without** `100rel`, **without** SDP | Standard relay. |

Alice-facing behavior is identical to `drop-sdp`: literally the **first**
18x (whichever subcode) is relayed as a bare 180 (body, `Content-Type`,
`Require`, `RSeq` removed); subsequent 18x are suppressed.

### UPDATE from Bob (in early dialog)
- Bob's UPDATE carries an SDP offer. The B2BUA replies 200 OK locally,
  carrying a **skeleton-fit SDP answer** built from Alice's INVITE SDP.
- Skeleton-fit construction:
  - Same number of m-lines as Bob's offer (RFC 3264 §6).
  - Each m-line: codec list = intersection of Bob's offered codecs ∩
    Alice's m-line *i* codecs (matched by codec name + clock rate).
  - Port and `c=` line copied from Alice's m-line *i* (or session-level `c=`).
  - Direction attribute kept from Bob's offer.
  - Missing Alice m-lines → port = 0 (disabled).
- If the intersection is empty for **any** m-line → reply **488 Not Acceptable Here**.
- On 200 OK reply, update b-leg dialog's cached SDP to Bob's UPDATE offer
  (so the cached SDP we send Alice at 200 OK INVITE reflects the latest
  Bob state).

### UPDATE from Alice (in early dialog)
- Alice has no committed SDP from Bob (we never sent her one), so she cannot
  carry a meaningful new offer.
- Reply 200 OK locally with **no body**. Do not forward to Bob.

### 200 OK INVITE to Alice
- **Cached SDP always wins.** If we have any cached SDP on the winning
  b-leg dialog, the 200 OK to Alice is rebuilt with that SDP body
  (overwriting Bob's 200 OK body if any).
- **FIXME (long-term)**: when Bob's 200 OK SDP differs from cached SDP,
  fire a re-INVITE on the a-leg after confirmation to align Alice with
  Bob's authoritative final state. Track as TODO comment in the policy
  module; do not implement v1.
- If Bob's 200 OK has no body **and** cache is empty → forward 200 OK
  with no body, emit a CDR warning event `fake-prack:200-ok-no-sdp`.
  Do not synthesize anything.

### Forking
- Cached SDP is keyed per b-leg dialog (lives on `Dialog.ext`).
- Loser b-legs' caches are discarded with their CANCEL.

### Failover / re-routing
- New b-leg starts with empty cache; previous b-leg's cache discarded
  along with its leg state.

### Delayed-offer fallback (Alice INVITE has no SDP)
- The policy detects this at activation time on the initial INVITE.
- Strip `Supported: 100rel` from the outbound INVITE to Bob. This prevents
  Bob from initiating reliable provisional (per RFC 3262, UAS uses 100rel
  only if UAC advertises Supported).
- Policy effectively self-disables: 18x relayed transparently, PRACK
  passes through end-to-end. Equivalent to no policy active.
- Logged as `fake-prack:disabled-delayed-offer` for observability.

## Files to change

### Wire schema (HTTP call-control)
- [src/decision/schemas/features.ts](../../src/decision/schemas/features.ts) line 54-61: add `"fake-prack"` to the strategy literal union for `relayFirst18xTo180`:
  ```ts
  strategy: Schema.Literals(["drop-sdp", "keep-sdp", "fake-prack"])
  ```
- [src/decision/adapters/http-reference/schemas.ts](../../src/decision/adapters/http-reference/schemas.ts): same widening on the wire schema.
- [src/decision/adapters/http-reference/translate.ts](../../src/decision/adapters/http-reference/translate.ts): pass the new strategy through `synthesizeFeatures()` (likely just a literal pass-through if untyped).

### New SDP helper module
- New: `src/sdp/parse.ts` — minimal SDP tokenizer/serializer (lines, m-line struct, a-rtpmap map, c-line). Pure functions, no Effect, no SIP coupling.
- New: `src/sdp/answer-from-offer.ts` — exports:
  ```ts
  export type SdpBuildResult =
    | { _tag: "ok"; body: string }
    | { _tag: "no-common-codec"; mLineIndex: number }
    | { _tag: "no-alice-sdp" }

  export const buildAnswerFromOffer = (
    bobOffer: string,
    aliceOffer: string | null
  ): SdpBuildResult
  ```
  - `no-alice-sdp` returned when delayed-offer fallback should kick in (caller never invokes this in practice because we self-disable, but exposed for safety).
  - `no-common-codec` triggers 488 reply.
- New: `src/sdp/parse.test.ts` and `src/sdp/answer-from-offer.test.ts` — pure-function unit tests covering codec intersection, m-line padding, payload-type renumbering, c-line precedence (session vs media level).

### Policy module — exact rule reuse / replacement matrix

In [src/b2bua/rules/custom/relayFirst18xTo180.ts](../../src/b2bua/rules/custom/relayFirst18xTo180.ts):

- The module's activation guard is extended to also accept
  `strategy === "fake-prack"`. The activation flag becomes a tri-state:
  `"drop-sdp" | "keep-sdp" | "fake-prack"`.

- **Rules unchanged across all three strategies** (always emitted whenever
  the policy is active, regardless of strategy):
  - `suppress-18x` — the first 18x is relayed to Alice as a bare 180
    (body, `Content-Type`, `Require`, `RSeq` removed); subsequent 18x are
    suppressed. **This rule fires identically under `fake-prack` as under
    `drop-sdp`.** No change to the rule itself.
  - `force-tag-consistency` — unchanged.

- **Rules conditional on strategy** (the existing module already gates some
  of these by strategy; `fake-prack` is a new branch in that gating):
  - `absorb-prack-200` — emitted **only** under `drop-sdp` (and `keep-sdp`
    when relevant). **NOT emitted under `fake-prack`**, because under
    `fake-prack` no PRACK is ever relayed end-to-end (Alice never sees
    `100rel`, so Alice never PRACKs; Bob's PRACK 200 OK is the response to
    *our* originated PRACK, not to a relayed one). This is a removal from
    the rule set in the `fake-prack` branch only.

- **New rules emitted only under `strategy === "fake-prack"`**:
  - **`fake-prack-originate-on-reliable-18x`** — matches
    `direction: "from-b" && response.cseqMethod === "INVITE" && statusClass === "1xx" && Require contains "100rel"`.
    Actions:
    1. If body present and `Content-Type` is `application/sdp`: cache the
       body as `dialog.ext.cachedSdp` on the b-leg dialog (new
       `cache-sdp-on-leg-dialog` action).
    2. Originate PRACK toward Bob via the existing `send-prack-to-leg`
       action ([src/b2bua/rules/framework/ActionExecutor.ts:1274-1322](../../src/b2bua/rules/framework/ActionExecutor.ts) — `executeSendPrackToLeg`, reused as-is).

    Note: this rule does **not** affect Alice-facing relay; the bare-180
    delivery to Alice is handled by `suppress-18x` above. The two rules
    are independent: `suppress-18x` shapes what Alice sees;
    `fake-prack-originate-on-reliable-18x` shapes what Bob sees.

  - **`fake-prack-absorb-originated-prack-200`** — matches the 200 OK
    response that Bob sends to *our originated* PRACK
    (`direction: "from-b" && response.cseqMethod === "PRACK"`), and
    absorbs it locally (no relay to Alice; Alice doesn't know PRACK
    happened). Distinct from the existing `absorb-prack-200` because the
    PRACK in question was never relayed in the first place — the response
    correlation is on our locally tracked outstanding PRACK transaction.

  - **`fake-prack-handle-update-from-b`** — matches
    `direction: "from-b" && method === "UPDATE"`. Action:
    `respond-locally-update-with-skeleton-sdp` (new). The handler:
    1. Calls `buildAnswerFromOffer(updateBody, state.call.aLegInvite.body)`.
    2. On `_tag: "ok"`: write 200 OK to b-leg with the produced body;
       update `dialog.ext.cachedSdp` to Bob's UPDATE offer body
       (so the Alice-facing 200 OK INVITE will reflect the latest Bob state).
    3. On `_tag: "no-common-codec"`: write 488 Not Acceptable Here to b-leg.
       Cached SDP is **not** updated.
    4. On `_tag: "no-alice-sdp"`: should not occur in practice (we'd have
       self-disabled at activation time); defensive 488.

  - **`fake-prack-handle-update-from-a`** — matches
    `direction: "from-a" && method === "UPDATE"` while the a-leg is still
    in early state (no confirmed dialog yet on a-leg). Action: reply 200
    OK locally to Alice with no body. Do not forward to Bob.

  - **`fake-prack-inject-cached-sdp-on-200`** — composes with the existing
    `confirm-dialog` rule path
    ([src/b2bua/rules/defaults/DialogRules.ts:57-145](../../src/b2bua/rules/defaults/DialogRules.ts)).
    Its job: when the 200 OK INVITE is being relayed from the winning
    b-leg to Alice, substitute the body with `dialog.ext.cachedSdp` if
    present. If cache empty AND Bob's 200 OK has no body, emit CDR warning
    `fake-prack:200-ok-no-sdp` and forward the empty body unchanged.

- **Per-dialog state**: add `cachedSdp?: string` to `Dialog.ext` declared in
  [src/call/CallModel.ts](../../src/call/CallModel.ts) lines 87-190.

### Action executor
- [src/b2bua/rules/framework/ActionExecutor.ts](../../src/b2bua/rules/framework/ActionExecutor.ts):
  - **Reuse `executeSendPrackToLeg`** (lines 1274-1322) for the originated PRACK — the function already builds RAck, advances local CSeq, and writes the b-leg dialog state correctly. No changes expected to that function.
  - New action handler **`executeRespondLocallyToUpdate`**: takes the b-leg UPDATE, retrieves `state.call.aLegInvite.body` as Alice basis, calls `buildAnswerFromOffer`, constructs 200 OK (or 488) response, writes it to the b-leg socket, and (on `_tag: "ok"`) updates `dialog.ext.cachedSdp` to Bob's UPDATE offer.
  - New action handler **`executeCacheSdpOnLegDialog`**: pure data write to `dialog.ext.cachedSdp` on the matched b-leg dialog. No I/O.
  - **Body-override on 200 OK INVITE relay**: rather than embedding fake-prack-specific knowledge in the relay path, follow the existing `policyUpdateHeaders` pattern ([src/b2bua/helpers.ts:189-195](../../src/b2bua/helpers.ts)). Add a generic **`policyUpdateBody`** field on the call state that the relay path (around `relayResponseMsg`, lines 697-860) consults and applies if set. The `fake-prack-inject-cached-sdp-on-200` rule writes `cachedSdp` into `policyUpdateBody` (with `Content-Type: application/sdp`) before the relay action fires. The executor stays generic; the policy stays self-contained.

### Initial INVITE handler (delayed-offer fallback)
- [src/b2bua/handlers/InitialInviteHandler.ts](../../src/b2bua/handlers/InitialInviteHandler.ts) (or wherever the b-leg INVITE is constructed): if `features.relayFirst18xTo180?.strategy === "fake-prack"` **and** `aLegInvite.body` is empty/non-SDP, set `policyUpdateHeaders["Supported"]` to a value with `100rel` removed (or to `null` if no other tags) before forwarding. Log `fake-prack:disabled-delayed-offer`.

## Test scenarios (fake stack, TestClock, scenarios in `tests/scenarios/`)

All eight scenarios introduce a small simulated latency between Bob's 18x
and Bob's 200 OK so PRACK / UPDATE ordering is observable in the trace.

| # | Scenario file | Verifies |
|---|---|---|
| 1 | `tests/scenarios/fake-prack-basic.ts` | Alice never sees `100rel`/PRACK/SDP-in-18x; B2BUA originates PRACK; 200 OK to Alice carries Bob's cached SDP |
| 2 | `tests/scenarios/fake-prack-multiple-18x.ts` | One PRACK per reliable 18x; Alice sees only first 18x as bare 180; cached SDP = last reliable 18x SDP |
| 3 | `tests/scenarios/fake-prack-update-happy.ts` | UPDATE answered with skeleton-fit SDP; cached → UPDATE SDP; Alice 200 OK carries UPDATE SDP |
| 4 | `tests/scenarios/fake-prack-update-codec-mismatch.ts` | B2BUA replies 488 to UPDATE; call continues; Bob 200 OK uses original cached path |
| 5 | `tests/scenarios/fake-prack-forking.ts` | Two b-legs, independent caches; loser CANCELled; Alice 200 OK has winner's cached SDP |
| 6 | `tests/scenarios/fake-prack-failover.ts` | b1 fails after PRACK; b2 fresh cache; Alice 200 OK has b2's SDP |
| 7 | `tests/scenarios/fake-prack-delayed-offer-fallback.ts` | Alice INVITE has no SDP; outbound INVITE to Bob has `Supported: 100rel` stripped; entire `relayFirst18xTo180` policy self-disables; Bob's 18x (necessarily without `100rel`) is relayed unmodified to Alice; standard offer/answer (offer in 18x, answer in PRACK-less ACK) proceeds |
| 8 | `tests/scenarios/fake-prack-no-policy-control.ts` | Mock backend returns **no** `relay_first_18x_to_180` activation; Bob sends 18x with `Require: 100rel` + SDP; full end-to-end PRACK relay path runs (regression guard against the new code leaking into the default path) |

Each scenario is invoked from both `tests/fullcall/e2e-fake-clock.test.ts`
and (where relevant) generates a `.global.txt` via the existing
`writeTextReports()` plumbing at [src/test-harness/framework/text-report.ts](../../src/test-harness/framework/text-report.ts).

Mock HTTP backend ([tests/fullcall/framework/MockCallControlLayer.ts](../../tests/fullcall/framework/MockCallControlLayer.ts))
returns `relay_first_18x_to_180.strategy = "fake-prack"` for scenarios 1-7
and **no `relay_first_18x_to_180` activation at all** for scenario 8.

## Implementation order

1. **SDP helper** (`src/sdp/`) with unit tests — pure, isolated, fast feedback.
2. **Wire schema + features struct** widening — typecheck breaks force every
   downstream callsite to be updated explicitly.
3. **Policy module + new actions** — `fake-prack` strategy paths in
   `relayFirst18xTo180.ts` and `ActionExecutor.ts`.
4. **Initial INVITE handler** — delayed-offer fallback header strip.
5. **Test scenarios** in order #1, #2, #3, #4, #7, #8, #5, #6.
6. **SIP analyser review loop** (below).

After every step: `npm run typecheck` (zero errors AND zero warnings; the
Effect plugin is the only thing catching v4 footguns — see CLAUDE.md).

## SIP analyser review loop

Once `npm run test:fake` is green for all eight scenarios:

1. For each `.global.txt` report under `test-results/` for the eight scenarios, invoke `/sip-callflow-review` (local skill at [.claude/skills/sip-callflow-review/SKILL.md](../../.claude/skills/sip-callflow-review/SKILL.md)).
2. For each finding the analyser surfaces that the test assertions did **not** catch:
   - Spawn a subagent (general-purpose) to **enhance the test harness** so the same finding becomes a test failure on next run. The fix lives in the harness/scenario assertions, not in a single test.
   - **Hard gate**: if the harness change touches a generic control (e.g., adds an assertion that runs in *every* scenario, modifies shared validation in [tests/support/harness.ts](../../tests/support/harness.ts), or adds RFC compliance checks that may trip many existing scenarios), the subagent must **stop and ask the user** before applying. Do not push generic controls without explicit confirmation.
   - Re-run `npm run test:fake`. If new failures appear in unrelated scenarios from the harness change, treat as scope expansion: stop, write a precursor plan, ask user.
3. Repeat steps 1-2 until the analyser surfaces no new untested findings.

## Critical files (reference)

| Purpose | Path |
|---|---|
| Existing policy module to extend | [src/b2bua/rules/custom/relayFirst18xTo180.ts](../../src/b2bua/rules/custom/relayFirst18xTo180.ts) |
| Feature activation schema | [src/decision/schemas/features.ts](../../src/decision/schemas/features.ts) |
| HTTP wire schema | [src/decision/adapters/http-reference/schemas.ts](../../src/decision/adapters/http-reference/schemas.ts) |
| HTTP wire translator | [src/decision/adapters/http-reference/translate.ts](../../src/decision/adapters/http-reference/translate.ts) |
| Action executor (reuse `executeSendPrackToLeg`, modify 200 OK relay path) | [src/b2bua/rules/framework/ActionExecutor.ts](../../src/b2bua/rules/framework/ActionExecutor.ts) |
| Dialog ext for `cachedSdp` | [src/call/CallModel.ts](../../src/call/CallModel.ts) |
| Initial INVITE handler (delayed-offer fallback) | [src/b2bua/handlers/InitialInviteHandler.ts](../../src/b2bua/handlers/InitialInviteHandler.ts) |
| Default 1xx relay rule (composed-with) | [src/b2bua/rules/defaults/DialogRules.ts](../../src/b2bua/rules/defaults/DialogRules.ts) |
| Default UPDATE relay (overridden) | [src/b2bua/rules/defaults/RelayRules.ts](../../src/b2bua/rules/defaults/RelayRules.ts) |
| Default PRACK relay (overridden, since we originate locally) | [src/b2bua/rules/defaults/RelayRules.ts](../../src/b2bua/rules/defaults/RelayRules.ts) |
| Test harness (SDP helpers for scenario authoring) | [src/test-harness/framework/helpers/sdp.ts](../../src/test-harness/framework/helpers/sdp.ts) |
| Mock HTTP backend (scenario-driven strategy) | [tests/fullcall/framework/MockCallControlLayer.ts](../../tests/fullcall/framework/MockCallControlLayer.ts) |
| Text-report writer (analyser input) | [src/test-harness/framework/text-report.ts](../../src/test-harness/framework/text-report.ts) |

## Verification

End-to-end:
```bash
npm run typecheck    # zero errors AND zero warnings (Effect plugin too)
npm run test:fake    # all eight new scenarios + existing suite
```

Manual review (SIP analyser loop):
```bash
# For each scenario:
ls test-results/**/fake-prack-*.global.txt
# Invoke /sip-callflow-review on each, iterate.
```

Successful exit criterion: typecheck clean, all tests green, SIP analyser
finds no untested anomalies on any of the eight `.global.txt` reports.
