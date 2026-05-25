/**
 * Redis-backed CallLimiter layer — windowed concurrent call counters
 * backed by atomic Lua scripts.
 *
 * Keys: `limiter:{id}:{windowTimestamp}` → count
 * Windows are rounded to `LIMITER_WINDOW_SECONDS` intervals.
 * Verification sums the last `LIMITER_ACTIVE_WINDOWS` windows.
 * TTL on each key ensures auto-cleanup if refresh stops (crash recovery).
 *
 * `redisLayer` is wrapped in `Layer.suspend` — see
 * `CallLimiter.memory.ts` for the rationale.
 */

import { Clock, Duration, Effect, Layer } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import { LimiterRedisClient } from "../redis/LimiterRedisClient.js"
import { MetricsRegistry } from "../observability/MetricsRegistry.js"
import {
  CallLimiter,
  LimiterTimeout,
  type LimiterBackendError,
  type LimiterDecision,
} from "./CallLimiter.js"
import { lazyEffect } from "../runtime/lazyEffect.js"

/**
 * Outer Effect-level timeout for `checkAndIncrement`. Defense-in-depth
 * behind ioredis `commandTimeout: 100` (configured on the limiter
 * connection). The 50 ms gap guarantees the ioredis-level timeout wins
 * under normal pathology; this outer net only fires if ioredis itself
 * misbehaves (command lost in some unrecoverable state). See
 * ADR-0004.
 */
const LIMITER_BUDGET_MS = 150 as const

/**
 * Atomically check the sum of last N windows and increment the current
 * window if under the limit.
 *
 * KEYS: window keys to sum (oldest first), last key is the current window
 * ARGV[1]: limit
 * ARGV[2]: TTL for the current window key
 *
 * Returns: current total (after increment) if allowed, -1 if rejected
 */
const CHECK_AND_INCREMENT_LUA = `
local total = 0
for i = 1, #KEYS do
  total = total + tonumber(redis.call('GET', KEYS[i]) or '0')
end
if total >= tonumber(ARGV[1]) then
  return -1
end
local current = KEYS[#KEYS]
redis.call('INCR', current)
redis.call('EXPIRE', current, tonumber(ARGV[2]))
return total + 1
`

/**
 * Refresh/migrate: move a count from origin window to current window.
 * INCR current first, then DECR origin (briefly overcounts, never
 * undercounts).
 *
 * KEYS[1]: current window key
 * KEYS[2]: origin window key
 * ARGV[1]: TTL for current window key
 */
const REFRESH_LUA = `
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
redis.call('DECR', KEYS[2])
return 1
`

/**
 * Decrement a specific window key.
 *
 * KEYS[1]: window key to decrement
 */
const DECREMENT_LUA = `
return redis.call('DECR', KEYS[1])
`

export const redisLayer: Layer.Layer<
  CallLimiter,
  never,
  AppConfig | LimiterRedisClient | MetricsRegistry
> = lazyEffect(() => CallLimiter, () =>
  Effect.gen(function* () {
      const config = yield* AppConfig
      const redis = yield* LimiterRedisClient
      const registry = yield* MetricsRegistry

      const windowSec = config.limiterWindowSeconds
      const activeWindows = config.limiterActiveWindows
      const ttl = config.limiterTtlSeconds

      // Per-result counters. The chaos verification needs to distinguish
      // "limiter saturating naturally" (rejected) from "limiter Redis
      // fell over" (redis_error / timeout).
      let allowedTotal = 0
      let rejectedTotal = 0
      let redisErrorTotal = 0
      let timeoutTotal = 0

      registry.callLimiter = {
        allowedTotal: () => allowedTotal,
        rejectedTotal: () => rejectedTotal,
        redisErrorTotal: () => redisErrorTotal,
        timeoutTotal: () => timeoutTotal,
      }

      const computeWindow = (epochSec: number): number => {
        return epochSec - (epochSec % windowSec)
      }

      const currentEpochSec = Effect.map(Clock.currentTimeMillis, (ms) => Math.floor(ms / 1000))

      /** Build the list of window keys (oldest → newest) for a given limiter. */
      const windowKeysFor = (limiterId: string, currentWin: number): string[] => {
        const keys: string[] = []
        for (let i = activeWindows - 1; i >= 0; i--) {
          keys.push(`limiter:${limiterId}:${currentWin - i * windowSec}`)
        }
        return keys
      }

      const checkAndIncrementInner = Effect.fnUntraced(function* (
        limiterId: string,
        limit: number,
      ) {
        const epochSec = yield* currentEpochSec
        const currentWin = computeWindow(epochSec)
        const keys = windowKeysFor(limiterId, currentWin)
        const result = yield* redis.eval(CHECK_AND_INCREMENT_LUA, keys, [limit, ttl])
        const count = Number(result)
        return count >= 0
          ? ({ _tag: "Allowed", currentWindow: currentWin } as const)
          : ({ _tag: "Rejected" } as const)
      })

      const checkAndIncrement = (
        limiterId: string,
        limit: number,
      ): Effect.Effect<LimiterDecision, LimiterBackendError> =>
        checkAndIncrementInner(limiterId, limit).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(LIMITER_BUDGET_MS),
            orElse: () => Effect.fail(new LimiterTimeout({ budgetMs: LIMITER_BUDGET_MS })),
          }),
          Effect.tap((decision) =>
            Effect.sync(() => {
              if (decision._tag === "Allowed") allowedTotal++
              else rejectedTotal++
            }),
          ),
          Effect.tapError((err) =>
            Effect.sync(() => {
              if (err._tag === "LimiterTimeout") timeoutTotal++
              else redisErrorTotal++
            }),
          ),
        )

      const decrement = Effect.fnUntraced(function* (
        limiterId: string,
        originWindow: number,
      ) {
        const key = `limiter:${limiterId}:${originWindow}`
        yield* redis.eval(DECREMENT_LUA, [key], [])
      })

      const refresh = Effect.fnUntraced(function* (
        limiterId: string,
        originWindow: number,
      ) {
        const epochSec = yield* currentEpochSec
        const currentWin = computeWindow(epochSec)
        if (originWindow === currentWin) {
          // Already in current window, no migration needed
          return currentWin
        }
        const currentKey = `limiter:${limiterId}:${currentWin}`
        const originKey = `limiter:${limiterId}:${originWindow}`
        yield* redis.eval(REFRESH_LUA, [currentKey, originKey], [ttl])
        return currentWin
      })

    return {
      checkAndIncrement,
      decrement,
      refresh,
      currentWindow: Effect.map(currentEpochSec, computeWindow),
    }
  }),
)
