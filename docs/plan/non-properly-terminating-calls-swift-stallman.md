# Non-properly-terminating calls — fix the leak class permanently

## Context

Memory-leak analysis on the k8s perf-test surfaced a separate correctness bug:
across 20K successful calls, `removeInvocations === 0`. Calls reach
`state="terminating"` but never `"terminated"`, so the rule-engine cleanup
effect (`remove-call` → `callState.remove()`) never fires. The 60s in-memory
orphan sweep ([src/call/CallState.ts:533-559](../../src/call/CallState.ts#L533-L559))
recovers the in-memory state, but everything `remove()` is supposed to do is
silently bypassed:

- **CDR is lost** ([src/cdr/CdrWriter.ts](../../src/cdr/CdrWriter.ts) only fires via the rule path; no per-call billing record).
- **Redis cache entries linger** until `callContextTtlSec` expires.
- **Replication tombstone is never propagated** to the backup peer
  ([src/call/CallState.ts:395-419](../../src/call/CallState.ts#L395-L419)) —
  the peer keeps stale `idx:*` entries until TTL.

Root mechanism: rules subscribe to *raw SIP messages* and the
"rule says leg terminated" responsibility is enforced only by reviewer
discipline. Specificity ranking
([src/b2bua/rules/framework/Matcher.ts:271-295](../../src/b2bua/rules/framework/Matcher.ts#L271-L295))
lets `absorbBye200Rule`
([src/b2bua/rules/defaults/DialogRules.ts:150-168](../../src/b2bua/rules/defaults/DialogRules.ts#L150-L168))
win over `resolveByeResponseRule`
([src/b2bua/rules/defaults/TerminatingRules.ts:24-49](../../src/b2bua/rules/defaults/TerminatingRules.ts#L24-L49))
in active state — so a 200 OK to a BYE we sent from `destroy-leg`
([src/b2bua/rules/framework/ActionExecutor.ts:1418-1470](../../src/b2bua/rules/framework/ActionExecutor.ts#L1418-L1470),
which does NOT promote call to "terminating") is silently absorbed and the leg
stays `bye_sent` forever. `isFullyResolved`
([src/call/CallModel.ts:920-928](../../src/call/CallModel.ts#L920-L928))
returns false; the framework never promotes terminating → terminated; cleanup
never fires.

Goal: fix this *class* of issue permanently. Three layers of defense, each
catches what the layer above missed, all observable.

## Termination model (the contract this plan enforces)

Two — and only two — paths terminate a SIP dialog:

1. **BYE** sent or received on an established dialog.
2. **Final non-2xx response to INVITE** (including 487 from CANCEL) **or
   B2BUA-internal timeout** on an early dialog.

Responsibility split:

| Layer | Owns |
| --- | --- |
| **SIP transaction layer** | RFC 3261 transaction state (Timer F, retransmit, ACK reuse). |
| **Rule** | Says "this leg is terminated" — emits `terminate-leg` with the correct `byeDisposition`. |
| **Framework (RuleExecutor)** | Aggregates: when `every leg is terminal` (`isFullyResolved`), promotes call `terminating → terminated`. `InvariantEnforcer` then guarantees `cancel-all-timers` / `decrement-limiter` / `write-cdr` / `remove-call` side effects. |
| **Orphan sweep** | Last-line recovery for crashes, reboots, or rule-path bugs that escaped the framework invariant. Performs the *full* cleanup (CDR + Redis delete + tombstone), not just memory. |

This plan changes nothing in the SIP transaction layer or the responsibility
split. It strengthens enforcement of the rule-author contract and upgrades
the sweep from "memory only" to "full cleanup with loud metric".

## Design

### Layer 1 — Fix the rule path (root cause)

Today no rule emits `terminate-leg(bye_confirmed)` when a 200/BYE arrives
while the call is still in active state. Fix the matcher so the
"resolve" rule wins regardless of `callState`, by binding it to the leg
state instead.

Modify `resolveByeResponseRule` in
[src/b2bua/rules/defaults/TerminatingRules.ts](../../src/b2bua/rules/defaults/TerminatingRules.ts):

- Drop the `callState: "terminating"` filter.
- Add a `filter` predicate: `ctx.sourceLeg.byeDisposition === "bye_sent"`.
- Specificity: `cseqMethod:"BYE"` (singleton, +2) + `statusClass:[2xx,3xx,4xx,5xx,6xx]` (array, +1) + filter (+1) = **4**, beats
  `absorbBye200Rule`'s 3 in any state.

Result: any final response to an outbound BYE we sent — in any call state —
is handled by `resolveByeResponseRule` and emits `terminate-leg(bye_confirmed)`.
`absorbBye200Rule` continues to handle the residual cases (200 to BYE we
already responded to, peer retransmits, etc.) where the leg is *not* in
`bye_sent`.

### Layer 2 — Framework invariant in RuleExecutor

After every rule fires, before
[src/b2bua/rules/framework/RuleExecutor.ts:241,250,263](../../src/b2bua/rules/framework/RuleExecutor.ts#L241-L268)
runs the `terminating → terminated` promotion, run a **bye-disposition
invariant**:

- **Trigger**: the inbound event is either
  - a final response (≥200) on a leg currently in `bye_sent`, with
    `cseqMethod === "BYE"`, OR
  - a `timer` event of type `terminating_timeout` for a leg in `bye_sent`.
- **Check (post-rule)**: if the rule output left that leg's `byeDisposition`
  *still* `bye_sent`, the rule absorbed a transaction-resolution event without
  acting.
- **Action**:
  - Force-set the disposition: `bye_confirmed` for response events,
    `bye_timeout` for `terminating_timeout`.
  - `Effect.logWarning` with the rule id, callRef, legId, and event kind.
  - Increment metric `framework_invariant_violation_bye_disposition_total{rule, event_kind}`.
- **Then** run the existing `terminating → terminated` promotion and
  `enforceInvariants` ([src/b2bua/rules/framework/InvariantEnforcer.ts](../../src/b2bua/rules/framework/InvariantEnforcer.ts))
  — calls always reach `terminated` in the same tick.

The invariant lives next to the existing termination check (three call sites
at lines 241, 250, 263). Extract a helper `enforceByeDispositionInvariant(callBefore, result, event)` to
keep all three sites consistent.

### Layer 3 — Orphan sweep upgrade

Modify
[src/call/CallState.ts:533-559](../../src/call/CallState.ts#L533-L559) to
perform the full cleanup, not memory-only. The sweep currently runs in a
plain `setInterval` callback — convert it to an Effect-based fiber so it
can call the same `cdr.write` / `storage.deleteCall` paths as `remove()`.

For each orphan call (state `terminating` or `terminated`):

1. If state is `terminating`, force-resolve all `bye_sent`/undefined-disposition
   legs to `bye_timeout` so `isFullyResolved` returns true; flip state to
   `terminated`.
2. Call the same side-effect sequence as the `remove-call` path
   (`cdr.write` → `callState.remove(callRef)` which atomically deletes Redis
   keys + propagates the tombstone via `propagate:{peer}`).
3. `Effect.logWarning` with callRef, age (now − createdAt), and which legs were
   force-resolved.
4. Increment metric `orphan_sweep_recovered_total{stuck_state}`.

The sweep keeps its 60s interval and its role as last-resort recovery for
restarts / crashes / bugs the invariant didn't catch. The existing
`console.warn` at line 554 becomes a structured `Effect.logWarning`; metrics
make accumulation visible.

### Layer 4 — CDR as the test anchor (in-memory CDR layer)

CDR presence is the single user-visible artifact that proves a call
terminated cleanly: a missing CDR record means cleanup never ran. Make
this the primary test assertion.

[src/cdr/CdrWriter.ts](../../src/cdr/CdrWriter.ts) already exposes
`CdrWriter` as `ServiceMap.Service` with `Layer.effect` — only the file
layer exists today. Add a sibling test layer.

**API extension** — extend the service interface with a read accessor:

```ts
class CdrWriter extends ServiceMap.Service<CdrWriter, {
  readonly write: (call: Call) => Effect.Effect<void>
  readonly readAll: Effect.Effect<ReadonlyArray<CdrRecord>>  // new
}>()(...)
```

**Two layers, same interface:**

- `CdrWriter.layer` (existing, default) — file-based; `readAll` reads the
  file back as JSONL. Production and live-stack tests use this. Naming
  unchanged so `main.ts` / `B2buaCore.ts` / `SipRouter.ts` /
  `liveStack.ts` / `networkLeaves.ts` keep working.
- `CdrWriter.testLayer` (new) — array-backed: `write` appends to an
  internal `Array<CdrRecord>`, `readAll` returns it. Used by the
  fake-clock stack only.

**Wire test layer into the fake stack** — replace `CdrWriter.layer` with
`CdrWriter.testLayer` in `tests/support/fakeStack.ts` (or whichever module
composes the fake-clock stack today; named in
[CLAUDE.md](../../CLAUDE.md)).

**Per-scenario auto-verification** — add to the fake-clock test harness a
post-condition asserter that runs after each scenario completes:

- For every Alice (a-leg) `callId` observed during the scenario, assert
  `cdr.readAll` contains a record where `aLeg.callId === <that callId>`.
  This is the CDR-based equivalent of "every created call terminated
  cleanly". Print the missing callIds on failure.
- `expect(framework_invariant_violation_bye_disposition_total).toBe(0)` —
  no rule absorbed a BYE-resolution event without acting.
- `expect(orphan_sweep_recovered_total).toBe(0)` — sweep never had to
  recover anything (sweep-rescued calls *do* now produce a CDR, so the
  CDR check passes; this counter distinguishes "rule path worked" from
  "rule path failed but sweep saved us").

**Cleanup task — dedicated subagent slice:**

Wiring CDR auto-verification into the harness will fail many existing
scenarios in `tests/scenarios/` (current count: 32, includes
`basic-call.ts`, `bye-directions.ts`, `cancel.ts`, `keepalive-*.ts`,
`refer-*.ts`, etc.). Most failures will be scenarios that cancel/abort
early-dialog calls where the test author didn't think about CDR
completeness, or scenarios that exercise rules where today's bug means no
CDR is ever written.

Spin off a dedicated subagent task (separate slice) to triage and fix
these failures. The subagent's job:

- Run each failing scenario and identify whether the missing CDR
  reflects (a) a real correctness gap the plan revealed, or (b) the
  scenario legitimately doesn't terminate the call (e.g., scenario
  asserts mid-dialog state then exits).
- For (a): file as a bug or fix in-place if trivial.
- For (b): add an explicit `harness.skipCdrCheck()` opt-out in that
  scenario with a one-line comment justifying it.
- Report a list of all (a) findings to the main agent.

**Regression scenario** — add one new scenario under `tests/scenarios/`
that reproduces the active-state BYE/200 case explicitly:

- Established call.
- Rule emits `destroy-leg` on b-leg in active state (single-leg destroy
  without `begin-termination`).
- Endpoint responds 200 OK while call is still active.
- Assert: leg reaches `bye_confirmed` within one tick (rule path), call
  reaches `terminated`, CDR contains alice's callId, invariant counter
  stays 0.

If the rule fix is reverted, this scenario fails on the bye_confirmed
assertion. If both rule fix and invariant are reverted, it fails on the
CDR-presence check (sweep recovers but only after 60s; harness asserts
immediately after the scenario settles).

### Layer 5 — Documentation

New doc: `docs/leg-termination-model.md`. Required content:

- The two dialog termination paths (BYE / final-non-2xx-or-timeout).
- The transaction ↔ leg ↔ call boundary: what each layer owns; which fields
  belong to which (`pendingRequests` and `inboundPendingRequests` are
  transaction-relay bookkeeping; `byeDisposition` is leg-level; `state` is
  call-level).
- Responsibility split (rule → framework → sweep) with one-paragraph
  description of each.
- The framework invariant contract for rule authors: "If your rule matches a
  BYE-related event on a leg in `bye_sent`, you MUST emit `terminate-leg`
  with a terminal disposition. The framework will catch you if you don't,
  loudly."
- Pointer from `docs/CallModel.md` and `docs/AdvancedCallModel.md`.

## Critical files

- [src/b2bua/rules/defaults/TerminatingRules.ts](../../src/b2bua/rules/defaults/TerminatingRules.ts) — relax `resolveByeResponseRule` matcher (Layer 1).
- [src/b2bua/rules/framework/RuleExecutor.ts](../../src/b2bua/rules/framework/RuleExecutor.ts) — add invariant before the three terminating→terminated promotion sites (Layer 2).
- [src/call/CallState.ts](../../src/call/CallState.ts) — convert orphan sweep to Effect-based full cleanup (Layer 3).
- [src/cdr/CdrWriter.ts](../../src/cdr/CdrWriter.ts) — extend service interface with `readAll`; add `testLayer` sibling to existing file layer (Layer 4).
- `tests/support/` (fakeStack composition + harness) and `tests/scenarios/` — wire `testLayer`, per-scenario CDR-presence assertion, regression scenario (Layer 4).
- New: `docs/leg-termination-model.md` (Layer 5).

## Reused functions / utilities

- `isFullyResolved`, `setByeDisposition`, `TERMINAL_BYE_DISPOSITIONS` in [src/call/CallModel.ts](../../src/call/CallModel.ts) — invariant uses these directly.
- `enforceInvariants` in [src/b2bua/rules/framework/InvariantEnforcer.ts](../../src/b2bua/rules/framework/InvariantEnforcer.ts) — already auto-injects `write-cdr`/`remove-call` once `state === "terminated"`; the bye-disposition invariant feeds it by ensuring the call gets there.
- `cdr.write`, `callState.remove` in [src/sip/SipRouter.ts:342-369](../../src/sip/SipRouter.ts#L342-L369) — orphan sweep calls the same effects in the same order.
- Specificity scoring in [src/b2bua/rules/framework/Matcher.ts:190-238](../../src/b2bua/rules/framework/Matcher.ts#L190-L238) — Layer 1 fix verified against scoring algebra.

## Recommended slicing (commit per slice)

1. **CDR test layer** — extend `CdrWriter` interface with `readAll`; add
   `testLayer`. Existing tests keep passing (file layer behavior unchanged
   in production paths; fake stack doesn't yet auto-verify). Standalone,
   low-risk.
2. **Sweep upgrade + metric** — orphan sweep performs full cleanup
   (CDR + Redis + tombstone) and emits structured metric. Even before the
   rule fix, this guarantees no data loss on stuck calls.
3. **Rule fix** (`resolveByeResponseRule` relaxation) — the root-cause fix;
   verifies the active-state BYE/200 path independently.
4. **Framework invariant** — the safety net in RuleExecutor; must not
   regress any existing scenario.
5. **Harness CDR auto-verification + regression scenario** — wire the
   testLayer into fakeStack; add post-condition asserter; add the
   active-state-BYE/200 regression scenario. Many existing scenarios will
   fail here.
6. **Cleanup of failing scenarios** (dedicated subagent task) — triage and
   fix every scenario broken by Slice 5; add `skipCdrCheck` opt-outs with
   justification where legitimate; report real correctness gaps back as
   bugs to the main agent.
7. **Documentation** — `docs/leg-termination-model.md` + cross-references.

Each slice runs `npm run typecheck` and `npm run test` clean before merge.
Slices 1–4 must pass independently; slice 5 is allowed to fail tests *only*
in scenarios that slice 6 then fixes — slices 5 and 6 should land together
or with slice 5's failures explicitly tracked.

## Verification

End-to-end sanity:

- `npm run typecheck` — zero `tsc` errors AND zero Effect-plugin warnings
  (per CLAUDE.md "Never ignore a warning").
- `npm run test` — all fake-clock scenarios pass with the new
  per-scenario assertions (`callsCreated === callsRemoved`,
  `framework_invariant_violation_bye_disposition_total === 0`,
  `orphan_sweep_recovered_total === 0`).
- `npm run test:ci` — medium-tier live-clock scenarios (real UDP) clean.

Targeted:

- Run the new active-state-BYE/200 regression scenario under
  `tests/scenarios/` standalone and confirm leg reaches `bye_confirmed` via
  the rule path (not the invariant).
- Temporarily revert just the rule fix (Layer 1) and confirm the
  regression scenario now passes via the invariant (counter increments,
  WARN logged, call still reaches `terminated`).
- Temporarily revert both Layer 1 and Layer 2 and confirm the harness
  asserts trip on `callsCreated === callsRemoved` (sweep recovers but only
  60s later — the scenario harness asserts immediately).

Production smoke (post-deploy):

- Re-run `sippperftest/memleak-test-k8s.sh` for ≥20K calls.
  - `removeInvocations` should equal call count.
  - `framework_invariant_violation_bye_disposition_total` should be 0 (or
    a small constant; non-zero indicates a remaining unprotected rule path
    worth investigating, but no longer leaks).
  - `orphan_sweep_recovered_total` should be 0.
- Confirm CDRs are written for every terminated call, Redis cache size
  drops to zero between bursts, and the backup peer's `idx:*` keys do not
  accumulate.
