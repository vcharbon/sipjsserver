# 0005 — Per-call FIFO via router + per-call worker fibers

**Status:** accepted (2026-05-16)

## Context

The pre-Stage-3 worker had **one** event-dispatch fiber. `SipRouter.start` consumed `txnLayer.events` with `Stream.runForEach`, so every event for every call shared that fiber. The 2026-05-15 endurance run showed a ~73 s limiter-Redis loss cascade into ~110 s of worker service loss — orders of magnitude over the 1–2 s chaos SLA. Three of the contributing causes had structural fixes (ADR-0004 — bounded limiter I/O + typed channels + symmetric INCR/DECR). The fourth and dominant cause was the single-fiber consumer itself: **one stalled handler stalled every other call's events behind it**, the eventQueue filled to capacity (400), drops kicked in, the worker effectively died until the slow handler finally completed.

The 10-s `Effect.timeoutOrElse` wrapping each handler was non-aborting — it logged and continued but did not interrupt the underlying fiber, so even after the timer fired the stuck fiber kept holding the dispatch slot until the underlying ioredis command surfaced its error.

ADR-0003's must-run categorisation already pinned **what** can run uninterruptibly. This ADR pins **who** runs each event — and structurally prevents one call's slowness from contaminating another.

## Decision: router + per-call queue + worker fiber

The single `Stream.runForEach` fiber is replaced by a three-tier dispatch pipeline:

```
              ┌──────────────┐         ┌──────────────────┐         ┌────────────┐
              │ Transaction  │         │   SipRouter      │         │ per-call   │
UDP packet → │ Layer        │ event → │   router fiber   │ event → │ worker(R₁) │
              │ (single      │ queue   │   (single fiber, │ per-    │            │
              │  fiber)      │         │    drains q,     │ callRef │            │
              └──────────────┘         │    routes by R)  │ queue   │            │
                                       └──────────────────┘         └────────────┘
                                                                     ┌────────────┐
                                                            ... →    │ worker(R₂) │
                                                                     └────────────┘
                                                                          ...
```

`R` is the callRef. Each active call has its **own** `Queue.bounded`, its **own** worker fiber, and its events run end-to-end on that fiber in strict FIFO order. A slow handler on call X stalls only call X.

### The two FIFO invariants

For each callRef `R`, the chain preserves UDP-arrival order through to handler execution:

1. **UDP-arrival order → `eventQueue` order.** The `TransactionLayer` ingest is single-fiber; events emit in the order packets arrived.
2. **`eventQueue` order → `perCallQueue[R]` order.** The `SipRouter` router fiber is single-fiber; for each event it derives `R` synchronously and offers to `perCallQueue[R]` in dequeue order.

Composition: **for any callRef, the worker fiber sees events in strict UDP-arrival order, and never overlapping** (one worker fiber, processes serially). This is the strongest per-call FIFO that the SIP layer is able to provide.

### Synchronous callRef resolution

The router MUST NOT block — a blocking resolve would re-create the single-fiber stall this design eliminates. Routing-key derivation rules (`SipRouter.ts:routeKey`):

| Event type | Source of callRef |
|---|---|
| `timer` / `timeout` / `internal-event` | carried on the event |
| SIP request, initial INVITE (no To-tag) | `deriveCallRef(selfOrdinal, callId, fromTag)` — pure JS |
| SIP request with `callref` URI param | the param value |
| SIP response with via `cr` param | the param value |
| SIP request/response fallback | `CallState.resolveFromSipKeySync(callId, fromTag)` — in-memory `sipIndex` only |
| SIP OPTIONS keepalive (out-of-dialog) | `undefined` — run inline on router |
| Unresolved | `undefined` — run inline on router |

Unresolved events run **inline on the router fiber** (rare path: OPTIONS keepalives, 481 responses). They are fast — short-lived synchronous responses — so they don't recreate the contamination problem.

The fallback in `resolveFromSipKeySync` is **memory-only** (a new sync method on `CallState`). A Redis lookup would be a router stall. Misses fall through to the inline path; `withCall` then performs the slower Redis-fallback resolve inside the worker (or, more often, returns 481 because the call is genuinely gone).

## Decision: eager pre-population at boot (Alt B)

Two designs were on the table:

- **Alt A** — lazy-only: queues and workers are created on first event for a callRef.
- **Alt B** — eager pre-population: at boot, every call returned by `loadOwnedCalls` and every call in the backup partition gets a queue + worker created up-front; lazy create remains the path for genuinely fresh INVITEs.

**Alt B chosen.** Three reasons:

1. **The cleanup path is exercised on every call.** Even calls that never see an event (boot-rehydrated, never touched again) follow the same `CallState.remove → POISON → worker drains → map entry removed` flow as a live call. Strong validation in production — there is no "rare cleanup path" that only fires for never-touched calls.
2. **No queue-creation surge during failover.** When primary A dies and B serves ~50K calls from its backup partition, all 50K perCallQueues already exist on B (pre-created at boot from `bak:A:call:*`). Cutover handles only the traffic surge, not the additional concurrent-fork load of building 50K queues at once.
3. **Boot cost is bounded and amortised.** ~50K fibers × ~2 KB ≈ 100 MB, paid once at startup. Acceptable on a worker with multi-GB heap; far cheaper than a synchronised burst at cutover.

The lazy path stays in place for new INVITEs that arrive before any rehydration has indexed them. The two paths converge on the same `tryCreateLocked` primitive — cap check, allocate `Queue.bounded`, fork `workerLoop` into `layerScope`, mark partition for metrics.

## Decision: POISON for symmetric cleanup

Every `CallState.remove` (and `forcePurgeOne` for force-purge / orphan sweep) enqueues a `POISON` sentinel into the call's queue. The worker fiber's loop:

```ts
while (true) {
  const item = yield* Queue.take(state.queue)
  if (item._tag === "poison") {
    while (Queue.takeUnsafe(state.queue) !== undefined) { /* drain */ }
    MutableHashMap.remove(perCallQueues, callRef)
    return
  }
  // ... run body ...
}
```

The worker drains any residual items (safe — post-POISON the call is dead, the residuals would 481 at `withCall` checkout anyway), removes its own map entry from `perCallQueues`, and exits. The fiber dies; the layer scope no longer holds a reference; GC takes the queue.

Why POISON via the queue and not `Fiber.interrupt`?

- POISON preserves the order of operations: every event offered **before** the terminate must run **before** POISON. Interrupt would race against in-flight body execution and could leave half-applied effects.
- It naturally folds into the existing FIFO invariant — the worker reads its termination signal from the same queue as everything else.
- It is uninterruptible-safe by construction: `Queue.offerUnsafe` is a sync JS operation, fine inside the `uninterruptibleMask` around `applyCritical` (ADR-0003).

`CallState.remove` resolves the dispatcher via `Effect.serviceOption(PerCallDispatcher)` at call time, not layer-build time, because some test fixtures (HTTP-only call fixtures) build CallState without the dispatcher in scope. When the service is absent the POISON enqueue is a no-op.

## Decision: hard caps + global concurrency

| Knob | Default | Bound |
|---|---|---|
| `EVENT_DISPATCH_CONCURRENCY` | 1024 | Global cap on simultaneously-running handler bodies. Workers park on a Semaphore when at the cap. Per-call FIFO is preserved (each call's worker still serialises; parking only delays the *next* event for the parked worker's call). |
| `PER_CALL_QUEUE_CAP` | 200 000 | Hard cap on the size of `perCallQueues`. Past this, the router refuses to lazy-create new queues and increments `b2bua_dispatch_worker_cap_drops_total` instead. |
| `PER_CALL_QUEUE_DEPTH` | 64 | Per-call queue bounded capacity. A healthy call has 0–1 events queued; anything more is a stuck handler or a flooding peer. Drops at this layer count via `b2bua_dispatch_queue_drops_total`. |

Worst-case heap at the 200K cap: ~400 MB (200K × ~2 KB fiber stack + queue overhead). Operator-visible: any non-zero `cap_drops_total` is alert-worthy — the system is past its design envelope.

## Decision: which fibers stay single-fiber

The parallel tier is the per-call worker. **Every other tier stays single-fiber** because each enforces a load-bearing ordering invariant:

| Fiber | Single-fiber? | Why |
|---|---|---|
| `TransactionLayer` UDP receiver | yes | SIP transaction match by `(callId, fromTag)` requires an ordered view; produces `eventQueue` in UDP-arrival order |
| `SipRouter` router fiber | yes | O(1) per-event work; preserves `eventQueue` dequeue order into perCallQueue order |
| Replication pull per peer | yes (1 per peer) | watermark ordering; unchanged |
| Orphan sweep / periodic flush | yes | off-pump; serialises on `CallState.withCall` semaphore |
| `BufferedCdrLayer` drainer | yes | ADR-0003 buffered IO contract |
| `BufferedTerminateWriter` drainer | unchanged pool size | ADR-0003 buffered IO pool |
| Metrics scanner | yes | read-only |
| **Per-call worker (new)** | **1 per active callRef** | only this tier is parallel |

## Relationship to ADR-0003 (must-run effects)

ADR-0003 wraps each effect category with its safe primitive. The per-call worker is the natural site for ADR-0003's slot interpreter — the body the worker runs IS `withCall(handlers, event)`, which runs `processResult`, which applies critical / outbound / soft / buffered / forks in fixed order. The two ADRs compose:

- ADR-0003 says: each slot must be uninterruptibly-safe (sync JS or non-blocking submit).
- ADR-0005 says: the slot interpreter runs on a fiber dedicated to one callRef, not on a fiber shared across all calls.

The per-call semaphore in `CallState.withCall` (Semaphore.withPermits(1) per callRef) is retained as **defense-in-depth** for off-pump callers (orphan sweep, periodic flush). On the on-pump path it is now structurally redundant — the worker fiber is the only writer.

## Test-time pacing

The dispatcher's worker fiber is parked on `Queue.take` when idle, which is **invisible** to the fake-clock harness's quiescence detector (pending-sleeps + simulated-network-in-flight). To prevent the test fiber from racing ahead of a worker's body execution under `TestClock`, the dispatcher reports submitted/completed work via the optional `TestPace` service ([src/observability/TestPace.ts](../../src/observability/TestPace.ts)).

The full mechanism — including why the obvious fixes (yieldNow, Deferred handshake, sleep(1ms)) don't work — is documented in [docs/typescript-effect.md](../typescript-effect.md) under "TestClock + scheduler-invisible async work". This ADR's mention is only to record that the dispatcher participates in that contract.

## The rule (operator-facing)

> All SIP events for a given `callRef` are processed in strict UDP-arrival order and never overlap. The invariant is enforced structurally by the router → perCallQueue → worker-fiber chain — not by reviewer discipline. Any new code path that produces an event for an existing call MUST go through `dispatcher.dispatch(callRef, body)` — never run handler logic on the router fiber. Any new code path that creates a queue (eager or lazy) MUST respect the 200 K cap. Any new code path that terminates a call MUST enqueue POISON via `CallState.remove`; do not delete the perCallQueues entry directly.

## References

- [src/sip/PerCallDispatcher.ts](../../src/sip/PerCallDispatcher.ts) — implementation
- [src/sip/SipRouter.ts](../../src/sip/SipRouter.ts) — `routeKey` (sync resolve) + `start` loop wiring
- [src/call/CallState.ts](../../src/call/CallState.ts) — `resolveFromSipKeySync`, POISON enqueue on `remove` / `forcePurgeOne`
- [src/b2bua/B2buaCore.ts](../../src/b2bua/B2buaCore.ts) — layer composition
- [src/observability/TestPace.ts](../../src/observability/TestPace.ts) — test-time pacing service
- [tests/sip/PerCallDispatcher.test.ts](../../tests/sip/PerCallDispatcher.test.ts) — unit tests (T1 FIFO, T5 parallelism, T7 POISON, T8 cap, preCreate)
- Plan: [docs/plan/to-review-and-properly-swift-moler.md](../plan/to-review-and-properly-swift-moler.md) — design questions Q3 (Alt B), Q5 (single-fiber set), Q6 (test design)
- Related: [ADR-0003 — Must-run effects under interruption](./0003-must-run-effects-under-interruption.md), [ADR-0004 — Strong INCR/DECR invariant](./0004-strong-incr-decr-invariant-for-call-limiter.md)
