/**
 * In-memory CallStateCache layer — two `MutableHashMap`s + Effect Clock
 * so TTL expiration can be driven deterministically under `TestClock`.
 *
 * Drop-in replacement for `redisLayer` in tests that want to exercise
 * cache TTL / cleanup-delay behavior without a real Redis.
 *
 * High-level Redis semantics preserved:
 * - `put*` writes value with absolute expiry (now + ttlSec*1000).
 * - `get*` returns null if expired.
 * - `expire*` only updates TTL on still-live keys (matches Redis EXPIRE).
 */

import { Clock, Effect, Layer, MutableHashMap, Option } from "effect"
import { CallStateCache } from "./CallStateCache.js"
import { lazyEffect } from "../runtime/lazyEffect.js"

export const memoryLayer: Layer.Layer<CallStateCache> = lazyEffect(
  () => CallStateCache,
  () => Effect.gen(function* () {
    interface Entry {
      value: string
      expiresAtMs: number
    }

    const calls = MutableHashMap.empty<string, Entry>()
    const indexes = MutableHashMap.empty<string, Entry>()

    const sweepKey = (
      store: MutableHashMap.MutableHashMap<string, Entry>,
      key: string,
      nowMs: number
    ): Option.Option<Entry> => {
      const opt = MutableHashMap.get(store, key)
      if (Option.isNone(opt)) return Option.none()
      if (opt.value.expiresAtMs <= nowMs) {
        MutableHashMap.remove(store, key)
        return Option.none()
      }
      return opt
    }

    const put = (
      store: MutableHashMap.MutableHashMap<string, Entry>,
      key: string,
      value: string,
      ttlSec: number,
      nowMs: number
    ): void => {
      MutableHashMap.set(store, key, { value, expiresAtMs: nowMs + ttlSec * 1000 })
    }

    const expireIn = (
      store: MutableHashMap.MutableHashMap<string, Entry>,
      key: string,
      ttlSec: number,
      nowMs: number
    ): void => {
      const opt = sweepKey(store, key, nowMs)
      if (Option.isSome(opt)) {
        MutableHashMap.set(store, key, {
          value: opt.value.value,
          expiresAtMs: nowMs + ttlSec * 1000
        })
      }
    }

    const putCall = Effect.fnUntraced(function* (
      callRef: string,
      json: string,
      ttlSec: number
    ) {
      const ms = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => put(calls, callRef, json, ttlSec, ms))
    })

    const getCall = Effect.fnUntraced(function* (callRef: string) {
      const ms = yield* Clock.currentTimeMillis
      return yield* Effect.sync(() => {
        const opt = sweepKey(calls, callRef, ms)
        return Option.isSome(opt) ? opt.value.value : null
      })
    })

    const expireCall = Effect.fnUntraced(function* (
      callRef: string,
      ttlSec: number
    ) {
      const ms = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => expireIn(calls, callRef, ttlSec, ms))
    })

    const deleteCall = Effect.fnUntraced(function* (callRef: string) {
      yield* Effect.sync(() => MutableHashMap.remove(calls, callRef))
    })

    const putIndex = Effect.fnUntraced(function* (
      indexKey: string,
      callRef: string,
      ttlSec: number
    ) {
      const ms = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => put(indexes, indexKey, callRef, ttlSec, ms))
    })

    const getIndex = Effect.fnUntraced(function* (indexKey: string) {
      const ms = yield* Clock.currentTimeMillis
      return yield* Effect.sync(() => {
        const opt = sweepKey(indexes, indexKey, ms)
        return Option.isSome(opt) ? opt.value.value : null
      })
    })

    const expireIndex = Effect.fnUntraced(function* (
      indexKey: string,
      ttlSec: number
    ) {
      const ms = yield* Clock.currentTimeMillis
      yield* Effect.sync(() => expireIn(indexes, indexKey, ttlSec, ms))
    })

    const deleteIndex = Effect.fnUntraced(function* (indexKey: string) {
      yield* Effect.sync(() => MutableHashMap.remove(indexes, indexKey))
    })

    const scanCallRefs = Effect.fnUntraced(function* () {
      const ms = yield* Clock.currentTimeMillis
      return yield* Effect.sync(() => {
        const live: string[] = []
        const expired: string[] = []
        for (const [k, v] of calls) {
          if (v.expiresAtMs <= ms) expired.push(k)
          else live.push(k)
        }
        for (const k of expired) MutableHashMap.remove(calls, k)
        return live
      })
    })

    return {
      putCall,
      getCall,
      expireCall,
      deleteCall,
      putIndex,
      getIndex,
      expireIndex,
      deleteIndex,
      scanCallRefs
    }
  }),
)
