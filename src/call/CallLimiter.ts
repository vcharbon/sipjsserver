/**
 * CallLimiter service — windowed concurrent call counters backed by Redis Lua scripts.
 *
 * Keys: limiter:{id}:{windowTimestamp} → count
 * Windows are rounded to LIMITER_WINDOW_SECONDS intervals.
 * Verification sums the last LIMITER_ACTIVE_WINDOWS windows.
 * TTL on each key ensures auto-cleanup if refresh stops (crash recovery).
 */

import { Clock, Duration, Effect, Layer, MutableHashMap, Option, Schema, ServiceMap } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import { LimiterRedisClient } from "../redis/LimiterRedisClient.js"
import type { RedisError } from "../redis/RedisClient.js"

// ---------------------------------------------------------------------------
// Service-level types: typed decision + typed backend error
// ---------------------------------------------------------------------------

/**
 * Outer Effect-level timeout for `checkAndIncrement`. Defense-in-depth
 * behind ioredis `commandTimeout: 100` (configured on the limiter
 * connection). The 50 ms gap guarantees the ioredis-level timeout wins
 * under normal pathology; this outer net only fires if ioredis itself
 * misbehaves (command lost in some unrecoverable state). See plan
 * `docs/plan/to-review-and-properly-swift-moler.md` Q4.
 */
const LIMITER_BUDGET_MS = 150 as const

/**
 * Typed admission decision returned by `checkAndIncrement` on a healthy
 * limiter. `Rejected` is a success-channel outcome (the caller sends
 * 486/failover) — only the absence of a decision lives in the error channel.
 */
export type LimiterDecision =
  | { readonly _tag: "Allowed"; readonly currentWindow: number }
  | { readonly _tag: "Rejected" }

/**
 * Typed backend failure for `checkAndIncrement`. Caller is expected to
 * `catchTag` both arms and synthesize an "admit-no-tag" admission that
 * skips the matching `DECR` on cleanup.
 */
export class LimiterTimeout extends Schema.TaggedErrorClass<LimiterTimeout>()(
  "LimiterTimeout",
  { budgetMs: Schema.Int },
) {}

export type LimiterBackendError = RedisError | LimiterTimeout

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
    /**
     * Atomic check-and-increment, bounded to {@link LIMITER_BUDGET_MS}.
     *
     * - Success channel: `LimiterDecision` — `Allowed` or `Rejected`. Both
     *   are normal outcomes (`Rejected` means cap hit; caller sends 486 /
     *   tries failover).
     * - Error channel: `RedisError` (ioredis surfaced an error within the
     *   commandTimeout) or `LimiterTimeout` (outer Effect-level safety net
     *   fired). The caller is expected to `catchTags` both arms and
     *   synthesize a fail-open admission with `incrementSucceeded: false`.
     */
    readonly checkAndIncrement: (limiterId: string, limit: number) => Effect.Effect<LimiterDecision, LimiterBackendError>
    /** Decrement the counter for a call that used the given origin window. */
    readonly decrement: (limiterId: string, originWindow: number) => Effect.Effect<void, RedisError>
    /** Refresh: migrate count from origin window to current window. */
    readonly refresh: (limiterId: string, originWindow: number) => Effect.Effect<number, RedisError>
    /** Compute the current window timestamp (rounded). */
    readonly currentWindow: Effect.Effect<number>
  }
>()("@sipjsserver/CallLimiter") {
  static readonly redisLayer = Layer.effect(
    CallLimiter,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const redis = yield* LimiterRedisClient

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

      const checkAndIncrementInner = Effect.fnUntraced(function* (
        limiterId: string,
        limit: number
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

      // Outer Effect-level timeout — defense in depth behind the limiter
      // Redis client's `commandTimeout: 100`. Only fires if ioredis fails
      // to surface its own timeout (unrecoverable command state). The
      // 50 ms gap guarantees the inner timeout wins under normal failure.
      const checkAndIncrement = (limiterId: string, limit: number): Effect.Effect<LimiterDecision, LimiterBackendError> =>
        checkAndIncrementInner(limiterId, limit).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(LIMITER_BUDGET_MS),
            orElse: () => Effect.fail(new LimiterTimeout({ budgetMs: LIMITER_BUDGET_MS })),
          }),
        )

      const decrement = Effect.fnUntraced(function* (
        limiterId: string,
        originWindow: number
      ) {
        const key = `limiter:${limiterId}:${originWindow}`
        yield* redis.eval(DECREMENT_LUA, [key], [])
      })

      const refresh = Effect.fnUntraced(function* (
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

  /**
   * In-memory layer — backed by a `MutableHashMap` and Effect `Clock` so
   * window rollover and per-key TTL expiration can be driven deterministically
   * under `TestClock`.
   *
   * Drop-in replacement for `redisLayer` in tests. Mirrors the *high-level*
   * semantics of the Redis/Lua-backed limiter (windowed counters with N active
   * windows summed, per-window TTL) without simulating Lua primitives.
   *
   * All time reads go through `Clock.currentTimeMillis` — never `Date.now()` —
   * so the 24h `TestClock` end-of-scenario sweep flushes limiter windows.
   */
  static readonly memoryLayer = Layer.effect(
    CallLimiter,
    Effect.gen(function* () {
      const config = yield* AppConfig
      return buildMemoryLimiterImpl(config, MutableHashMap.empty<string, LimiterMemoryEntry>())
    })
  )

  /**
   * Like `memoryLayer` but the backing `MutableHashMap` is supplied
   * externally. Used by multi-worker fake-stack SUTs to share **one**
   * counter map across every simulated worker — mirrors the cluster-shared
   * Redis topology used by the production `LimiterRedisClient`.
   *
   * Tests can also peek/reset the map directly via the handle they passed in.
   */
  static readonly sharedMemoryLayer = (
    store: LimiterMemoryStore
  ): Layer.Layer<CallLimiter, never, AppConfig> =>
    Layer.effect(
      CallLimiter,
      Effect.gen(function* () {
        const config = yield* AppConfig
        return buildMemoryLimiterImpl(config, store)
      })
    )
}

// ---------------------------------------------------------------------------
// In-memory limiter — shared body for `memoryLayer` and `sharedMemoryLayer`.
// ---------------------------------------------------------------------------

export interface LimiterMemoryEntry {
  count: number
  expiresAtMs: number
}

export type LimiterMemoryStore = MutableHashMap.MutableHashMap<string, LimiterMemoryEntry>

/** Construct a fresh empty store — convenience for SUT builders. */
export const makeLimiterMemoryStore = (): LimiterMemoryStore =>
  MutableHashMap.empty<string, LimiterMemoryEntry>()

const buildMemoryLimiterImpl = (
  config: { limiterWindowSeconds: number; limiterActiveWindows: number; limiterTtlSeconds: number },
  store: LimiterMemoryStore
) => {
  const windowSec = config.limiterWindowSeconds
  const activeWindows = config.limiterActiveWindows
  const ttlSec = config.limiterTtlSeconds

  const currentEpochSec = Effect.map(Clock.currentTimeMillis, (ms) => Math.floor(ms / 1000))

  const computeWindowFromSec = (sec: number): number => sec - (sec % windowSec)

  /** Sweep entries whose TTL has elapsed. */
  const sweep = (nowMs: number): void => {
    const expired: string[] = []
    for (const [k, v] of store) {
      if (v.expiresAtMs <= nowMs) expired.push(k)
    }
    for (const k of expired) MutableHashMap.remove(store, k)
  }

  const keyFor = (limiterId: string, window: number) => `limiter:${limiterId}:${window}`

  const checkAndIncrement = Effect.fnUntraced(function* (
    limiterId: string,
    limit: number
  ) {
    const sec = yield* currentEpochSec
    const ms = sec * 1000
    const currentWin = computeWindowFromSec(sec)

    return yield* Effect.sync((): LimiterDecision => {
      sweep(ms)

      let total = 0
      for (let i = activeWindows - 1; i >= 0; i--) {
        const w = currentWin - i * windowSec
        const opt = MutableHashMap.get(store, keyFor(limiterId, w))
        if (Option.isSome(opt)) total += opt.value.count
      }

      if (total >= limit) {
        return { _tag: "Rejected" }
      }

      const k = keyFor(limiterId, currentWin)
      const existing = MutableHashMap.get(store, k)
      const newCount = Option.isSome(existing) ? existing.value.count + 1 : 1
      MutableHashMap.set(store, k, { count: newCount, expiresAtMs: ms + ttlSec * 1000 })
      return { _tag: "Allowed", currentWindow: currentWin }
    })
  })

  const decrement = Effect.fnUntraced(function* (
    limiterId: string,
    originWindow: number
  ) {
    const ms = yield* Clock.currentTimeMillis
    yield* Effect.sync(() => {
      sweep(ms)
      const k = keyFor(limiterId, originWindow)
      const opt = MutableHashMap.get(store, k)
      if (Option.isSome(opt)) {
        const next = Math.max(0, opt.value.count - 1)
        MutableHashMap.set(store, k, { count: next, expiresAtMs: opt.value.expiresAtMs })
      }
    })
  })

  const refresh = Effect.fnUntraced(function* (
    limiterId: string,
    originWindow: number
  ) {
    const sec = yield* currentEpochSec
    const ms = sec * 1000
    const currentWin = computeWindowFromSec(sec)
    if (originWindow === currentWin) return currentWin

    yield* Effect.sync(() => {
      sweep(ms)
      const ck = keyFor(limiterId, currentWin)
      const cExisting = MutableHashMap.get(store, ck)
      const cNext = Option.isSome(cExisting) ? cExisting.value.count + 1 : 1
      MutableHashMap.set(store, ck, { count: cNext, expiresAtMs: ms + ttlSec * 1000 })

      const ok = keyFor(limiterId, originWindow)
      const oExisting = MutableHashMap.get(store, ok)
      if (Option.isSome(oExisting)) {
        const next = Math.max(0, oExisting.value.count - 1)
        MutableHashMap.set(store, ok, { count: next, expiresAtMs: oExisting.value.expiresAtMs })
      }
    })
    return currentWin
  })

  return {
    checkAndIncrement,
    decrement,
    refresh,
    currentWindow: Effect.map(currentEpochSec, computeWindowFromSec)
  }
}
