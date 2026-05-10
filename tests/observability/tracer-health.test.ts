/**
 * TracerHealthSignal supervisor — kill-switch hysteresis (Slice 5.3
 * of docs/plan/endurance-stuck-terminating-and-overload-hardening.md).
 *
 * The plan calls for raising the saturation flag when the BSP queue
 * crosses 80 % of `maxQueueSize` for ≥ 3 s and lowering it once the
 * queue dips below 50 % for ≥ 3 s. Without this hysteresis the flag
 * would flap whenever depth oscillated near a threshold during normal
 * load — turning the kill switch on/off rapidly defeats its purpose
 * and produces log noise.
 *
 * The supervisor is exercised against a synthetic depth source so the
 * test can drive any sequence of values without a real BSP.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import {
  TracerHealthSignal,
  runTracerHealthSupervisor,
} from "../../src/observability/tracer-health.js"

const provide = <A, E>(eff: Effect.Effect<A, E, TracerHealthSignal>) =>
  eff.pipe(Effect.provide(TracerHealthSignal.live))

describe("TracerHealthSignal — noop default", () => {
  it.effect(
    "isSaturated() always returns false; setSaturated has no effect",
    () =>
      Effect.gen(function* () {
        const sig = yield* TracerHealthSignal
        expect(sig.isSaturated()).toBe(false)
        yield* sig.setSaturated("bsp_saturated", true)
        expect(sig.isSaturated()).toBe(false)
        expect(sig.disabledTotal()).toEqual({ bsp_saturated: 0 })
      }).pipe(Effect.provide(TracerHealthSignal.noop)),
  )
})

describe("TracerHealthSignal — live + supervisor", () => {
  it.effect(
    "raises after sustained > 80% capacity, lowers after sustained < 50%, counts each transition exactly once",
    () =>
      provide(
        Effect.gen(function* () {
          const signal = yield* TracerHealthSignal
          const maxQueueSize = 100
          // Mutable depth source the test drives.
          let depth = 0
          const supervisor = yield* Effect.forkChild(
            runTracerHealthSupervisor({
              queueDepth: () => depth,
              maxQueueSize,
              pollIntervalMs: 1000,
              raiseSamples: 3,
              lowerSamples: 3,
            }),
          )

          // Helper: advance one polling tick.
          const tick = () =>
            Effect.gen(function* () {
              yield* TestClock.adjust("1 second")
              yield* Effect.yieldNow
            })

          // Initial state: not saturated, no transitions counted.
          expect(signal.isSaturated()).toBe(false)
          expect(signal.disabledTotal().bsp_saturated).toBe(0)

          // Drive depth above 80 (=80% of 100). Raise should fire on
          // the THIRD consecutive sample, not the first.
          depth = 90
          yield* tick()
          expect(signal.isSaturated()).toBe(false)
          yield* tick()
          expect(signal.isSaturated()).toBe(false)
          yield* tick()
          expect(signal.isSaturated()).toBe(true)
          expect(signal.disabledTotal().bsp_saturated).toBe(1)

          // Re-poll while still saturated — counter does NOT bump.
          yield* tick()
          expect(signal.disabledTotal().bsp_saturated).toBe(1)

          // Drop into the dead-band (between lower and raise thresholds).
          // Should NOT lower yet — depth must be ≤ 50 %.
          depth = 70
          yield* tick()
          yield* tick()
          yield* tick()
          expect(signal.isSaturated()).toBe(true)
          expect(signal.disabledTotal().bsp_saturated).toBe(1)

          // Drop below 50 — needs three consecutive ticks to lower.
          depth = 40
          yield* tick()
          expect(signal.isSaturated()).toBe(true)
          yield* tick()
          expect(signal.isSaturated()).toBe(true)
          yield* tick()
          expect(signal.isSaturated()).toBe(false)
          // Lowering does NOT increment the disabled counter — we count
          // raises only (the metric semantically tracks "tracer was
          // shut off" events).
          expect(signal.disabledTotal().bsp_saturated).toBe(1)

          // Re-saturate to confirm the counter bumps a second time.
          depth = 90
          yield* tick()
          yield* tick()
          yield* tick()
          expect(signal.isSaturated()).toBe(true)
          expect(signal.disabledTotal().bsp_saturated).toBe(2)

          yield* Fiber.interrupt(supervisor)
        }),
      ),
  )

  it.effect(
    "brief spikes that don't last 3 ticks do NOT raise the flag",
    () =>
      provide(
        Effect.gen(function* () {
          const signal = yield* TracerHealthSignal
          const maxQueueSize = 100
          let depth = 0
          const supervisor = yield* Effect.forkChild(
            runTracerHealthSupervisor({
              queueDepth: () => depth,
              maxQueueSize,
              pollIntervalMs: 1000,
              raiseSamples: 3,
              lowerSamples: 3,
            }),
          )

          // Two consecutive high samples then a normal sample —
          // streak resets, flag stays low.
          depth = 95
          yield* TestClock.adjust("1 second"); yield* Effect.yieldNow
          yield* TestClock.adjust("1 second"); yield* Effect.yieldNow
          depth = 30
          yield* TestClock.adjust("1 second"); yield* Effect.yieldNow
          expect(signal.isSaturated()).toBe(false)
          expect(signal.disabledTotal().bsp_saturated).toBe(0)

          yield* Fiber.interrupt(supervisor)
        }),
      ),
  )
})

// Layer wiring: confirms `live` and `noop` are interchangeable from
// a downstream consumer's perspective.
describe("TracerHealthSignal — layer surface", () => {
  it.effect(
    "live layer satisfies the same shape as noop layer",
    () =>
      Effect.gen(function* () {
        const sig = yield* TracerHealthSignal
        expect(typeof sig.isSaturated).toBe("function")
        expect(typeof sig.disabledTotal).toBe("function")
        expect(typeof sig.setSaturated).toBe("function")
      }).pipe(Effect.provide(Layer.merge(TracerHealthSignal.live, Layer.empty))),
  )
})
