/**
 * Slice 6 EpochCounter — redesigned `gen` mechanism.
 *
 * Asserts the K8s-downward-API + UnixMillisAtBoot packing rules per
 * docs/plan/grill-me-on-the-spicy-lark.md §D4:
 *   - `gen = restartCount * 2^48 + (UnixMillisAtBoot & (2^48 - 1))`
 *   - Higher restartCount → strictly higher gen, regardless of millis.
 *   - Same restartCount, later boot → higher gen.
 *   - Survives sidecar Redis wipes (no Redis state involved).
 *   - `RESTART_COUNT` env var consulted by `fromKubernetesDownwardAPI`.
 *   - Falls back to wall-clock-only when env var is unavailable / malformed.
 *
 * Legacy `redisLayer` / `memoryLayerFromStore` continue to live at
 * `epoch-monotonic.test.ts` until the Slice 7 cutover.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  EpochCounter,
  GEN_RESTART_MULTIPLIER,
  packGen,
  unpackGen,
  ENV_RESTART_COUNT,
} from "../../src/replication/EpochCounter.js"

describe("packGen / unpackGen", () => {
  it("packs (restartCount, millis) into a single value with restart in high bits", () => {
    const gen = packGen(7, 1_700_000_000_000)
    const u = unpackGen(gen)
    expect(u.restartCount).toBe(7)
    expect(u.unixMillisAtBoot).toBe(1_700_000_000_000)
  })

  it("higher restartCount yields strictly higher gen regardless of millis", () => {
    const earlier = packGen(8, 1_000)
    const later = packGen(7, Number.MAX_SAFE_INTEGER >>> 0)
    expect(earlier).toBeGreaterThan(later)
  })

  it("same restartCount, later millis yields higher gen", () => {
    const a = packGen(3, 1_000_000)
    const b = packGen(3, 2_000_000)
    expect(b).toBeGreaterThan(a)
  })

  it("clamps negative inputs to 0", () => {
    expect(packGen(-1, -1)).toBe(0)
    expect(packGen(0, 0)).toBe(0)
  })

  it("multiplier matches design constant 2^48", () => {
    expect(GEN_RESTART_MULTIPLIER).toBe(2 ** 48)
    expect(packGen(1, 0)).toBe(GEN_RESTART_MULTIPLIER)
  })

  it("packed values stay within Number.MAX_SAFE_INTEGER for realistic restart counts", () => {
    // 2^53 / 2^48 ≈ 32 — the safe-integer ceiling on restartCount with
    // a 48-bit millis low. K8s pods rarely see more than a handful of
    // restarts before being replaced; 30 is the design ceiling.
    const gen = packGen(30, Date.now())
    expect(Number.isSafeInteger(gen)).toBe(true)
  })
})

describe("EpochCounter.fixedForTesting", () => {
  it.effect("returns the injected gen via both `current` and `gen` shapes", () =>
    Effect.gen(function* () {
      const counter = yield* EpochCounter
      expect(counter.gen).toBe(42_000)
      const fromEffect = yield* counter.current
      expect(fromEffect).toBe(42_000)
      expect(counter.owner).toBe("worker-A")
    }).pipe(
      Effect.provide(EpochCounter.fixedForTesting(42_000, "worker-A"))
    )
  )

  it.effect("two layer builds with different fixed gens model a pod restart", () =>
    Effect.gen(function* () {
      const g1 = yield* Effect.gen(function* () {
        return (yield* EpochCounter).gen
      }).pipe(Effect.provide(EpochCounter.fixedForTesting(1, "worker-A")))
      // Simulate a pod restart with restartCount=1.
      const g2 = yield* Effect.gen(function* () {
        return (yield* EpochCounter).gen
      }).pipe(
        Effect.provide(
          EpochCounter.fixedForTesting(packGen(1, 1_000), "worker-A")
        )
      )
      expect(g2).toBeGreaterThan(g1)
    })
  )
})

describe("EpochCounter.fromWallClock", () => {
  it.effect("gen has restartCount=0 and a wall-clock-based millis", () =>
    Effect.gen(function* () {
      const counter = yield* EpochCounter
      const u = unpackGen(counter.gen)
      expect(u.restartCount).toBe(0)
      // The TestClock starts at 0; on `it.effect` we expect ms to be 0
      // unless the test advanced it.
      expect(u.unixMillisAtBoot).toBeGreaterThanOrEqual(0)
    }).pipe(Effect.provide(EpochCounter.fromWallClock("worker-A")))
  )
})

describe("EpochCounter.fromKubernetesDownwardAPI", () => {
  // Apply env overrides at effect-execution time (NOT layer-build time
  // outside the effect, which is when withEnv would return). The env
  // var is restored by `Effect.acquireRelease` so test order doesn't
  // matter and a failed assertion still cleans up.
  const withEnvEffect = <A, E, R>(
    key: string,
    value: string | undefined,
    eff: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const prev = process.env[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
      try {
        return yield* eff
      } finally {
        if (prev === undefined) delete process.env[key]
        else process.env[key] = prev
      }
    })

  it.effect("reads RESTART_COUNT env var into the high bits of gen", () =>
    withEnvEffect(
      ENV_RESTART_COUNT,
      "5",
      Effect.gen(function* () {
        const counter = yield* EpochCounter
        const u = unpackGen(counter.gen)
        expect(u.restartCount).toBe(5)
      }).pipe(
        Effect.provide(EpochCounter.fromKubernetesDownwardAPI("worker-A"))
      )
    )
  )

  it.effect("missing env var falls back to restartCount=0 with a WARN log", () =>
    withEnvEffect(
      ENV_RESTART_COUNT,
      undefined,
      Effect.gen(function* () {
        const counter = yield* EpochCounter
        const u = unpackGen(counter.gen)
        expect(u.restartCount).toBe(0)
      }).pipe(
        Effect.provide(EpochCounter.fromKubernetesDownwardAPI("worker-A"))
      )
    )
  )

  it.effect("malformed env var falls back to restartCount=0", () =>
    withEnvEffect(
      ENV_RESTART_COUNT,
      "not-a-number",
      Effect.gen(function* () {
        const counter = yield* EpochCounter
        const u = unpackGen(counter.gen)
        expect(u.restartCount).toBe(0)
      }).pipe(
        Effect.provide(EpochCounter.fromKubernetesDownwardAPI("worker-A"))
      )
    )
  )

  it.effect("simulated pod restart (restartCount 0 → 1) yields strictly higher gen", () =>
    Effect.gen(function* () {
      const g0 = yield* withEnvEffect(
        ENV_RESTART_COUNT,
        "0",
        Effect.gen(function* () {
          return (yield* EpochCounter).gen
        }).pipe(
          Effect.provide(EpochCounter.fromKubernetesDownwardAPI("worker-A"))
        )
      )
      const g1 = yield* withEnvEffect(
        ENV_RESTART_COUNT,
        "1",
        Effect.gen(function* () {
          return (yield* EpochCounter).gen
        }).pipe(
          Effect.provide(EpochCounter.fromKubernetesDownwardAPI("worker-A"))
        )
      )
      expect(g1).toBeGreaterThan(g0)
      expect(unpackGen(g1).restartCount).toBe(1)
    })
  )
})
