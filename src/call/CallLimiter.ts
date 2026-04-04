/**
 * CallLimiter service — windowed concurrent call counters backed by Redis Lua scripts.
 *
 * Keys: limiter:{id}:{windowTimestamp} → count
 * Windows are rounded to LIMITER_WINDOW_SECONDS intervals.
 * Verification sums the last LIMITER_ACTIVE_WINDOWS windows.
 * TTL on each key ensures auto-cleanup if refresh stops (crash recovery).
 */

import { Clock, Effect, Layer, ServiceMap } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import { RedisClient, RedisError } from "../redis/RedisClient.js"

// ---------------------------------------------------------------------------
// Lua scripts
// ---------------------------------------------------------------------------

/**
 * Atomically check the sum of last N windows and increment the current window
 * if under the limit.
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
 * INCR current first, then DECR origin (briefly overcounts, never undercounts).
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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CallLimiter extends ServiceMap.Service<
  CallLimiter,
  {
    /** Check and increment. Returns true if allowed, false if rejected. */
    readonly checkAndIncrement: (limiterId: string, limit: number) => Effect.Effect<{ allowed: boolean; currentWindow: number }, RedisError>
    /** Decrement the counter for a call that used the given origin window. */
    readonly decrement: (limiterId: string, originWindow: number) => Effect.Effect<void, RedisError>
    /** Refresh: migrate count from origin window to current window. */
    readonly refresh: (limiterId: string, originWindow: number) => Effect.Effect<number, RedisError>
    /** Compute the current window timestamp (rounded). */
    readonly currentWindow: Effect.Effect<number>
  }
>()("@sipjsserver/CallLimiter") {
  static readonly layer = Layer.effect(
    CallLimiter,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const redis = yield* RedisClient

      const windowSec = config.limiterWindowSeconds
      const activeWindows = config.limiterActiveWindows
      const ttl = config.limiterTtlSeconds

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

      const checkAndIncrement = Effect.fn("CallLimiter.checkAndIncrement")(function* (
        limiterId: string,
        limit: number
      ) {
        const epochSec = yield* currentEpochSec
        const currentWin = computeWindow(epochSec)
        const keys = windowKeysFor(limiterId, currentWin)
        const result = yield* redis.eval(CHECK_AND_INCREMENT_LUA, keys, [limit, ttl])
        const count = Number(result)
        return { allowed: count >= 0, currentWindow: currentWin }
      })

      const decrement = Effect.fn("CallLimiter.decrement")(function* (
        limiterId: string,
        originWindow: number
      ) {
        const key = `limiter:${limiterId}:${originWindow}`
        yield* redis.eval(DECREMENT_LUA, [key], [])
      })

      const refresh = Effect.fn("CallLimiter.refresh")(function* (
        limiterId: string,
        originWindow: number
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
        currentWindow: Effect.map(currentEpochSec, computeWindow)
      }
    })
  )
}
