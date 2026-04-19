/**
 * CallState service — manages call lifecycle with in-memory + cache persistence.
 *
 * Design:
 * - In-memory MutableHashMap<callRef, Call> for active/checked-out calls
 * - In-memory MutableHashMap<sipKey, callRef> for SIP message → call routing
 * - In-memory MutableHashMap<callRef, Semaphore> for per-call sequential processing
 * - CallStateCache for persistence: flush after key events, load on demand
 *
 * Persistence is delegated to the CallStateCache service so the storage
 * substrate (Redis in production, in-memory test fake) is swappable. CallState
 * itself is the in-memory layer; CallStateCache is the cache layer.
 *
 * Flush lifecycle:
 * 1. After /call/new response → flush initial state
 * 2. After 200 OK → flush confirmed state
 * 3. On idle (configurable) → flush and evict from memory
 * 4. On termination → schedule cache cleanup (with delay for retransmissions)
 *
 * Semaphore is released before async cache flush.
 */

import { Effect, Layer, MutableHashMap, Option, Ref, Schema, Semaphore, ServiceMap } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import type { RedisError } from "../redis/RedisClient.js"
import type { Call } from "./CallModel.js"
import { Call as CallSchema } from "./CallModel.js"
import { CallStateCache } from "./CallStateCache.js"

const JsonCallSchema = Schema.fromJsonString(CallSchema)

// ---------------------------------------------------------------------------
// SIP key helpers (used both for in-memory sipIndex and cache index keys)
// ---------------------------------------------------------------------------

function legKey(callId: string, tag: string): string {
  return `leg:${callId}|${tag}`
}

function legCallIdKey(callId: string): string {
  return `leg:${callId}`
}

function ctxKey(ctx: string): string {
  return `ctx:${ctx}`
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CallState extends ServiceMap.Service<
  CallState,
  {
    /** Create a new call and store it in memory. Returns the callRef. */
    readonly create: (call: Call) => Effect.Effect<string>
    /** Acquire the semaphore for a call, load from cache if needed. */
    readonly checkout: (callRef: string) => Effect.Effect<Call | undefined, RedisError>
    /** Update a call in memory (must be checked out). */
    readonly update: (callRef: string, fn: (call: Call) => Call) => Effect.Effect<void>
    /** Get call without checkout (read-only, from memory only). */
    readonly peek: (callRef: string) => Effect.Effect<Call | undefined>
    /** Release the semaphore (call this after processing a message). */
    readonly release: (callRef: string) => Effect.Effect<void>
    /** Flush a call to the cache. Memory entry stays. */
    readonly flushToRedis: (callRef: string) => Effect.Effect<void, RedisError>
    /** Remove a call from memory and schedule cache cleanup. */
    readonly remove: (callRef: string) => Effect.Effect<void, RedisError>
    /** Resolve a SIP key (callId|tag) to a callRef, checking memory then cache. */
    readonly resolveFromSipKey: (callId: string, tag: string) => Effect.Effect<string | undefined, RedisError>
    /** Get stats for the status endpoint. */
    readonly stats: () => Effect.Effect<{ concurrent: number; total: number }>
    /** Synchronous stats snapshot (for metrics interval — no Effect needed). */
    readonly statsSync: () => { concurrent: number; total: number; sipIndexSize: number; semaphoresSize: number }
    /** Load all calls owned by a specific worker from the cache (for crash recovery). */
    readonly loadOwnedCalls: (workerIndex: number) => Effect.Effect<ReadonlyArray<Call>, RedisError>
    /** Flush all in-memory calls to the cache (for graceful shutdown). */
    readonly flushAllCalls: () => Effect.Effect<void, RedisError>
  }
>()("@sipjsserver/CallState") {
  static readonly layer = Layer.effect(
    CallState,
    Effect.gen(function* () {
      const cache = yield* CallStateCache
      const config = yield* AppConfig
      const ttl = config.callContextTtlSec

      // In-memory state
      const callsMap = MutableHashMap.empty<string, Call>()
      const sipIndex = MutableHashMap.empty<string, string>()
      const semaphores = MutableHashMap.empty<string, Semaphore.Semaphore>()
      const totalRef = yield* Ref.make(0)
      // Plain mutable counter shadowing totalRef for sync reads (metrics interval).
      let totalSync = 0

      const getSemaphore = Effect.fn("CallState.getSemaphore")(function* (callRef: string) {
        const existing = Option.getOrUndefined(MutableHashMap.get(semaphores, callRef))
        if (existing !== undefined) return existing
        const sem = yield* Semaphore.make(1)
        yield* Effect.sync(() => MutableHashMap.set(semaphores, callRef, sem))
        return sem
      })

      /** Index all SIP keys for a call into the local map. */
      const indexCall = (call: Call): Effect.Effect<void> =>
        Effect.sync(() => {
          MutableHashMap.set(sipIndex, `${call.aLeg.callId}|${call.aLeg.fromTag}`, call.callRef)
          for (const bLeg of call.bLegs) {
            MutableHashMap.set(sipIndex, `${bLeg.callId}|${bLeg.fromTag}`, call.callRef)
            MutableHashMap.set(sipIndex, bLeg.callId, call.callRef)
            for (const dialog of bLeg.dialogs) {
              const bTag = dialog.sip.remoteTag
              if (bTag) {
                MutableHashMap.set(sipIndex, `${bLeg.callId}|${bTag}`, call.callRef)
              }
            }
          }
        })

      /** Write all cache index keys for a call. */
      const writeCacheIndexes = Effect.fn("CallState.writeCacheIndexes")(function* (call: Call) {
        yield* cache.putIndex(legKey(call.aLeg.callId, call.aLeg.fromTag), call.callRef, ttl)
        for (const bLeg of call.bLegs) {
          yield* cache.putIndex(legKey(bLeg.callId, bLeg.fromTag), call.callRef, ttl)
          yield* cache.putIndex(legCallIdKey(bLeg.callId), call.callRef, ttl)
          for (const dialog of bLeg.dialogs) {
            const bTag = dialog.sip.remoteTag
            if (bTag) {
              yield* cache.putIndex(legKey(bLeg.callId, bTag), call.callRef, ttl)
            }
          }
        }
        if (call.callbackContext !== undefined) {
          yield* cache.putIndex(ctxKey(call.callbackContext), call.callRef, ttl)
        }
      })

      /** Refresh TTL on all cache index keys for a call. */
      const refreshIndexTtl = Effect.fn("CallState.refreshIndexTtl")(function* (call: Call) {
        yield* cache.expireIndex(legKey(call.aLeg.callId, call.aLeg.fromTag), ttl)
        for (const bLeg of call.bLegs) {
          yield* cache.expireIndex(legKey(bLeg.callId, bLeg.fromTag), ttl)
          yield* cache.expireIndex(legCallIdKey(bLeg.callId), ttl)
          for (const dialog of bLeg.dialogs) {
            const bTag = dialog.sip.remoteTag
            if (bTag) {
              yield* cache.expireIndex(legKey(bLeg.callId, bTag), ttl)
            }
          }
        }
        if (call.callbackContext !== undefined) {
          yield* cache.expireIndex(ctxKey(call.callbackContext), ttl)
        }
      })

      const create = Effect.fn("CallState.create")(function* (call: Call) {
        yield* Effect.sync(() => MutableHashMap.set(callsMap, call.callRef, call))
        yield* indexCall(call)
        yield* Ref.update(totalRef, (n) => n + 1)
        totalSync++
        return call.callRef
      })

      const checkout = Effect.fn("CallState.checkout")(function* (callRef: string) {
        const sem = yield* getSemaphore(callRef)
        yield* Semaphore.take(sem, 1)

        const inMemory = Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))
        if (inMemory !== undefined) return inMemory

        const json = yield* cache.getCall(callRef)
        if (json === null) {
          yield* Semaphore.release(sem, 1)
          return undefined
        }

        const decoded = Schema.decodeUnknownSync(JsonCallSchema)(json)

        // Don't reload terminated/terminating calls into memory from cache.
        // "terminated": lingered in cache for retransmission safety but must
        //   not re-enter callsMap (otherwise noop handlers leak them).
        // "terminating": stuck after a crash — all transaction state is lost,
        //   so BYE responses will never arrive. Force-skip and let the cache
        //   entry expire naturally (or be cleaned by loadOwnedCalls).
        if (decoded.state === "terminated" || decoded.state === "terminating") {
          if (decoded.state === "terminating") {
            yield* Effect.logWarning(`Checkout skipping terminating call ${callRef} from cache — stuck after crash, deleting`)
            yield* cache.deleteCall(callRef)
          }
          yield* Semaphore.release(sem, 1)
          return undefined
        }

        yield* Effect.sync(() => MutableHashMap.set(callsMap, callRef, decoded))
        yield* indexCall(decoded)
        return decoded
      })

      const update = Effect.fn("CallState.update")(function* (
        callRef: string,
        fn: (call: Call) => Call
      ) {
        yield* Effect.sync(() => {
          const opt = MutableHashMap.get(callsMap, callRef)
          if (Option.isSome(opt)) {
            MutableHashMap.set(callsMap, callRef, fn(opt.value))
          }
        })
      })

      const peek = Effect.fn("CallState.peek")(function* (callRef: string) {
        return Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))
      })

      const release = Effect.fn("CallState.release")(function* (callRef: string) {
        const sem = Option.getOrUndefined(MutableHashMap.get(semaphores, callRef))
        if (sem !== undefined) {
          yield* Semaphore.release(sem, 1)
        }
      })

      const flushToRedis = Effect.fn("CallState.flushToRedis")(function* (callRef: string) {
        const call = Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))
        if (call === undefined) return

        const json = Schema.encodeSync(JsonCallSchema)(call)
        yield* cache.putCall(callRef, json, ttl)
        yield* refreshIndexTtl(call)

        yield* Effect.logDebug(`Flushed call ${callRef} to cache`)
      })

      const remove = Effect.fn("CallState.remove")(function* (callRef: string) {
        const call = Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))

        // Clean memory + SIP index
        yield* Effect.sync(() => {
          MutableHashMap.remove(callsMap, callRef)
          MutableHashMap.remove(semaphores, callRef)

          if (call !== undefined) {
            MutableHashMap.remove(sipIndex, `${call.aLeg.callId}|${call.aLeg.fromTag}`)
            for (const bLeg of call.bLegs) {
              MutableHashMap.remove(sipIndex, `${bLeg.callId}|${bLeg.fromTag}`)
              MutableHashMap.remove(sipIndex, bLeg.callId)
              for (const dialog of bLeg.dialogs) {
                const bTag = dialog.sip.remoteTag
                if (bTag) MutableHashMap.remove(sipIndex, `${bLeg.callId}|${bTag}`)
              }
            }
          }
        })

        // Delete cache keys immediately. The "terminating" state already waited
        // for all outstanding BYE transactions to resolve (or timeout), so by
        // the time remove() is called no more SIP messages will arrive for this
        // call. TransactionLayer still holds completed transactions for its 65s
        // sweep, so true retransmissions get cached responses replayed there.
        if (call !== undefined) {
          yield* cache.deleteCall(callRef)
          yield* cache.deleteIndex(legKey(call.aLeg.callId, call.aLeg.fromTag))
          for (const bLeg of call.bLegs) {
            yield* cache.deleteIndex(legKey(bLeg.callId, bLeg.fromTag))
            yield* cache.deleteIndex(legCallIdKey(bLeg.callId))
            for (const dialog of bLeg.dialogs) {
              const bTag = dialog.sip.remoteTag
              if (bTag) yield* cache.deleteIndex(legKey(bLeg.callId, bTag))
            }
          }
          if (call.callbackContext !== undefined) {
            yield* cache.deleteIndex(ctxKey(call.callbackContext))
          }
        } else {
          yield* cache.deleteCall(callRef)
        }
      })

      const resolveFromSipKey = Effect.fn("CallState.resolveFromSipKey")(function* (
        callId: string,
        tag: string
      ) {
        const byTag = Option.getOrUndefined(MutableHashMap.get(sipIndex, `${callId}|${tag}`))
        if (byTag !== undefined) return byTag

        const byCallId = Option.getOrUndefined(MutableHashMap.get(sipIndex, callId))
        if (byCallId !== undefined) return byCallId

        const ref = yield* cache.getIndex(legKey(callId, tag))
        if (ref !== null) return ref

        const refById = yield* cache.getIndex(legCallIdKey(callId))
        return refById ?? undefined
      })

      const stats = Effect.fn("CallState.stats")(function* () {
        const total = yield* Ref.get(totalRef)
        return { concurrent: MutableHashMap.size(callsMap), total }
      })

      const statsSync = (): { concurrent: number; total: number; sipIndexSize: number; semaphoresSize: number } => ({
        concurrent: MutableHashMap.size(callsMap),
        total: totalSync,
        sipIndexSize: MutableHashMap.size(sipIndex),
        semaphoresSize: MutableHashMap.size(semaphores),
      })

      const loadOwnedCalls = Effect.fn("CallState.loadOwnedCalls")(function* (workerIndex: number) {
        const refs = yield* cache.scanCallRefs()
        const loaded: Call[] = []

        for (const ref of refs) {
          const json = yield* cache.getCall(ref)
          if (json === null) continue

          const decoded = Schema.decodeUnknownSync(JsonCallSchema)(json)
          if (decoded.workerIndex !== workerIndex) continue

          // Skip terminating calls on recovery — they were mid-teardown when
          // the worker crashed. All transaction state is lost, so BYE responses
          // will never arrive. Delete from cache to prevent permanent leaks.
          if (decoded.state === "terminating") {
            yield* Effect.logWarning(`Skipping terminating call ${decoded.callRef} on recovery — deleting from cache`)
            yield* cache.deleteCall(ref)
            continue
          }

          yield* Effect.sync(() => MutableHashMap.set(callsMap, decoded.callRef, decoded))
          yield* indexCall(decoded)
          yield* Ref.update(totalRef, (n) => n + 1)
          totalSync++
          loaded.push(decoded)
        }

        yield* Effect.logInfo(`Loaded ${loaded.length} owned calls from cache for worker ${workerIndex}`)
        return loaded
      })

      const flushAllCalls = Effect.fn("CallState.flushAllCalls")(function* () {
        let flushed = 0
        for (const [callRef, call] of callsMap) {
          const json = Schema.encodeSync(JsonCallSchema)(call)
          yield* cache.putCall(callRef, json, ttl)
          yield* writeCacheIndexes(call)
          flushed++
        }
        yield* Effect.logInfo(`Flushed ${flushed} calls to cache`)
      })

      // ── Orphan sweep ──────────────────────────────────────────────────
      // Safety net: remove calls stuck in terminal state (terminated/terminating)
      // from in-memory maps. These should have been cleaned up by the normal
      // remove() path, but can leak if a handler throws after checkout.
      // Uses setInterval (not Effect.sleep) to avoid TestClock issues in tests.
      const ORPHAN_SWEEP_INTERVAL = 60_000 // 60s between sweeps
      const orphanSweepInterval = setInterval(() => {
        for (const [callRef, call] of callsMap) {
          if (call.state === "terminated" || call.state === "terminating") {
            // In-memory cleanup only — cache TTL handles persistence expiry
            MutableHashMap.remove(callsMap, callRef)
            MutableHashMap.remove(semaphores, callRef)
            MutableHashMap.remove(sipIndex, `${call.aLeg.callId}|${call.aLeg.fromTag}`)
            for (const bLeg of call.bLegs) {
              MutableHashMap.remove(sipIndex, `${bLeg.callId}|${bLeg.fromTag}`)
              MutableHashMap.remove(sipIndex, bLeg.callId)
              for (const dialog of bLeg.dialogs) {
                const bTag = dialog.sip.remoteTag
                if (bTag) MutableHashMap.remove(sipIndex, `${bLeg.callId}|${bTag}`)
              }
            }
            console.warn(`[CallState] Orphan sweep: removed ${call.state} call ${callRef}`)
          }
        }
      }, ORPHAN_SWEEP_INTERVAL)
      orphanSweepInterval.unref()
      yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(orphanSweepInterval)))

      return { create, checkout, update, peek, release, flushToRedis, remove, resolveFromSipKey, stats, statsSync, loadOwnedCalls, flushAllCalls }
    })
  )
}
