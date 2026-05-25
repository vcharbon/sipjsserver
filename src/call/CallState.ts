/**
 * CallState service — manages call lifecycle with in-memory + cache persistence.
 *
 * Design:
 * - In-memory MutableHashMap<callRef, Call> for active/checked-out calls
 * - In-memory MutableHashMap<sipKey, callRef> for SIP message → call routing
 * - In-memory MutableHashMap<callRef, Semaphore> for per-call sequential processing
 * - PartitionedRelayStorage for persistence: flush after key events, load on demand
 *
 * Persistence is delegated to the PartitionedRelayStorage service so the storage
 * substrate (Redis in production, in-memory test fake) is swappable. CallState
 * itself is the in-memory layer; PartitionedRelayStorage is the cache layer.
 *
 * Flush lifecycle:
 * 1. After /call/new response → flush initial state
 * 2. After 200 OK → flush confirmed state
 * 3. On idle (configurable) → flush and evict from memory
 * 4. On termination → schedule cache cleanup (with delay for retransmissions)
 *
 * Semaphore is released before async cache flush.
 */

import { Clock, Duration, Effect, Layer, MutableHashMap, Option, Ref, Semaphore, ServiceMap, Stream } from "effect"
import { BufferedTerminateWriter } from "../cache/BufferedTerminateWriter.js"
import {
  PartitionedRelayStorage,
  type PartitionRole,
  type StorageError,
} from "../cache/PartitionedRelayStorage.js"
import type { PropagateDirection } from "../cache/PartitionRef.js"
import { AppConfig } from "../config/AppConfig.js"
import { CdrWriter } from "../cdr/CdrWriter.js"
import { RedisError } from "../redis/RedisClient.js"
import { CallLimiter } from "./CallLimiter.js"
import { CallDecodeError, decodeBodyAutoEffect, encodeCall } from "./CallCodec.js"
import type { Call } from "./CallModel.js"
import { callIndexKeys, isFullyResolved, parseCallRef, setByeDisposition } from "./CallModel.js"
import type { TimerEntry } from "./CallModel.js"
import { replaceTimerById, TERMINATING_TIMEOUT_MS } from "./timer-helpers.js"
import { MetricsRegistry, type TerminatingCallsByBucket } from "../observability/MetricsRegistry.js"
import { TimerService } from "./TimerService.js"
import { TransactionLayer } from "../sip/TransactionLayer.js"
import { PerCallDispatcher } from "../sip/PerCallDispatcher.js"

// ---------------------------------------------------------------------------
// Codec-error diagnostics
// ---------------------------------------------------------------------------
//
// Endurance run 2026-05-09 surfaced a `SchemaError: Missing key at
// ['callRef']` from inside a `terminating_timeout` timer body, which
// `Effect.orDie` converted to a defect that halted the safety-net
// rule chain. The actual offending payload never made it into the
// log — the error was just `cause`-formatted with no payload context.
// Post-msgpackr-migration the encode path is no longer fallible (we
// trust the in-memory Call shape), so only the decode-failure
// diagnostic remains; it logs the truncated raw bytes hex so the
// next occurrence is identifiable.

const MAX_DIAG_PAYLOAD_BYTES = 256

const truncateBuffer = (buf: Buffer): string => {
  const slice = buf.length <= MAX_DIAG_PAYLOAD_BYTES
    ? buf
    : buf.subarray(0, MAX_DIAG_PAYLOAD_BYTES)
  const suffix =
    buf.length <= MAX_DIAG_PAYLOAD_BYTES
      ? ""
      : `…(truncated, full length=${buf.length})`
  return `${slice.toString("hex")}${suffix}`
}

const logDecodeFailure = (
  source: string,
  callRef: string | undefined,
  raw: Buffer,
) =>
  Effect.fnUntraced(function* (err: CallDecodeError) {
    yield* Effect.logError(
      `[CallState] CallDecodeError on ${source}` +
        `${callRef !== undefined ? ` callRef=${callRef}` : ""} — ${err.reason}` +
        ` payload(hex)=${truncateBuffer(raw)}`,
    )
  })

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
    /**
     * Run `body` while holding the per-callRef serialisation permit. The
     * call is loaded from memory or cache before `body` runs; the permit
     * is released by `Semaphore.withPermits`'s uninterruptible finalizer
     * on success, error, and fiber interrupt — so callers cannot leak it.
     */
    readonly withCall: <A, E, R>(
      callRef: string,
      body: (call: Call | undefined) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | RedisError, R>
    /**
     * Update a call in memory (must be inside a `withCall` body).
     *
     * `sourceLegId`, when present, identifies the leg whose event drove
     * this update. While `state === "terminating"`, only the first
     * update from each distinct leg refreshes the safety-purge timer —
     * subsequent updates from the same leg apply the mutation but leave
     * the timer running. Pass `undefined` for synthetic updates that
     * shouldn't extend the terminating window (timer rescheduling
     * helpers, trace-id seeding, etc.).
     */
    readonly update: (callRef: string, fn: (call: Call) => Call, sourceLegId?: string) => Effect.Effect<void>
    /** Get call without serialisation (read-only, from memory only). */
    readonly peek: (callRef: string) => Effect.Effect<Call | undefined>
    /**
     * Flush a call to the cache. Memory entry stays.
     *
     * Phase 2/4: routed through `BufferedTerminateWriter` so the SipRouter
     * consumer never blocks on Redis. Errors surface in the writer's
     * structured logging + `storageBuffer.fallthroughErrorTotal` metric.
     */
    readonly flushToRedis: (callRef: string) => Effect.Effect<void>
    /**
     * Remove a call from memory and schedule cache cleanup.
     *
     * Phase 2/4: cache delete routed through `BufferedTerminateWriter`.
     */
    readonly remove: (callRef: string) => Effect.Effect<void>
    /**
     * Last-resort cleanup for one specific call — same recovery actions as
     * the orphan sweep but driven on demand. Used by the safety-net
     * `terminating_timeout` timer when its rule-chain handler errored or
     * timed out, so the call doesn't have to wait up to 60 s for the
     * orphan sweep to notice.
     *
     * No-op when the call is no longer in `callsMap` (race with a
     * concurrent rule-path remove). Internal failures (CDR / limiter /
     * cache) are logged but never propagated — force-purge is itself
     * the last line of defence.
     */
    readonly forcePurge: (callRef: string, reason: string) => Effect.Effect<void>
    /** Resolve a SIP key (callId|tag) to a callRef, checking memory then cache. */
    readonly resolveFromSipKey: (callId: string, tag: string) => Effect.Effect<string | undefined, RedisError>
    /**
     * Memory-only synchronous variant of `resolveFromSipKey`. Returns
     * `undefined` if neither `callId|tag` nor `callId` is currently in
     * the in-memory `sipIndex`. Used by `SipRouter`'s dispatch routing
     * key resolver — it must never block on Redis. Missing in memory
     * surfaces as "route inline" (fallback to the existing `withCall`
     * flow which can do the async Redis lookup itself).
     */
    readonly resolveFromSipKeySync: (callId: string, tag: string) => string | undefined
    /** Get stats for the status endpoint. */
    readonly stats: () => Effect.Effect<{ concurrent: number; total: number }>
    /** Synchronous stats snapshot (for metrics interval — no Effect needed). */
    readonly statsSync: () => { concurrent: number; total: number; sipIndexSize: number; semaphoresSize: number; removeInvocations: number; orphanSweepRecoveredCount: number; flushCacheSize: number; flushCacheBytes: number }
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
      // Phase 4: terminate-path Redis I/O is routed through the
      // BufferedTerminateWriter so a stalled Redis cannot pin the
      // SipRouter consumer fiber on call eviction. Admission and
      // hot-dialog flushes still go through `storage` directly —
      // back-pressure on those paths is desirable.
      const terminateWriter = yield* BufferedTerminateWriter
      const config = yield* AppConfig
      const cdr = yield* CdrWriter
      const limiter = yield* CallLimiter
      const registry = yield* MetricsRegistry
      const timers = yield* TimerService
      // PerCallDispatcher is the per-callRef event-handler pool
      // (ADR-0004). `remove()` enqueues POISON so the worker drains
      // and removes its own map entry — symmetric cleanup. Resolved at
      // call time (not layer-build) so test stacks that omit it
      // (`cache-and-limiter` / HTTP-only call fixtures) still build;
      // when absent, the POISON enqueue is a no-op. Same mechanism as
      // the `TransactionLayer` deferred resolve below.
      const dispatcherPoisonForCallRef = (callRef: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const opt = yield* Effect.serviceOption(PerCallDispatcher)
          if (Option.isSome(opt)) yield* opt.value.enqueuePoison(callRef)
        })
      // TransactionLayer is read at call time (not at layer-build time)
      // because the build-time Effect.gen of CallState.layer runs BEFORE
      // the parent layer composition has provided TransactionLayer into
      // its scope; a build-time `serviceOption` returns None and the
      // cancellation becomes a no-op. Reading inside each method body
      // resolves against the calling fiber's context, where the worker
      // stack does have TransactionLayer in scope. Call-only test
      // harnesses (cache-and-limiter, HTTP-only CallStateLayer in main.ts)
      // legitimately have no TransactionLayer at call time and the no-op
      // branch is correct for them.
      const cancelTxnsForCallRef = (callRef: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const opt = yield* Effect.serviceOption(TransactionLayer)
          if (Option.isSome(opt)) yield* opt.value.cancelTxnsForCall(callRef)
        })
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
      // Fix #3: per-callRef cache of the last flushed (call ref, body) pair.
      // Hit when an auto-flush fires but the in-memory Call hasn't changed
      // since the previous flush — re-submits the cached body to refresh
      // TTL without re-encoding. Invalidated via `remove`/`forcePurgeOne`.
      const flushCache = MutableHashMap.empty<
        string,
        { readonly call: Call; readonly body: Buffer }
      >()
      // Diagnostic: count flushToRedis dedup hits + misses.
      let flushDedupHits = 0
      let flushDedupMisses = 0
      // ADR 0012 sizing observation. encodeCount counts every encodeCall
      // invocation; encodeBytesTotal sums the resulting Buffer sizes.
      // replicationWritesTotal counts submits to the buffered terminate
      // writer (== encodeCount + dedup re-submits).
      let encodeCount = 0
      let encodeBytesTotal = 0
      let replicationWritesTotal = 0
      const totalRef = yield* Ref.make(0)
      // Plain mutable counter shadowing totalRef for sync reads (metrics interval).
      let totalSync = 0
      // Diagnostic: count remove() invocations.
      let removeInvocations = 0

      // Forward reference — the safety-timer handler installed by
      // `update()` (the structural fix from ADR 0003 / plan
      // "this-kind-of-issue-flickering-moth" Phase 5) needs to invoke
      // `forcePurge`, but `forcePurge` is defined further down (after
      // `forcePurgeOne`'s dependencies). The timer body doesn't run
      // until `+TERMINATING_TIMEOUT_MS`, by which point this ref has
      // been bound. Using `!` at the call site is safe; if the ref
      // were ever still null at fire time, the call's signature on
      // CallState was constructed wrong (programmer error).
      let forcePurgeRef:
        | ((callRef: string, reason: string) => Effect.Effect<void>)
        | undefined = undefined
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
        Effect.gen(function* () {
          // Defensive setter: surface any cross-call key collision as a
          // structured warning instead of silently overwriting. Catches
          // logic bugs where two distinct calls produce the same
          // `callId|tag` pair.
          const safeSet = (key: string): Effect.Effect<void> =>
            Effect.gen(function* () {
              const existing = Option.getOrUndefined(MutableHashMap.get(sipIndex, key))
              if (existing !== undefined && existing !== call.callRef) {
                yield* Effect.logWarning(
                  `[CallState] sipIndex key '${key}' overwritten: ${existing} → ${call.callRef}`,
                )
              }
              yield* Effect.sync(() => MutableHashMap.set(sipIndex, key, call.callRef))
            })

          yield* safeSet(`${call.aLeg.callId}|${call.aLeg.fromTag}`)
          // Mirror the b-leg pattern below: also index by the b2bua's
          // own a-leg tag (= dialog.localTag, which a peer puts in the
          // toTag of in-dialog responses and the fromTag of any b2bua-
          // originated request that loops back through a misbehaving
          // proxy). Without this, a loopbacked request resolves to
          // `null` and gets 481'd. See docs/plan/structured-imagining-dewdrop.md.
          for (const dialog of call.aLeg.dialogs) {
            const aLocalTag = dialog.sip.localTag
            if (aLocalTag && aLocalTag !== call.aLeg.fromTag) {
              yield* safeSet(`${call.aLeg.callId}|${aLocalTag}`)
            }
          }
          for (const bLeg of call.bLegs) {
            yield* safeSet(`${bLeg.callId}|${bLeg.fromTag}`)
            yield* safeSet(bLeg.callId)
            for (const dialog of bLeg.dialogs) {
              const bTag = dialog.sip.remoteTag
              if (bTag) {
                yield* safeSet(`${bLeg.callId}|${bTag}`)
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

      // Pure load: returns the live call for `callRef` from memory or
      // cache, or `undefined` for cache-miss / tombstone / decode-error /
      // terminated-or-terminating-state. Holds no semaphore by itself —
      // it must run inside a `sem.withPermits(1)(...)` block (see
      // `withCall` below) so concurrent events for the same callRef are
      // serialised. Decode-failure rationale: see `logDecodeFailure`
      // above. Deleted calls produce `json === null` (the body slot is
      // hard-DEL'd by `storage.deleteCall` per
      // docs/plan/lets-plan-a-proper-crystalline-emerson.md), which
      // already maps to `undefined` here.
      const loadCall = Effect.fnUntraced(function* (callRef: string) {
        const inMemory = Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))
        if (inMemory !== undefined) return inMemory

        const { role, primary } = partitionOf(callRef)
        const body = yield* storage
          .getCall(role, primary, callRef)
          .pipe(Effect.mapError(toRedisErr))

        if (body === null) return undefined

        const decodedOpt = yield* decodeBodyAutoEffect(body, callRef).pipe(
          Effect.tapErrorTag(
            "CallDecodeError",
            logDecodeFailure("loadCall", callRef, body),
          ),
          Effect.option,
        )
        if (Option.isNone(decodedOpt)) return undefined
        const decoded = decodedOpt.value

        // Don't reload terminated/terminating calls into memory from cache.
        // "terminated": lingered in cache for retransmission safety but must
        //   not re-enter callsMap (otherwise noop handlers leak them).
        // "terminating": stuck after a crash — all transaction state is lost,
        //   so BYE responses will never arrive. Force-skip and let the cache
        //   entry expire naturally (or be cleaned by loadOwnedCalls).
        if (decoded.state === "terminated" || decoded.state === "terminating") {
          if (decoded.state === "terminating") {
            yield* Effect.logWarning(`loadCall skipping terminating call ${callRef} from cache — stuck after crash, deleting`)
            yield* cancelTxnsForCallRef(callRef)
            yield* terminateWriter.submitTerminateDelete(role, primary, callRef, callIndexKeys(decoded))
          }
          return undefined
        }

        yield* Effect.sync(() => MutableHashMap.set(callsMap, callRef, decoded))
        yield* indexCall(decoded)
        return decoded
      })

      // Public API: run `body` under the per-callRef serialisation
      // permit. `Semaphore.withPermits(1)` releases the permit in an
      // uninterruptible finalizer on success, error, AND fiber
      // interrupt, so the take/release pair cannot leak — the dangerous
      // shape that the historical `checkout` + `release` API allowed.
      // See sippperftest investigation 2026-05-02 for the measured
      // leak rate (~2 sems per call under 100 cps + 2 workers) on the
      // pre-fix code.
      const withCall = <A, E, R>(
        callRef: string,
        body: (call: Call | undefined) => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | RedisError, R> =>
        Effect.gen(function* () {
          const sem = yield* getSemaphore(callRef)
          return yield* sem.withPermits(1)(
            Effect.gen(function* () {
              const call = yield* loadCall(callRef)
              const result = yield* body(call)
              if (call === undefined) {
                // Memory hygiene: drop the per-callRef sem slot for
                // callRefs with no live call so the map cannot grow
                // unboundedly under retransmits / strays. Benign under
                // races: a concurrent fiber that re-creates the slot
                // protects nothing (no shared state for a missing call)
                // and the next sweep through this branch drops it again.
                yield* Effect.sync(() => MutableHashMap.remove(semaphores, callRef))
              }
              return result
            }),
          )
        })

      const update = Effect.fnUntraced(function* (
        callRef: string,
        fn: (call: Call) => Call,
        sourceLegId?: string,
      ) {
        // Phase 5 of "must-run effects under interruption" (ADR 0003):
        // every transition into `terminating` must install the safety
        // timer atomically with the state mutation. Pre-fix, the rule
        // chain emitted a `schedule-timer(terminating_timeout)` effect
        // separately and the interpreter could be interrupted between
        // the mutation and the scheduling, leaving calls stuck in
        // `terminating` until orphan sweep (60 s later). Doing both in
        // a small `uninterruptibleMask` whose body is sync JS +
        // `Effect.forkIn` (also sync from caller's POV) makes the
        // guarantee structural — no caller can bypass it.
        yield* Effect.uninterruptibleMask((_restore) =>
          Effect.gen(function* () {
            const opt = MutableHashMap.get(callsMap, callRef)
            if (Option.isNone(opt)) return
            const prev = opt.value
            const next = fn(prev)

            const enteringTerminating =
              prev.state !== "terminating" && next.state === "terminating"
            // While the call is in `terminating`, refresh the safety timer
            // at most ONCE per distinct leg. Each leg gets one budgeted
            // refresh — e.g. peer BYE 200 / 487 — and further updates
            // from the same leg apply the mutation but no longer extend
            // the window. Adversarial in-dialog noise (re-INVITE / OPTIONS
            // flood from a single leg) therefore cannot keep a call
            // immortal in `terminating`.
            const inTerminating =
              !enteringTerminating &&
              prev.state === "terminating" &&
              next.state === "terminating"
            const refreshedLegs = next.terminatingRefreshLegs ?? []
            const refreshingTerminating =
              inTerminating &&
              sourceLegId !== undefined &&
              !refreshedLegs.includes(sourceLegId)

            if (!enteringTerminating && !refreshingTerminating) {
              MutableHashMap.set(callsMap, callRef, next)
              return
            }

            const now = yield* Clock.currentTimeMillis
            const safetyEntry: TimerEntry = {
              id: `terminating-timeout-${callRef}`,
              type: "terminating_timeout",
              fireAt: now + TERMINATING_TIMEOUT_MS,
            }
            const updatedRefreshedLegs = enteringTerminating
              ? []
              : sourceLegId !== undefined && !refreshedLegs.includes(sourceLegId)
                ? [...refreshedLegs, sourceLegId]
                : refreshedLegs
            const withTimer: Call = {
              ...next,
              timers: replaceTimerById(next.timers, safetyEntry),
              terminatingRefreshLegs: updatedRefreshedLegs,
            }
            MutableHashMap.set(callsMap, callRef, withTimer)
            yield* timers.schedule(callRef, safetyEntry, (cr) =>
              forcePurgeRef !== undefined
                ? forcePurgeRef(cr, "safety_timer")
                : Effect.void,
            )
          }),
        )
      })

      const peek = Effect.fnUntraced(function* (callRef: string) {
        return Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))
      })

      const flushToRedis = Effect.fnUntraced(function* (callRef: string) {
        const call = Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))
        if (call === undefined) return

        // Fix #3 — dedup gate. If the in-memory Call reference is the
        // same one we flushed last time, re-submit the cached body to
        // refresh TTL on the primary (and propagate to the backup,
        // where the content-gate in EchoApply will skip the apply
        // because `_topology.gen` is unchanged). Skips the gen bump,
        // the msgpack pack of a ~100-field schema, and the 9-byte
        // stamp prefix alloc.
        const cached = MutableHashMap.get(flushCache, callRef)
        if (Option.isSome(cached) && cached.value.call === call) {
          flushDedupHits++
          const { role, primary } = partitionOf(callRef)
          const indexes = callIndexKeys(call)
          const peerOpt = propagatePeerFor(role, primary, call._topology)
          const direction = directionFor(role)
          const dedupCallGen = call._topology?.gen ?? 0
          yield* terminateWriter.submitTerminatePut(
            role, primary, callRef, cached.value.body, indexes, ttl, dedupCallGen,
            { peer: peerOpt, direction },
          )
          replicationWritesTotal++
          yield* Effect.logDebug(`Flushed call ${callRef} to cache (dedup hit)`)
          return
        }
        flushDedupMisses++

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

        // ADR-0011: bare codec bytes, no stamp prefix. The peer's
        // apply gate uses the wire frame's callGen, not a body-level
        // timestamp.
        const body = encodeCall(bumped)
        encodeCount++
        encodeBytesTotal += body.byteLength
        MutableHashMap.set(flushCache, callRef, { call: bumped, body })
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
        // Phase 2 + Phase 4: route every flush through the buffered
        // writer so the SipRouter consumer never blocks on Redis. Hot
        // paths still get back-pressure via the queue + fall-through;
        // terminate paths get the un-stallable guarantee that closes
        // the production incident (Phase 5 safety net + non-blocking
        // body inside the critical-effects mask in processResult).
        const flushCallGen = bumped._topology?.gen ?? 0
        yield* terminateWriter.submitTerminatePut(
          role, primary, callRef, body, indexes, ttl, flushCallGen,
          { peer: peerOpt, direction },
        )
        replicationWritesTotal++

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

        // Slice 1.5 — guarantee that no timer fiber outlives the call.
        // Today the rule path's InvariantEnforcer issues
        // `cancel-all-timers` before `remove-call`, so this is
        // idempotent for that path. It exists to also cover any future
        // caller of `remove()` (e.g. force-purge) without re-deriving
        // the invariant.
        yield* timers.cancelAll(callRef)

        // Clean memory + SIP index
        yield* Effect.sync(() => {
          MutableHashMap.remove(callsMap, callRef)
          MutableHashMap.remove(semaphores, callRef)
          // Fix #3 — drop the dedup-cache entry so a later create with
          // the same callRef doesn't accidentally hit an alias of a
          // dead Call object via `===`.
          MutableHashMap.remove(flushCache, callRef)

          if (call !== undefined) {
            MutableHashMap.remove(sipIndex, `${call.aLeg.callId}|${call.aLeg.fromTag}`)
            for (const dialog of call.aLeg.dialogs) {
              const aLocalTag = dialog.sip.localTag
              if (aLocalTag && aLocalTag !== call.aLeg.fromTag) {
                MutableHashMap.remove(sipIndex, `${call.aLeg.callId}|${aLocalTag}`)
              }
            }
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
        // Cancel any live client INVITE/BYE transactions for this call
        // BEFORE the storage delete. Pre-delete so that if a Timer B/F
        // fires concurrently and wins the race, it still resolves the
        // call and goes through the 481 reject path rather than firing
        // against a vanished call (the orphan-transaction leak).
        yield* cancelTxnsForCallRef(callRef)
        yield* terminateWriter.submitTerminateDelete(role, primary, callRef, indexes, {
          peer: peerOpt,
          direction,
        })
        // Per-call dispatcher cleanup (ADR-0004). POISON makes the
        // per-call worker drain and exit; its own fiber removes the
        // perCallQueues entry. No-op when dispatcher service is not in
        // scope (HTTP-only test fixtures).
        yield* dispatcherPoisonForCallRef(callRef)
      })

      const resolveFromSipKeySync = (callId: string, tag: string): string | undefined => {
        const byTag = Option.getOrUndefined(MutableHashMap.get(sipIndex, `${callId}|${tag}`))
        if (byTag !== undefined) return byTag
        return Option.getOrUndefined(MutableHashMap.get(sipIndex, callId))
      }

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
        //
        // EchoApply writes `idx:leg:*` alongside the `bak:` body on
        // every replicated UPDATE frame, so the backup worker's Redis
        // should have the index entries for any call whose body it
        // holds. If this lookup still fails, check that scanByPrefix
        // in PartitionedRelayStorageKvBacked correctly prefixes the
        // SCAN pattern with the RedisClient key prefix.
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

      const statsSync = (): { concurrent: number; total: number; sipIndexSize: number; semaphoresSize: number; removeInvocations: number; orphanSweepRecoveredCount: number; flushCacheSize: number; flushCacheBytes: number } => {
        let flushCacheBytes = 0
        for (const [, entry] of flushCache) flushCacheBytes += entry.body.byteLength
        return {
          concurrent: MutableHashMap.size(callsMap),
          total: totalSync,
          sipIndexSize: MutableHashMap.size(sipIndex),
          semaphoresSize: MutableHashMap.size(semaphores),
          removeInvocations,
          orphanSweepRecoveredCount,
          flushCacheSize: MutableHashMap.size(flushCache),
          flushCacheBytes,
        }
      }

      // Bucket every call currently in `terminating` by how long it has
      // been in that state. The historical bug (see
      // docs/plan/endurance-stuck-terminating-and-overload-hardening.md
      // Slice 1) drifted calls indefinitely inside `terminating`; the
      // `gte300s` bucket should always read zero in healthy systems.
      // Age is derived from the safety-net `terminating_timeout` timer:
      // `enteredAt = timer.fireAt - TERMINATING_TIMEOUT_MS`. For
      // crash-recovered calls that lost the timer entry, fall back to
      // `createdAt` so the canary still trips.
      const terminatingByBucket = (): TerminatingCallsByBucket => {
        const now = Date.now()
        let lt10s = 0
        let lt60s = 0
        let lt300s = 0
        let gte300s = 0
        for (const [, call] of callsMap) {
          if (call.state !== "terminating") continue
          const safety = call.timers.find((t) => t.type === "terminating_timeout")
          const enteredAt = safety !== undefined ? safety.fireAt - TERMINATING_TIMEOUT_MS : call.createdAt
          const ageMs = now - enteredAt
          if (ageMs < 10_000) lt10s++
          else if (ageMs < 60_000) lt60s++
          else if (ageMs < 300_000) lt300s++
          else gte300s++
        }
        return { lt10s, lt60s, lt300s, gte300s }
      }
      const flushCacheBytesSync = (): number => {
        let total = 0
        for (const [, entry] of flushCache) total += entry.body.byteLength
        return total
      }
      registry.callState = {
        terminatingByBucket,
        concurrentCallsCount: () => MutableHashMap.size(callsMap),
        flushCacheSize: () => MutableHashMap.size(flushCache),
        flushCacheBytes: flushCacheBytesSync,
        encodeCount: () => encodeCount,
        encodeBytesTotal: () => encodeBytesTotal,
        replicationWritesTotal: () => replicationWritesTotal,
      }

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
          const decoded = yield* decodeBodyAutoEffect(entry.body).pipe(
            Effect.tapErrorTag(
              "CallDecodeError",
              logDecodeFailure("loadOwnedCalls", undefined, entry.body),
            ),
            Effect.orDie,
          )

          // Skip terminating calls on recovery — they were mid-teardown when
          // the worker crashed. All transaction state is lost, so BYE responses
          // will never arrive. Delete from cache to prevent permanent leaks.
          if (decoded.state === "terminating") {
            yield* Effect.logWarning(`Skipping terminating call ${decoded.callRef} on recovery — deleting from cache`)
            // Slice 1.5 — defensive cancelAll. No fibers are armed yet
            // for this call on this boot (rehydrate happens after
            // loadOwnedCalls), so this is a no-op today. Kept so the
            // "drop the call" primitive is consistently paired with
            // "drop its timers" on every code path.
            yield* timers.cancelAll(decoded.callRef)
            yield* cancelTxnsForCallRef(decoded.callRef)
            yield* terminateWriter.submitTerminateDelete(
              "pri",
              selfOrdinal,
              decoded.callRef,
              callIndexKeys(decoded),
            )
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
          const body = encodeCall(bumped)
          const { role, primary } = partitionOf(callRef)
          const indexes = callIndexKeys(bumped)
          // Slice 6 + Slice B: same peer-selection rule as flushToRedis;
          // replication is implicit in the Lua write — no separate
          // fan-out.
          const peerOpt = propagatePeerFor(role, primary, bumped._topology)
          const direction = directionFor(role)
          const allFlushCallGen = bumped._topology?.gen ?? 0
          yield* storage
            .putCall(role, primary, callRef, body, indexes, ttl, allFlushCallGen, {
              peer: peerOpt,
              direction,
            })
            .pipe(Effect.mapError(toRedisErr))
          flushed++
        }
        yield* Effect.logInfo(`Flushed ${flushed} calls to cache`)
      })

      // ── Force-purge primitive shared by orphan sweep + safety-timer ────
      // Performs the full set of side effects the rule-path `remove-call`
      // would have done for one specific call, plus the leg-disposition
      // force-resolve that `terminating-safety-timeout` does. The caller
      // is responsible for the diagnostic log line (orphan sweep prints
      // age; the safety-timer path prints the failure reason).
      //
      // All inner failures are caught + logged. Force-purge is itself
      // the last line of defence — if its CDR write / cache delete /
      // limiter decrement bounces, we still want every other step to
      // run so the in-memory entry is gone.
      const forcePurgeOne = Effect.fnUntraced(function* (callRef: string) {
        const original = Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))
        if (original === undefined) return

        let promoted = original
        const wasTerminating = promoted.state === "terminating"
        if (wasTerminating) {
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

        yield* cdr.write(promoted).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(`Force-purge CDR write failed for ${callRef}`, cause)
          )
        )

        const { role, primary } = partitionOf(callRef)

        // Mirror the InvariantEnforcer's decrement-limiter on the
        // rule path: the natural primary releases its window slots
        // when the call truly ends. Backups must not decrement
        // (would double-decrement on takeover races).
        if (wasTerminating && role === "pri") {
          for (const entry of promoted.limiterEntries) {
            // Skip DECR if the matching INCR never landed (fail-open
            // admission, see CallLimiterState.incrementSucceeded).
            // Older replicated entries omit the flag (`undefined`) and
            // reflect successful INCRs — only explicit `false` means skip.
            if (entry.incrementSucceeded === false) continue
            // Phase 7 / Trap 4: explicit short timeout. Limiter window
            // rotation is self-repairing — a missed DECR leaks at most
            // one window. Wrapping in `ensuring` would convert a slow
            // Redis hang into a stalled force-purge.
            yield* limiter.decrement(entry.limiterId, entry.originWindow).pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(config.limiterDecrementTimeoutMs),
                orElse: () =>
                  Effect.logError(
                    `Force-purge limiter decrement timed out for ${callRef} ` +
                      `(limiter=${entry.limiterId}, ${config.limiterDecrementTimeoutMs}ms)`,
                  ),
              }),
              Effect.catchTag("RedisError", (e) =>
                Effect.logError(
                  `Force-purge limiter decrement failed for ${callRef} ` +
                    `(limiter=${entry.limiterId}): ${e.reason}`
                )
              )
            )
          }
        }

        // Drop the call's timer fibers BEFORE removing the in-memory
        // entry, otherwise a still-armed keepalive or safety timer
        // would fire against a callRef that no longer resolves, eating
        // CPU + emitting an OTel span every cycle until the timer
        // expires. Same rationale for the transaction-layer cancel:
        // any in-flight INVITE/BYE retransmit fiber must die together
        // with the call, otherwise Timer B/F fires +32s against a
        // vanished call (see TransactionLayer.cancelTxnsForCall doc).
        yield* timers.cancelAll(callRef)
        yield* cancelTxnsForCallRef(callRef)

        MutableHashMap.remove(callsMap, callRef)
        MutableHashMap.remove(semaphores, callRef)
        // Fix #3 — same invalidation as `remove()`.
        MutableHashMap.remove(flushCache, callRef)
        MutableHashMap.remove(sipIndex, `${promoted.aLeg.callId}|${promoted.aLeg.fromTag}`)
        for (const dialog of promoted.aLeg.dialogs) {
          const aLocalTag = dialog.sip.localTag
          if (aLocalTag && aLocalTag !== promoted.aLeg.fromTag) {
            MutableHashMap.remove(sipIndex, `${promoted.aLeg.callId}|${aLocalTag}`)
          }
        }
        for (const bLeg of promoted.bLegs) {
          MutableHashMap.remove(sipIndex, `${bLeg.callId}|${bLeg.fromTag}`)
          MutableHashMap.remove(sipIndex, bLeg.callId)
          for (const dialog of bLeg.dialogs) {
            const bTag = dialog.sip.remoteTag
            if (bTag) MutableHashMap.remove(sipIndex, `${bLeg.callId}|${bTag}`)
          }
        }
        const indexes = callIndexKeys(promoted)
        const peerOpt = propagatePeerFor(role, primary, promoted._topology)
        const direction = directionFor(role)
        yield* terminateWriter.submitTerminateDelete(role, primary, callRef, indexes, {
          peer: peerOpt,
          direction,
        })
        // Symmetric per-call dispatcher cleanup — see remove() above.
        yield* dispatcherPoisonForCallRef(callRef)
      })

      const forcePurge = Effect.fnUntraced(function* (callRef: string, reason: string) {
        const present = Option.getOrUndefined(MutableHashMap.get(callsMap, callRef))
        if (present === undefined) return
        yield* Effect.logWarning(
          `[CallState] Force-purging call ${callRef} state=${present.state} reason=${reason}`
        )
        yield* forcePurgeOne(callRef)
      })

      // Bind the forward reference declared at the top of the layer
      // body, so the safety-timer handler installed by `update()`
      // can invoke force-purge when it fires.
      forcePurgeRef = forcePurge

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
        // Stage 4 of docs/plan/to-review-and-properly-swift-moler.md:
        // the orphan sweep no longer purges every `terminating` call on
        // the 60s tick. Instead it respects the per-call safety timer's
        // `fireAt`, which `CallState.update` refreshes on every event
        // for the callRef. Net effect: an in-flight dialog that gets a
        // peer response during a chaos window is NOT purged just because
        // it has been in `terminating` for >60s.
        //
        // `terminated` calls (corner case where rule-path cleanup
        // missed) are still swept immediately — they're cleaned up
        // logically, just need their memory entry removed.
        const now = yield* Clock.currentTimeMillis
        const orphans: Array<{ callRef: string; state: Call["state"]; createdAt: number }> = []
        for (const [callRef, call] of callsMap) {
          if (call.state === "terminated") {
            orphans.push({ callRef, state: call.state, createdAt: call.createdAt })
            continue
          }
          if (call.state === "terminating") {
            const safety = call.timers.find((t) => t.type === "terminating_timeout")
            const deadline =
              safety !== undefined
                ? safety.fireAt
                : call.createdAt + TERMINATING_TIMEOUT_MS
            if (now >= deadline) {
              orphans.push({ callRef, state: call.state, createdAt: call.createdAt })
            }
          }
        }
        for (const { callRef, state, createdAt } of orphans) {
          yield* Effect.logWarning(
            `[CallState] Orphan sweep recovering ${state} call ${callRef}` +
              ` (age ${Date.now() - createdAt}ms)`
          )
          yield* forcePurgeOne(callRef)
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

      return { create, withCall, update, peek, flushToRedis, remove, forcePurge, resolveFromSipKey, resolveFromSipKeySync, stats, statsSync, loadOwnedCalls, flushAllCalls }
    })
  )
}
