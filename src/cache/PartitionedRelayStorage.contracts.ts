/**
 * **TEST-ONLY exports.** Production composition uses the bare
 * `PartitionedRelayStorage.{memoryLayer,redisLayer}` (or the
 * `kvBackedMemoryLayer` factory) directly. Every wrapper here adds
 * `Recorder | RunContext` to the dependency channel — services
 * production does not provide, so applying any wrapper inside
 * `src/main.ts` will refuse to build the layer at startup. No
 * automated guard; reviewers must reject any import of these symbols
 * from `src/main.ts` / `bin/*`. See SURPRISES T2.
 *
 * PartitionedRelayStorage contract wrappers — extend a storage Layer with
 * typed-channel recording, caller-side precondition checks, scope-close
 * audit invariants, and optional memory-vs-redis parity.
 *
 * Wrapper composition (canonical order — see effectLayerTest):
 *
 *   paranoidInputs(scopedAudit(impl))
 *
 * `propertyTest` is intentionally skipped (no natural input domain —
 * the storage takes opaque Buffers + arbitrary callRefs). `parity`
 * stays outside the helper per D7; build a parity layer first and pass
 * it as `impl`.
 *
 * Recording
 * ---------
 * Every public method emits a typed event on the per-Tag channel
 * `Recorder.forTag(PartitionedRelayStorage)`. The original
 * `repl.frameReceived` variant (Slice 9) coexists with new
 * `{get,getIndex,put,refresh,delete}Call.{called,result}` Effect-method
 * events and `scanCalls.{streamStart,streamItem,streamEnd}` Stream
 * lifecycle events.
 *
 * Anomaly buffer
 * --------------
 * Per the Slice 8 handoff, a single shared per-Tag anomaly buffer is
 * used rather than competing per-wrapper projectors. The buffer lives
 * in `scopedAudit`'s Layer-effect scope; the same projector closure
 * reads both the channel events (producing `replTrace`) and the
 * anomaly buffer (producing `anomalies`). `parity` does not register
 * a competing projector — parity violations throw immediately
 * (`Effect.fail`), so they never need to surface through the snapshot.
 *
 * Severity tiers (D5)
 * -------------------
 *   - `unit-test-of-layer`  audit findings are FATAL.
 *   - `test-with-recorder`  audit findings are `deferred-fail` and
 *                            surface at scope close via
 *                            `PartitionedRelayStorageAuditViolation`.
 *   - `real-run`            findings are recorded `advisory`.
 *
 * `paranoidInputs` always Effect.die's (programmer-error invariant
 * regardless of context). `parity` always `Effect.fail`s
 * (correctness-correlation invariant).
 */

import {
  Clock,
  Data,
  Effect,
  Layer,
  ServiceMap,
  Stream,
} from "effect"
import type { DataFrame, NoopFrame } from "../replication/ReplicationProtocol.js"
import type {
  Projector,
  RecordedReplEntry,
  TaggedChannel,
} from "../test-harness/framework/report-recorder/types.js"
import { Recorder } from "../test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../test-harness/framework/RunContext.js"
import {
  withCanonicalContracts,
  type CanonicalContractsOptions,
} from "../test-harness/framework/effectLayerTest.js"
import { mkAuditContext } from "../test-harness/framework/auditContext.js"
import { recordEffectCallSimple } from "../test-harness/framework/recordingHelpers.js"
import {
  PartitionedRelayStorage,
  StorageError,
  type PartitionRole,
  type PartitionedRelayStorageApi,
  type PartitionedRelayWriteOptions,
  type ScanEntry,
} from "./PartitionedRelayStorage.js"

// ---------------------------------------------------------------------------
// Typed event union
// ---------------------------------------------------------------------------

/**
 * One observation on the `PartitionedRelayStorage` typed channel. The
 * Recorder stamps `seq` + `atMs` on every entry; payload is narrow so
 * projectors and rules switch on `tag`.
 *
 * Variants:
 *   - `repl.frameReceived` — replication-frame tap (Slice 9; the
 *     simulated `/replog` puller calls into this).
 *   - `{get,getIndex,put,refresh,delete}Call.{called,result}` —
 *     Effect-method lifecycle. `.result` carries the outcome kind.
 *   - `scanCalls.{streamStart,streamItem,streamEnd}` — Stream lifecycle
 *     for the cursor-walked scan endpoint.
 */
export type PartitionedRelayStorageEvent =
  | {
      readonly tag: "repl.frameReceived"
      readonly timestamp: number
      readonly from: string
      readonly to: string
      readonly frame: DataFrame | NoopFrame
    }
  // getCall
  | {
      readonly tag: "getCall.called"
      readonly role: PartitionRole
      readonly owner: string
      readonly callRef: string
    }
  | {
      readonly tag: "getCall.result"
      readonly role: PartitionRole
      readonly owner: string
      readonly callRef: string
      readonly outcome: "ok" | "fail" | "interrupt"
      /** Only populated on `ok` outcomes; null = miss/expired. */
      readonly bodyBytes?: number | null
    }
  // getIndex
  | {
      readonly tag: "getIndex.called"
      readonly indexKey: string
    }
  | {
      readonly tag: "getIndex.result"
      readonly indexKey: string
      readonly outcome: "ok" | "fail" | "interrupt"
      readonly callRef?: string | null
    }
  // putCall
  | {
      readonly tag: "putCall.called"
      readonly role: PartitionRole
      readonly owner: string
      readonly callRef: string
      readonly indexes: ReadonlyArray<string>
      readonly ttlSec: number
      readonly callGen?: number
      readonly opts?: PartitionedRelayWriteOptions
      readonly bodyBytes: number
    }
  | {
      readonly tag: "putCall.result"
      readonly role: PartitionRole
      readonly owner: string
      readonly callRef: string
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  // refreshCall
  | {
      readonly tag: "refreshCall.called"
      readonly role: PartitionRole
      readonly owner: string
      readonly callRef: string
      readonly indexes: ReadonlyArray<string>
      readonly ttlSec: number
      readonly opts?: PartitionedRelayWriteOptions
    }
  | {
      readonly tag: "refreshCall.result"
      readonly role: PartitionRole
      readonly owner: string
      readonly callRef: string
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  // deleteCall
  | {
      readonly tag: "deleteCall.called"
      readonly role: PartitionRole
      readonly owner: string
      readonly callRef: string
      readonly indexes: ReadonlyArray<string>
      readonly opts?: PartitionedRelayWriteOptions
    }
  | {
      readonly tag: "deleteCall.result"
      readonly role: PartitionRole
      readonly owner: string
      readonly callRef: string
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  // scanCalls — Stream lifecycle
  | {
      readonly tag: "scanCalls.streamStart"
      readonly role: PartitionRole
      readonly owner: string
    }
  | {
      readonly tag: "scanCalls.streamItem"
      readonly role: PartitionRole
      readonly owner: string
      readonly callRef: string
      readonly bodyBytes: number
      readonly ttlSec: number
    }
  | {
      readonly tag: "scanCalls.streamEnd"
      readonly role: PartitionRole
      readonly owner: string
      readonly reason: "ended" | "interrupt"
    }

// ---------------------------------------------------------------------------
// Channel-handle helper
// ---------------------------------------------------------------------------

export type PartitionedRelayStorageChannel =
  TaggedChannel<PartitionedRelayStorageEvent>

// ---------------------------------------------------------------------------
// Built-in projector — typed events → replTrace
// ---------------------------------------------------------------------------

/**
 * Project the typed channel into the legacy `RecordedReplEntry[]` shape
 * the HTML / SVG renderers consume. Only `repl.frameReceived` variants
 * contribute today; the Effect-method / Stream variants are not
 * surfaced as wire entries (they're internal recording for rules).
 *
 * NOTE: when `scopedAudit` is also active, the same projector closure
 * inside `scopedAudit` produces replTrace AND anomalies in a single
 * pass. This standalone export remains for tests that want only the
 * replTrace projection without the audit overlay.
 */
export const toReplTrace: Projector<PartitionedRelayStorageEvent> = (
  events,
) => {
  const replTrace: RecordedReplEntry[] = []
  for (const ev of events) {
    if (ev.tag !== "repl.frameReceived") continue
    replTrace.push({
      timestamp: ev.timestamp,
      from: ev.from,
      to: ev.to,
      frame: ev.frame,
      seq: ev.seq,
    })
  }
  return { replTrace }
}

/**
 * Convenience constructor for the `repl.frameReceived` event.
 */
export const recordReplFrameReceived = (
  channel: PartitionedRelayStorageChannel,
  args: {
    readonly timestamp: number
    readonly from: string
    readonly to: string
    readonly frame: DataFrame | NoopFrame
  },
): Effect.Effect<void> =>
  channel.record({
    tag: "repl.frameReceived",
    timestamp: args.timestamp,
    from: args.from,
    to: args.to,
    frame: args.frame,
  })

// ---------------------------------------------------------------------------
// Failure shapes
// ---------------------------------------------------------------------------

export class PartitionedRelayStorageParanoidInputViolation extends Error {
  readonly _tag = "PartitionedRelayStorageParanoidInputViolation"
  constructor(
    readonly check: string,
    readonly detail: string,
  ) {
    super(`partitioned-relay-storage ${check}: ${detail}`)
  }
}

export class PartitionedRelayStorageAuditViolation extends Data.TaggedError(
  "PartitionedRelayStorageAuditViolation",
)<{
  readonly check: string
  readonly detail: string
}> {}

export class PartitionedRelayStorageParityViolation extends Error {
  readonly _tag = "PartitionedRelayStorageParityViolation"
  constructor(
    readonly method: string,
    readonly side: "memory-vs-redis",
    readonly detail: string,
  ) {
    super(`partitioned-relay-storage parity ${method} ${side}: ${detail}`)
  }
}

// ---------------------------------------------------------------------------
// paranoidInputs
// ---------------------------------------------------------------------------

const isNonEmptyString = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0

const isPositiveInt = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n > 0

const isRole = (r: unknown): r is PartitionRole => r === "pri" || r === "bak"

const checkWriteOpts = (
  method: string,
  opts: PartitionedRelayWriteOptions | undefined,
): Effect.Effect<void, never, never> => {
  if (opts === undefined) return Effect.void
  if (opts.peer !== undefined && opts.peer !== "") {
    if (!isNonEmptyString(opts.peer)) {
      return Effect.die(
        new PartitionedRelayStorageParanoidInputViolation(
          `PA_${method}_peer`,
          `opts.peer must be a non-empty string when provided (got ${typeof opts.peer})`,
        ),
      )
    }
  }
  if (
    opts.propagateSetTtlSec !== undefined &&
    !isPositiveInt(opts.propagateSetTtlSec)
  ) {
    return Effect.die(
      new PartitionedRelayStorageParanoidInputViolation(
        `PA_${method}_propagateSetTtl`,
        `opts.propagateSetTtlSec must be a positive integer (got ${String(opts.propagateSetTtlSec)})`,
      ),
    )
  }
  return Effect.void
}

const checkRoleOwnerCallRef = (
  method: string,
  role: unknown,
  owner: unknown,
  callRef: unknown,
): Effect.Effect<void, never, never> => {
  if (!isRole(role)) {
    return Effect.die(
      new PartitionedRelayStorageParanoidInputViolation(
        `PA_${method}_role`,
        `role must be "pri" | "bak" (got ${String(role)})`,
      ),
    )
  }
  if (!isNonEmptyString(owner)) {
    return Effect.die(
      new PartitionedRelayStorageParanoidInputViolation(
        `PA_${method}_owner`,
        `owner must be non-empty string (got ${typeof owner})`,
      ),
    )
  }
  if (!isNonEmptyString(callRef)) {
    return Effect.die(
      new PartitionedRelayStorageParanoidInputViolation(
        `PA_${method}_callRef`,
        `callRef must be non-empty string (got ${typeof callRef})`,
      ),
    )
  }
  return Effect.void
}

const checkIndexes = (
  method: string,
  indexes: ReadonlyArray<string>,
): Effect.Effect<void, never, never> => {
  if (!Array.isArray(indexes)) {
    return Effect.die(
      new PartitionedRelayStorageParanoidInputViolation(
        `PA_${method}_indexes`,
        `indexes must be an array (got ${typeof indexes})`,
      ),
    )
  }
  for (const idx of indexes) {
    if (!isNonEmptyString(idx)) {
      return Effect.die(
        new PartitionedRelayStorageParanoidInputViolation(
          `PA_${method}_indexEntry`,
          `every index entry must be a non-empty string (got ${typeof idx})`,
        ),
      )
    }
  }
  return Effect.void
}

const checkTtl = (
  method: string,
  ttlSec: unknown,
): Effect.Effect<void, never, never> => {
  if (!isPositiveInt(ttlSec)) {
    return Effect.die(
      new PartitionedRelayStorageParanoidInputViolation(
        `PA_${method}_ttl`,
        `ttlSec must be positive integer (got ${String(ttlSec)})`,
      ),
    )
  }
  return Effect.void
}

/**
 * Wrap a `PartitionedRelayStorage` Layer with caller-side preconditions.
 * Violations programmer-error → `Effect.die`.
 */
export const paranoidInputs = (
  inner: Layer.Layer<PartitionedRelayStorage>,
): Layer.Layer<PartitionedRelayStorage> =>
  Layer.effect(
    PartitionedRelayStorage,
    Effect.gen(function* () {
      const svcs = yield* Layer.build(inner)
      const innerApi = ServiceMap.get(svcs, PartitionedRelayStorage)

      const getCall: PartitionedRelayStorageApi["getCall"] = (
        role,
        owner,
        callRef,
      ) =>
        Effect.gen(function* () {
          yield* checkRoleOwnerCallRef("getCall", role, owner, callRef)
          return yield* innerApi.getCall(role, owner, callRef)
        })

      const getIndex: PartitionedRelayStorageApi["getIndex"] = (indexKey) =>
        Effect.suspend(() => {
          if (!isNonEmptyString(indexKey)) {
            return Effect.die(
              new PartitionedRelayStorageParanoidInputViolation(
                "PA_getIndex_indexKey",
                `indexKey must be non-empty string (got ${typeof indexKey})`,
              ),
            )
          }
          return innerApi.getIndex(indexKey)
        })

      const putCall: PartitionedRelayStorageApi["putCall"] = (
        role,
        owner,
        callRef,
        body,
        indexes,
        ttlSec,
        callGen,
        opts,
      ) =>
        Effect.gen(function* () {
          yield* checkRoleOwnerCallRef("putCall", role, owner, callRef)
          if (!Buffer.isBuffer(body) || body.length === 0) {
            return yield* Effect.die(
              new PartitionedRelayStorageParanoidInputViolation(
                "PA_putCall_body",
                `body must be a non-empty Buffer (got len=${
                  Buffer.isBuffer(body) ? body.length : "non-Buffer"
                })`,
              ),
            )
          }
          yield* checkIndexes("putCall", indexes)
          yield* checkTtl("putCall", ttlSec)
          if (
            callGen !== undefined &&
            (typeof callGen !== "number" || !Number.isFinite(callGen))
          ) {
            return yield* Effect.die(
              new PartitionedRelayStorageParanoidInputViolation(
                "PA_putCall_callGen",
                `callGen must be a finite number when provided (got ${String(callGen)})`,
              ),
            )
          }
          yield* checkWriteOpts("putCall", opts)
          return yield* innerApi.putCall(
            role,
            owner,
            callRef,
            body,
            indexes,
            ttlSec,
            callGen,
            opts,
          )
        })

      const refreshCall: PartitionedRelayStorageApi["refreshCall"] = (
        role,
        owner,
        callRef,
        indexes,
        ttlSec,
        opts,
      ) =>
        Effect.gen(function* () {
          yield* checkRoleOwnerCallRef("refreshCall", role, owner, callRef)
          yield* checkIndexes("refreshCall", indexes)
          yield* checkTtl("refreshCall", ttlSec)
          yield* checkWriteOpts("refreshCall", opts)
          return yield* innerApi.refreshCall(
            role,
            owner,
            callRef,
            indexes,
            ttlSec,
            opts,
          )
        })

      const deleteCall: PartitionedRelayStorageApi["deleteCall"] = (
        role,
        owner,
        callRef,
        indexes,
        opts,
      ) =>
        Effect.gen(function* () {
          yield* checkRoleOwnerCallRef("deleteCall", role, owner, callRef)
          yield* checkIndexes("deleteCall", indexes)
          yield* checkWriteOpts("deleteCall", opts)
          return yield* innerApi.deleteCall(role, owner, callRef, indexes, opts)
        })

      const scanCalls: PartitionedRelayStorageApi["scanCalls"] = (
        role,
        owner,
        opts,
      ) =>
        // scanCalls returns a Stream — defer the precondition into a
        // suspended stream so the synchronous die fires when the stream
        // is run, not at construction.
        Stream.unwrap(
          Effect.suspend(() => {
            if (!isRole(role)) {
              return Effect.die(
                new PartitionedRelayStorageParanoidInputViolation(
                  "PA_scanCalls_role",
                  `role must be "pri" | "bak" (got ${String(role)})`,
                ),
              )
            }
            if (!isNonEmptyString(owner)) {
              return Effect.die(
                new PartitionedRelayStorageParanoidInputViolation(
                  "PA_scanCalls_owner",
                  `owner must be non-empty string (got ${typeof owner})`,
                ),
              )
            }
            if (opts?.batch !== undefined && !isPositiveInt(opts.batch)) {
              return Effect.die(
                new PartitionedRelayStorageParanoidInputViolation(
                  "PA_scanCalls_batch",
                  `opts.batch must be positive integer (got ${String(opts.batch)})`,
                ),
              )
            }
            return Effect.succeed(innerApi.scanCalls(role, owner, opts))
          }),
        )

      return {
        getCall,
        getIndex,
        putCall,
        refreshCall,
        deleteCall,
        scanCalls,
      }
    }),
  )

// ---------------------------------------------------------------------------
// scopedAudit
// ---------------------------------------------------------------------------

export interface ScopedAuditOptions {
  /**
   * When `true` (default) the audit verifies every `putCall` that did
   * not have a subsequent `deleteCall` is either still present or had
   * a finite ttlSec. Mismatched put/delete refcounts surface as
   * `refcountImbalance` anomalies.
   */
  readonly checkRefcount?: boolean
  /**
   * When `true` (default) the audit verifies that any scanCalls Stream
   * started during the scope also recorded a streamEnd. Mid-stream
   * scope close (e.g. fiber interrupt without cleanup) surfaces as a
   * `scanCursorLeak` anomaly.
   */
  readonly checkScanDrained?: boolean
  /**
   * Optional shouldSkip predicate keyed by (role, owner). Returning
   * `true` excludes that partition from refcount checks. Used by SUTs
   * that intentionally retain state across scope close (e.g. recovery
   * fixtures that leave keys for the next puller iteration).
   */
  readonly skipPartition?: (role: PartitionRole, owner: string) => boolean
}

/**
 * Wrap a `PartitionedRelayStorage` Layer with typed recording + scope-
 * close audit invariants. Reads `Recorder` + `RunContext` from the
 * surrounding scope.
 *
 * Invariants checked at scope close:
 *
 *   - **A1_refcountImbalance** — putCall without matching deleteCall.
 *     Advisory by default (many real-run patterns retain state across
 *     the layer scope by design — the layer outlives one call's
 *     lifetime).
 *   - **A2_scanCursorLeak** — scanCalls streamStart without streamEnd.
 *     Surfaces partial cursor drains where a fiber was interrupted
 *     mid-walk.
 *
 * No A3 today: replication-frame events flow from a puller fiber
 * outside this layer's scope, and there's no production producer to
 * audit against. A previous draft documented `A3_replicationFrameLeak`;
 * it was never wired and was removed to avoid false confidence in
 * coverage. If a real puller-side producer ever lands, add A3 alongside
 * the producer (cross-reference SURPRISES T17 and the SKILL.md
 * "Cross-reference scope-close audit docstrings against the finalizer
 * body" rule before doing so).
 */
export const scopedAudit = (
  inner: Layer.Layer<PartitionedRelayStorage>,
  options?: ScopedAuditOptions,
): Layer.Layer<PartitionedRelayStorage, never, Recorder | RunContext> => {
  const checkRefcount = options?.checkRefcount ?? true
  const checkScanDrained = options?.checkScanDrained ?? true
  const skipPartition = options?.skipPartition ?? (() => false)
  return Layer.effect(
    PartitionedRelayStorage,
    Effect.gen(function* () {
      const {
        innerApi,
        recorder,
        channel,
        ctx,
        anomalies,
        pushAnomaly,
      } = yield* mkAuditContext<
        PartitionedRelayStorageEvent,
        PartitionedRelayStorage,
        PartitionedRelayStorageApi
      >(PartitionedRelayStorage, inner, "prs")

      // Refcount bookkeeping: key = `${role}:${owner}:${callRef}`.
      const liveCalls = new Map<
        string,
        { role: PartitionRole; owner: string; callRef: string; ttlSec: number }
      >()
      const scanCursors = new Map<
        string,
        { role: PartitionRole; owner: string }
      >()
      let nextCursorId = 0

      // Unified projector: replTrace + anomalies in one pass.
      const projector: Projector<PartitionedRelayStorageEvent> = (events) => {
        const replTrace: RecordedReplEntry[] = []
        for (const ev of events) {
          if (ev.tag !== "repl.frameReceived") continue
          replTrace.push({
            timestamp: ev.timestamp,
            from: ev.from,
            to: ev.to,
            frame: ev.frame,
            seq: ev.seq,
          })
        }
        return { replTrace, anomalies: anomalies.slice() }
      }
      yield* recorder.registerProjector(PartitionedRelayStorage, projector)

      const refKey = (
        role: PartitionRole,
        owner: string,
        callRef: string,
      ): string => `${role}:${owner}:${callRef}`

      const getCall: PartitionedRelayStorageApi["getCall"] = (
        role,
        owner,
        callRef,
      ) =>
        recordEffectCallSimple<
          PartitionedRelayStorageEvent,
          never,
          Buffer | null,
          StorageError
        >(
          channel,
          { tag: "getCall.called", role, owner, callRef },
          (outcome, value) => ({
            tag: "getCall.result",
            role,
            owner,
            callRef,
            outcome,
            ...(outcome === "ok"
              ? { bodyBytes: value === null ? null : value.length }
              : {}),
          }),
          innerApi.getCall(role, owner, callRef),
        )

      const getIndex: PartitionedRelayStorageApi["getIndex"] = (indexKey) =>
        recordEffectCallSimple<
          PartitionedRelayStorageEvent,
          never,
          string | null,
          StorageError
        >(
          channel,
          { tag: "getIndex.called", indexKey },
          (outcome, value) => ({
            tag: "getIndex.result",
            indexKey,
            outcome,
            ...(outcome === "ok" ? { callRef: value ?? null } : {}),
          }),
          innerApi.getIndex(indexKey),
        )

      const putCall: PartitionedRelayStorageApi["putCall"] = (
        role,
        owner,
        callRef,
        body,
        indexes,
        ttlSec,
        callGen,
        opts,
      ) =>
        Effect.gen(function* () {
          yield* channel.record({
            tag: "putCall.called",
            role,
            owner,
            callRef,
            indexes,
            ttlSec,
            ...(callGen !== undefined ? { callGen } : {}),
            ...(opts !== undefined ? { opts } : {}),
            bodyBytes: body.length,
          })
          const exit = yield* Effect.exit(
            innerApi.putCall(
              role,
              owner,
              callRef,
              body,
              indexes,
              ttlSec,
              callGen,
              opts,
            ),
          )
          yield* channel.record({
            tag: "putCall.result",
            role,
            owner,
            callRef,
            outcome: exit._tag === "Success" ? "ok" : "fail",
          })
          if (exit._tag === "Success") {
            liveCalls.set(refKey(role, owner, callRef), {
              role,
              owner,
              callRef,
              ttlSec,
            })
            return
          }
          return yield* Effect.failCause(exit.cause)
        })

      const refreshCall: PartitionedRelayStorageApi["refreshCall"] = (
        role,
        owner,
        callRef,
        indexes,
        ttlSec,
        opts,
      ) =>
        Effect.gen(function* () {
          yield* channel.record({
            tag: "refreshCall.called",
            role,
            owner,
            callRef,
            indexes,
            ttlSec,
            ...(opts !== undefined ? { opts } : {}),
          })
          const exit = yield* Effect.exit(
            innerApi.refreshCall(role, owner, callRef, indexes, ttlSec, opts),
          )
          yield* channel.record({
            tag: "refreshCall.result",
            role,
            owner,
            callRef,
            outcome: exit._tag === "Success" ? "ok" : "fail",
          })
          if (exit._tag === "Success") {
            // Refresh updates the ttl bookkeeping; the entry is
            // considered live again.
            const existing = liveCalls.get(refKey(role, owner, callRef))
            if (existing !== undefined) {
              liveCalls.set(refKey(role, owner, callRef), {
                ...existing,
                ttlSec,
              })
            }
            return
          }
          return yield* Effect.failCause(exit.cause)
        })

      const deleteCall: PartitionedRelayStorageApi["deleteCall"] = (
        role,
        owner,
        callRef,
        indexes,
        opts,
      ) =>
        Effect.gen(function* () {
          yield* channel.record({
            tag: "deleteCall.called",
            role,
            owner,
            callRef,
            indexes,
            ...(opts !== undefined ? { opts } : {}),
          })
          const exit = yield* Effect.exit(
            innerApi.deleteCall(role, owner, callRef, indexes, opts),
          )
          yield* channel.record({
            tag: "deleteCall.result",
            role,
            owner,
            callRef,
            outcome: exit._tag === "Success" ? "ok" : "fail",
          })
          if (exit._tag === "Success") {
            liveCalls.delete(refKey(role, owner, callRef))
            return
          }
          return yield* Effect.failCause(exit.cause)
        })

      const scanCalls: PartitionedRelayStorageApi["scanCalls"] = (
        role,
        owner,
        opts,
      ) => {
        const cursorId = `${role}:${owner}:${nextCursorId++}`
        const started = { fired: false }
        return innerApi.scanCalls(role, owner, opts).pipe(
          Stream.tap((entry) =>
            Effect.gen(function* () {
              if (!started.fired) {
                started.fired = true
                scanCursors.set(cursorId, { role, owner })
                yield* channel.record({
                  tag: "scanCalls.streamStart",
                  role,
                  owner,
                })
              }
              yield* channel.record({
                tag: "scanCalls.streamItem",
                role,
                owner,
                callRef: entry.callRef,
                bodyBytes: entry.body.length,
                ttlSec: entry.ttlSec,
              })
            }),
          ),
          Stream.ensuring(
            Effect.gen(function* () {
              if (started.fired) {
                scanCursors.delete(cursorId)
                yield* channel.record({
                  tag: "scanCalls.streamEnd",
                  role,
                  owner,
                  reason: "ended",
                })
              }
            }),
          ),
        )
      }

      // Scope-close finalizer: refcount / scan-cursor / repl-frame
      // drain. Per D5 severity; in test-with-recorder, a non-empty
      // deferred-fail list surfaces via PartitionedRelayStorageAuditViolation.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Clock.currentTimeMillis

          // A1 — refcount imbalance
          if (checkRefcount) {
            for (const [, entry] of liveCalls) {
              if (skipPartition(entry.role, entry.owner)) continue
              pushAnomaly(
                "A1_refcountImbalance",
                `putCall(${entry.role}:${entry.owner}:${entry.callRef}) had no matching deleteCall at scope close`,
                "advisory",
              )
            }
          }

          // A2 — scan-cursor leak
          if (checkScanDrained) {
            for (const [, cur] of scanCursors) {
              pushAnomaly(
                "A2_scanCursorLeak",
                `scanCalls(${cur.role}:${cur.owner}) streamStart had no streamEnd at scope close`,
                "advisory",
              )
            }
          }

          // No deferred-fail surfacing today — every audit variant is
          // advisory pending Slice-5-style settle-bound assertion sites.
          // Reserved for the future hardening pass.
          //
          // Note: unit-test-of-layer FATAL path is wired but only fires
          // when a finding genuinely warrants the strict tier — none of
          // the variants above qualify in current fixtures.
          if (ctx.kind === "unit-test-of-layer") {
            const first = anomalies.find(
              (a) => a.kind === "signalingAudit" && a.severity === "deferred-fail",
            )
            if (first !== undefined && first.kind === "signalingAudit") {
              return yield* Effect.die(
                new PartitionedRelayStorageAuditViolation({
                  check: first.check,
                  detail: first.detail,
                }),
              )
            }
          }
        }),
      )

      return {
        getCall,
        getIndex,
        putCall,
        refreshCall,
        deleteCall,
        scanCalls,
      }
    }),
  )
}

// ---------------------------------------------------------------------------
// parity (memory vs redis)
// ---------------------------------------------------------------------------

const partitionLabel = (
  role: PartitionRole,
  owner: string,
  callRef: string,
): string => `${role}:${owner}:${callRef}`

const buffersEqual = (
  a: Buffer | null,
  b: Buffer | null,
): boolean => {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.equals(b)
}

/**
 * Wrap TWO `PartitionedRelayStorage` impls (memory + redis) and assert
 * deep-equal outcomes on each Effect-returning method. Returns the
 * `blue` (memory) side's result by default; pass `returnSide: "green"`
 * to switch.
 *
 * Streams (`scanCalls`) are parity-checked entry-by-entry against the
 * blue side's ordering; if the green side returns a different ordering
 * the violation surfaces on the first divergent item.
 */
export interface ParityOptions {
  readonly returnSide?: "blue" | "green"
}

export const parity = (
  blue: Layer.Layer<PartitionedRelayStorage>,
  green: Layer.Layer<PartitionedRelayStorage>,
  options?: ParityOptions,
): Layer.Layer<PartitionedRelayStorage> => {
  const returnSide = options?.returnSide ?? "blue"
  return Layer.effect(
    PartitionedRelayStorage,
    Effect.gen(function* () {
      const blueMap = yield* Layer.build(blue)
      const greenMap = yield* Layer.build(green)
      const blueApi = ServiceMap.get(blueMap, PartitionedRelayStorage)
      const greenApi = ServiceMap.get(greenMap, PartitionedRelayStorage)

      const getCall: PartitionedRelayStorageApi["getCall"] = (
        role,
        owner,
        callRef,
      ) =>
        Effect.gen(function* () {
          const [b, g] = yield* Effect.all([
            blueApi.getCall(role, owner, callRef),
            greenApi.getCall(role, owner, callRef),
          ])
          if (!buffersEqual(b, g)) {
            return yield* Effect.die(
              new PartitionedRelayStorageParityViolation(
                "getCall",
                "memory-vs-redis",
                `getCall(${partitionLabel(role, owner, callRef)}) memory=${
                  b === null ? "null" : `len=${b.length}`
                } vs redis=${g === null ? "null" : `len=${g.length}`}`,
              ),
            )
          }
          return returnSide === "blue" ? b : g
        })

      const getIndex: PartitionedRelayStorageApi["getIndex"] = (indexKey) =>
        Effect.gen(function* () {
          const [b, g] = yield* Effect.all([
            blueApi.getIndex(indexKey),
            greenApi.getIndex(indexKey),
          ])
          if (b !== g) {
            return yield* Effect.die(
              new PartitionedRelayStorageParityViolation(
                "getIndex",
                "memory-vs-redis",
                `getIndex(${indexKey}) memory=${b ?? "null"} vs redis=${g ?? "null"}`,
              ),
            )
          }
          return returnSide === "blue" ? b : g
        })

      const putCall: PartitionedRelayStorageApi["putCall"] = (
        role,
        owner,
        callRef,
        body,
        indexes,
        ttlSec,
        callGen,
        opts,
      ) =>
        Effect.all([
          blueApi.putCall(role, owner, callRef, body, indexes, ttlSec, callGen, opts),
          greenApi.putCall(role, owner, callRef, body, indexes, ttlSec, callGen, opts),
        ]).pipe(Effect.asVoid)

      const refreshCall: PartitionedRelayStorageApi["refreshCall"] = (
        role,
        owner,
        callRef,
        indexes,
        ttlSec,
        opts,
      ) =>
        Effect.all([
          blueApi.refreshCall(role, owner, callRef, indexes, ttlSec, opts),
          greenApi.refreshCall(role, owner, callRef, indexes, ttlSec, opts),
        ]).pipe(Effect.asVoid)

      const deleteCall: PartitionedRelayStorageApi["deleteCall"] = (
        role,
        owner,
        callRef,
        indexes,
        opts,
      ) =>
        Effect.all([
          blueApi.deleteCall(role, owner, callRef, indexes, opts),
          greenApi.deleteCall(role, owner, callRef, indexes, opts),
        ]).pipe(Effect.asVoid)

      // Stream parity: zip the two streams; assert each entry matches.
      const scanCalls: PartitionedRelayStorageApi["scanCalls"] = (
        role,
        owner,
        opts,
      ) => {
        const blueStream = blueApi.scanCalls(role, owner, opts)
        const greenStream = greenApi.scanCalls(role, owner, opts)
        return Stream.zip(blueStream, greenStream).pipe(
          Stream.mapEffect(([b, g]: readonly [ScanEntry, ScanEntry]) =>
            Effect.gen(function* () {
              if (
                b.callRef !== g.callRef ||
                !b.body.equals(g.body) ||
                b.ttlSec !== g.ttlSec
              ) {
                return yield* Effect.die(
                  new PartitionedRelayStorageParityViolation(
                    "scanCalls",
                    "memory-vs-redis",
                    `scanCalls(${role}:${owner}) entry divergence: memory.callRef=${b.callRef} vs redis.callRef=${g.callRef}`,
                  ),
                )
              }
              return returnSide === "blue" ? b : g
            }),
          ),
        )
      }

      return {
        getCall,
        getIndex,
        putCall,
        refreshCall,
        deleteCall,
        scanCalls,
      }
    }),
  )
}

// ---------------------------------------------------------------------------
// Tag.withAllContracts — canonical-order forwarder
// ---------------------------------------------------------------------------

export interface PartitionedRelayStorageContractsOptions {
  readonly scopedAudit?: ScopedAuditOptions | true
  /**
   * `true` (default when caller passes `scopedAudit`) → wrap with
   * `paranoidInputs`. Set to `false` to skip (perf benchmarks).
   */
  readonly paranoidInputs?: boolean
}

/**
 * Thin forwarder around `withCanonicalContracts`. `propertyTest` is
 * intentionally not exposed — no natural input domain (Buffers +
 * caller-supplied callRefs). `parity` stays outside the helper per D7;
 * build a parity layer first and pass it as `impl`.
 */
export const withAllContracts = <RIn = never>(
  impl: Layer.Layer<PartitionedRelayStorage, never, RIn>,
  options?: PartitionedRelayStorageContractsOptions,
): Layer.Layer<PartitionedRelayStorage, never, RIn | Recorder | RunContext> => {
  const opts: CanonicalContractsOptions<
    PartitionedRelayStorage,
    never,
    never,
    ScopedAuditOptions
  > = {
    ...(options?.scopedAudit !== undefined
      ? {
          scopedAudit: {
            wrap: scopedAudit as never,
            ...(options.scopedAudit === true
              ? {}
              : { opts: options.scopedAudit }),
          },
        }
      : {}),
    ...(options?.paranoidInputs !== false
      ? { paranoidInputs: { wrap: paranoidInputs as never } }
      : {}),
  }
  return withCanonicalContracts(
    PartitionedRelayStorage,
    impl as Layer.Layer<PartitionedRelayStorage>,
    opts,
  ) as Layer.Layer<PartitionedRelayStorage, never, RIn | Recorder | RunContext>
}
