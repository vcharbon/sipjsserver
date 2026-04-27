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

import { Effect, Layer, MutableHashMap, Option, Ref, Schema, Semaphore, ServiceMap, Stream } from "effect"
import {
  PartitionedRelayStorage,
  type PartitionRole,
  type StorageError,
} from "../cache/PartitionedRelayStorage.js"
import {
  PeerCachePort,
  WorkerOrdinal,
  type PeerWriteError,
} from "../cache/PeerCachePort.js"
import { AppConfig } from "../config/AppConfig.js"
import { RedisError } from "../redis/RedisClient.js"
import type { Call } from "./CallModel.js"
import { Call as CallSchema, parseCallRef } from "./CallModel.js"

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
      const storage = yield* PartitionedRelayStorage
      const config = yield* AppConfig
      const ttl = config.callContextTtlSec
      // Slice 5: optional cross-pod cache port. When present, every
      // local flush also fires-and-forgets a remote write to the
      // call's `_topology.bak` peer (D3: failures must NEVER block
      // the local write). When absent (single-worker tests / dev),
      // the dual-write path is a no-op.
      const peerCachePort = yield* Effect.serviceOption(PeerCachePort)
      // Slice 4/5: this worker's ordinal, used to compute
      // `(role, primary)` from a callRef. Prefers the explicit
      // `workerOrdinalLabel` (production K8s pod hostname; matches the
      // `WorkerId` string the proxy puts in the cookie); falls back to
      // `String(workerIndex)` (clustered mode) and finally to "self"
      // (single-worker tests / dev). Mirrors `SipRouter.ts`.
      const selfOrdinal =
        config.workerOrdinalLabel !== undefined
          ? config.workerOrdinalLabel
          : config.workerIndex >= 0
            ? String(config.workerIndex)
            : "self"

      // In-memory state
      const callsMap = MutableHashMap.empty<string, Call>()
      const sipIndex = MutableHashMap.empty<string, string>()
      const semaphores = MutableHashMap.empty<string, Semaphore.Semaphore>()
      const totalRef = yield* Ref.make(0)
      // Plain mutable counter shadowing totalRef for sync reads (metrics interval).
      let totalSync = 0

      // Slice 4: convert StorageError → RedisError to keep CallState's
      // declared error type stable for downstream catchers.
      const toRedisErr = (e: StorageError): RedisError =>
        new RedisError({ reason: e.reason })

      // Slice 4: for a given callRef, derive (role, primary) so the
      // storage path is `{role}:{primary}:call:{callRef}`. callRef
      // encodes the natural primary in its first segment (Option C of
      // the HA-resilience plan, D15). Legacy refs without the primary
      // segment fall back to `(pri, self)` so existing tests that build
      // callRefs by hand keep working.
      const partitionOf = (
        callRef: string
      ): { role: PartitionRole; primary: string } => {
        const parsed = parseCallRef(callRef)
        if (parsed === null) {
          return { role: "pri", primary: selfOrdinal }
        }
        return {
          role: parsed.primary === selfOrdinal ? "pri" : "bak",
          primary: parsed.primary,
        }
      }

      // Slice 5: decide whether to fan a write/delete out to the
      // backup peer named in `_topology.bak`. Returns `Option.none()`
      // when the call has no topology, or when bak equals self
      // (degenerate single-worker case from cookie encode time), or
      // when the peer port is not provided.
      const backupTarget = (
        call: Call
      ): Option.Option<{
        readonly peer: WorkerOrdinal
        readonly role: PartitionRole
        readonly owner: WorkerOrdinal
      }> => {
        if (Option.isNone(peerCachePort)) return Option.none()
        const topo = call._topology
        if (topo === undefined) return Option.none()
        if (topo.bak.length === 0) return Option.none()
        if (topo.bak === selfOrdinal) return Option.none()
        // The backup peer always stores under `bak:{cookie.w_pri}:`
        // — D16 (recovery write-back invariant). The "owner" is the
        // cookie's natural primary, not `self`.
        return Option.some({
          peer: WorkerOrdinal(topo.bak),
          role: "bak" as const,
          owner: WorkerOrdinal(topo.pri),
        })
      }

      // Slice 5: fire-and-forget remote write. D3: failures must NEVER
      // block the local write or fail the call event. We log + swallow.
      const fanOutPut = (
        call: Call,
        callRef: string,
        json: string,
        indexes: ReadonlyArray<string>
      ): Effect.Effect<void> => {
        const tgt = backupTarget(call)
        if (Option.isNone(tgt)) return Effect.void
        if (Option.isNone(peerCachePort)) return Effect.void
        const port = peerCachePort.value
        const remote = port
          .putCall({
            peer: tgt.value.peer,
            role: tgt.value.role,
            owner: tgt.value.owner,
            callRef,
            state: json,
            indexes,
            ttlSec: ttl,
          })
          .pipe(
            Effect.catchTag("PeerWriteError", (e: PeerWriteError) =>
              Effect.logWarning(
                `Backup peer-write failed for ${callRef} (peer=${e.peer} reason=${e.reason})`
              )
            )
          )
        return Effect.forkChild(remote).pipe(Effect.asVoid)
      }

      const fanOutDelete = (
        call: Call | undefined,
        callRef: string,
        indexes: ReadonlyArray<string>
      ): Effect.Effect<void> => {
        if (call === undefined) return Effect.void
        const tgt = backupTarget(call)
        if (Option.isNone(tgt)) return Effect.void
        if (Option.isNone(peerCachePort)) return Effect.void
        const port = peerCachePort.value
        const remote = port
          .deleteCall({
            peer: tgt.value.peer,
            role: tgt.value.role,
            owner: tgt.value.owner,
            callRef,
            indexes,
          })
          .pipe(
            Effect.catchTag("PeerWriteError", (e: PeerWriteError) =>
              Effect.logWarning(
                `Backup peer-delete failed for ${callRef} (peer=${e.peer} reason=${e.reason})`
              )
            )
          )
        return Effect.forkChild(remote).pipe(Effect.asVoid)
      }

      // Slice 4: build the flat list of index keys associated with a
      // call (collapses what used to be `writeCacheIndexes` /
      // `refreshIndexTtl` index-writes into an array passed to the
      // storage's all-at-once put/refresh/delete ops).
      const callIndexKeys = (call: Call): Array<string> => {
        const keys: Array<string> = [legKey(call.aLeg.callId, call.aLeg.fromTag)]
        for (const bLeg of call.bLegs) {
          keys.push(legKey(bLeg.callId, bLeg.fromTag))
          keys.push(legCallIdKey(bLeg.callId))
          for (const dialog of bLeg.dialogs) {
            const bTag = dialog.sip.remoteTag
            if (bTag) keys.push(legKey(bLeg.callId, bTag))
          }
        }
        if (call.callbackContext !== undefined) {
          keys.push(ctxKey(call.callbackContext))
        }
        return keys
      }

      const getSemaphore = Effect.fnUntraced(function* (callRef: string) {
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

      // Slice 4: writeCacheIndexes / refreshIndexTtl collapse into the
      // single `storage.putCall` / `storage.refreshCall` calls that
      // take the index-keys list inline. See `flushToRedis` and
      // `flushAllCalls` below.

      const create = Effect.fnUntraced(function* (call: Call) {
        yield* Effect.sync(() => MutableHashMap.set(callsMap, call.callRef, call))
        yield* indexCall(call)
        yield* Ref.update(totalRef, (n) => n + 1)
        totalSync++
        return call.callRef
      })

      const checkout = Effect.fnUntraced(function* (callRef: string) {
        const sem = yield* getSemaphore(callRef)
        yield* Semaphore.take(sem, 1)

        const inMemory = Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))
        if (inMemory !== undefined) return inMemory

        const { role, primary } = partitionOf(callRef)
        const json = yield* storage
          .getCall(role, primary, callRef)
          .pipe(Effect.mapError(toRedisErr))
        if (json === null) {
          yield* Semaphore.release(sem, 1)
          return undefined
        }

        const decoded = yield* Schema.decodeUnknownEffect(JsonCallSchema)(json).pipe(
          Effect.orDie,
        )

        // Don't reload terminated/terminating calls into memory from cache.
        // "terminated": lingered in cache for retransmission safety but must
        //   not re-enter callsMap (otherwise noop handlers leak them).
        // "terminating": stuck after a crash — all transaction state is lost,
        //   so BYE responses will never arrive. Force-skip and let the cache
        //   entry expire naturally (or be cleaned by loadOwnedCalls).
        if (decoded.state === "terminated" || decoded.state === "terminating") {
          if (decoded.state === "terminating") {
            yield* Effect.logWarning(`Checkout skipping terminating call ${callRef} from cache — stuck after crash, deleting`)
            yield* storage
              .deleteCall(role, primary, callRef, callIndexKeys(decoded))
              .pipe(Effect.mapError(toRedisErr))
          }
          yield* Semaphore.release(sem, 1)
          return undefined
        }

        yield* Effect.sync(() => MutableHashMap.set(callsMap, callRef, decoded))
        yield* indexCall(decoded)
        return decoded
      })

      const update = Effect.fnUntraced(function* (
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

      const peek = Effect.fnUntraced(function* (callRef: string) {
        return Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))
      })

      const release = Effect.fnUntraced(function* (callRef: string) {
        const sem = Option.getOrUndefined(MutableHashMap.get(semaphores, callRef))
        if (sem !== undefined) {
          yield* Semaphore.release(sem, 1)
        }
      })

      const flushToRedis = Effect.fnUntraced(function* (callRef: string) {
        const call = Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))
        if (call === undefined) return

        // Slice 5: bump `_topology.gen` BEFORE encoding so the persisted
        // value carries the new generation. Newest-`gen` wins on
        // partition-heal conflict resolution (D7). When `_topology` is
        // absent (legacy in-memory-only path), leave it absent — the
        // dual-write logic only fires when topology is present anyway.
        const bumped: Call =
          call._topology !== undefined
            ? {
                ...call,
                _topology: { ...call._topology, gen: call._topology.gen + 1 },
              }
            : call

        if (bumped !== call) {
          yield* Effect.sync(() =>
            MutableHashMap.set(callsMap, callRef, bumped)
          )
        }

        const json = yield* Schema.encodeEffect(JsonCallSchema)(bumped).pipe(
          Effect.orDie
        )
        const { role, primary } = partitionOf(callRef)
        const indexes = callIndexKeys(bumped)
        yield* storage
          .putCall(role, primary, callRef, json, indexes, ttl)
          .pipe(Effect.mapError(toRedisErr))

        // Slice 5: AFTER the local write succeeds, fan out to the
        // backup peer. Best-effort — never blocks or fails the local
        // write event (D3).
        yield* fanOutPut(bumped, callRef, json, indexes)

        yield* Effect.logDebug(`Flushed call ${callRef} to cache`)
      })

      const remove = Effect.fnUntraced(function* (callRef: string) {
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
        const { role, primary } = partitionOf(callRef)
        const indexes = call !== undefined ? callIndexKeys(call) : []
        // Slice 5: fan delete out to the backup peer too (best-effort).
        yield* fanOutDelete(call, callRef, indexes)
        yield* storage
          .deleteCall(role, primary, callRef, indexes)
          .pipe(Effect.mapError(toRedisErr))
      })

      const resolveFromSipKey = Effect.fnUntraced(function* (
        callId: string,
        tag: string
      ) {
        const byTag = Option.getOrUndefined(MutableHashMap.get(sipIndex, `${callId}|${tag}`))
        if (byTag !== undefined) return byTag

        const byCallId = Option.getOrUndefined(MutableHashMap.get(sipIndex, callId))
        if (byCallId !== undefined) return byCallId

        // Slice 4: indexes are flat in the partitioned storage —
        // `idx:{indexKey} → callRef`. The callRef itself encodes the
        // primary, so a single hop here gives us everything we need
        // for the subsequent `checkout` to derive the partition path.
        const ref = yield* storage
          .getIndex(legKey(callId, tag))
          .pipe(Effect.mapError(toRedisErr))
        if (ref !== null) return ref

        const refById = yield* storage
          .getIndex(legCallIdKey(callId))
          .pipe(Effect.mapError(toRedisErr))
        return refById ?? undefined
      })

      const stats = Effect.fnUntraced(function* () {
        const total = yield* Ref.get(totalRef)
        return { concurrent: MutableHashMap.size(callsMap), total }
      })

      const statsSync = (): { concurrent: number; total: number; sipIndexSize: number; semaphoresSize: number } => ({
        concurrent: MutableHashMap.size(callsMap),
        total: totalSync,
        sipIndexSize: MutableHashMap.size(sipIndex),
        semaphoresSize: MutableHashMap.size(semaphores),
      })

      const loadOwnedCalls = Effect.fnUntraced(function* (workerIndex: number) {
        // Slice 4: with the partitioned keyspace, "calls owned by self
        // as primary" live in `pri:{self.ordinal}:call:*`. The Option-C
        // callRef encoding ensures every entry in this partition is
        // by definition owned by `self`, so the redundant
        // `decoded.workerIndex !== workerIndex` filter that the legacy
        // single-flat-keyspace code needed is no longer required.
        const entries = yield* Stream.runCollect(
          storage.scanCalls("pri", selfOrdinal)
        ).pipe(Effect.mapError(toRedisErr))
        const loaded: Call[] = []

        for (const entry of entries) {
          const decoded = yield* Schema.decodeUnknownEffect(JsonCallSchema)(entry.json).pipe(
            Effect.orDie,
          )

          // Skip terminating calls on recovery — they were mid-teardown when
          // the worker crashed. All transaction state is lost, so BYE responses
          // will never arrive. Delete from cache to prevent permanent leaks.
          if (decoded.state === "terminating") {
            yield* Effect.logWarning(`Skipping terminating call ${decoded.callRef} on recovery — deleting from cache`)
            yield* storage
              .deleteCall("pri", selfOrdinal, decoded.callRef, callIndexKeys(decoded))
              .pipe(Effect.mapError(toRedisErr))
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

      const flushAllCalls = Effect.fnUntraced(function* () {
        let flushed = 0
        for (const [callRef, call] of callsMap) {
          // Slice 5: same gen bump as flushToRedis — the persisted JSON
          // must carry the bumped value.
          const bumped: Call =
            call._topology !== undefined
              ? {
                  ...call,
                  _topology: { ...call._topology, gen: call._topology.gen + 1 },
                }
              : call
          if (bumped !== call) {
            MutableHashMap.set(callsMap, callRef, bumped)
          }
          const json = yield* Schema.encodeEffect(JsonCallSchema)(bumped).pipe(Effect.orDie)
          const { role, primary } = partitionOf(callRef)
          const indexes = callIndexKeys(bumped)
          yield* storage
            .putCall(role, primary, callRef, json, indexes, ttl)
            .pipe(Effect.mapError(toRedisErr))
          // Slice 5: fan out best-effort. flushAllCalls is the drain
          // path (D5) — we want every backup to have the latest gen.
          yield* fanOutPut(bumped, callRef, json, indexes)
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
