# BYE-resolution gap — preliminary plan

This is a precursor plan for two related symptoms surfaced while
diagnosing the limiter inflight leak (now fixed via the orphan-sweep
limiter-decrement at
[`src/call/CallState.ts`](../../src/call/CallState.ts) and tested by
[`tests/support/cache-and-limiter.test.ts`](../../tests/support/cache-and-limiter.test.ts)
"orphan sweep decrements limiterEntries…").

The orphan-sweep fix stops the leak even when these two symptoms
persist. They are still worth investigating because they explain
*why orphans exist in the first place* — and an orphan-sweep recovery
should always be a "shouldn't happen" condition (the harness already
asserts `orphanSweepRecoveredCount === 0` for non-skipped scenarios).

## TL;DR

In the 2026-05-05 endurance run, ~10 limiter-probe calls per 15-minute
window got stuck in `state="terminating"` on the worker that owned
them. Two separate questions emerge:

1. **Why no transaction timeout fired** to resolve the unanswered
   B-leg BYE. RFC 3261 Timer F (32 s for non-INVITE) IS armed by
   [`TransactionLayer.ts:300`](../../src/sip/TransactionLayer.ts#L300),
   so the `timeout` event was emitted — but no rule handles it for a
   call already in `"terminating"`, so the leg never reaches
   `bye_timeout` via the rule path.
2. **Why the 200 OK to BYE never arrived** from the b-leg upstream.
   Inferred from `Unroutable BYE` warnings on the *peer* worker —
   the peer never sees the call (correct: it's not the primary), but
   the question is what happens at the actual b-leg destination. Could
   be a backend bug, a sipp-side socket close, or a topology issue
   in the K8s test fixture.

## Evidence collected during the limiter-leak investigation

Source artefact: [endurance-2026-05-05t19-38-38-468z](../../test-results/k8s-endurance/endurance-2026-05-05t19-38-38-468z/).

For one stuck probe call (`...46-1@det`, primary = b2bua-worker-0):

| Worker | Time | Event |
| --- | --- | --- |
| worker-0 | 19:40:42 | INVITE admitted (inferred — orphan sweep age 925 074 ms) |
| worker-1 | 19:41:30 | sweep on `bak:b2bua-worker-0:` (age 47 976 ms) |
| worker-0 | 19:55:22 | "Unroutable OPTIONS" on the same Call-ID |
| worker-0 | 19:56:07 | sweep on `pri:b2bua-worker-0:` (age 925 074 ms) |
| worker-0 | 19:56:24 / 20:00:15 / 20:10:02 | "Call … not found on checkout for timer" (recurring) |

Two findings of interest:

- **Both peers swept the same call** — worker-1 swept the backup
  copy at age 47 s (before the 64 s safety timer), and worker-0
  later swept its own primary copy at age 925 s (15 min). The
  primary sweep is suspicious: a 60 s sweep daemon should have caught
  this much earlier than 15 min. There is something keeping the call
  re-resurrecting in worker-0's `callsMap` between sweeps, or the
  daemon is not iterating it. Worth checking
  [`src/call/CallState.ts:554-560`](../../src/call/CallState.ts#L554)
  for any concurrency hazard with `callsMap` iteration during writes.
- **Recurring "not found on checkout for timer"** lines at +5 min
  intervals after the sweep. Those are the `limiter_refresh` /
  `keepalive` timer fibers continuing to fire against a callRef
  whose call object was already removed. The fibers should have been
  cancelled by `cancel-all-timers`, but the sweep doesn't call
  `timers.cancelAll(callRef)` — it just drops the call from
  `callsMap`. That's another sweep path correctness issue, separate
  from the limiter leak. (Not visible to users — the `not found on
  checkout` path returns early — but it's wasted work and noise.)

## Q1 — why doesn't the BYE transaction timeout resolve the leg?

### Hypothesis space

#### H1.a — Timer F fires but no rule consumes the event

`TransactionLayer.startClientRetransmit` arms a 32 s Timer F that
emits `event = { type: "timeout", branch, callRef, legId, method }`
at [`TransactionLayer.ts:329`](../../src/sip/TransactionLayer.ts#L329).
That event flows through `SipRouter.withCall` and reaches the rule
chain.

For a call in `state="terminating"`, scanning the rules:

- [`TerminatingRules.ts:99`](../../src/b2bua/rules/defaults/TerminatingRules.ts#L99)
  `terminating-safety-timeout` matches `kind:"timer"` for the
  *internal* `terminating_timeout` timer — NOT a transaction
  `kind:"timeout"` event.
- [`TerminatingRules.ts:32`](../../src/b2bua/rules/defaults/TerminatingRules.ts#L32)
  `resolve-bye-response` matches `kind:"response"` (a real 200/4xx
  /5xx OK to BYE), not a transaction timeout.
- No rule in the default registry matches `kind:"timeout"` +
  `method:"BYE"` + `callState:"terminating"`.

So the timeout event likely **falls through to `noopFallback`**:
[`B2buaCore.ts:91`](../../src/b2bua/B2buaCore.ts#L91) returns a
501 response by default, but a `timeout` event has no inbound request
to respond to, so the fallback is effectively a no-op. The leg never
reaches `bye_timeout` via the rule path.

**Plausibility: high.** This would exactly produce the observed
behaviour — call sits in `"terminating"` until the orphan sweep
catches it. The `terminating_timeout` safety timer scheduled by
[`beginTerminationEffects`](../../src/b2bua/helpers.ts#L75) (64 s)
is supposed to be the backstop, and on its rule firing
`terminating-safety-timeout` DOES force-resolve. So if the safety
timer is also broken, that's a second issue — see H1.b.

Distinguishing test: write a fake-clock test that puts a call into
`"terminating"`, advances TestClock past 32 s, asserts that the
leg's `byeDisposition` transitions to `bye_timeout` via the rule
path. Today this would fail.

#### H1.b — `terminating_timeout` safety timer never fires after rehydration

`beginTerminationEffects` schedules a `terminating_timeout` timer at
+64 s ([`helpers.ts:79`](../../src/b2bua/helpers.ts#L79)). The
`schedule-timer` effect goes through
[`SipRouter.processResult`](../../src/sip/SipRouter.ts#L346-L351)
which calls `timers.schedule(...)` — but does NOT update
`call.timers`. (Only `ActionExecutor.executeScheduleTimer` updates
`call.timers`; the framework-emitted `schedule-timer` SideEffect
does not.)

Result: the timer fiber lives in `TimerService.fibersMap` but is
absent from the persisted `call.timers`. On worker rehydration after
takeover (or any path that re-loads the call from cache), only the
*persisted* timers are restored — so the safety timer is lost.

This is the same persistence gap that `FrameworkLimiterRefresh`
also suffers from (see investigation notes). Both schedule timers
via the SideEffect path, both bypass `call.timers`.

**Plausibility: medium-high** — explains why some calls reached
age 925 s (15 min) instead of being safety-resolved at 64 s.

Distinguishing test: admit + BYE + flush-and-rehydrate the call
(simulating takeover), advance past 64 s, assert
`terminating-safety-timeout` rule fires.

#### H1.c — sweep catches the call before Timer F fires (race)

Sweep interval is 60 s; Timer F is 32 s. So under steady state,
Timer F always wins. But the sweep is wall-clock-aligned, so calls
that enter `"terminating"` 28-32 s before a sweep tick are caught
*after* Timer F has emitted its `timeout` event but *before* the
event cleared the call (because, per H1.a, no rule consumes it).

This is a *consequence* of H1.a, not a separate cause. Listed for
completeness.

### Proposed fix shape (after diagnostic confirms H1.a)

Add a rule in `TerminatingRules.ts`:

```ts
export const resolveByeTransactionTimeoutRule: RuleDefinition<undefined, undefined> = {
  id: "resolve-bye-transaction-timeout",
  name: "Resolve BYE Transaction Timeout",
  alwaysActive: true,
  match: {
    kind: "timeout",
    method: "BYE",
    callState: "terminating",
  },
  // ...
  handle: (ctx) => {
    return Effect.succeed({
      actions: [{
        type: "terminate-leg",
        legId: ctx.sourceLeg.legId,
        byeDisposition: "bye_timeout",
      }],
      state: undefined,
    })
  },
}
```

Caveats — verify before coding:

- The `timeout` event currently doesn't carry an explicit "sourceLeg"
  in the same way request/response events do. The match infrastructure
  may need to derive the leg from `event.legId`. Check
  [`RuleDefinition.ts`](../../src/b2bua/rules/framework/RuleDefinition.ts)
  match.kind="timeout" semantics.
- Decide whether to also handle `kind:"timeout"` + `method:"BYE"` +
  `callState:"active"` (BYE was sent by `destroy-leg` while the
  rest of the call kept going).

### Plan slices

- **Slice 1 — diagnostic**: confirm Timer F fires for stuck-BYE calls
  by adding a temporary log in TransactionLayer's timeout fiber
  (already there as `WARN: Transaction timeout: non-invite`). Re-run
  the endurance probe with focused logs and confirm no rule absorbed
  the timeout. *Expected output*: forensic note in the artifact dir
  saying "Timer F fires at +32 s, no rule handles it".
- **Slice 2 — rule + safety-timer persistence fix**: add the rule
  above, and fix the `call.timers` persistence gap by routing the
  framework's `schedule-timer` SideEffect through the same
  `state.call.timers` dedup path that
  [`ActionExecutor.executeScheduleTimer:1598-1604`](../../src/b2bua/rules/framework/ActionExecutor.ts#L1598)
  uses.
- **Slice 3 — fake-clock tests**: regression tests for both the new
  rule and the persistence fix, under
  `tests/b2bua/rules/terminating-bye-transaction-timeout.test.ts`
  and a takeover-side variant under `tests/sip-front-proxy/failover/`.

### RFC notes for the fix

- **RFC 3261 §17.1.2.2 (Timer F)**: a non-INVITE client transaction
  that does not receive a final response within 64×T1 (32 s by
  default) MUST be terminated. The transaction layer already does
  this. The fix is purely application-layer: resolve the leg's BYE
  disposition.
- **RFC 3261 §15.1.1 (BYE)**: a UAC that times out a BYE has fully
  performed its termination obligations regardless of whether the
  UAS responded. So `bye_timeout` is the correct disposition.

## Q2 — why is the 200 OK to BYE never received?

This is a *cause* question, not a behaviour question. The B2BUA
forwards a-leg BYE to the b-leg destination, and the upstream never
replies. With Q1 fixed, this just becomes "why is the upstream
flaky" — the call still resolves cleanly via Timer F at +32 s.

### Hypothesis space

#### H2.a — backend (sipp upstream / call-control mock) drops BYE under load

The endurance probe routes via `route_decision` to a backend
specified by the test fixture. If that backend is a sipp uas
scenario, sipp scenarios are typically blocking on `<recv>` slots
and a BYE arriving outside the expected sequence is silently dropped.
Under load, sipp can fall behind on its UDP read loop — packets
queued in the kernel buffer get discarded if the buffer fills.

Distinguishing test: run with reduced offered concurrency
(`--caps 5`) and check whether stuck-call rate drops linearly with
load.

#### H2.b — sipp closes its UDP socket on probe scenario completion

The probe scenario file is
[`uac-endurance-limiter.xml`](../../tests/k8s/charts/sipp/scenarios/uac-endurance-limiter.xml).
After the BYE the scenario is done; sipp moves to the next call. If
the upstream b-leg is bound to the same sipp pod, a 200 OK from the
b-leg arriving *after* its scenario closed would be discarded.

But this doesn't fit — the b-leg isn't sipp; it's the route_decision
backend.

Distinguishing test: capture pcap on the worker pod for one stuck
call and look for a 200 OK that wasn't matched to the BYE
transaction (wrong branch / wrong CSeq).

#### H2.c — proxy / cookie misroute on the BYE response path

The 200 OK to BYE is routed by SIP transaction matching — Via-branch
+ CSeq. The proxy is in path. If the proxy is overloaded or the call
cookie handling has an edge case for BYE responses, the 200 might
land on the wrong worker (which would log "Unroutable response").

Distinguishing test: search worker + proxy logs for "Unroutable
response" / "Branch not found" entries within the 30 s window after
each stuck-call BYE.

### Plan slices

- **Slice 1 — pcap + log triage**: pick 5 stuck calls from the
  endurance artefact, dump worker + proxy logs around their BYE
  transactions, capture pcap on the worker pod for a fresh repro.
  Output: forensic doc naming the probable cause (H2.a / H2.b / H2.c
  / other).
- **Slice 2 — fix scoped to cause**: TBD by Slice 1.

## Out of scope (this plan)

- The "primary sweep at age 925 s" anomaly — separate concurrency
  audit of the sweep daemon vs `callsMap` iteration. Listed in
  evidence above; not on this plan's critical path.
- The dangling `limiter_refresh` / `keepalive` timer fibers after
  sweep — fix is to call `timers.cancelAll(callRef)` in the sweep
  body. One-line change but unrelated to BYE resolution; bundle it
  into Slice 2 of Q1 if convenient.

## Acceptance criteria (overall)

- [ ] After Q1 fix: in a fake-clock scenario where the b-leg never
      replies to BYE, the call resolves via the rule path within
      32 s and the orphan sweep counter stays at 0.
- [ ] After Q2 fix: re-run endurance with seed 1777960808113;
      `orphanSweepRecoveredCount === 0` (i.e., the symptom from
      this plan no longer fires).
- [ ] Together with the already-merged limiter-decrement fix:
      `limiterProbe.exceededCap === false`.
