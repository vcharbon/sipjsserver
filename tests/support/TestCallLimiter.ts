/**
 * TestCallLimiter — in-memory implementation of CallLimiter that uses Effect
 * Clock for window timestamps and TTL expiration. Drop-in replacement for
 * CallLimiter.layer in tests that need to deterministically drive window
 * rollover via TestClock.adjust.
 *
 * Mirrors the *high-level* semantics of the real Redis/Lua-backed limiter
 * (windowed counters with N active windows summed, per-window TTL) without
 * simulating Lua or Redis primitives directly.
 */

import { Clock, Effect, Layer, MutableHashMap, Option } from "effect"
import { AppConfig } from "../../src/config/AppConfig.js"
import { CallLimiter } from "../../src/call/CallLimiter.js"

interface Entry {
  count: number
  expiresAtMs: number
}

export class TestCallLimiter {
  static readonly layer = Layer.effect(
    CallLimiter,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const windowSec = config.limiterWindowSeconds
      const activeWindows = config.limiterActiveWindows
      const ttlSec = config.limiterTtlSeconds

      const store = MutableHashMap.empty<string, Entry>()

      const nowSec = Effect.gen(function* () {
        const ms = yield* Clock.currentTimeMillis
        return Math.floor(ms / 1000)
      })

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

      const checkAndIncrement = Effect.fn("TestCallLimiter.checkAndIncrement")(function* (
        limiterId: string,
        limit: number
      ) {
        const sec = yield* nowSec
        const ms = sec * 1000
        const currentWindow = computeWindowFromSec(sec)

        return yield* Effect.sync(() => {
          sweep(ms)

          let total = 0
          for (let i = activeWindows - 1; i >= 0; i--) {
            const w = currentWindow - i * windowSec
            const opt = MutableHashMap.get(store, keyFor(limiterId, w))
            if (Option.isSome(opt)) total += opt.value.count
          }

          if (total >= limit) {
            return { allowed: false, currentWindow }
          }

          const k = keyFor(limiterId, currentWindow)
          const existing = MutableHashMap.get(store, k)
          const newCount = Option.isSome(existing) ? existing.value.count + 1 : 1
          MutableHashMap.set(store, k, { count: newCount, expiresAtMs: ms + ttlSec * 1000 })
          return { allowed: true, currentWindow }
        })
      })

      const decrement = Effect.fn("TestCallLimiter.decrement")(function* (
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

      const refresh = Effect.fn("TestCallLimiter.refresh")(function* (
        limiterId: string,
        originWindow: number
      ) {
        const sec = yield* nowSec
        const ms = sec * 1000
        const currentWindow = computeWindowFromSec(sec)
        if (originWindow === currentWindow) return currentWindow

        yield* Effect.sync(() => {
          sweep(ms)
          // INCR current
          const ck = keyFor(limiterId, currentWindow)
          const cExisting = MutableHashMap.get(store, ck)
          const cNext = Option.isSome(cExisting) ? cExisting.value.count + 1 : 1
          MutableHashMap.set(store, ck, { count: cNext, expiresAtMs: ms + ttlSec * 1000 })
          // DECR origin
          const ok = keyFor(limiterId, originWindow)
          const oExisting = MutableHashMap.get(store, ok)
          if (Option.isSome(oExisting)) {
            const next = Math.max(0, oExisting.value.count - 1)
            MutableHashMap.set(store, ok, { count: next, expiresAtMs: oExisting.value.expiresAtMs })
          }
        })
        return currentWindow
      })

      const currentWindow = (): number => {
        // Synchronous; uses Date.now() as a fallback. Tests that care about
        // deterministic windowing should call checkAndIncrement/refresh which
        // both consult the Effect Clock.
        const sec = Math.floor(Date.now() / 1000)
        return computeWindowFromSec(sec)
      }

      return {
        checkAndIncrement,
        decrement,
        refresh,
        currentWindow
      }
    })
  )
}
