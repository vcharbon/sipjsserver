/**
 * In-memory CallLimiter layer — backed by a `MutableHashMap` and Effect
 * `Clock` so window rollover and per-key TTL expiration can be driven
 * deterministically under `TestClock`.
 *
 * Drop-in replacement for `redisLayer` in tests. Mirrors the *high-level*
 * semantics of the Redis/Lua-backed limiter (windowed counters with N
 * active windows summed, per-window TTL) without simulating Lua
 * primitives.
 *
 * All time reads go through `Clock.currentTimeMillis` — never
 * `Date.now()` — so the 24 h `TestClock` end-of-scenario sweep flushes
 * limiter windows.
 *
 * `memoryLayer` is wrapped in `Layer.suspend` to defer
 * `Layer.effect(CallLimiter, ...)` past this module's load phase. The
 * parent `CallLimiter.ts` imports this module from its class-static
 * initialiser; without the suspend the class reference is undefined at
 * Layer-build time. Same workaround as `CallStateCache.memory.ts`.
 */

import { Clock, Effect, Layer, MutableHashMap, Option } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import { CallLimiter, type LimiterDecision } from "./CallLimiter.js"

export interface LimiterMemoryEntry {
  count: number
  expiresAtMs: number
}

export type LimiterMemoryStore = MutableHashMap.MutableHashMap<string, LimiterMemoryEntry>

/** Construct a fresh empty store — convenience for SUT builders. */
export const makeLimiterMemoryStore = (): LimiterMemoryStore =>
  MutableHashMap.empty<string, LimiterMemoryEntry>()

export const buildMemoryLimiterImpl = (
  config: { limiterWindowSeconds: number; limiterActiveWindows: number; limiterTtlSeconds: number },
  store: LimiterMemoryStore,
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
    limit: number,
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
    originWindow: number,
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
    originWindow: number,
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
    currentWindow: Effect.map(currentEpochSec, computeWindowFromSec),
  }
}

/** Per-instance memory layer (single-worker tests). */
export const memoryLayer: Layer.Layer<CallLimiter, never, AppConfig> = Layer.suspend(() =>
  Layer.effect(
    CallLimiter,
    Effect.gen(function* () {
      const config = yield* AppConfig
      return buildMemoryLimiterImpl(config, makeLimiterMemoryStore())
    }),
  ),
)

/**
 * Shared-store memory layer — multi-worker fake-stack SUTs pass the
 * same `MutableHashMap` so every simulated worker increments the same
 * counter (mirrors the cluster-shared Redis topology used by the
 * production `LimiterRedisClient`).
 */
export const sharedMemoryLayer = (
  store: LimiterMemoryStore,
): Layer.Layer<CallLimiter, never, AppConfig> =>
  Layer.suspend(() =>
    Layer.effect(
      CallLimiter,
      Effect.gen(function* () {
        const config = yield* AppConfig
        return buildMemoryLimiterImpl(config, store)
      }),
    ),
  )
