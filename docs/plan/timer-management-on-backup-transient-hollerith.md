# Timer Management Across Worker Restart — Plan

## Context

When the LB routes a call to a primary B2BUA worker (W1) with a backup (W2), the
primary owns several long-lived timers per call: SIP OPTIONS keepalive,
`keepalive_timeout` watchdogs, and `limiter_refresh` window-migration ticks.
Today, the runtime fibers backing those timers are not persisted (by design —
[src/call/TimerService.ts:1-7](src/call/TimerService.ts#L1-L7)) and the
`TimerEntry` JSON snapshots that *are* persisted to `pri:{W1}:call:{ref}` (and
mirrored into W2's `bak:{W1}:call:{ref}`) are never used to respawn fibers.

Concretely:
- [src/call/TimerService.ts:90-103](src/call/TimerService.ts#L90-L103) implements
  `restoreFromEntries`, but **no production code calls it.**
- [src/call/CallState.ts:460-497](src/call/CallState.ts#L460-L497) (`loadOwnedCalls`)
  is also dead code: `ReclaimRunner` only re-pulls peer's `bak:{self}:` into the
  worker's local `pri:{self}:` cache. It never populates the in-memory `callsMap`
  and never spawns timer fibers.

Result: when W1 reboots, recovered calls sit in cache. OPTIONS keepalive stops
firing, `limiter_refresh` stops ticking, and the next message is required to
even bring the call into memory. For a healthy two-leg call with no in-progress
SIP traffic, that "next message" never comes — the call eventually expires
silently.

This plan (a) wires the existing rehydration helpers into the boot path so a
restarted primary picks up its own timers, (b) documents the explicit
limitation that the backup does **not** fire timers on the primary's behalf
(per the §0 single-owner invariant), and (c) adds a `timer-reactivation-big-case`
test mirroring `reinvite-big-case` that proves the fix.

## Out of scope

- **Backup-side timer firing.** The §0 single-owner invariant (`docs/replication/call-cache-backup.md`)
  stays intact. Backup remains passive. We add a written restriction acknowledging
  that this is acceptable only because primary restart is fast relative to
  `callContextTtlSec`. A future iteration (driven by REGISTER / long-lived flows
  where keepalive cadence is tighter than restart time) will need a true
  takeover model — out of scope here.
- A second scenario covering "primary not restarted immediately, backup manages
  OPTIONS." Documenting the limitation supersedes testing it.

---

## Code changes

### 1. Wire timer rehydration at primary boot

**File:** [src/sip/SipRouter.ts](src/sip/SipRouter.ts)

Add a public method on `SipRouter` that rehydrates the worker's owned calls and
their persisted timer entries:

- After ReclaimRunner finishes (which already pulls peer's `bak:{self}:` back
  into local `pri:{self}:`), call `callState.loadOwnedCalls(workerIndex)` to
  pull every `pri:{self}:call:*` entry into the in-memory `callsMap`.
- For each loaded `Call`, call
  `timers.restoreFromEntries(call.callRef, call.timers, makeTimerHandler(handlers))`
  using the same `timerHandler` closure already constructed at
  [src/sip/SipRouter.ts:238-263](src/sip/SipRouter.ts#L238-L263).

Naming: `rehydrateOwnedCalls(handlers: HandlerRegistry): Effect.Effect<void, RedisError>`.
Expose it on the service interface so `main.ts` and the test fake-stack can call it.

`TimerEntry.fireAt` is absolute epoch ms ([src/call/CallModel.ts:347-356](src/call/CallModel.ts#L347-L356)).
`TimerService.schedule` already uses `Math.max(0, fireAt - now)`
([src/call/TimerService.ts:55-56](src/call/TimerService.ts#L55-L56)) so timers
that should have fired during the outage fire immediately on respawn — and
`restoreFromEntries` already logs a warning when that happens.

### 2. Call rehydration from boot paths

**File:** [src/main.ts](src/main.ts)

After `ReadyGate.run` returns and before `WorkerReadiness.markReady(true)`,
yield the SipRouter and invoke `router.rehydrateOwnedCalls(handlers)`. Run inside
a `catchTag("RedisError", ...)` that logs and continues — a recovery error
shouldn't keep the worker not-ready forever.

**File:** [tests/support/k8sFakeStack.ts](tests/support/k8sFakeStack.ts) (worker
build closure around line 280-320)

After the worker's services are constructed, `yield* router.rehydrateOwnedCalls(handlers)`
once. The `respawn` path already re-runs the build closure
([tests/support/SimulatedK8sCluster.ts:336-376](tests/support/SimulatedK8sCluster.ts#L336-L376)),
so respawned workers will rehydrate by the same path — no special handling needed.

### 3. Documented restriction

**File:** [docs/replication/call-cache-backup.md](docs/replication/call-cache-backup.md)

Add a §11 (or appropriate next-numbered) "Restriction: backup does not fire
timers" section that states:

- Backup never fires SIP timers (OPTIONS keepalive, `keepalive_timeout`,
  `limiter_refresh`, `no-answer`, REFER timers). Per §0 single-owner invariant.
- Operational consequence: the primary worker MUST restart within
  `callContextTtlSec` (default `keepaliveIntervalSec * 2`); past that, the
  `bak:{primary}:` copy TTL-expires and the call is unrecoverable.
- During the outage window, the remote endpoints receive no keepalive pings.
  If the call's BYE-detection on the remote relies on keepalive failure
  (e.g. some user agents), the call may be cleaned up locally on those
  endpoints before primary returns.
- Future work: REGISTER and similar long-lived flows where tick cadence is
  shorter than typical restart time will require backup-side timer management,
  which breaks §0. Tracked separately.

---

## Harness changes (so the new test can prove "no leak" via the standard sweep)

The user's intent is to drop `.skipFinalSweep()` on the new test and let the
harness's end-of-scenario `verifyCleanState` catch any leftover timer fibers or
in-memory call entries. Today, that sweep at
[tests/fullcall/framework/simulated-backend.ts:492-515](tests/fullcall/framework/simulated-backend.ts#L492-L515)
only inspects a single `mockState.timerServiceRef` / `mockState.callStateRef`
captured for legacy SUTs — for `k8sFailover`, those refs are `undefined` and
the leak check silently passes
([tests/fullcall/framework/simulated-backend.ts:291-298](tests/fullcall/framework/simulated-backend.ts#L291-L298)).

**Files:** [tests/support/k8sFakeStack.ts](tests/support/k8sFakeStack.ts),
[tests/support/SimulatedK8sCluster.ts](tests/support/SimulatedK8sCluster.ts),
[tests/fullcall/framework/simulated-backend.ts](tests/fullcall/framework/simulated-backend.ts)

1. Extend `WorkerHandle` (k8sFakeStack) to expose its per-worker `CallState` and
   `TimerService` instances (read out of the worker's `services` ServiceMap, the
   same place `SipRouter` is read at line 317 today).
2. Add `cluster.verifyCleanStateOnAllWorkers()` to `SimulatedK8sClusterApi` — for
   each non-killed worker, assert `TimerService.activeCount() === 0` and
   `CallState.stats().concurrent === 0`. Returns a `string[]` of error messages.
3. In `simulated-backend.ts:verifyCleanState`, when `sut === "k8sFailover"`,
   yield the cluster and append its `verifyCleanStateOnAllWorkers()` result to
   the existing `errors[]` collection.

This change is additive — existing k8sFailover tests still call
`.skipFinalSweep()` and bypass the sweep entirely; only tests that opt out of
`skipFinalSweep` get the per-worker clean-state assertion.

---

## New test

**File:** `tests/sip-front-proxy/failover/timer-reactivation-big-case.test.ts`

Mirrors [tests/sip-front-proxy/failover/reinvite-big-case.test.ts](tests/sip-front-proxy/failover/reinvite-big-case.test.ts)
with the timer-rehydration shape. Reuses
[tests/scenarios/keepalive-happy.ts](tests/scenarios/keepalive-happy.ts) as the
per-cycle keepalive observation pattern.

Sequence (TestClock virtual time, default `keepaliveIntervalSec = 900`):

1. Two-worker proxy SUT (`k8sFailover`). Stable agents `alice` (caller) and
   `bob` (callee), explicit call-id chosen so the LB primary cookie is W1
   (reuse `CALLID_TO_W1` from
   [tests/scenarios/ha/two-calls-routed-to-two-workers.ts](tests/scenarios/ha/two-calls-routed-to-two-workers.ts)).
2. `s.pause(25_000)` to clear the fresh-pod guard and let initial OPTIONS
   keepalive flip both workers `unknown` → `alive` (same prelude as
   reinvite-big-case lines 60-83).
3. INVITE → 100 → 180 → 200 → ACK on alice/bob legs.
4. `expectReplicatedTo(W2, { primary: W1 })`.
5. `s.pause(900_000)` — first keepalive cycle. `aliceDialog.expect("OPTIONS").reply(200)`,
   `bobDialog.expect("OPTIONS").reply(200)` (proves baseline keepalive flow).
6. `s.cluster.kill(W1)`.
7. Short pause (e.g. `s.pause(1_000)`) — well under `callContextTtlSec`. No
   OPTIONS expected; backup is passive (the documented limitation).
8. `s.cluster.respawn(W1)`.
9. `s.pause(50)` to let rehydration run (kicked off in the worker build
   closure during respawn).
10. `expectCallStateOn(W1, { partition: "pri", owner: W1, present: true })` —
    proves `loadOwnedCalls` populated memory.
11. `s.pause(900_000)` — second keepalive cycle, AFTER respawn. Assert
    `aliceDialog.expect("OPTIONS").reply(200)` and `bobDialog.expect("OPTIONS").reply(200)`.
    **This is the crux: it fails on master because no fiber is respawned, and
    passes after the §1/§2 wiring.**
12. (Optional) `s.pause(60_000)` enough to also exercise one `limiter_refresh`
    rehydrated tick — verifies the limiter timer survives restart.
13. BYE on aliceDialog → `bobDialog.expect("BYE").reply(200)` →
    `aliceByeTxn.expect(200)`.
14. **Do NOT call `.skipFinalSweep()`.** End-of-scenario sweep enforces:
    - Per-worker `TimerService.activeCount() === 0` on W1 and W2 (via the
      harness extension above).
    - Per-worker `CallState.stats().concurrent === 0` on both workers.
    - No leftover `pri:` or `bak:{W1}:` entries (already covered by existing
      `expectCallStateOn` at the storage level — add explicit ones too:
      `expectCallStateOn(W1, { partition: "pri", owner: W1, present: false })`
      and `expectCallStateOn(W2, { partition: "bak", primary: W1, present: false })`).

Test invocation pattern matches reinvite-big-case lines 194-202:

```ts
const run = createSimulatedRunner({ outputDir: OUTPUT_DIR, sut: "k8sFailover" })
it.effect(
  "timer-reactivation-big-case: keepalive resumes after primary restart",
  () => run(timerReactivationBigCase.toScenario()),
  { timeout: 240_000 },
)
```

---

## Verification

1. **Failing baseline.** Before any code/harness changes, write the test and run
   `npm run test -- timer-reactivation-big-case`. The post-respawn
   `aliceDialog.expect("OPTIONS")` step must time out (no OPTIONS observed) —
   confirms the gap.
2. **Apply harness changes (§3) only.** Re-run; same failure (the missing
   OPTIONS, not a sweep failure).
3. **Apply code fix (§1, §2).** Re-run; both cycles' OPTIONS observed,
   end-of-scenario sweep clean, `npm run typecheck` reports zero errors and
   zero warnings (Effect plugin included — see [CLAUDE.md](CLAUDE.md) "Never
   ignore a warning").
4. **Regression check.** Run the full fake-stack suite: `npm run test:fake`.
   In particular, `keepalive-happy` and `reinvite-big-case` must still pass —
   the harness change is additive (only fires when `skipFinalSweep` is off
   under k8sFailover, which existing tests still set).
5. **Documentation review.** Confirm the new restriction section in
   `docs/replication/call-cache-backup.md` is referenced from the
   "Progressive reading guide" table in [CLAUDE.md](CLAUDE.md) if not already.

## Critical files

- New: `tests/sip-front-proxy/failover/timer-reactivation-big-case.test.ts`
- Modified: `src/sip/SipRouter.ts` — add `rehydrateOwnedCalls`
- Modified: `src/main.ts` — invoke rehydration after ReadyGate
- Modified: `tests/support/k8sFakeStack.ts` — invoke rehydration in worker
  build closure; expose per-worker CallState + TimerService on WorkerHandle
- Modified: `tests/support/SimulatedK8sCluster.ts` — add
  `verifyCleanStateOnAllWorkers`
- Modified: `tests/fullcall/framework/simulated-backend.ts` — call
  cluster-wide clean-state when `sut === "k8sFailover"`
- Modified: `docs/replication/call-cache-backup.md` — add restriction section

## Reused utilities

- [src/call/TimerService.ts:90-103](src/call/TimerService.ts#L90-L103) `restoreFromEntries` — already implemented; just needs to be called.
- [src/call/CallState.ts:460-497](src/call/CallState.ts#L460-L497) `loadOwnedCalls` — already implemented; just needs to be called.
- [src/sip/SipRouter.ts:238-263](src/sip/SipRouter.ts#L238-L263) `timerHandler` closure — reuse exactly as-is for the rehydration handler.
- [tests/scenarios/keepalive-happy.ts](tests/scenarios/keepalive-happy.ts) — copy the per-cycle OPTIONS-observation pattern.
- [tests/sip-front-proxy/failover/reinvite-big-case.test.ts](tests/sip-front-proxy/failover/reinvite-big-case.test.ts) — copy the kill/respawn skeleton, the 25s prelude, and the W1/W2/CALLID_TO_W1 wiring.
- [tests/scenarios/ha/two-calls-routed-to-two-workers.ts](tests/scenarios/ha/two-calls-routed-to-two-workers.ts) — `CALLID_TO_W1` constant.
