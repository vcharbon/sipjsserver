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

import { Effect, Layer, ServiceMap } from "effect"
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

      const putCall = Effect.fn("CallStateCache.putCall")(function* (
        callRef: string,
        json: string,
        ttlSec: number
      ) {
        yield* redis.setex(callKey(callRef), ttlSec, json)
      })

      const getCall = Effect.fn("CallStateCache.getCall")(function* (callRef: string) {
        return yield* redis.get(callKey(callRef))
      })

      const expireCall = Effect.fn("CallStateCache.expireCall")(function* (
        callRef: string,
        ttlSec: number
      ) {
        yield* redis.expire(callKey(callRef), ttlSec)
      })

      const deleteCall = Effect.fn("CallStateCache.deleteCall")(function* (callRef: string) {
        yield* redis.del(callKey(callRef))
      })

      const putIndex = Effect.fn("CallStateCache.putIndex")(function* (
        indexKey: string,
        callRef: string,
        ttlSec: number
      ) {
        yield* redis.setex(indexKey, ttlSec, callRef)
      })

      const getIndex = Effect.fn("CallStateCache.getIndex")(function* (indexKey: string) {
        return yield* redis.get(indexKey)
      })

      const expireIndex = Effect.fn("CallStateCache.expireIndex")(function* (
        indexKey: string,
        ttlSec: number
      ) {
        yield* redis.expire(indexKey, ttlSec)
      })

      const deleteIndex = Effect.fn("CallStateCache.deleteIndex")(function* (indexKey: string) {
        yield* redis.del(indexKey)
      })

      const scanCallRefs = Effect.fn("CallStateCache.scanCallRefs")(function* () {
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
}
