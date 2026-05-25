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
 *
 * Impl Layers live in `CallStateCache.memory.ts` / `CallStateCache.redis.ts`;
 * `memoryLayer` / `redisLayer` here are thin static re-exports wrapped in
 * `Layer.suspend` to defer construction past this class's static
 * initializer (the impl modules' `Layer.effect(CallStateCache, ...)`
 * would otherwise capture the Tag before its static fields are set).
 */

import { Effect, Layer, ServiceMap } from "effect"
import { RedisClient, RedisError } from "../redis/RedisClient.js"
import * as memoryImpl from "./CallStateCache.memory.js"
import * as redisImpl from "./CallStateCache.redis.js"

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
  /** In-memory implementation — see `./CallStateCache.memory.ts`. */
  static readonly memoryLayer: Layer.Layer<CallStateCache> = memoryImpl.memoryLayer
  /** Redis-backed implementation — see `./CallStateCache.redis.ts`. */
  static readonly redisLayer: Layer.Layer<CallStateCache, never, RedisClient> = redisImpl.redisLayer
}
