/**
 * Redis-backed CallStateCache layer — thin adapter over RedisClient.
 *
 * Owns the `call:` key prefix for the call store; index keys are stored
 * verbatim (caller already encodes them as `leg:...`, `ctx:...`, etc.).
 */

import { Effect, Layer } from "effect"
import { RedisClient } from "../redis/RedisClient.js"
import { CallStateCache } from "./CallStateCache.js"
import { lazyEffect } from "../runtime/lazyEffect.js"

export const redisLayer: Layer.Layer<CallStateCache, never, RedisClient> =
  lazyEffect(() => CallStateCache, () =>
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
    }),
  )
