/**
 * PerCallDispatcher — per-callRef event-handler fibers (ADR-0004).
 *
 * Replaces the single-fiber `Stream.runForEach` consumer in SipRouter
 * with a router→per-call-queue→worker-fiber pipeline so a slow handler
 * on call X cannot stall handlers for calls Y, Z, …
 *
 * Two FIFO invariants (see ADR-0004):
 *   1. UDP arrival → `eventQueue` order (TransactionLayer single-fiber).
 *   2. `eventQueue` → `perCallQueue` order (SipRouter single-fiber).
 *
 * Together they give the strongest possible per-call FIFO: events for
 * the same callRef are processed in strict UDP-arrival order and never
 * overlap.
 *
 * Lifecycle:
 *   - Workers are forked into `layerScope`, so they die when the layer
 *     scope closes (worker shutdown).
 *   - `enqueuePoison(callRef)` (called from `CallState.remove`) drains
 *     and exits the worker; the worker removes its own map entry.
 *   - `preCreate(callRef, partition)` is the boot-time eager
 *     pre-population path: every call rehydrated from
 *     `loadOwnedCalls` gets a queue + worker up-front so the cleanup
 *     path is exercised continuously, and so a failover cutover does
 *     not have to fork ~50 K queues at once.
 *
 * Capacity:
 *   - Global concurrency cap (`eventDispatchConcurrency`, default 1024):
 *     a Semaphore caps how many worker fibers can actually be running
 *     a handler at the same time. The other workers park on `take` or
 *     on the permit acquire — cheap.
 *   - Per-call queue depth (`perCallQueueDepth`, default 64): a healthy
 *     call has at most 0-1 events queued; anything more is a stuck
 *     handler or a flooding peer, and we drop newest with a counter.
 *   - Per-call queue cap (`perCallQueueCap`, default 200K): bounds
 *     total fiber + queue memory at ~400 MB worst case. Lazy create
 *     past this cap drops the offered event with a counter.
 */

import { Effect, Layer, MutableHashMap, Option, Queue, Semaphore, ServiceMap } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import { MetricsRegistry, type DispatchMetrics } from "../observability/MetricsRegistry.js"
import { TestPace } from "../observability/TestPace.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Which partition this call belongs to, for partition-tagged metrics.
 * - `primary`: this worker is the call's natural primary.
 * - `backup`: this worker holds the call as backup for `peer` (the
 *   original primary's ordinal).
 */
export type Partition =
  | { readonly kind: "primary" }
  | { readonly kind: "backup"; readonly peer: string }

export const primaryPartition: Partition = { kind: "primary" }
export const backupPartition = (peer: string): Partition => ({ kind: "backup", peer })

/** Reason supplied at queue creation, for metric labelling. */
export type CreationReason = "boot" | "lazy" | "failover"

// ---------------------------------------------------------------------------
// Internal types (not exported)
// ---------------------------------------------------------------------------

type DispatchItem =
  | { readonly _tag: "event"; readonly run: Effect.Effect<void, never, never> }
  | { readonly _tag: "poison" }

interface PerCallQueueState {
  readonly queue: Queue.Queue<DispatchItem>
  readonly partition: Partition
}

// ---------------------------------------------------------------------------
// Snapshot type for /debug/dispatch + tests
// ---------------------------------------------------------------------------

export interface DispatchStatsSnapshot {
  readonly queueCount: number
  readonly queueCountPrimary: number
  readonly queueCountBackup: number
  readonly inFlightPrimary: number
  readonly inFlightBackup: number
  readonly creationsBoot: number
  readonly creationsLazy: number
  readonly creationsFailover: number
  readonly removalsTerminate: number
  readonly removalsReaper: number
  readonly capDropsTotal: number
  readonly queueDropsTotal: number
  readonly saturationTotal: number
  readonly concurrencyCap: number
  readonly queueCap: number
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PerCallDispatcher extends ServiceMap.Service<
  PerCallDispatcher,
  {
    /**
     * Best-effort enqueue of `body` into `callRef`'s per-call queue.
     * Returns immediately. The body is type-erased internally; the
     * caller is responsible for providing all required services when
     * building it (typically by constructing it inside an `Effect.gen`
     * that already has them in scope).
     *
     * If no queue exists for `callRef`, this lazy-creates it (subject
     * to `perCallQueueCap`). A queue already at `perCallQueueDepth`
     * drops the event and increments `dispatch_queue_drops_total`.
     *
     * `partition` defaults to `primary` — backup-partition lazy creates
     * surface via the failover/replication path, which calls `preCreate`
     * explicitly so the partition label is correct on the gauge.
     */
    readonly dispatch: <R>(
      callRef: string,
      body: Effect.Effect<void, never, R>
    ) => Effect.Effect<void, never, R>

    /**
     * Eagerly create the queue + worker for `callRef` if not already
     * present. Used by:
     *   - Boot pre-population (Alt B in plan Q3): every call rehydrated
     *     from `loadOwnedCalls` gets a queue, so the cleanup path runs
     *     even for calls that never see an event.
     *   - Failover: the new owner pre-creates queues for promoted calls
     *     so cutover handles only the traffic surge, not the additional
     *     fork load.
     *
     * Capacity-checked the same way as lazy create; over-cap is a
     * `capDropsTotal++` no-op.
     */
    readonly preCreate: (
      callRef: string,
      partition: Partition,
      reason: CreationReason
    ) => Effect.Effect<void>

    /**
     * Signal the worker for `callRef` to drain and exit. The worker
     * removes its own map entry once it has drained. Called from
     * `CallState.remove` (and any other terminate path that wants
     * symmetric cleanup).
     *
     * No-op if there is no queue for `callRef` — the call may have been
     * created and terminated before any event ever arrived (in which
     * case there was no lazy/eager create), or the cleanup ran already.
     */
    readonly enqueuePoison: (callRef: string) => Effect.Effect<void>

    /** Synchronous snapshot for /debug/dispatch + tests. */
    readonly statsSync: () => DispatchStatsSnapshot

    /**
     * Test/diagnostic only: whether a queue currently exists for the
     * given callRef.
     */
    readonly hasQueue: (callRef: string) => boolean
  }
>()("@sipjsserver/PerCallDispatcher") {
  static readonly layer = Layer.effect(
    PerCallDispatcher,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const registry = yield* MetricsRegistry
      const layerScope = yield* Effect.scope
      // Optional async-work registry — present only under the fake-clock
      // test harness via PumpableClock. Production builds resolve None;
      // the begin/end hooks are no-ops at runtime.
      const testPaceOpt = yield* Effect.serviceOption(TestPace)
      const paceBegin = (): void => {
        if (testPaceOpt._tag === "Some") testPaceOpt.value.beginWork()
      }
      const paceEnd = (): void => {
        if (testPaceOpt._tag === "Some") testPaceOpt.value.endWork()
      }

      const perCallQueues = MutableHashMap.empty<string, PerCallQueueState>()

      // Global concurrency cap: how many handlers can run at once
      // across all workers. Workers park on the permit when the cap is
      // hit, so per-call FIFO is preserved — events behind a parked
      // worker still wait their turn in their own queue.
      const dispatchSlots = yield* Semaphore.make(config.eventDispatchConcurrency)

      // Counters / gauges — plain JS so the metrics scrape and
      // statsSync are both O(1).
      let queueCountPrimary = 0
      let queueCountBackup = 0
      let inFlightPrimary = 0
      let inFlightBackup = 0
      let creationsBoot = 0
      let creationsLazy = 0
      let creationsFailover = 0
      let removalsTerminate = 0
      const removalsReaper = 0
      let capDropsTotal = 0
      let queueDropsTotal = 0
      let saturationTotal = 0

      const metrics: DispatchMetrics = {
        queueCounts: () => ({ primary: queueCountPrimary, backup: queueCountBackup }),
        creationsTotal: () => ({
          boot: creationsBoot,
          lazy: creationsLazy,
          failover: creationsFailover,
        }),
        removalsTotal: () => ({
          terminate: removalsTerminate,
          reaper: removalsReaper,
        }),
        capDropsTotal: () => capDropsTotal,
        queueDropsTotal: () => queueDropsTotal,
        inFlight: () => ({ primary: inFlightPrimary, backup: inFlightBackup }),
        saturationTotal: () => saturationTotal,
        concurrencyCap: config.eventDispatchConcurrency,
        queueCap: config.perCallQueueCap,
      }
      registry.dispatch = metrics

      const partitionIsPrimary = (p: Partition): boolean => p.kind === "primary"

      // Bump partition-tagged gauges when a queue is created/removed.
      const onCreate = (partition: Partition): void => {
        if (partitionIsPrimary(partition)) queueCountPrimary++
        else queueCountBackup++
      }
      const onRemove = (partition: Partition): void => {
        if (partitionIsPrimary(partition)) queueCountPrimary--
        else queueCountBackup--
      }

      /**
       * Worker fiber body. Runs a strict FIFO loop on `state.queue`
       * until it sees POISON, then drains residual items (no-ops on a
       * deleted call), removes its own map entry, and exits.
       *
       * Handler bodies are guarded by `dispatchSlots.withPermits(1)` so
       * total in-flight handlers never exceed `eventDispatchConcurrency`.
       * `Effect.exit` swallows any failure/defect into a logged error —
       * the dispatch loop is the last line of defence; one broken
       * handler must not kill the worker for the rest of the call's
       * events.
       */
      const workerLoop = (callRef: string, state: PerCallQueueState): Effect.Effect<void> =>
        Effect.gen(function* () {
          while (true) {
            const item = yield* Queue.take(state.queue)
            if (item._tag === "poison") {
              // Drain residual events. Post-POISON, the call is dead;
              // any leftover events are stale and harmless (their
              // `withCall` checkout would find no call and 481).
              // `takeUnsafe` returns `undefined` when the queue is
              // empty, so the loop terminates naturally.
              while (Queue.takeUnsafe(state.queue) !== undefined) {
                // discard
              }
              yield* Effect.sync(() => {
                MutableHashMap.remove(perCallQueues, callRef)
                onRemove(state.partition)
                removalsTerminate++
              })
              return
            }

            // Saturation proxy: increment if all permits are already
            // taken, meaning this worker is about to park on permit
            // acquire. Not perfectly accurate under high concurrency
            // (multiple workers can race past the check before any of
            // them is queued), but enough as an alerting signal.
            if (inFlightPrimary + inFlightBackup >= config.eventDispatchConcurrency) {
              saturationTotal++
            }

            yield* dispatchSlots.withPermits(1)(
              Effect.gen(function* () {
                if (partitionIsPrimary(state.partition)) inFlightPrimary++
                else inFlightBackup++
                const exit = yield* Effect.exit(item.run)
                if (partitionIsPrimary(state.partition)) inFlightPrimary--
                else inFlightBackup--
                if (exit._tag === "Failure") {
                  // The body is typed as `never` errors but defects /
                  // interrupts can still surface here. Log + continue —
                  // the worker survives so the rest of the call's
                  // events still get handled.
                  yield* Effect.logError(
                    `PerCallDispatcher: handler for ${callRef} failed`,
                    exit.cause,
                  )
                }
              }),
            )
            // Test-only handshake (see DispatchItem doc + AppConfig
            // `dispatchTestSync`). Signal AFTER the body completes so
            // the awaiting dispatcher sees "this event has been fully
            // processed" — required because the symptom we are fighting
            // is the test fiber blasting through assertions before the
            // body's effects (e.g. limiter DECR) have run. Production
            // never sets `dequeueConfirmed`, so the dispatch chain is
            // pure offer-and-forget.
            paceEnd()
          }
        })

      /**
       * Try to create a new queue + worker for `callRef`. Returns
       * `true` if created, `false` if rejected (already exists, or cap
       * exceeded). Capacity check uses `MutableHashMap.size` which is
       * O(1) — safe to call inline.
       */
      const tryCreateLocked = (
        callRef: string,
        partition: Partition,
        reason: CreationReason,
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const existing = MutableHashMap.get(perCallQueues, callRef)
          if (Option.isSome(existing)) return false
          if (MutableHashMap.size(perCallQueues) >= config.perCallQueueCap) {
            capDropsTotal++
            return false
          }
          const queue = yield* Queue.bounded<DispatchItem>(config.perCallQueueDepth)
          const state: PerCallQueueState = { queue, partition }
          yield* Effect.sync(() => {
            MutableHashMap.set(perCallQueues, callRef, state)
            onCreate(partition)
            switch (reason) {
              case "boot":
                creationsBoot++
                break
              case "lazy":
                creationsLazy++
                break
              case "failover":
                creationsFailover++
                break
            }
          })
          // Fork from layerScope so the worker fiber dies on layer
          // teardown. `forkIn` inherits the call-site fiber's
          // ServiceMap, so the body the worker runs has access to the
          // same services SipRouter does.
          yield* Effect.forkIn(workerLoop(callRef, state), layerScope)
          return true
        })

      const dispatch = <R>(
        callRef: string,
        body: Effect.Effect<void, never, R>,
      ): Effect.Effect<void, never, R> =>
        Effect.gen(function* () {
          let stateOpt = MutableHashMap.get(perCallQueues, callRef)
          if (Option.isNone(stateOpt)) {
            const created = yield* tryCreateLocked(callRef, primaryPartition, "lazy")
            if (!created) {
              // Cap-exceeded: drop. Already counted in tryCreateLocked.
              return
            }
            stateOpt = MutableHashMap.get(perCallQueues, callRef)
          }
          // stateOpt is now Some — we either found or just created the
          // entry. A racing remove cannot have run yet because the
          // router is the single producer.
          if (Option.isNone(stateOpt)) return
          const state = stateOpt.value
          // Body's R-channel is fully provided by the caller's gen
          // context; the worker fiber inherits services from the same
          // ServiceMap via forkIn. Erasure here is the standard
          // boundary trick — the runtime instance carries the services
          // even though the static type forgets them.
          const erased = body as unknown as Effect.Effect<void, never, never>
          const accepted = Queue.offerUnsafe(state.queue, { _tag: "event", run: erased })
          if (!accepted) {
            queueDropsTotal++
            yield* Effect.logWarning(
              `PerCallDispatcher: queue full for ${callRef} (cap=${config.perCallQueueDepth}) — dropping event`,
            )
            return
          }
          // Register this offered item with the optional TestPace
          // registry (see import). Under fake-clock test harness the
          // registry's counter is consulted by `PumpableClock.adjust`
          // to keep yielding until the worker has run the body —
          // closes the "worker parked on Queue.take is invisible to
          // pendingSleeps" gap. Production: no-op.
          paceBegin()
          yield* Effect.yieldNow
        })

      const preCreate = (
        callRef: string,
        partition: Partition,
        reason: CreationReason,
      ): Effect.Effect<void> =>
        Effect.asVoid(tryCreateLocked(callRef, partition, reason))

      const enqueuePoison = (callRef: string): Effect.Effect<void> =>
        Effect.sync(() => {
          const opt = MutableHashMap.get(perCallQueues, callRef)
          if (Option.isNone(opt)) return
          // POISON is offered without checking the result. The queue
          // is bounded and could in principle be full; but POISON is
          // always the last event we ever send for this callRef, so a
          // full queue means the worker is severely behind. The
          // POISON's job is "drain and exit"; if we drop it, the
          // worker keeps running until the layer scope closes (still
          // safe — the worker is part of the layer's scope) but its
          // entry won't be GCed. Force-offer would unbound the queue;
          // we accept the rare leak and log instead.
          const accepted = Queue.offerUnsafe(opt.value.queue, { _tag: "poison" })
          if (!accepted) {
            queueDropsTotal++
            // No catchable Effect channel here — sync-only path. Log
            // via console fallback would be noisy; the metric is
            // sufficient for alerting.
          }
        })

      const statsSync = (): DispatchStatsSnapshot => ({
        queueCount: MutableHashMap.size(perCallQueues),
        queueCountPrimary,
        queueCountBackup,
        inFlightPrimary,
        inFlightBackup,
        creationsBoot,
        creationsLazy,
        creationsFailover,
        removalsTerminate,
        removalsReaper,
        capDropsTotal,
        queueDropsTotal,
        saturationTotal,
        concurrencyCap: config.eventDispatchConcurrency,
        queueCap: config.perCallQueueCap,
      })

      const hasQueue = (callRef: string): boolean =>
        Option.isSome(MutableHashMap.get(perCallQueues, callRef))

      return PerCallDispatcher.of({
        dispatch,
        preCreate,
        enqueuePoison,
        statsSync,
        hasQueue,
      })
    }),
  )
}
