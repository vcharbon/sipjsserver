/**
 * CallLimiter parity (memory vs redis) — short-scenario coverage.
 *
 * Wires `CallLimiter.parity(memoryLayer, redisLayer)` and runs a few
 * `checkAndIncrement` / `decrement` / `refresh` / `currentWindow` cycles
 * to prove the two impls produce deep-equal observable outcomes.
 *
 * Gating: this test runs in FAKE mode by stubbing `LimiterRedisClient`
 * with a deterministic in-memory simulator of the three Lua scripts the
 * Redis impl executes. The stub keeps its kv state in a `Map`, so both
 * the per-instance memory layer and the Redis impl observe an identical
 * starting state under `TestClock`. This avoids a live-Redis dependency
 * for the parity wrapper itself — the alternative (`KV_BACKEND=redis`)
 * is reserved for the existing storage parity test and isn't required
 * to validate the limiter wrapper.
 *
 * If parity catches a real divergence (e.g. an in-place fix to one impl
 * that doesn't land on the other), the right resolution is to normalise
 * impl outputs — not to relax the comparator. See CLAUDE.md.
 */

import { describe, expect, it } from "@effect/vitest"
import { TestClock } from "effect/testing"
import { Effect, Layer } from "effect"
import { AppConfig } from "../../src/config/AppConfig.js"
import { CallLimiter } from "../../src/call/CallLimiter.js"
// Side-effect import bolts CallLimiter.parity onto the Tag.
import "../../src/call/CallLimiter.contracts.js"
import { LimiterRedisClient } from "../../src/redis/LimiterRedisClient.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { RedisError, type RedisOps } from "../../src/redis/RedisClient.js"
import { Recorder } from "../../src/test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../../src/test-harness/framework/RunContext.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

/**
 * Build a stubbed `LimiterRedisClient` that simulates the three Lua
 * scripts the Redis CallLimiter impl runs. State lives in a shared
 * `Map<string, number>`; expirations are tracked separately and applied
 * on access (mirrors Redis's lazy-expiry behaviour for our purposes).
 */
const makeSimulatedLimiterRedis = (): Layer.Layer<LimiterRedisClient> => {
  const store = new Map<string, number>()
  const expiresAt = new Map<string, number>()

  // Lua scripts the CallLimiter.redis impl ships. We detect by literal
  // prefix; if the impl mutates the script body the test should fail
  // visibly here, which is the right behaviour.
  const CHECK_AND_INCREMENT = "local total = 0"
  const REFRESH = "redis.call('INCR', KEYS[1])"
  const DECREMENT = "return redis.call('DECR', KEYS[1])"

  const sweep = (nowMs: number): void => {
    const expired: string[] = []
    for (const [k, expMs] of expiresAt) {
      if (expMs <= nowMs) expired.push(k)
    }
    for (const k of expired) {
      store.delete(k)
      expiresAt.delete(k)
    }
  }

  const evalImpl = (
    script: string,
    keys: Array<string>,
    args: Array<string | number>,
  ): Effect.Effect<unknown, RedisError> =>
    Effect.gen(function* () {
      const nowMs = Date.now()
      sweep(nowMs)

      if (script.trim().startsWith(CHECK_AND_INCREMENT)) {
        const limit = Number(args[0])
        const ttlSec = Number(args[1])
        let total = 0
        for (const k of keys) total += store.get(k) ?? 0
        if (total >= limit) return -1
        const current = keys[keys.length - 1]!
        store.set(current, (store.get(current) ?? 0) + 1)
        expiresAt.set(current, nowMs + ttlSec * 1000)
        return total + 1
      }

      if (script.trim().startsWith(REFRESH)) {
        const currentKey = keys[0]!
        const originKey = keys[1]!
        const ttlSec = Number(args[0])
        store.set(currentKey, (store.get(currentKey) ?? 0) + 1)
        expiresAt.set(currentKey, nowMs + ttlSec * 1000)
        const v = store.get(originKey) ?? 0
        store.set(originKey, v - 1)
        return 1
      }

      if (script.trim().startsWith(DECREMENT)) {
        const k = keys[0]!
        const v = (store.get(k) ?? 0) - 1
        store.set(k, v)
        return v
      }

      return yield* Effect.fail(
        new RedisError({ reason: `unknown script in stub: ${script.slice(0, 40)}` }),
      )
    })

  const ops = {
    get: () => Effect.die("not used in parity stub"),
    set: () => Effect.die("not used in parity stub"),
    setex: () => Effect.die("not used in parity stub"),
    del: () => Effect.die("not used in parity stub"),
    exists: () => Effect.die("not used in parity stub"),
    incr: () => Effect.die("not used in parity stub"),
    decr: () => Effect.die("not used in parity stub"),
    expire: () => Effect.die("not used in parity stub"),
    eval: evalImpl,
    pipeline: () => Effect.die("not used in parity stub"),
    scanKeys: () => Effect.die("not used in parity stub"),
    raw: null as unknown as RedisOps["raw"],
  } as unknown as RedisOps
  return Layer.succeed(LimiterRedisClient, ops)
}

const ConfigLayer = Layer.succeed(AppConfig, testAppConfigDefaults())

describe("CallLimiter.parity — memory vs redis (short scenario)", () => {
  it.effect(
    "tryAcquire / release / currentWindow / refresh hold parity across a small admission cycle",
    () => {
      const memoryLayer = CallLimiter.memoryLayer
      const stubLimiterRedis = makeSimulatedLimiterRedis()
      const redisLayer = CallLimiter.redisLayer.pipe(
        Layer.provide(stubLimiterRedis),
        Layer.provide(MetricsRegistry.layer),
      )
      const parityLayer = CallLimiter.parity(memoryLayer, redisLayer).pipe(
        Layer.provide(ConfigLayer),
        Layer.provideMerge(Recorder.fake),
        Layer.provideMerge(RunContext.testWithRecorder),
      )

      return Effect.gen(function* () {
        const limiter = yield* CallLimiter

        // 5 admissions under a generous limit; all should succeed and
        // both sides should report identical Allowed windows.
        for (let i = 0; i < 5; i++) {
          const decision = yield* limiter.checkAndIncrement("parity-id", 100)
          expect(decision._tag).toBe("Allowed")
        }

        // Currently-window read should match across both impls.
        const win = yield* limiter.currentWindow
        expect(typeof win).toBe("number")

        // Decrement 3 of the 5 — parity wrapper would die if outcomes
        // diverged. Inside the same window so origin == current.
        for (let i = 0; i < 3; i++) {
          yield* limiter.decrement("parity-id", win)
        }

        // Advance past one window boundary (300s) and force a refresh.
        // Both impls should migrate the counter to the new window
        // identically.
        yield* TestClock.adjust("301 seconds")
        const newWin = yield* limiter.refresh("parity-id", win)
        expect(newWin).toBeGreaterThan(win)

        // One more admission against the new window — proves the
        // post-refresh state is parity-consistent.
        const finalDecision = yield* limiter.checkAndIncrement("parity-id", 100)
        expect(finalDecision._tag).toBe("Allowed")

        // No parity violations in the recorder snapshot.
        const recorder = yield* Recorder
        const snap = yield* recorder.snapshot
        const violations = snap.anomalies.filter(
          (a) =>
            a.kind === "signalingAudit" &&
            a.check.startsWith("lim.parity."),
        )
        expect(violations).toHaveLength(0)
      }).pipe(Effect.provide(parityLayer))
    },
  )

  it.effect(
    "Rejected outcomes match on both sides when the cap is reached",
    () => {
      const memoryLayer = CallLimiter.memoryLayer
      const stubLimiterRedis = makeSimulatedLimiterRedis()
      const redisLayer = CallLimiter.redisLayer.pipe(
        Layer.provide(stubLimiterRedis),
        Layer.provide(MetricsRegistry.layer),
      )
      const parityLayer = CallLimiter.parity(memoryLayer, redisLayer).pipe(
        Layer.provide(ConfigLayer),
        Layer.provideMerge(Recorder.fake),
        Layer.provideMerge(RunContext.testWithRecorder),
      )

      return Effect.gen(function* () {
        const limiter = yield* CallLimiter
        const LIMIT = 3

        // Fill to the cap.
        for (let i = 0; i < LIMIT; i++) {
          const d = yield* limiter.checkAndIncrement("tight", LIMIT)
          expect(d._tag).toBe("Allowed")
        }

        // Next call rejected on BOTH sides — parity must hold.
        const rejected = yield* limiter.checkAndIncrement("tight", LIMIT)
        expect(rejected._tag).toBe("Rejected")

        const recorder = yield* Recorder
        const snap = yield* recorder.snapshot
        const violations = snap.anomalies.filter(
          (a) =>
            a.kind === "signalingAudit" &&
            a.check.startsWith("lim.parity."),
        )
        expect(violations).toHaveLength(0)
      }).pipe(Effect.provide(parityLayer))
    },
  )
})
