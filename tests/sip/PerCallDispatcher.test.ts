/**
 * PerCallDispatcher — unit tests (ADR-0004).
 *
 * Targets the dispatcher service in isolation, exercising it with
 * `perCallQueueDepth > 0` (the production mode — the fake-clock
 * harness uses the passthrough mode via the `config-defaults.ts`
 * default of 0; this file flips it back to verify the real
 * implementation).
 *
 * Uses `it.live` (real wall clock) because the worker fiber parks on
 * `Queue.take`, which is invisible to the `pumpAll` quiescence
 * detector — TestClock-driven tests would race ahead of the dequeue.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Queue, Ref } from "effect"
import { PerCallDispatcher, primaryPartition } from "../../src/sip/PerCallDispatcher.js"
import { AppConfig } from "../../src/config/AppConfig.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

const buildLayer = (overrides: { perCallQueueDepth: number; perCallQueueCap?: number; eventDispatchConcurrency?: number }) => {
  const config = testAppConfigDefaults({
    perCallQueueDepth: overrides.perCallQueueDepth,
    ...(overrides.perCallQueueCap !== undefined ? { perCallQueueCap: overrides.perCallQueueCap } : {}),
    ...(overrides.eventDispatchConcurrency !== undefined
      ? { eventDispatchConcurrency: overrides.eventDispatchConcurrency }
      : {}),
  })
  const ConfigLayer = Layer.succeed(AppConfig, config)
  return PerCallDispatcher.layer.pipe(
    Layer.provide(ConfigLayer),
    Layer.provide(MetricsRegistry.layer),
  )
}

// Real-clock sleep helper — we run under `it.live` so `Effect.sleep`
// is real wall clock. 10 ms is enough for parked workers to wake on
// every machine I've tested without inflating the suite duration.
const wait = (ms: number) => Effect.sleep(`${ms} millis`)

describe("PerCallDispatcher", () => {
  describe("dispatcher mode (perCallQueueDepth > 0)", () => {
    it.live(
      "T1: dispatches lazy-create a per-call queue + worker (hasQueue flips true)",
      () =>
        Effect.gen(function* () {
          const dispatcher = yield* PerCallDispatcher
          const ran = yield* Ref.make<Array<string>>([])
          yield* dispatcher.dispatch(
            "callA",
            Ref.update(ran, (xs) => [...xs, "A"]),
          )
          yield* wait(20)
          expect(yield* Ref.get(ran)).toEqual(["A"])
          expect(dispatcher.hasQueue("callA")).toBe(true)
          const stats = dispatcher.statsSync()
          expect(stats.queueCount).toBe(1)
          expect(stats.queueCountPrimary).toBe(1)
          expect(stats.creationsLazy).toBe(1)
        }).pipe(Effect.provide(buildLayer({ perCallQueueDepth: 64 }))),
    )

    it.live(
      "T1: per-call FIFO — three events for one callRef run in submit order",
      () =>
        Effect.gen(function* () {
          const dispatcher = yield* PerCallDispatcher
          const ran = yield* Ref.make<Array<string>>([])
          const slow = (label: string) =>
            wait(15).pipe(Effect.andThen(Ref.update(ran, (xs) => [...xs, label])))
          yield* dispatcher.dispatch("callA", slow("1"))
          yield* dispatcher.dispatch("callA", slow("2"))
          yield* dispatcher.dispatch("callA", slow("3"))
          // Three sequential 15ms events → ~45ms total; wait 100ms for headroom.
          yield* wait(100)
          expect(yield* Ref.get(ran)).toEqual(["1", "2", "3"])
        }).pipe(Effect.provide(buildLayer({ perCallQueueDepth: 64 }))),
    )

    it.live(
      "T5: distinct callRefs run in parallel — N×T_work ≈ T_work, not N×T_work",
      () =>
        Effect.gen(function* () {
          const dispatcher = yield* PerCallDispatcher
          const counter = yield* Ref.make(0)
          // 4 calls × 30ms each. Serial would be ~120ms; parallel ≈ 30ms.
          const slow = wait(30).pipe(Effect.andThen(Ref.update(counter, (n) => n + 1)))
          const start = Date.now()
          yield* dispatcher.dispatch("call1", slow)
          yield* dispatcher.dispatch("call2", slow)
          yield* dispatcher.dispatch("call3", slow)
          yield* dispatcher.dispatch("call4", slow)
          yield* wait(80)
          const elapsed = Date.now() - start
          expect(yield* Ref.get(counter)).toBe(4)
          // Headroom: scheduler jitter on a busy CI box can add 20-30ms.
          // The serial baseline (120ms) is well clear of this band, so any
          // value < 100ms confirms parallel execution.
          expect(elapsed).toBeLessThan(100)
        }).pipe(Effect.provide(buildLayer({ perCallQueueDepth: 64 }))),
    )

    it.live(
      "T7: enqueuePoison drains the worker and removes the perCallQueues entry",
      () =>
        Effect.gen(function* () {
          const dispatcher = yield* PerCallDispatcher
          yield* dispatcher.dispatch("callA", Effect.void)
          yield* wait(20)
          expect(dispatcher.hasQueue("callA")).toBe(true)
          yield* dispatcher.enqueuePoison("callA")
          yield* wait(20)
          expect(dispatcher.hasQueue("callA")).toBe(false)
          const stats = dispatcher.statsSync()
          expect(stats.queueCount).toBe(0)
          expect(stats.removalsTerminate).toBe(1)
        }).pipe(Effect.provide(buildLayer({ perCallQueueDepth: 64 }))),
    )

    it.live(
      "T7: enqueuePoison for a non-existent callRef is a no-op",
      () =>
        Effect.gen(function* () {
          const dispatcher = yield* PerCallDispatcher
          yield* dispatcher.enqueuePoison("never-existed")
          yield* wait(10)
          const stats = dispatcher.statsSync()
          expect(stats.queueCount).toBe(0)
          expect(stats.removalsTerminate).toBe(0)
        }).pipe(Effect.provide(buildLayer({ perCallQueueDepth: 64 }))),
    )

    it.live(
      "T8: perCallQueueCap blocks lazy creation past the cap, increments capDropsTotal",
      () =>
        Effect.gen(function* () {
          const dispatcher = yield* PerCallDispatcher
          // Cap = 2. Dispatch slow events to two callRefs first to fill
          // the map, then the third dispatch must be dropped.
          const block = yield* Queue.bounded<void>(1)
          const blocking = Queue.take(block)
          yield* dispatcher.dispatch("call1", blocking)
          yield* dispatcher.dispatch("call2", blocking)
          yield* wait(20)
          const before = dispatcher.statsSync()
          expect(before.queueCount).toBe(2)
          expect(before.capDropsTotal).toBe(0)
          yield* dispatcher.dispatch("call3", Effect.void)
          yield* wait(20)
          const after = dispatcher.statsSync()
          expect(after.queueCount).toBe(2)
          expect(after.capDropsTotal).toBe(1)
          expect(dispatcher.hasQueue("call3")).toBe(false)
          // Unblock the held workers so the layer scope can close cleanly.
          yield* Queue.offer(block, undefined)
          yield* Queue.offer(block, undefined)
        }).pipe(Effect.provide(buildLayer({ perCallQueueDepth: 64, perCallQueueCap: 2 }))),
    )

    it.live(
      "preCreate eagerly creates the worker queue; subsequent dispatch reuses it",
      () =>
        Effect.gen(function* () {
          const dispatcher = yield* PerCallDispatcher
          yield* dispatcher.preCreate("eager", primaryPartition, "boot")
          yield* wait(10)
          expect(dispatcher.hasQueue("eager")).toBe(true)
          const beforeStats = dispatcher.statsSync()
          expect(beforeStats.creationsBoot).toBe(1)
          expect(beforeStats.creationsLazy).toBe(0)
          const ran = yield* Ref.make(0)
          yield* dispatcher.dispatch("eager", Ref.update(ran, (n) => n + 1))
          yield* wait(20)
          expect(yield* Ref.get(ran)).toBe(1)
          const afterStats = dispatcher.statsSync()
          // No NEW lazy create — preCreate already placed the queue.
          expect(afterStats.creationsLazy).toBe(0)
        }).pipe(Effect.provide(buildLayer({ perCallQueueDepth: 64 }))),
    )
  })
})
