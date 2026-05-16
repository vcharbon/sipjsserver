# Plan: properly fix the limiter-Redis cascade — concurrency + fail-open + per-call ordering

> Working draft. Replaces / supersedes [2026-05-15-limiter-redis-spof-cascade-fix.md](2026-05-15-limiter-redis-spof-cascade-fix.md).
> Updated through grill-with-docs session.

## Implementation tracking

Updated as each step lands. ✅ = done, 🚧 = in progress, ⬜ = pending.

### Stage 1 — Bounded limiter I/O + typed channels

- ✅ `LimiterRedisClient` opts in to `commandTimeout: 100`, `enableOfflineQueue: false`, `maxRetriesPerRequest: 1` (via new `RedisConnectionOptions` parameter on `makeRedisOps`)
- ✅ `CallLimiter.checkAndIncrement` returns typed `LimiterDecision` / `LimiterBackendError` with outer `Effect.timeoutOrElse(150)` → `LimiterTimeout`
- ✅ `applyRoute.ts` caller pattern (`catchTags` + `incrementSucceeded` written into `limiterEntry`)
- ✅ `CallLimiterState` schema gains `incrementSucceeded?: boolean` (optional for backward-compat with replicated entries)
- ✅ `InvariantEnforcer` skips `decrement-limiter` when `incrementSucceeded === false`
- ✅ `CallState.ts:878-889` force-purge decrement loop skips `incrementSucceeded === false`
- ✅ Test stubs updated (`tests/call/forcepurge-limiter-decrement-bounded.test.ts`, `tests/support/cache-and-limiter.test.ts`) to use new `_tag: "Allowed"/"Rejected"` shape
- ✅ T3 `limiter-timeout-fail-open` test ([tests/call/limiter-fail-open.test.ts](../../tests/call/limiter-fail-open.test.ts))
- ✅ T4 `limiter-redis-error-fail-open` test (same file)
- ✅ `npm run typecheck` introduces no new errors (pre-existing 2 errors in `tests/k8s/endurance/dispatchChaos.ts` from the chaos-primitives WIP commit `5a6dcc38`; tracked in `docs/plan/2026-05-16-chaos-primitives-verify-not-noop.md` — out of scope for this plan)
- ✅ `npm run test:fake` — 1241 tests pass, 0 fail (full fake-clock suite regression check)

### Stage 2 — Symmetric admission/release

- ✅ `Call.limiterEntries` element gains `incrementSucceeded?: boolean` (landed under Stage 1 because the schema change was a Stage 1 typecheck prerequisite)
- ✅ `CallState.ts:878-889` force-purge decrement skips entries where `incrementSucceeded === false`
- ✅ `InvariantEnforcer` rule-path decrement skips entries where `incrementSucceeded === false`
- ✅ `terminateCallEffects` and `finalCleanupEffects` in `src/b2bua/helpers.ts` filter on `incrementSucceeded !== false` so fail-open admissions do not produce a DECR soft-effect
- ⬜ Lua `DECREMENT_LUA` adds `MAX(0, ...)` clamp (defense in depth) — **deferred** as the existing in-memory variant already clamps and the new caller-side skip closes the primary leak path
- ✅ New test asserting force-purge skips DECR when `incrementSucceeded === false` ([tests/call/forcepurge-skips-decr-on-fail-open.test.ts](../../tests/call/forcepurge-skips-decr-on-fail-open.test.ts))

### Stage 2.5 — Strong INCR/DECR invariant in `applyRoute`

The user's invariant: **a successful INCR is matched by exactly one DECR, regardless of which code path closes the call. On any error after a successful INCR, the DECR fires immediately.**

Pre-fix audit surfaced two leaks beyond what Stage 1 addressed:

- **Path 2** (within-loop reject): when `limiter[k]` rejected after `limiter[0..k-1]` admitted, the rejection branch built `rejected = addCdrEvent(args.call, ...)` from the *pre-INCR* call, discarding `limiterEntries`. `terminateCallEffects(rejected)` then emitted no decrement-limiter → prior INCRs leaked.
- **Path 3** (post-loop defect): when `createBLegFromRoute` or any post-loop step died, the `Effect.gen` body failed with `Cause.Die`, the handler returned no `HandlerResult`, the call state was never durably stamped with `limiterEntries` → all INCRs leaked.

Fixes:

- ✅ `applyRoute` now tracks `successfulIncrements` (only `incrementSucceeded: true` entries) separately from `limiterEntries`. `eagerDecrement()` iterates the canonical record — fail-open admissions are *never* DECR'd.
- ✅ **Path 2 fix** — within-loop reject:
  - 486 reject branch: attaches `limiterEntries` to the rejected call so `terminateCallEffects` emits decrement-limiter for each (filtered on `incrementSucceeded !== false`).
  - Failover branch: attaches `limiterEntries` to `failoverCall` so the failover call carries them through to its own terminate flow.
  - Failover-admission reject branch: calls `eagerDecrement()` explicitly because `buildAdmissionRejectResult` builds from `args.call` (no `limiterEntries`).
- ✅ **Path 3 fix** — outer `.pipe(Effect.onExit(exit => Exit.isFailure(exit) ? eagerDecrement() : Effect.void))`. Fires on any Cause-level failure, defect, or interrupt after the limiter loop. Does not swallow the cause — the same exit is re-emitted after the finalizer.
- ✅ 3 dedicated tests ([tests/decision/apply-route-incr-decr-invariant.test.ts](../../tests/decision/apply-route-incr-decr-invariant.test.ts)):
  - Path 2a (within-loop reject with prior INCR) — DECR emitted via terminate effects
  - Path 2b (no prior INCR) — no DECR emitted
  - Path 3 (post-INCR defect) — eager DECR fires for each successful INCR
- ✅ `npm run test:fake` clean: 1245 tests pass / 0 fail

The invariant is now structural: a successful INCR is *always* matched by exactly one DECR — either through the terminate path (for admitted calls) or through `eagerDecrement` (for error paths).

### Stage 3 — Per-call queue dispatch

- ⬜ New `src/sip/PerCallDispatcher.ts` (perCallQueues, router-fiber, worker-fiber, POISON)
- ⬜ Replace `Stream.runForEach` in `SipRouter.ts:1071`
- ⬜ Move handler `timeoutOrElse` into worker loop
- ⬜ Pre-populate at boot from CallStateCache
- ⬜ `CallState.delete` enqueues POISON
- ⬜ `AppConfig` adds `EVENT_DISPATCH_CONCURRENCY` (default 1024) + `PER_CALL_QUEUE_CAP` (default 200000)
- ⬜ Metrics (`dispatch_queues{partition}`, `dispatch_in_flight`, `dispatch_saturation_total`, `dispatch_worker_cap_drops`, `dispatch_queue_creations_total`, `dispatch_queue_removals_total`, `dispatch_handler_duration_ms`)
- ⬜ Tests T1, T2, T5, T6, T7, T8, T9

### Stage 4 — Safety-timer refresh + config validation

- ⬜ Bump `TERMINATING_TIMEOUT_MS` from 64 000 → 420 000
- ⬜ `CallState.update` refreshes `terminating_timeout` `fireAt` on every update while in `terminating`
- ⬜ `AppConfig` validator: refuse to start if `terminatingTimeoutMs ≤ keepaliveIntervalSec*1000 + 60_000`
- ⬜ Test `orphan-sweep-refreshes-on-peer-activity`
- ⬜ Test `config-validation-rejects-inconsistent`

### Stage 5 — ADR-0004 + CONTEXT.md

- ⬜ `docs/adr/0004-per-call-fifo-via-router-and-workers.md`
- ⬜ CONTEXT.md gains "Per-call FIFO" + "Event dispatch" entries

### Live (k8s) tests

- ⬜ L1 `limiter-redis-kill9-cascade-gone`
- ⬜ L2 `worker-cut-from-limiter-redis-hard`
- ⬜ L3 `node-shutdown-edge` (limiter Redis pinned to `tier: app`)

## Context

The 2026-05-15 endurance run showed a transient limiter-Redis loss (~73 s) cascading into ~110 s of total worker service loss — orders of magnitude over the 1–2 s chaos SLA. The previous plan diagnosed two contributing causes:

1. The limiter's `Effect.catchTag("RedisError")` fail-open path does not actually fire on every failure mode (TCP black-hole, reconnect-buffering, never-resolving promise).
2. `INCR`/`DECR` asymmetry leaks counters negative once fail-open does kick in.
3. The orphan sweep purges in-flight dialogs once the handler timeout fires.

**Those three are real, but they are not the full story.** The investigation surfaces a **fourth, dominant** cause that the original plan missed:

> The worker has **exactly one event-dispatch fiber**. `SipRouter` consumes `eventQueue` with `Stream.runForEach` ([src/sip/SipRouter.ts:1071](../../src/sip/SipRouter.ts#L1071)). All events for all calls share that fiber. When **any one event** stalls on Redis (limiter `INCR`, call-cache write, anything), every other event on the worker waits behind it. The queue fills to 400, drops kick in, and the worker effectively dies until the slow handler completes or the 10-second `Effect.timeoutOrElse` fires.

The 10-s timeout itself is *non-aborting* (`timeoutOrElse` logs and continues but does not interrupt the underlying fiber — [SipRouter.ts:1092](../../src/sip/SipRouter.ts#L1092)), so even after the timer fires, the stuck fiber keeps holding the dispatch slot until the underlying ioredis command finally errors out.

**Therefore the proper fix is in three independent layers, all of which must land:**

A. **Concurrent event dispatch with preserved per-call FIFO** — so one slow handler cannot block other calls.
B. **Bounded Redis I/O** — `commandTimeout` + `enableOfflineQueue: false` + an Effect-side timeout, so the limiter actually fails fast.
C. **Symmetric admission/release + orphan-sweep predicate** — so the fail-open path neither leaks counters nor purges in-flight dialogs.

The grill below resolves the open design questions for each layer.

## What is _verified_ from exploration (do not relitigate)

- **TransactionLayer event queue.** Bounded `Queue` of capacity `max(64, udpQueueMax * 4) = 400` by default ([TransactionLayer.ts:294](../../src/sip/TransactionLayer.ts#L294)). Producers use `Queue.offerUnsafe` — tail-drop, never block. Drops classified by reason and reported via metric.
- **Consumer.** Single fiber via `Stream.runForEach` ([SipRouter.ts:1071](../../src/sip/SipRouter.ts#L1071)). Handler is wrapped in `Effect.timeoutOrElse(eventHandlerTimeoutMs=10000)` ([SipRouter.ts:1086-1102](../../src/sip/SipRouter.ts#L1086-L1102)) — **non-aborting**: timeout logs but the underlying fiber keeps running and keeps the dispatch slot.
- **Per-call serialization** is enforced by a per-`callRef` semaphore with capacity 1 in [src/call/CallState.ts:218](../../src/call/CallState.ts#L218), acquired by `withCall` at [CallState.ts:455-477](../../src/call/CallState.ts#L455-L477). The permit is released by Effect v4's uninterruptible finalizer on `withPermits`, so neither failure nor interrupt leaks the permit ([CallState.ts:447-454](../../src/call/CallState.ts#L447-L454) comment block).
- **TransactionLayer CANCEL** matches the INVITE server transaction by `(callId, fromTag)` in the producer side ([TransactionLayer.ts:505-571](../../src/sip/TransactionLayer.ts#L505-L571)), sends 200 to the CANCEL and 487 to the INVITE synchronously, then emits a `{type:"cancelled"}` event. The INVITE event was already emitted earlier in queue order; the CANCEL event always enters the queue *after* its matching INVITE.
- **Limiter Redis client** uses ioredis with `{ lazyConnect: true }` ONLY ([RedisClient.ts:74](../../src/redis/RedisClient.ts#L74)). No `commandTimeout`. No `enableOfflineQueue: false`. No `maxRetriesPerRequest`. So an unreachable Redis silently buffers every issued command and resolves them only after reconnect — **this is the load-bearing footgun** that defeats the existing `catchTag("RedisError")`.
- **`checkAndIncrement` path.** Lua atomic on a healthy Redis. No timeout wrapper at the call site ([applyRoute.ts:197-208](../../src/decision/apply/applyRoute.ts#L197-L208)).
- **`decrement` path.** Plain Lua `DECR` ([CallLimiter.ts:63-65](../../src/call/CallLimiter.ts#L63-L65)) — **no clamp at zero on the Redis side.** The in-memory variant clamps at zero. Wrapped in `Effect.timeoutOrElse(limiterDecrementTimeoutMs)` at [CallState.ts:881-889](../../src/call/CallState.ts#L881-L889).
- **Orphan sweep / safety timer.** Auto-armed atomically on the `terminating` transition inside `Effect.uninterruptibleMask` ([CallState.ts:479-526](../../src/call/CallState.ts#L479-L526)); when it fires it calls `forcePurge(callRef, "safety_timer")`. Today the predicate is unconditional on age — it does not consult recent peer activity.

## Open design questions (resolved during grill)

These will be filled in as we walk down each branch.

### Q1 — Diagnosis framing _[resolved]_

**Decision:** all three layers (A) parallel dispatch, (B) bounded Redis I/O, (C) symmetric admission/release — landed together. Single-fiber consumer is the dominant amplifier the original plan missed; (B)+(C) alone are necessary but not sufficient because any other slow dependency (call-control HTTP, downstream UDP buffer, CDR drainer) would re-create the same single-fiber stall.

### Q2 — Target concurrency level _[resolved]_

**Decision:** event-dispatch concurrency is configurable; **default 1024**, env var `EVENT_DISPATCH_CONCURRENCY`. Justification: covers 100 CAPS × 10 s worst-case slow downstream while leaving headroom for INVITE-storm spikes; Effect v4 fibers are cheap (no kernel thread, ~KB stack per fiber); per-call semaphore already prevents in-flight overlap for the same call so 1024 fibers map to up to 1024 distinct calls.

**Mandatory accompanying instrumentation** (must land in same change):
- `dispatch_in_flight` gauge — current in-flight handlers
- `dispatch_saturation_total` counter — incremented when the dispatch concurrency cap blocks a pull
- `dispatch_handler_duration_ms` histogram — to detect creeping slowness

Without these gauges, sizing tomorrow is guesswork.

### Q3 — Per-call queue architecture _[resolved — Alternative B chosen]_

**Decision.** Router + per-callRef queue + worker fiber. **Eager pre-population at boot** (Alternative B), with lazy fall-through for new INVITEs.

**Why Alt B over Alt A:**
1. **Cleanup path is exercised continuously**, including for backup-held calls that never see traffic. When the call terminates and `CallState.delete(callRef)` fires, POISON is enqueued, worker drains, exits, map entry is removed — same machinery on every call regardless of whether it ever saw an event. Strong validation in production.
2. **No queue-creation surge during failover.** When primary A dies and B becomes the served-from-backup target for ~50K calls, all 50K perCallQueues already exist on B (pre-created at boot from `bak:A:call:*`). Cutover handles only the *traffic* surge, not the additional concurrent-fork load of building 50K queues at once.
3. **Boot cost is amortized**: ~50K fibers × ~2 KB = ~100 MB, paid once at startup. Acceptable on a worker with multi-GB heap.

**Lifecycle:**

```
worker startup:
  1. layer scope opens
  2. CallStateCache.loadOwnedCalls() — repopulates primary partition entries
  3. replication bootstrap-pull — repopulates backup partition entries from peers
  4. for every callRef now in CallStateCache:
       perCallQueues.set(callRef, { queue, partition: "primary" | "backup:peer-X" })
       forkDaemon(workerLoop(callRef))
  5. SipRouter starts: router daemon drains eventQueue

router fiber (single):
  loop:
    event = eventQueue.take()
    callRef = resolveCallRef(event)
    if callRef === undefined: drop, continue
    w = perCallQueues.get(callRef)
    if w is None:
      // fresh INVITE for a callRef not in CallStateCache → lazy create
      w = { queue: Queue.bounded(64), partition: "primary" }
      perCallQueues.set(callRef, w)
      forkDaemon(workerLoop(callRef, w))
    w.queue.offer(event)

worker(callRef, w):
  loop:
    event = w.queue.take()
    if event === POISON:
      drain remaining (no-ops on deleted call), return
    handle(event)
  on return: emit "remove" to router via lock-free SPSC channel; router removes map entry on its own fiber.

CallState.delete(callRef) (existing leaf-of-terminate):
  + enqueue POISON into perCallQueues[callRef].queue
  + perCallQueues entry removed by router after worker exit-signal
```

**Hard cap:** `perCallQueues` size limited to **200 000** entries. Router checks cap before lazy creation; over-cap creates increment `dispatch_worker_cap_drops` counter. Operator-visible alert when non-zero.

**Metrics (partition-tagged, per your request):**

| Metric | Labels | Description |
|---|---|---|
| `dispatch_queues` | `partition="primary"` or `partition="backup",peer="<workerOrdinal>"` | Gauge: current count of perCallQueues |
| `dispatch_queue_creations_total` | `reason="boot"` / `"lazy"` / `"failover"` | Counter |
| `dispatch_queue_removals_total` | `reason="terminate"` / `"reaper"` | Counter |
| `dispatch_worker_cap_drops` | `kind="cap-exceeded"` | Counter — bounded by 200K cap |
| `dispatch_in_flight` | `partition` | Gauge: how many workers are currently handling an event (not parked on `take`) |
| `dispatch_saturation_total` | — | Counter incremented when the dispatch concurrency cap (1024) would have blocked a take |
| `dispatch_handler_duration_ms` | `event_type` | Histogram |

**Per-call serialization → semaphore deprecation:**

With per-call queues, the worker fiber is structurally the sole writer for events arriving via the router (the common path). The `Semaphore.withPermits(1)` inside `CallState.withCall` ([CallState.ts:218,338,460](../../src/call/CallState.ts#L218)) becomes redundant for on-pump events. It remains useful for off-pump callers — orphan sweep, periodic flush, replication-apply path — and stays as defense-in-depth.

**Pod-restart impact:** strictly improved. Today one fiber blocks the worker during cold start if any recovered call's first event stalls; with Alt B, each recovered call has its own worker so a stuck call cannot block the rest.

**Future enhancement (deferred):** CANCEL-while-INVITE-in-flight could interrupt the in-flight handler. Per-call queue carries a `currentFiber` ref; on CANCEL dequeue the dispatcher could `Fiber.interrupt(currentFiber)` if the INVITE has not yet reached the "b-leg sent" state. Out of scope here.

### Q4 — Limiter service contract _[resolved]_

**Decision.** Replace the `undefined`-marker fail-open contract with typed Effect channels.

```ts
type LimiterDecision =
  | { _tag: "Allowed";  currentWindow: number }
  | { _tag: "Rejected" }      // limit-exceeded; success channel, not an error

type LimiterBackendError =
  | { _tag: "RedisError"; cause: RedisError }
  | { _tag: "LimiterTimeout"; budgetMs: 150 }   // outer (Effect-level) bound

checkAndIncrement(id, limit): Effect<LimiterDecision, LimiterBackendError, never>
```

- Budget (defense in depth, two layers):
  - **ioredis `commandTimeout: 100 ms`** — primary, fires first when ioredis is functioning correctly.
  - **`Effect.timeout(Duration.millis(150))`** — outer safety net. Only fires if the ioredis-level timeout *fails* to surface (ioredis bug, command buffered in an unrecoverable state, etc.). The 50 ms gap guarantees normal-mode wins (`RedisError` surfaces at 100 ms via ioredis) and the outer net only catches genuine ioredis pathology. The Effect-level bound is also what makes the must-run contract from ADR-0003 explicit on the fiber.
- Healthy Redis: success channel. `Rejected` is success (limit-hit is an expected outcome — caller sends 503).
- Unhealthy Redis: error channel. Caller uses `Effect.catchTags({ RedisError, LimiterTimeout })` and synthesizes an `"admit-no-tag"` admission.
- **Caller obligation:** an `"admit-no-tag"` admission writes the `limiterEntry` with `incrementSucceeded: false`. Cleanup paths (`forcePurge`, terminate flow, orphan sweep) MUST skip `DECR` for entries with `incrementSucceeded: false`. This closes the counter-leak hole described as cause (2b) in the original plan.

Caller pattern:

```ts
const admission = yield* limiter.checkAndIncrement(entry.id, entry.limit).pipe(
  Effect.catchTags({
    RedisError:     (e) => Effect.logWarning(`limiter ${entry.id} unavailable: ${e.cause.reason}`).pipe(Effect.as("admit-no-tag" as const)),
    LimiterTimeout: (e) => Effect.logWarning(`limiter ${entry.id} timed out (${e.budgetMs}ms)`).pipe(Effect.as("admit-no-tag" as const)),
  }),
)
```

**ioredis configuration** (in `RedisClient.ts` for the limiter connection):

| Setting | Value | Why |
|---|---|---|
| `commandTimeout` | `100` | Cap every command at 100 ms. **The fix for the TCP black-hole stall** observed in 2026-05-15. |
| `enableOfflineQueue` | `false` | Reject during reconnect instead of silently buffering — kills the "queue, replay on reconnect, late success" pattern. |
| `maxRetriesPerRequest` | `1` | Bound the internal ioredis retry so the 100 ms budget isn't blown by retry. |
| `lazyConnect` | `true` (already set) | Unchanged. |

### Q5 — Single-fiber set (load-bearing for FIFO) _[resolved]_

**Decision.** Keep the following fibers single-fiber. They are load-bearing for the per-call FIFO invariant.

| Fiber | Stays single | Why |
|---|---|---|
| TransactionLayer UDP receiver | Yes | SIP transaction match-by-`(callId,fromTag)` requires ordered view; produces `eventQueue` in UDP-arrival order |
| `SipRouter` dispatcher (router) | Yes | O(1) per-event work; preserves `eventQueue` dequeue order into perCallQueue order |
| Replication pull per peer | Yes (1 per peer) | watermark ordering; unchanged |
| Orphan-sweep / periodic flush | Yes | off-pump; coordinates with workers via `CallState.withCall` semaphore |
| BufferedCdrLayer drainer | Yes | ADR-0003, unchanged |
| BufferedTerminateWriter drainer | unchanged (N) | ADR-0003 pool |
| Metrics scanner | Yes | read-only |
| **Per-call worker** (new) | 1 per active callRef | only this tier is parallel |

**Two derived invariants** (must be documented in ADR-0004):

1. UDP-arrival order → `eventQueue` order (via TransactionLayer single-fiber).
2. `eventQueue` order → `perCallQueue` order (via Router single-fiber).

Together: for any callRef, perCallQueue order matches the UDP arrival order of the SIP messages that produced events for that call — the strongest possible per-call FIFO.

### Q6 — Test design _[resolved]_

**Fake-clock unit tests (run on every PR):**

| # | Name | Assertion |
|---|---|---|
| T1 | `dispatch-invite-then-cancel-same-call` | INVITE handler completes (limiter + HTTP + b-leg sent) **before** CANCEL handler begins. Final state: call deleted, no 481, perCallQueues entry removed. |
| T2 | `dispatch-cancel-orphan` | CANCEL with no preceding INVITE: lazy creation, worker emits 481, cleanup via POISON or reaper. |
| T3 | `limiter-timeout-fail-open` | Redis hangs (Deferred.never). Handler admits within ≤ 150 ms with `incrementSucceeded=false`. Two sub-tests: (a) stub at ioredis layer → admit at 100 ms; (b) stub at Effect layer → admit at 150 ms (outer safety-net path). Terminate skips DECR in both. |
| T4 | `limiter-redis-error-fail-open` | Redis fails (RedisError). Handler admits within ≤10 ms with `incrementSucceeded=false`. Terminate skips DECR. |
| T5 | `dispatch-parallelism-throughput` | 1 024 distinct callRefs × 200 ms Redis-INCR → total wall time ≈ 200 ms (parallel), not 1 024 × 200 ms (serial). |
| T6 | `boot-eager-populates-queues` | Pre-seeded CallStateCache (N primary + M backup) → after boot `perCallQueues.size === N+M`; partition-tagged gauges correct. |
| T7 | `terminate-removes-perCallQueue` | `CallState.delete(X)` enqueues POISON; worker exits; `perCallQueues.has(X) === false`; removal counter ++ . |
| T8 | `cap-exceeded-drop` | At 200K cap, new INVITE for new callRef is dropped at router; `dispatch_worker_cap_drops++`. |
| **T9** | **`cancel-while-invite-in-flight`** | INVITE handler is mid-`/call/new` HTTP await. CANCEL arrives. Asserts: CANCEL is queued (perCallQueue depth = 1), not yet processed. Once INVITE handler completes (b-leg INVITE sent downstream), CANCEL is processed (b-leg CANCEL sent, terminate). Final state correct. **Today's correct behavior** — pins it so the future fiber-interrupt enhancement can be added without regressing the FIFO baseline. |

**Live (kind / k8s) tests:**

| # | Name | Setup | Pass criterion |
|---|---|---|---|
| L1 | `limiter-redis-kill9-cascade-gone` | Existing chaos op | `endurance-short` failure ≤ 2 s equivalent; `inflight ≥ 0` throughout; no `Call ... not found on checkout` wave 30 s post-recovery |
| L2 | `worker-cut-from-limiter-redis-hard` | Existing chaos op | Same as L1 |
| L3 | `node-shutdown-edge` (limiter Redis pinned to `tier: app`, NOT edge) | Existing chaos | Sanity — validates the SPOF was the *placement*, the rest of the cascade is fully fixed |

**Sketch of T1 (the INVITE+CANCEL race the user explicitly requested):**

```ts
it.effect("INVITE then CANCEL for same call → INVITE completes before CANCEL begins",
  Effect.gen(function* () {
    const sip = yield* makeFakeStack()
    const observed: Array<string> = []
    yield* sip.installHandlers({
      invite:    () => Effect.sync(() => observed.push("invite-start"))
                         .pipe(Effect.zipRight(TestClock.adjust("10 millis")))
                         .pipe(Effect.zipRight(Effect.sync(() => observed.push("invite-end")))),
      cancelled: () => Effect.sync(() => observed.push("cancel-start"))
                         .pipe(Effect.zipRight(Effect.sync(() => observed.push("cancel-end")))),
    })
    yield* sip.fireEvent({ type: "invite",    callRef: "X" })
    yield* sip.fireEvent({ type: "cancelled", callRef: "X" })
    yield* TestClock.adjust("100 millis")
    expect(observed).toEqual(["invite-start", "invite-end", "cancel-start", "cancel-end"])
  })
)
```

Ordering is **structurally** guaranteed by the FIFO invariant, not by `Effect` scheduling — the test passes regardless of fiber yield order.

### Q7 — Safety-timer refresh-on-activity _[partially resolved — pending Q7a]_

**Decision (mechanism).** Do **not** add a separate `lastPeerActivityMs` field. Instead, **the existing safety timer (`terminating_timeout`, defined as `TERMINATING_TIMEOUT_MS` in [src/call/timer-helpers.ts:18](../../src/call/timer-helpers.ts#L18)) is *refreshed* on every event for the callRef** — peer-originated and own-events alike. Mechanically:

```
on every withCall(callRef, event):
  if call.state === "terminating" AND a "terminating_timeout" timer exists:
    refreshTimerFireAt(callRef, "terminating_timeout", now + TERMINATING_TIMEOUT_MS)
```

This treats peer messages exactly like own activity for purposes of "is this call dead?". Net effect: the sweep only fires when **the call has truly been silent for `TERMINATING_TIMEOUT_MS` from any source** — much stronger predicate than today's "any call in terminating for N seconds gets purged".

Combined with the per-call queue model:
- `currentEvent != null` (handler in flight) → the timer is being refreshed *now* by the act of processing → naturally protective.
- `currentEvent == null` AND queue empty AND no peer activity for `TERMINATING_TIMEOUT_MS` → fire.

So we get the 3-way AND for free, with one mechanism (timer refresh) instead of three independent predicates.

**Decision (config validation).** At startup, validate:

```
TERMINATING_TIMEOUT_MS > expected_peer_activity_interval_ms + safety_margin_ms  (≥ 60 000 ms)
```

If violated: **refuse to start**, log explicit error, exit non-zero. The platform must not run with an inconsistent configuration.

**Q7a — open:** *which* keepalive is the relevant peer-activity interval to validate against?

Today's repo has:

| Config | Default | Where | Purpose |
|---|---|---|---|
| `keepaliveIntervalSec` | 300 s | [AppConfig.ts:320](../../src/config/AppConfig.ts#L320) | **Out-of-dialog OPTIONS probe interval** between front-proxy and worker (worker liveness probe; not call-specific). |
| `keepaliveTimeoutSec` | 10 s | [AppConfig.ts:321](../../src/config/AppConfig.ts#L321) | Per-OPTIONS-probe wait. |
| `TERMINATING_TIMEOUT_MS` | 64 000 ms | [timer-helpers.ts:18](../../src/call/timer-helpers.ts#L18) | Safety net for stuck `terminating` call. |

Under the proposed rule (`safety > keepalive + 60 s`), the current pair `64_000 < 300_000 + 60_000 = 360_000` **fails the check**, so the platform would refuse to boot with defaults.

Two possible reads of the intent:

1. *You meant the out-of-dialog OPTIONS probe.* Then we must bump `TERMINATING_TIMEOUT_MS` to ≥ 400 s (or lower the keepalive interval). Probably the right answer if OPTIONS messages can land on calls in `terminating` (they don't today — OPTIONS in this codebase is dialog-less, per [SipRouter.ts:619](../../src/sip/SipRouter.ts#L619) — but the principle "safety timer is bigger than the longest gap between peer activity" applies).
2. *You meant an in-dialog refresh interval* (session-timer / re-INVITE / UPDATE / re-REGISTER). The repo doesn't currently expose one; we'd need to add it, default to something realistic (e.g., session-timer minimum is 90 s per RFC 4028), then validate.

**Decision:** Option 1 — validate against `keepaliveIntervalSec`. Bump `TERMINATING_TIMEOUT_MS` from 64 000 to **420 000** (7 minutes, satisfies the +120 s margin against the default 300 s OPTIONS interval). Config-load validation:

```
if (TERMINATING_TIMEOUT_MS <= keepaliveIntervalSec * 1000 + 60_000)
  throw "Inconsistent config: TERMINATING_TIMEOUT_MS (${...}) must exceed " +
        "keepaliveIntervalSec*1000 + 60000 (${...}). Bump TERMINATING_TIMEOUT_MS " +
        "or lower KEEPALIVE_INTERVAL_SEC."
```

Existing tests that exercise the safety timer at 64 s must be updated; the structural test (`callstate-arms-safety-on-terminating.test.ts`) uses the constant so a single source change covers it.

### Q8 — ADR-0004 + CONTEXT.md _[resolved]_

**Decision.** Land **ADR-0004 — Per-call FIFO via router + per-call worker fibers** alongside the code.

ADR scope:
- The two FIFO invariants (UDP→eventQueue, eventQueue→perCallQueue) and the single-fiber set enforcing them (Q5 table).
- Why Alt B (eager pre-population) over Alt A (lazy-only) — cleanup-validation rationale.
- 200K hard cap rationale (≤ 400 MB worst-case + operator-visible `dispatch_worker_cap_drops`).
- Relationship to ADR-0003: the per-call worker is the natural site for the `critical`/`outbound`/`soft`/`buffered`/`fireAndForget` slot interpreter — it is the "single thread" running `processResult`.
- Relationship to `CallState.withCall` semaphore: retained as defense-in-depth for off-pump callers.
- Future fiber-interrupt for CANCEL-while-INVITE-in-flight — "deferred" section.

Out of ADR (left in plan):
- Limiter contract details, Redis client config, orphan-sweep predicate, safety-timer bump.

**CONTEXT.md additions:**

```
### Event processing

**Per-call FIFO**:
The invariant that all events for the same `callRef` are processed in
strict arrival order and never overlap. Enforced structurally by the
SipRouter → perCallQueue chain. See ADR-0004.

**Event dispatch**:
The pipeline from UDP receive (TransactionLayer) through the SipRouter
to the per-call handler. Two single-fiber tiers (receiver + router)
preserve UDP-arrival order; per-callRef worker fibers apply the
per-call FIFO above.
```

## Final fix plan

Three independent fix layers land in this order; each is shippable on its own merits but the cascade is only fully fixed once all three are in.

### Stage 1 — Bounded limiter I/O + typed channels  _(was: original plan Stage 2)_

**Goal:** `CallLimiter.checkAndIncrement` returns within 100 ms in **all** ioredis-functioning failure modes and within ≤ 150 ms even if ioredis itself misbehaves. Two-layer defense in depth (ioredis `commandTimeout: 100` + outer `Effect.timeout(150)`). Caller code uses typed channels, not `undefined` markers.

**Critical files:**

- [src/redis/RedisClient.ts:74](../../src/redis/RedisClient.ts#L74) — change the `ioredis` constructor options for the limiter connection: add `commandTimeout: 100`, `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`. Keep `lazyConnect: true`.
  - Verify the limiter connection is built through a path that can pass these options. May need a dedicated builder for the limiter connection vs the call-context cache connection (separate trust contracts already, per [LimiterRedisClient.ts](../../src/redis/LimiterRedisClient.ts)).
- [src/call/CallLimiter.ts](../../src/call/CallLimiter.ts) — refactor `checkAndIncrement` to return `Effect<LimiterDecision, LimiterBackendError>` per Q4. Add `Effect.timeout(Duration.millis(150))` mapped to `LimiterTimeout` as defense-in-depth (outer safety net beyond ioredis's 100 ms).
- [src/decision/apply/applyRoute.ts:197-208](../../src/decision/apply/applyRoute.ts#L197-L208) — replace the `result === undefined` branch with the `catchTags({RedisError, LimiterTimeout})` pattern; admit with `incrementSucceeded: false`.

**Tests added:**

- T3 `limiter-timeout-fail-open` (fake-clock)
- T4 `limiter-redis-error-fail-open` (fake-clock)

**Exit criteria:** under chaos op `limiter-redis-kill9`, individual INVITE handlers complete in ≤ 200 ms instead of stalling for 10 s.

### Stage 2 — Symmetric admission/release  _(was: original plan Stage 2b)_

**Goal:** every fail-open admission is matched with a skipped DECR — limiter counter cannot drift negative.

**Critical files:**

- [src/call/CallState.ts](../../src/call/CallState.ts) — change `limiterEntries` element shape from `{limiterId, originWindow, limit}` to `{limiterId, originWindow, limit, incrementSucceeded: boolean}`.
- [src/call/CallState.ts:878-889](../../src/call/CallState.ts#L878-L889) — `forcePurge*` decrement loop: skip entries with `incrementSucceeded === false`.
- [src/b2bua/rules/framework/InvariantEnforcer.ts](../../src/b2bua/rules/framework/InvariantEnforcer.ts) — same skip logic on the rule-path decrement.
- [src/call/CallLimiter.ts:63-65](../../src/call/CallLimiter.ts#L63-L65) — optional: add a clamp `MAX(0, ...)` in the Lua DECREMENT script. Defense-in-depth in case a future caller forgets the tag check.

**Tests added:**

- Extend T3/T4 to assert `limiterEntries[0].incrementSucceeded === false` *and* that the terminate path does not call `limiter.decrement` for that entry.
- New regression test: limiter probe inflight ≥ 0 throughout an injected fail-open scenario.

**Exit criteria:** `limiter-probe.ndjson` from a chaos run never shows `inflight < 0`.

### Stage 3 — Per-call queue dispatch  _(new)_

**Goal:** N=1024 concurrent calls in flight on a worker, with per-call FIFO preserved. The single-fiber consumer is replaced by router + per-callRef worker fibers.

**Critical files:**

- [src/sip/SipRouter.ts:1071](../../src/sip/SipRouter.ts#L1071) — replace `Stream.runForEach(stream, handler)` with the router-fiber model. The router drains `eventQueue`, resolves callRef, and either dispatches into an existing `perCallQueues[callRef]` or lazily creates one.
- [src/sip/SipRouter.ts:1086-1102](../../src/sip/SipRouter.ts#L1086-L1102) — the `Effect.timeoutOrElse(eventHandlerTimeoutMs)` wrapper moves *into* the per-call worker loop. Keep it `timeoutOrElse` (non-aborting) so a slow handler doesn't kill the worker, just gets logged. With Stage 1 in place, real handler stalls should be ≤ 200 ms in chaos.
- **New file** `src/sip/PerCallDispatcher.ts` (or similar) — the perCallQueues map + worker loop + POISON handling + partition-tagged gauges.
- [src/call/CallState.ts](../../src/call/CallState.ts) — `delete(callRef)` additionally enqueues POISON into perCallQueues[callRef].
- [src/call/CallState.ts:218,338,460](../../src/call/CallState.ts#L218) — keep the existing semaphore (defense-in-depth for off-pump callers).
- Worker startup: pre-populate perCallQueues from CallStateCache (primary + backup partitions) after `loadOwnedCalls` and bootstrap-pull complete, before SipRouter starts.
- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — add `EVENT_DISPATCH_CONCURRENCY` (default 1024) and `PER_CALL_QUEUE_CAP` (default 200000) env vars.
- [src/observability/MetricsRegistry.ts](../../src/observability/MetricsRegistry.ts) — register the new metrics (table in Q3).
- [src/http/StatusServer.ts](../../src/http/StatusServer.ts) — surface dispatch gauges on `/debug/dispatch`.

**Tests added:**

- T1 `dispatch-invite-then-cancel-same-call` (the user's explicit ask)
- T2 `dispatch-cancel-orphan`
- T5 `dispatch-parallelism-throughput`
- T6 `boot-eager-populates-queues`
- T7 `terminate-removes-perCallQueue`
- T8 `cap-exceeded-drop`
- T9 `cancel-while-invite-in-flight`

**Exit criteria:** T1–T9 green; L1/L2 chaos runs pass within the 2-s SLA.

### Stage 4 — Safety-timer refresh + config validation  _(was: original plan Stage 3, refined)_

**Goal:** the orphan sweep no longer purges dialogs with recent activity (own or peer).

**Critical files:**

- [src/call/timer-helpers.ts:18](../../src/call/timer-helpers.ts#L18) — bump `TERMINATING_TIMEOUT_MS` from 64 000 to **420 000** (7 min).
- [src/call/CallState.ts:479-526](../../src/call/CallState.ts#L479-L526) — extend the auto-arm path to also support **refresh on subsequent updates** while in `terminating`. Mechanism: every `CallState.update` that finds `next.state === "terminating"` and an existing `terminating_timeout` timer entry rewrites its `fireAt` to `now + TERMINATING_TIMEOUT_MS`.
- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — add config-load validator:
  ```
  if (terminatingTimeoutMs <= keepaliveIntervalSec * 1000 + 60_000)
    return Effect.die(`Inconsistent config: TERMINATING_TIMEOUT_MS (${terminatingTimeoutMs}) must exceed keepaliveIntervalSec*1000 + 60000 (${keepaliveIntervalSec*1000 + 60_000}). Bump TERMINATING_TIMEOUT_MS or lower KEEPALIVE_INTERVAL_SEC.`)
  ```
- Existing safety-timer tests that hard-code 64 s must update (mostly cover-through-the-constant).

**Tests added:**

- `orphan-sweep-refreshes-on-peer-activity` (fake-clock): call enters `terminating`; peer 200 OK arrives at +30 s; sweep does not fire at +64 s; sweep fires at +420 s after last activity.
- `config-validation-rejects-inconsistent` (fake-clock): boot with `TERMINATING_TIMEOUT_MS=64000, KEEPALIVE_INTERVAL_SEC=300` → expects defect.

**Exit criteria:** no `Call ... not found on checkout` warning in the 30 s post-recovery window of L1/L2.

### Stage 5 — ADR-0004 + CONTEXT.md update  _(new)_

**Goal:** lock in the design rationale and domain vocabulary.

**Files added/modified:**

- **New**: `docs/adr/0004-per-call-fifo-via-router-and-workers.md` (scope per Q8)
- `CONTEXT.md` — add "Per-call FIFO" and "Event dispatch" entries (Q8)

## Acceptance criteria

The plan is fully landed only when **all** hold:

1. All 9 fake-clock tests (T1–T9) green in `npm run test:fake`.
2. Live reproductions L1, L2, L3 (per Q6) all satisfy:
   - `endurance-short` failure rate ≤ 2 s equivalent across chaos+recovery window
   - `limiter-probe.ndjson` shows `inflight ≥ 0` for every sample
   - No `Call ... not found on checkout` warnings in the 30 s post-recovery window
3. `npm run typecheck` clean — zero errors, **zero Effect plugin warnings**.
4. Config-load validator refuses to start when `TERMINATING_TIMEOUT_MS ≤ keepaliveIntervalSec*1000 + 60000`.
5. ADR-0004 merged; CONTEXT.md glossary additions merged.
6. New gauges (`dispatch_queues{partition}`, `dispatch_in_flight`, `dispatch_saturation_total`, `dispatch_worker_cap_drops`) visible in the b2bua-worker-internals Grafana dashboard.

## Verification (how to test end-to-end)

```bash
# Inner-loop typecheck + fake-clock suite
npm run typecheck
npm run test:fake

# Targeted runs of the new tests
npm run test -- --run tests/sip/dispatch-invite-cancel-fifo.test.ts
npm run test -- --run tests/sip/cancel-while-invite-in-flight.test.ts
npm run test -- --run tests/sip/dispatch-parallelism-throughput.test.ts
npm run test -- --run tests/limiter/limiter-timeout-fail-open.test.ts

# Live cascade reproduction (kind/k8s)
npm run test:k8s:chaos -- --type limiter-redis-kill9
npm run test:k8s:chaos -- --type worker-cut-from-limiter-redis-hard

# Long-form endurance gate (the 2026-05-15 baseline)
npm run test:k8s:endurance -- --duration 30m --caps 40
```

After the run, inspect the run dir under `test-results/k8s-endurance/`:

- `limiter-probe.ndjson` — assert `inflight >= 0` throughout.
- `b2bua-worker-0.proc.ndjson` — VmRSS should NOT show the 216→142 MB drop observed in the original incident (calls are not being shed any more).
- `metrics/b2bua-worker-0.metrics.ndjson` — `dispatch_in_flight` peaks during chaos but bounded under 1024; `dispatch_saturation_total` ideally 0 (or low); `dispatch_worker_cap_drops` zero.

## Out of scope

- Production-grade Redis HA for the limiter (sentinel / cluster) — Stage 4 of the original plan.
- Call-context sidecar Redis topology — different concern.
- Future enhancement: CANCEL interrupting in-flight INVITE handler (Q3 sub-question 4).

