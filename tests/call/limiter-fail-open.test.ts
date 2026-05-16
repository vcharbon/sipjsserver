/**
 * T3 + T4 from docs/plan/to-review-and-properly-swift-moler.md:
 *
 *   T3 — limiter-timeout-fail-open: when the limiter Redis hangs (no
 *        response within 150 ms), `CallLimiter.checkAndIncrement` surfaces
 *        `LimiterTimeout` on the error channel. Callers map this to a
 *        fail-open admission with `incrementSucceeded: false`.
 *
 *   T4 — limiter-redis-error-fail-open: when the limiter Redis fails
 *        synchronously with `RedisError`, `CallLimiter.checkAndIncrement`
 *        surfaces `RedisError` on the error channel within ~0 ms (no
 *        timeout slack needed). Same fail-open contract on the caller.
 *
 * Tests run against `CallLimiter.redisLayer` with a stubbed
 * `LimiterRedisClient` so the timing and error semantics are deterministic
 * under `TestClock` — they do not require an actual Redis.
 *
 * Note: the production fix also enforces the 100 ms budget at the ioredis
 * `commandTimeout` layer (`src/redis/LimiterRedisClient.ts`). That layer
 * is exercised end-to-end by the live cascade reproduction (L1) in
 * tests/k8s/endurance, not here.
 */

import { describe, expect, it } from "@effect/vitest"
import { TestClock } from "effect/testing"
import { Cause, Duration, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { AppConfig } from "../../src/config/AppConfig.js"
import { CallLimiter, LimiterTimeout } from "../../src/call/CallLimiter.js"
import { LimiterRedisClient } from "../../src/redis/LimiterRedisClient.js"
import { RedisError, type RedisOps } from "../../src/redis/RedisClient.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

/**
 * Build a `LimiterRedisClient` layer where `eval` (the only operation
 * `CallLimiter.checkAndIncrement` calls) behaves according to the
 * supplied effect. All other operations are unimplemented `Effect.die`.
 */
const stubLimiterRedis = (
  evalImpl: () => Effect.Effect<unknown, RedisError>,
): Layer.Layer<LimiterRedisClient> => {
  const ops = {
    get: () => Effect.die("not used"),
    set: () => Effect.die("not used"),
    setex: () => Effect.die("not used"),
    del: () => Effect.die("not used"),
    exists: () => Effect.die("not used"),
    incr: () => Effect.die("not used"),
    decr: () => Effect.die("not used"),
    expire: () => Effect.die("not used"),
    eval: evalImpl,
    pipeline: () => Effect.die("not used"),
    scanKeys: () => Effect.die("not used"),
    raw: null as unknown as RedisOps["raw"],
  } as unknown as RedisOps
  return Layer.succeed(LimiterRedisClient, ops)
}

const ConfigLayer = Layer.succeed(AppConfig, testAppConfigDefaults())

describe("CallLimiter.redisLayer — fail-open contract", () => {
  it.effect(
    "T3 — Redis hang surfaces LimiterTimeout within the 150 ms outer budget",
    () => {
      const hangingEval = () =>
        Effect.callback<unknown, RedisError>(() => {
          // never resume — simulates a hung Redis command
        })
      const stubLayer = stubLimiterRedis(hangingEval)
      const limiterLayer = CallLimiter.redisLayer.pipe(
        Layer.provide(stubLayer),
        Layer.provide(ConfigLayer),
      )

      return Effect.gen(function* () {
        const limiter = yield* CallLimiter

        // Fork the call so we can advance TestClock past the budget.
        const fiber = yield* Effect.forkChild(
          Effect.exit(limiter.checkAndIncrement("test-id", 100)),
        )

        // 100 ms — under the 150 ms outer budget; the call must still be
        // pending (the ioredis layer would have fired at 100 ms in
        // production, but we stubbed that out and only the outer
        // Effect.timeoutOrElse remains).
        yield* TestClock.adjust("100 millis")

        // 150 ms — outer Effect-level timeout fires.
        yield* TestClock.adjust("50 millis")

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          // value is itself an `Exit` because we wrapped with `Effect.exit`
          const inner = exit.value
          expect(Exit.isFailure(inner)).toBe(true)
          if (Exit.isFailure(inner)) {
            const errOpt = Cause.findErrorOption(inner.cause)
            expect(Option.isSome(errOpt)).toBe(true)
            if (Option.isSome(errOpt)) {
              expect(errOpt.value._tag).toBe("LimiterTimeout")
              expect((errOpt.value as LimiterTimeout).budgetMs).toBe(150)
            }
          }
        }
      }).pipe(Effect.provide(limiterLayer))
    },
  )

  it.effect(
    "T4 — Redis synchronous error surfaces RedisError without timeout slack",
    () => {
      let evalCallCount = 0
      const failingEval = () => {
        evalCallCount++
        return Effect.fail(new RedisError({ reason: "ECONNREFUSED 10.96.44.111:6379" }))
      }
      const stubLayer = stubLimiterRedis(failingEval)
      const limiterLayer = CallLimiter.redisLayer.pipe(
        Layer.provide(stubLayer),
        Layer.provide(ConfigLayer),
      )

      return Effect.gen(function* () {
        const limiter = yield* CallLimiter
        const exit = yield* Effect.exit(limiter.checkAndIncrement("test-id", 100))

        expect(evalCallCount).toBe(1)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const errOpt = Cause.findErrorOption(exit.cause)
          expect(Option.isSome(errOpt)).toBe(true)
          if (Option.isSome(errOpt)) {
            expect(errOpt.value._tag).toBe("RedisError")
            expect((errOpt.value as RedisError).reason).toContain("ECONNREFUSED")
          }
        }
      }).pipe(Effect.provide(limiterLayer))
    },
  )

  it.effect(
    "T3/T4 supplement — healthy Allowed path returns success-channel decision",
    () => {
      // CHECK_AND_INCREMENT_LUA returns `count + 1` on admit (>= 0)
      const evalImpl = () => Effect.succeed(1)
      const stubLayer = stubLimiterRedis(evalImpl)
      const limiterLayer = CallLimiter.redisLayer.pipe(
        Layer.provide(stubLayer),
        Layer.provide(ConfigLayer),
      )

      return Effect.gen(function* () {
        const limiter = yield* CallLimiter
        const decision = yield* limiter.checkAndIncrement("test-id", 100)
        expect(decision._tag).toBe("Allowed")
        if (decision._tag === "Allowed") {
          expect(typeof decision.currentWindow).toBe("number")
        }
      }).pipe(Effect.provide(limiterLayer))
    },
  )

  it.effect(
    "T3/T4 supplement — Rejected (limit-hit) is a success-channel outcome, not an error",
    () => {
      // CHECK_AND_INCREMENT_LUA returns -1 on rejection
      const evalImpl = () => Effect.succeed(-1)
      const stubLayer = stubLimiterRedis(evalImpl)
      const limiterLayer = CallLimiter.redisLayer.pipe(
        Layer.provide(stubLayer),
        Layer.provide(ConfigLayer),
      )

      return Effect.gen(function* () {
        const limiter = yield* CallLimiter
        const decision = yield* limiter.checkAndIncrement("test-id", 100)
        expect(decision._tag).toBe("Rejected")
      }).pipe(Effect.provide(limiterLayer))
    },
  )
})

// silence unused-import warnings for things only referenced in types
void Duration
void Stream
