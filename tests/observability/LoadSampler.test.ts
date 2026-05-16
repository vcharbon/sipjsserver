import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  LoadSampler,
  LoadSamplerSimulatedControl,
  simulatedLayer,
} from "../../src/observability/LoadSampler.js"

describe("LoadSampler — simulated", () => {
  it.effect("elu and gcFraction default to 0", () =>
    Effect.gen(function* () {
      const sampler = yield* LoadSampler
      expect(sampler.elu()).toBe(0)
      expect(sampler.gcFraction()).toBe(0)
    }).pipe(Effect.provide(simulatedLayer())),
  )

  it.effect("setElu writes a value that elu() reads back on the same fiber", () =>
    Effect.gen(function* () {
      const sampler = yield* LoadSampler
      const control = yield* LoadSamplerSimulatedControl
      control.setElu(0.73)
      expect(sampler.elu()).toBeCloseTo(0.73, 5)
    }).pipe(Effect.provide(simulatedLayer())),
  )

  it.effect("setGcFraction writes a value that gcFraction() reads back", () =>
    Effect.gen(function* () {
      const sampler = yield* LoadSampler
      const control = yield* LoadSamplerSimulatedControl
      control.setGcFraction(0.31)
      expect(sampler.gcFraction()).toBeCloseTo(0.31, 5)
    }).pipe(Effect.provide(simulatedLayer())),
  )

  it.effect("setElu and setGcFraction clamp out-of-range inputs to [0,1]", () =>
    Effect.gen(function* () {
      const sampler = yield* LoadSampler
      const control = yield* LoadSamplerSimulatedControl
      control.setElu(-0.5)
      expect(sampler.elu()).toBe(0)
      control.setElu(1.5)
      expect(sampler.elu()).toBe(1)
      control.setGcFraction(-0.1)
      expect(sampler.gcFraction()).toBe(0)
      control.setGcFraction(2.0)
      expect(sampler.gcFraction()).toBe(1)
    }).pipe(Effect.provide(simulatedLayer())),
  )

  it.effect("NaN / Infinity coerce to 0 rather than corrupting state", () =>
    Effect.gen(function* () {
      const sampler = yield* LoadSampler
      const control = yield* LoadSamplerSimulatedControl
      control.setElu(Number.NaN)
      expect(sampler.elu()).toBe(0)
      control.setElu(Number.POSITIVE_INFINITY)
      expect(sampler.elu()).toBe(0)
    }).pipe(Effect.provide(simulatedLayer())),
  )

  it.effect("two simulatedLayer invocations create independent state (no shared module-level refs)", () =>
    Effect.gen(function* () {
      // First layer: set elu=0.4
      yield* Effect.gen(function* () {
        const control = yield* LoadSamplerSimulatedControl
        control.setElu(0.4)
        const sampler = yield* LoadSampler
        expect(sampler.elu()).toBeCloseTo(0.4, 5)
      }).pipe(Effect.provide(simulatedLayer()))

      // Second layer: fresh default value
      yield* Effect.gen(function* () {
        const sampler = yield* LoadSampler
        expect(sampler.elu()).toBe(0)
      }).pipe(Effect.provide(simulatedLayer()))
    }),
  )
})

describe("LoadSampler — live (perf_hooks)", () => {
  it.effect("elu returns a finite value in [0,1] after burning some loop time", () =>
    Effect.gen(function* () {
      const sampler = yield* LoadSampler
      // Establish baseline.
      sampler.elu()
      // Burn ~5 ms of synchronous work so the next call has a real delta.
      const end = Date.now() + 5
      while (Date.now() < end) {
        // spin
      }
      const u = sampler.elu()
      expect(Number.isFinite(u)).toBe(true)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThanOrEqual(1)
    }).pipe(Effect.provide(LoadSampler.liveLayer)),
  )

  it.effect("gcFraction returns a finite value in [0,1]", () =>
    Effect.gen(function* () {
      const sampler = yield* LoadSampler
      const f = sampler.gcFraction()
      expect(Number.isFinite(f)).toBe(true)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThanOrEqual(1)
    }).pipe(Effect.provide(LoadSampler.liveLayer)),
  )
})
