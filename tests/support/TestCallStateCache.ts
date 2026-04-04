/**
 * TestCallStateCache — in-memory CallStateCache backed by Effect Clock so that
 * TTL expiration can be driven deterministically by TestClock.adjust. Drop-in
 * replacement for CallStateCache.redisLayer in tests that need to exercise
 * call cache TTL / cleanup-delay corner cases.
 *
 * Simulates the high-level behavior of Redis SET/GET/EXPIRE with TTLs:
 * - put writes a value with absolute expiry (now + ttlSec*1000).
 * - get returns null if expired.
 * - expire only updates TTL on still-live keys (matches Redis EXPIRE).
 */

import { Clock, Effect, Layer, MutableHashMap, Option } from "effect"
import { CallStateCache } from "../../src/call/CallStateCache.js"

interface Entry {
  value: string
  expiresAtMs: number
}

export class TestCallStateCache {
  static readonly layer = Layer.effect(
    CallStateCache,
    Effect.gen(function* () {
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

      const expire = (
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

      const putCall = Effect.fn("TestCallStateCache.putCall")(function* (
        callRef: string,
        json: string,
        ttlSec: number
      ) {
        const ms = yield* Clock.currentTimeMillis
        yield* Effect.sync(() => put(calls, callRef, json, ttlSec, ms))
      })

      const getCall = Effect.fn("TestCallStateCache.getCall")(function* (callRef: string) {
        const ms = yield* Clock.currentTimeMillis
        return yield* Effect.sync(() => {
          const opt = sweepKey(calls, callRef, ms)
          return Option.isSome(opt) ? opt.value.value : null
        })
      })

      const expireCall = Effect.fn("TestCallStateCache.expireCall")(function* (
        callRef: string,
        ttlSec: number
      ) {
        const ms = yield* Clock.currentTimeMillis
        yield* Effect.sync(() => expire(calls, callRef, ttlSec, ms))
      })

      const deleteCall = Effect.fn("TestCallStateCache.deleteCall")(function* (callRef: string) {
        yield* Effect.sync(() => MutableHashMap.remove(calls, callRef))
      })

      const putIndex = Effect.fn("TestCallStateCache.putIndex")(function* (
        indexKey: string,
        callRef: string,
        ttlSec: number
      ) {
        const ms = yield* Clock.currentTimeMillis
        yield* Effect.sync(() => put(indexes, indexKey, callRef, ttlSec, ms))
      })

      const getIndex = Effect.fn("TestCallStateCache.getIndex")(function* (indexKey: string) {
        const ms = yield* Clock.currentTimeMillis
        return yield* Effect.sync(() => {
          const opt = sweepKey(indexes, indexKey, ms)
          return Option.isSome(opt) ? opt.value.value : null
        })
      })

      const expireIndex = Effect.fn("TestCallStateCache.expireIndex")(function* (
        indexKey: string,
        ttlSec: number
      ) {
        const ms = yield* Clock.currentTimeMillis
        yield* Effect.sync(() => expire(indexes, indexKey, ttlSec, ms))
      })

      const deleteIndex = Effect.fn("TestCallStateCache.deleteIndex")(function* (indexKey: string) {
        yield* Effect.sync(() => MutableHashMap.remove(indexes, indexKey))
      })

      const scanCallRefs = Effect.fn("TestCallStateCache.scanCallRefs")(function* () {
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
    })
  )
}
