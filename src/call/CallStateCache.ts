/**
 * CallStateCache service — narrow persistence interface used by CallState.
 *
 * Splits the "where do calls live across restarts / between workers" concern
 * out of CallState so the storage substrate is swappable. The production
 * implementation (`redisLayer`) is a thin adapter over RedisClient. Tests can
 * provide an in-memory implementation backed by Effect Clock to simulate TTL
 * expiration deterministically.
 *
 * Two logical stores:
 *   - call store:  callRef → JSON-encoded Call (used for crash recovery / scan)
 *   - index store: arbitrary key (e.g. "leg:abc|tag", "ctx:foo") → callRef
 *
 * The cache only stores opaque strings; CallState owns the key naming and
 * JSON encoding. The cache owns TTL semantics.
 */

import { Clock, Effect, Layer, MutableHashMap, Option, ServiceMap } from "effect"
import { RedisClient, RedisError } from "../redis/RedisClient.js"

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CallStateCache extends ServiceMap.Service<
  CallStateCache,
  {
    /** Store the encoded Call JSON for a callRef with the given TTL (seconds). */
    readonly putCall: (callRef: string, json: string, ttlSec: number) => Effect.Effect<void, RedisError>
    /** Read the encoded Call JSON for a callRef. Returns null if missing/expired. */
    readonly getCall: (callRef: string) => Effect.Effect<string | null, RedisError>
    /** Update the TTL on a callRef key (no-op if missing). */
    readonly expireCall: (callRef: string, ttlSec: number) => Effect.Effect<void, RedisError>
    /** Immediately delete a callRef key from the cache. */
    readonly deleteCall: (callRef: string) => Effect.Effect<void, RedisError>

    /** Store an index entry (e.g. "leg:abc|tag" → callRef) with the given TTL. */
    readonly putIndex: (indexKey: string, callRef: string, ttlSec: number) => Effect.Effect<void, RedisError>
    /** Read an index entry. Returns null if missing/expired. */
    readonly getIndex: (indexKey: string) => Effect.Effect<string | null, RedisError>
    /** Update the TTL on an index key (no-op if missing). */
    readonly expireIndex: (indexKey: string, ttlSec: number) => Effect.Effect<void, RedisError>
    /** Immediately delete an index key from the cache. */
    readonly deleteIndex: (indexKey: string) => Effect.Effect<void, RedisError>

    /** List all currently-live callRefs (used for crash recovery scan). */
    readonly scanCallRefs: () => Effect.Effect<ReadonlyArray<string>, RedisError>
  }
>()("@sipjsserver/CallStateCache") {
  /**
   * Production layer — backed by Redis.
   *
   * Owns the `call:` key prefix for the call store; index keys are stored
   * verbatim (caller already encodes them as `leg:...`, `ctx:...`, etc.).
   */
  static readonly redisLayer = Layer.effect(
    CallStateCache,
    Effect.gen(function* () {
      const redis = yield* RedisClient

      const callKey = (callRef: string) => `call:${callRef}`

      const putCall = Effect.fnUntraced(function* (
        callRef: string,
        json: string,
        ttlSec: number
      ) {
        yield* redis.setex(callKey(callRef), ttlSec, json)
      })

      const getCall = Effect.fnUntraced(function* (callRef: string) {
        return yield* redis.get(callKey(callRef))
      })

      const expireCall = Effect.fnUntraced(function* (
        callRef: string,
        ttlSec: number
      ) {
        yield* redis.expire(callKey(callRef), ttlSec)
      })

      const deleteCall = Effect.fnUntraced(function* (callRef: string) {
        yield* redis.del(callKey(callRef))
      })

      const putIndex = Effect.fnUntraced(function* (
        indexKey: string,
        callRef: string,
        ttlSec: number
      ) {
        yield* redis.setex(indexKey, ttlSec, callRef)
      })

      const getIndex = Effect.fnUntraced(function* (indexKey: string) {
        return yield* redis.get(indexKey)
      })

      const expireIndex = Effect.fnUntraced(function* (
        indexKey: string,
        ttlSec: number
      ) {
        yield* redis.expire(indexKey, ttlSec)
      })

      const deleteIndex = Effect.fnUntraced(function* (indexKey: string) {
        yield* redis.del(indexKey)
      })

      const scanCallRefs = Effect.fnUntraced(function* () {
        const keys = yield* redis.scanKeys("call:*")
        return keys.map((k) => k.slice("call:".length))
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

  /**
   * In-memory layer — backed by two `MutableHashMap`s and Effect `Clock` so TTL
   * expiration can be driven deterministically under `TestClock`.
   *
   * Drop-in replacement for `redisLayer` in tests that want to exercise
   * cache TTL / cleanup-delay behavior without a real Redis.
   *
   * High-level Redis semantics preserved:
   * - `put*` writes value with absolute expiry (now + ttlSec*1000).
   * - `get*` returns null if expired.
   * - `expire*` only updates TTL on still-live keys (matches Redis EXPIRE).
   */
  static readonly memoryLayer = Layer.effect(
    CallStateCache,
    Effect.gen(function* () {
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
    })
  )
}
