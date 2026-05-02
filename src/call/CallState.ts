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
import type { PropagateDirection } from "../replication/AtomicWriter.js"
import { AppConfig } from "../config/AppConfig.js"
import { CdrWriter } from "../cdr/CdrWriter.js"
import { RedisError } from "../redis/RedisClient.js"
import type { Call } from "./CallModel.js"
import { Call as CallSchema, callIndexKeys, isFullyResolved, parseCallRef, setByeDisposition } from "./CallModel.js"

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
    readonly statsSync: () => { concurrent: number; total: number; sipIndexSize: number; semaphoresSize: number; removeInvocations: number; orphanSweepRecoveredCount: number }
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
      const cdr = yield* CdrWriter
      const ttl = config.callContextTtlSec
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
      // Diagnostic: count remove() invocations.
      let removeInvocations = 0
      // Counts calls the orphan sweep had to recover (rule path missed the
      // terminating→terminated transition or worker crashed mid-cleanup).
      // Should stay at 0 in healthy systems; non-zero indicates the sweep
      // is the only thing keeping CDR/Redis state consistent.
      let orphanSweepRecoveredCount = 0

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

      /**
       * Choose the propagate peer for a write, depending on which role
       * this worker holds for the call:
       *
       * - role==="pri" (we are the call's natural primary): propagate to
       *   the LB-assigned backup `_topology.bak`. Skip if absent or
       *   equal to self (degenerate cookie / single-copy call).
       * - role==="bak" (we are taking over for the original primary
       *   `primary`): propagate to `primary` itself so that when the
       *   original primary returns from its outage its ReadyGate drains
       *   `propagate:{primary}` from us and merges the takeover state
       *   into its own `pri:{primary}:` partition (spec §10.3, §11.2).
       *   Without this branch, takeover writes were silently lost
       *   because the previous code only propagated to `_topology.bak`
       *   — which equals self in the takeover case — so `peer===self`
       *   was filtered out and nothing announced.
       */
      const propagatePeerFor = (
        role: PartitionRole,
        primary: string,
        topology: { readonly pri: string; readonly bak: string; readonly gen: number } | undefined
      ): string | undefined => {
        if (role === "pri") {
          if (
            topology !== undefined &&
            topology.bak.length > 0 &&
            topology.bak !== selfOrdinal
          ) {
            return topology.bak
          }
          return undefined
        }
        // role === "bak" — we are writing into the original primary's
        // partition. Always announce to that primary so it can pick up
        // takeover edits on its return. `primary` is, by partitionOf
        // construction, !== selfOrdinal whenever role is "bak".
        return primary.length > 0 ? primary : undefined
      }

      /**
       * Slice 2.4 direction tag for the propagate stream. Forward when
       * this worker is the call's primary (we ZADD into the backup
       * peer's `propagate:{peer}` set on our sidecar; the receiver
       * applies to `bak:{self}:`). Reverse when this worker is acting
       * as backup-on-behalf-of the original primary (we ZADD into
       * `propagate:{primary}` on our sidecar; on its eventual reboot
       * the primary's ReadyGate drains it and applies the entries to
       * its own `pri:{primary}:` partition — single-owner invariant
       * preserved, spec §0).
       */
      const directionFor = (role: PartitionRole): PropagateDirection =>
        role === "pri" ? "forward" : "reverse"

      // Slice 6: dual-write fan-out is gone. Replication is now driven
      // by the propagate stream + ReplPuller (slices 2-4): every write
      // through `storage.putCall` (with a peer attached) atomically
      // bumps `propagate:{peer}` inside the same Lua, and the peer's
      // ReplPuller picks it up over the long-poll. CallState no longer
      // forks an HTTP push.

      // Slice 4: index-key computation collapses what used to be
      // `writeCacheIndexes` / `refreshIndexTtl` into an array passed
      // to the storage's all-at-once put/refresh/delete ops. The
      // helper is exported from `CallModel.ts` so `ReclaimRunner`
      // (slice 6) can reuse it when copying entries into local
      // storage on recovery — keeps the index shape in lock-step with
      // the write path.

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
          // No call exists for this callRef — neither in memory nor cache.
          // The semaphore that `getSemaphore` just inserted is now orphaned:
          // the caller will not invoke `remove(callRef)` (there's no call to
          // remove), and the orphan sweep at the bottom of this layer only
          // iterates callsMap so it would never see this entry. Without this
          // cleanup, every misrouted request / late retransmission / cross-
          // worker stray packet would leak one SemaphoreImpl until process
          // restart. See sippperftest investigation 2026-05-02 for the
          // measured leak rate (~2 sems per call under 100 cps + 2 workers).
          yield* Semaphore.release(sem, 1)
          yield* Effect.sync(() => MutableHashMap.remove(semaphores, callRef))
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
          // Same orphan-semaphore cleanup as the json===null branch above.
          // Without this, every retransmitted message for an already-
          // terminated call leaks a SemaphoreImpl.
          yield* Effect.sync(() => MutableHashMap.remove(semaphores, callRef))
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
        // Slice 2: when role==="pri" and the LB has assigned a backup,
        // propagate to that backup. Slice B (bye-takeover-replicated-
        // indexes-fix): when role==="bak" we are taking over for the
        // original primary, so propagate to `primary` itself.
        const peerOpt = propagatePeerFor(role, primary, bumped._topology)
        // Slice 2.4 direction tag: forward (role==="pri") lands in the
        // peer's `bak:{self}:`; reverse (role==="bak") lands in the
        // returning primary's `pri:{primary}:` after its ReadyGate drain.
        const direction = directionFor(role)
        yield* storage
          .putCall(role, primary, callRef, json, indexes, ttl, {
            peer: peerOpt,
            direction,
          })
          .pipe(Effect.mapError(toRedisErr))

        // Slice 6: replication is implicit in the Lua write above —
        // when `peerOpt` is set, the storage layer's atomic script
        // ZADDs `propagate:{peer}` and the peer's ReplPuller observes
        // it via its open long-poll. No HTTP fan-out from CallState.

        yield* Effect.logDebug(`Flushed call ${callRef} to cache`)
      })

      const remove = Effect.fnUntraced(function* (callRef: string) {
        const call = Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))

        // Diagnostic: count remove() invocations to detect missed cleanups.
        removeInvocations++

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
        // Slice 2/6 + Slice B: same peer-selection rule as flushToRedis.
        // The delete event is announced through `propagate:{peer}` so
        // the backup's ReplPuller observes termination on its open
        // long-poll. Takeover deletes (role==="bak") propagate to the
        // original primary so its ReadyGate sees the tombstone on
        // return.
        const peerOpt = propagatePeerFor(
          role,
          primary,
          call !== undefined ? call._topology : undefined
        )
        const direction = directionFor(role)
        yield* storage
          .deleteCall(role, primary, callRef, indexes, {
            peer: peerOpt,
            direction,
          })
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

      const statsSync = (): { concurrent: number; total: number; sipIndexSize: number; semaphoresSize: number; removeInvocations: number; orphanSweepRecoveredCount: number } => ({
        concurrent: MutableHashMap.size(callsMap),
        total: totalSync,
        sipIndexSize: MutableHashMap.size(sipIndex),
        semaphoresSize: MutableHashMap.size(semaphores),
        removeInvocations,
        orphanSweepRecoveredCount,
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
          // Slice 6 + Slice B: same peer-selection rule as flushToRedis;
          // replication is implicit in the Lua write — no separate
          // fan-out.
          const peerOpt = propagatePeerFor(role, primary, bumped._topology)
          const direction = directionFor(role)
          yield* storage
            .putCall(role, primary, callRef, json, indexes, ttl, {
              peer: peerOpt,
              direction,
            })
            .pipe(Effect.mapError(toRedisErr))
          flushed++
        }
        yield* Effect.logInfo(`Flushed ${flushed} calls to cache`)
      })

      // ── Orphan sweep ──────────────────────────────────────────────────
      // Last-line recovery: if the rule-engine cleanup path missed a call (or
      // the worker crashed mid-cleanup), the sweep performs the *full* set of
      // side effects the normal `remove-call` rule effect would have done —
      // CDR write, Redis delete, replication tombstone — so a missed rule path
      // becomes a perf hit, not a correctness loss. Forks a daemon fiber that
      // sleeps on the active Clock; under TestClock the sleep parks until
      // `TestClock.adjust` advances past the interval, so fake-clock tests see
      // no sweep activity unless they explicitly opt in.
      const ORPHAN_SWEEP_INTERVAL_MS = 60_000

      const sweepOnce = Effect.gen(function* () {
        const orphans: Array<{ callRef: string; call: Call }> = []
        for (const [callRef, call] of callsMap) {
          if (call.state === "terminated" || call.state === "terminating") {
            orphans.push({ callRef, call })
          }
        }
        for (const { callRef, call: original } of orphans) {
          // Force-resolve any leg whose BYE never reached terminal disposition
          // so isFullyResolved() returns true and the CDR / cleanup record is
          // internally consistent. Mirrors what `terminating-safety-timeout`
          // would have produced if the rule path had completed.
          let promoted = original
          if (promoted.state === "terminating") {
            for (const leg of [promoted.aLeg, ...promoted.bLegs]) {
              const bd = leg.byeDisposition
              if (bd === undefined || bd === "bye_sent") {
                promoted = setByeDisposition(promoted, leg.legId, "bye_timeout")
              }
            }
            if (isFullyResolved(promoted)) {
              promoted = { ...promoted, state: "terminated" }
            }
          }

          yield* Effect.logWarning(
            `[CallState] Orphan sweep recovering ${original.state} call ${callRef}` +
              ` (age ${Date.now() - promoted.createdAt}ms)`
          )

          yield* cdr.write(promoted).pipe(
            Effect.catchCause((cause) =>
              Effect.logError(`Orphan sweep CDR write failed for ${callRef}`, cause)
            )
          )

          // Mirror remove(): drop in-memory state, then atomic Redis delete +
          // tombstone propagation. Ignore RedisError so one failing peer
          // doesn't stop the rest of the sweep.
          MutableHashMap.remove(callsMap, callRef)
          MutableHashMap.remove(semaphores, callRef)
          MutableHashMap.remove(sipIndex, `${promoted.aLeg.callId}|${promoted.aLeg.fromTag}`)
          for (const bLeg of promoted.bLegs) {
            MutableHashMap.remove(sipIndex, `${bLeg.callId}|${bLeg.fromTag}`)
            MutableHashMap.remove(sipIndex, bLeg.callId)
            for (const dialog of bLeg.dialogs) {
              const bTag = dialog.sip.remoteTag
              if (bTag) MutableHashMap.remove(sipIndex, `${bLeg.callId}|${bTag}`)
            }
          }
          const { role, primary } = partitionOf(callRef)
          const indexes = callIndexKeys(promoted)
          const peerOpt = propagatePeerFor(role, primary, promoted._topology)
          const direction = directionFor(role)
          yield* storage
            .deleteCall(role, primary, callRef, indexes, { peer: peerOpt, direction })
            .pipe(
              Effect.catchTag("PartitionedRelayStorageError", (e) =>
                Effect.logError(`Orphan sweep Redis delete failed for ${callRef}: ${e.reason}`)
              )
            )

          orphanSweepRecoveredCount++
        }
      })

      // Bind the orphan-sweep daemon to the layer's scope so it dies
      // together with the worker that built CallState. With
      // `forkDetach` the daemon kept ticking against a stale closure
      // after a simulated `kill` in the failover harness, holding open
      // references to the just-killed worker's CDR/storage services.
      const layerScope = yield* Effect.scope
      yield* Effect.forkIn(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(ORPHAN_SWEEP_INTERVAL_MS)
            yield* sweepOnce
          }
        }),
        layerScope,
      )

      return { create, checkout, update, peek, release, flushToRedis, remove, resolveFromSipKey, stats, statsSync, loadOwnedCalls, flushAllCalls }
    })
  )
}
