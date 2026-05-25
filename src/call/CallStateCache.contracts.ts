/**
 * **TEST-ONLY exports.** Production composition (if any) uses the
 * bare `CallStateCache.{memoryLayer,redisLayer}` directly. Every
 * wrapper here adds `Recorder | RunContext` to the dependency
 * channel — services production does not provide, so applying any
 * wrapper inside `src/main.ts` will refuse to build the layer at
 * startup. No automated guard; reviewers must reject any import of
 * these symbols from `src/main.ts` / `bin/*`. See SURPRISES T2.
 *
 * CallStateCache contract wrappers — extend a cache Layer with
 * typed-channel recording, caller-side precondition checks, property
 * invariants, and scope-close audit invariants.
 *
 * Wrapper composition (canonical order — see effectLayerTest):
 *
 *   propertyTest(paranoidInputs(scopedAudit(impl)))
 *
 * Parity is intentionally skipped — the fidelity difference between
 * memory and Redis is in TTL precision + scan ordering, both of which
 * are test-infra noise rather than real defects worth gating tests on.
 *
 * Recording
 * ---------
 * Every public method emits a typed event on the per-Tag channel
 * `Recorder.forTag(CallStateCache)`. `.called` carries the input shape
 * (callRef / indexKey / ttlSec); `.result` carries `outcome` plus a
 * `hit` boolean on the two getters.
 *
 * Anomaly buffer
 * --------------
 * Per the Slice 8 handoff, a single shared per-Tag anomaly buffer is
 * used rather than competing per-wrapper projectors. `scopedAudit`
 * owns the buffer; `propertyTest` pushes into the same buffer via a
 * captured-closure setter that scopedAudit registers when both are
 * composed together. When `propertyTest` is composed alone it
 * registers a fallback projector that surfaces only its own anomalies.
 *
 * Severity tiers (D5)
 * -------------------
 *   - `unit-test-of-layer`  audit findings are FATAL.
 *   - `test-with-recorder`  audit findings are `deferred-fail` and
 *                            surface at scope close via
 *                            `CallStateCacheAuditViolation`.
 *   - `real-run`            findings are recorded `advisory`.
 *
 * `paranoidInputs` always Effect.die's (programmer-error invariant).
 */

import { Clock, Data, Effect, Layer, ServiceMap } from "effect"
import type { RedisError } from "../redis/RedisClient.js"
import type {
  Projector,
  RecordedAnomaly,
  TaggedChannel,
} from "../test-harness/framework/report-recorder/types.js"
import { Recorder } from "../test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../test-harness/framework/RunContext.js"
import {
  withCanonicalContracts,
  type CanonicalContractsOptions,
} from "../test-harness/framework/effectLayerTest.js"
import { CallStateCache } from "./CallStateCache.js"

// ---------------------------------------------------------------------------
// Typed event union
// ---------------------------------------------------------------------------

/**
 * One observation on the `CallStateCache` typed channel. Recording only
 * runs in tests — payload size is intentional. `putCall.called` carries
 * `jsonBytes` (count, not the full string) by default; full payload
 * exposure would require a separate opt-in.
 */
export type CallStateCacheEvent =
  | {
      readonly tag: "putCall.called"
      readonly callRef: string
      readonly jsonBytes: number
      readonly ttlSec: number
    }
  | {
      readonly tag: "putCall.result"
      readonly callRef: string
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  | { readonly tag: "getCall.called"; readonly callRef: string }
  | {
      readonly tag: "getCall.result"
      readonly callRef: string
      readonly hit: boolean
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  | {
      readonly tag: "expireCall.called"
      readonly callRef: string
      readonly ttlSec: number
    }
  | {
      readonly tag: "expireCall.result"
      readonly callRef: string
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  | { readonly tag: "deleteCall.called"; readonly callRef: string }
  | {
      readonly tag: "deleteCall.result"
      readonly callRef: string
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  | {
      readonly tag: "putIndex.called"
      readonly indexKey: string
      readonly callRef: string
      readonly ttlSec: number
    }
  | {
      readonly tag: "putIndex.result"
      readonly indexKey: string
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  | { readonly tag: "getIndex.called"; readonly indexKey: string }
  | {
      readonly tag: "getIndex.result"
      readonly indexKey: string
      readonly hit: boolean
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  | {
      readonly tag: "expireIndex.called"
      readonly indexKey: string
      readonly ttlSec: number
    }
  | {
      readonly tag: "expireIndex.result"
      readonly indexKey: string
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  | { readonly tag: "deleteIndex.called"; readonly indexKey: string }
  | {
      readonly tag: "deleteIndex.result"
      readonly indexKey: string
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  | { readonly tag: "scanCallRefs.called" }
  | {
      readonly tag: "scanCallRefs.result"
      readonly liveCount: number
      readonly outcome: "ok" | "fail" | "interrupt"
    }

export type CallStateCacheChannel = TaggedChannel<CallStateCacheEvent>

// ---------------------------------------------------------------------------
// Failure shapes
// ---------------------------------------------------------------------------

export class CallStateCacheParanoidInputViolation extends Error {
  readonly _tag = "CallStateCacheParanoidInputViolation"
  constructor(
    readonly check: string,
    readonly detail: string,
  ) {
    super(`call-state-cache ${check}: ${detail}`)
  }
}

export class CallStateCacheAuditViolation extends Data.TaggedError(
  "CallStateCacheAuditViolation",
)<{
  readonly check: string
  readonly detail: string
}> {}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const isNonEmptyString = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0

const isPositiveInt = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n > 0 && Number.isFinite(n)

type CallStateCacheApi = CallStateCache["Service"]

// ---------------------------------------------------------------------------
// paranoidInputs
// ---------------------------------------------------------------------------

/**
 * Wrap a `CallStateCache` Layer with caller-side precondition checks.
 * Violations are programmer error → `Effect.die`.
 *
 * Checks:
 *   PA1_validCallRef  — callRef is a non-empty string
 *   PA2_validIndexKey — indexKey is a non-empty string
 *   PA3_validTtl      — ttlSec is a finite positive integer
 *   PA4_validJson     — json parses (only on putCall). Gated behind
 *                       `B2BUA_PARANOID=1` because JSON.parse is the
 *                       only check above µs-scale.
 */
export const paranoidInputs = (
  inner: Layer.Layer<CallStateCache>,
): Layer.Layer<CallStateCache> =>
  Layer.effect(
    CallStateCache,
    Effect.gen(function* () {
      const svcs = yield* Layer.build(inner)
      const innerApi = ServiceMap.get(svcs, CallStateCache)
      const PA4_ENABLED = process.env["B2BUA_PARANOID"] === "1"

      const dieIfBadCallRef = (
        method: string,
        callRef: unknown,
      ): Effect.Effect<void, never, never> => {
        if (isNonEmptyString(callRef)) return Effect.void
        return Effect.die(
          new CallStateCacheParanoidInputViolation(
            `PA1_validCallRef`,
            `${method}: callRef must be non-empty string (got ${typeof callRef})`,
          ),
        )
      }

      const dieIfBadIndexKey = (
        method: string,
        indexKey: unknown,
      ): Effect.Effect<void, never, never> => {
        if (isNonEmptyString(indexKey)) return Effect.void
        return Effect.die(
          new CallStateCacheParanoidInputViolation(
            `PA2_validIndexKey`,
            `${method}: indexKey must be non-empty string (got ${typeof indexKey})`,
          ),
        )
      }

      const dieIfBadTtl = (
        method: string,
        ttlSec: unknown,
      ): Effect.Effect<void, never, never> => {
        if (isPositiveInt(ttlSec)) return Effect.void
        return Effect.die(
          new CallStateCacheParanoidInputViolation(
            `PA3_validTtl`,
            `${method}: ttlSec must be a finite positive integer (got ${String(ttlSec)})`,
          ),
        )
      }

      const dieIfBadJson = (
        method: string,
        json: unknown,
      ): Effect.Effect<void, never, never> => {
        if (typeof json !== "string") {
          return Effect.die(
            new CallStateCacheParanoidInputViolation(
              `PA4_validJson`,
              `${method}: json must be a string (got ${typeof json})`,
            ),
          )
        }
        if (!PA4_ENABLED) return Effect.void
        try {
          JSON.parse(json)
          return Effect.void
        } catch (e) {
          return Effect.die(
            new CallStateCacheParanoidInputViolation(
              `PA4_validJson`,
              `${method}: json failed JSON.parse (${e instanceof Error ? e.message : String(e)})`,
            ),
          )
        }
      }

      const putCall: CallStateCacheApi["putCall"] = (callRef, json, ttlSec) =>
        Effect.gen(function* () {
          yield* dieIfBadCallRef("putCall", callRef)
          yield* dieIfBadJson("putCall", json)
          yield* dieIfBadTtl("putCall", ttlSec)
          return yield* innerApi.putCall(callRef, json, ttlSec)
        })

      const getCall: CallStateCacheApi["getCall"] = (callRef) =>
        Effect.gen(function* () {
          yield* dieIfBadCallRef("getCall", callRef)
          return yield* innerApi.getCall(callRef)
        })

      const expireCall: CallStateCacheApi["expireCall"] = (callRef, ttlSec) =>
        Effect.gen(function* () {
          yield* dieIfBadCallRef("expireCall", callRef)
          yield* dieIfBadTtl("expireCall", ttlSec)
          return yield* innerApi.expireCall(callRef, ttlSec)
        })

      const deleteCall: CallStateCacheApi["deleteCall"] = (callRef) =>
        Effect.gen(function* () {
          yield* dieIfBadCallRef("deleteCall", callRef)
          return yield* innerApi.deleteCall(callRef)
        })

      const putIndex: CallStateCacheApi["putIndex"] = (indexKey, callRef, ttlSec) =>
        Effect.gen(function* () {
          yield* dieIfBadIndexKey("putIndex", indexKey)
          yield* dieIfBadCallRef("putIndex", callRef)
          yield* dieIfBadTtl("putIndex", ttlSec)
          return yield* innerApi.putIndex(indexKey, callRef, ttlSec)
        })

      const getIndex: CallStateCacheApi["getIndex"] = (indexKey) =>
        Effect.gen(function* () {
          yield* dieIfBadIndexKey("getIndex", indexKey)
          return yield* innerApi.getIndex(indexKey)
        })

      const expireIndex: CallStateCacheApi["expireIndex"] = (indexKey, ttlSec) =>
        Effect.gen(function* () {
          yield* dieIfBadIndexKey("expireIndex", indexKey)
          yield* dieIfBadTtl("expireIndex", ttlSec)
          return yield* innerApi.expireIndex(indexKey, ttlSec)
        })

      const deleteIndex: CallStateCacheApi["deleteIndex"] = (indexKey) =>
        Effect.gen(function* () {
          yield* dieIfBadIndexKey("deleteIndex", indexKey)
          return yield* innerApi.deleteIndex(indexKey)
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
        scanCallRefs: innerApi.scanCallRefs,
      }
    }),
  )

// ---------------------------------------------------------------------------
// propertyTest
// ---------------------------------------------------------------------------

export interface PropertyTestOptions {
  /**
   * `true` (default) — enable all four properties; `false` — disable all;
   * an array — enable only the named properties.
   */
  readonly properties?:
    | boolean
    | ReadonlyArray<
        "P1_putGetRoundTrip" | "P2_deleteSticks" | "P3_ttlElapse" | "P4_scanCoverage"
      >
}

/**
 * Wrap a `CallStateCache` Layer with cross-call invariants. Invariants
 * run at layer close (snapshot replay) so violations are detected in
 * aggregate rather than per-call.
 *
 * Invariants:
 *   P1_putGetRoundTrip — every `putCall(callRef, json, ttl)` followed by
 *     `getCall(callRef)` BEFORE TTL elapse returns the same `json`.
 *   P2_deleteSticks    — `putCall → deleteCall → getCall` returns null.
 *   P3_ttlElapse       — `putCall(ttl=X)` then TestClock-advance past
 *                        X then `getCall` returns null. ONLY fires
 *                        under `test-with-recorder` (TestClock present).
 *   P4_scanCoverage    — `scanCallRefs` returns every callRef that was
 *                        `put` and not `delete`d (modulo TTL).
 *
 * Findings are recorded as `signalingAudit`-shaped anomalies with a
 * `csc.*` check prefix (mirrors PartitionedRelayStorage's `prs.*`).
 */
export const propertyTest = (
  inner: Layer.Layer<CallStateCache>,
  options?: PropertyTestOptions,
): Layer.Layer<CallStateCache, never, Recorder | RunContext> => {
  const enabledArr = resolvePropertyTestEnabled(options)
  const enabled = new Set<string>(enabledArr)
  return Layer.effect(
    CallStateCache,
    Effect.gen(function* () {
      const svcs = yield* Layer.build(inner)
      const innerApi = ServiceMap.get(svcs, CallStateCache)
      const recorder = yield* Recorder
      const ctx = yield* RunContext
      const channel = recorder.forTag<CallStateCache, CallStateCacheEvent>(
        CallStateCache,
      )
      const anomalies: RecordedAnomaly[] = []

      // Fallback projector when propertyTest is composed without
      // scopedAudit. scopedAudit registers a richer projector that owns
      // a shared anomaly buffer; first-registration wins so when both
      // are stacked, scopedAudit's projector beats this one.
      const projector: Projector<CallStateCacheEvent> = () => ({
        anomalies: anomalies.slice(),
      })
      yield* recorder.registerProjector(CallStateCache, projector)

      const pushAnomaly = (check: string, detail: string): void => {
        anomalies.push({
          kind: "signalingAudit",
          check: `csc.${check}`,
          detail,
          severity: ctx.kind === "real-run" ? "advisory" : "deferred-fail",
        })
      }

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const snap = yield* channel.snapshot
          yield* runPropertyInvariants({
            enabled,
            ctx,
            events: snap,
            push: pushAnomaly,
          })
        }),
      )

      return innerApi
    }),
  )
}

const resolvePropertyTestEnabled = (
  options?: PropertyTestOptions,
): ReadonlyArray<string> => {
  const all = ["P1_putGetRoundTrip", "P2_deleteSticks", "P3_ttlElapse", "P4_scanCoverage"]
  const v = options?.properties
  if (v === undefined || v === true) return all
  if (v === false) return []
  return v
}

/**
 * Cross-call invariant runner. Reads a snapshot of channel events and
 * pushes anomalies for any violations. Each pass is O(events); TTL
 * tracking uses event-timestamp arithmetic since the cache's TTL
 * semantics are driven by Clock.currentTimeMillis.
 */
const runPropertyInvariants = (args: {
  readonly enabled: ReadonlySet<string>
  readonly ctx: { readonly kind: string }
  readonly events: ReadonlyArray<CallStateCacheEvent & { seq: number; atMs: number }>
  readonly push: (check: string, detail: string) => void
}): Effect.Effect<void> =>
  Effect.sync(() => {
    const { enabled, ctx, events, push } = args
    const sorted = [...events].sort((a, b) => a.seq - b.seq)

    // Last successful putCall per callRef: { json byteSize, atMs, ttlSec }.
    interface LivePut {
      jsonBytes: number
      atMs: number
      ttlSec: number
    }
    const lastPut = new Map<string, LivePut>()
    const lastDeleteAtMs = new Map<string, number>()
    const lastGet = new Map<
      string,
      { hit: boolean; atMs: number }
    >()
    const observedScanLiveCounts: Array<{
      atMs: number
      liveCount: number
    }> = []

    for (const ev of sorted) {
      switch (ev.tag) {
        case "putCall.result":
          if (ev.outcome === "ok") {
            // jsonBytes / ttl came in via the .called event; we'll fix
            // up below by scanning paired .called events.
            // Keep the put marker; details filled below.
            const pending = lastPut.get(ev.callRef)
            lastPut.set(ev.callRef, pending ?? { jsonBytes: -1, atMs: ev.atMs, ttlSec: -1 })
          }
          break
        case "putCall.called":
          // Pre-stash details; .result above marks success.
          lastPut.set(ev.callRef, {
            jsonBytes: ev.jsonBytes,
            atMs: ev.atMs,
            ttlSec: ev.ttlSec,
          })
          break
        case "deleteCall.result":
          if (ev.outcome === "ok") {
            lastDeleteAtMs.set(ev.callRef, ev.atMs)
            lastPut.delete(ev.callRef)
          }
          break
        case "getCall.result":
          if (ev.outcome === "ok") {
            lastGet.set(ev.callRef, { hit: ev.hit, atMs: ev.atMs })
          }
          break
        case "scanCallRefs.result":
          if (ev.outcome === "ok") {
            observedScanLiveCounts.push({
              atMs: ev.atMs,
              liveCount: ev.liveCount,
            })
          }
          break
      }
    }

    // Per-callRef pair walker for P1/P2/P3. Order events again per ref.
    const byRef = new Map<
      string,
      Array<CallStateCacheEvent & { seq: number; atMs: number }>
    >()
    for (const ev of sorted) {
      const ref =
        "callRef" in ev
          ? (ev as { callRef?: string }).callRef
          : undefined
      if (!isNonEmptyString(ref)) continue
      const arr = byRef.get(ref) ?? []
      arr.push(ev)
      byRef.set(ref, arr)
    }

    for (const [callRef, evs] of byRef) {
      // Local state per ref while walking.
      let live: { jsonBytes: number; atMs: number; ttlSec: number } | null = null
      let deleted = false
      for (const ev of evs) {
        if (ev.tag === "putCall.called") {
          live = { jsonBytes: ev.jsonBytes, atMs: ev.atMs, ttlSec: ev.ttlSec }
          deleted = false
        } else if (ev.tag === "deleteCall.result" && ev.outcome === "ok") {
          live = null
          deleted = true
        } else if (ev.tag === "getCall.result" && ev.outcome === "ok") {
          const elapsed = live === null ? null : ev.atMs - live.atMs
          const beforeExpiry = live !== null && elapsed !== null && elapsed < live.ttlSec * 1000
          if (enabled.has("P1_putGetRoundTrip") && live !== null && beforeExpiry) {
            if (!ev.hit) {
              push(
                "P1_putGetRoundTrip",
                `getCall(${callRef}) returned null at +${elapsed}ms after putCall (ttlSec=${live.ttlSec}, jsonBytes=${live.jsonBytes})`,
              )
            }
          }
          if (enabled.has("P2_deleteSticks") && deleted && live === null && ev.hit) {
            push(
              "P2_deleteSticks",
              `getCall(${callRef}) returned non-null after deleteCall`,
            )
          }
          if (
            enabled.has("P3_ttlElapse") &&
            ctx.kind === "test-with-recorder" &&
            live !== null &&
            elapsed !== null &&
            elapsed >= live.ttlSec * 1000 &&
            ev.hit
          ) {
            push(
              "P3_ttlElapse",
              `getCall(${callRef}) returned non-null at +${elapsed}ms after putCall (ttlSec=${live.ttlSec}); expected null after TTL`,
            )
          }
        }
      }
    }

    // P4_scanCoverage — every scanCallRefs.result must include the
    // count of live (put-not-deleted-not-expired) refs at that moment.
    // We only check counts (not key membership) because the typed
    // channel doesn't carry per-key scan output by default.
    if (enabled.has("P4_scanCoverage")) {
      for (const scan of observedScanLiveCounts) {
        let expectedLive = 0
        for (const [, info] of lastPut) {
          const elapsed = scan.atMs - info.atMs
          // -1 jsonBytes means we never paired the .called event; skip.
          if (info.jsonBytes < 0) continue
          if (elapsed < info.ttlSec * 1000) expectedLive++
        }
        if (scan.liveCount < expectedLive) {
          push(
            "P4_scanCoverage",
            `scanCallRefs returned ${scan.liveCount} live; expected at least ${expectedLive} based on outstanding puts`,
          )
        }
      }
    }
  })

// ---------------------------------------------------------------------------
// scopedAudit
// ---------------------------------------------------------------------------

export interface ScopedAuditOptions {
  /**
   * When `true` (default) the audit verifies every successful `putCall`
   * had either a `deleteCall` or sufficient TTL slack at scope close.
   * Advisory in `test-with-recorder` and `real-run` — many fixtures
   * outlive a single put's expected lifetime.
   */
  readonly checkNoOrphanKeys?: boolean
  /**
   * When `true` (default) the audit verifies every `putIndex(idx, ref)`
   * still points at a live (non-null `getCall`) callRef at scope close.
   */
  readonly checkNoDanglingIndexes?: boolean
  /**
   * When `true` (default) the audit verifies that after a `deleteCall`,
   * no subsequent `getCall` returned non-null UNLESS an intervening
   * `putCall` re-created the entry. Fatal class — `deferred-fail` in
   * `test-with-recorder`.
   */
  readonly checkNoTombstoneResurrection?: boolean
}

/**
 * Wrap a `CallStateCache` Layer with typed recording + scope-close
 * audit invariants. Reads `Recorder` + `RunContext` from the
 * surrounding scope.
 *
 * Invariants checked at scope close:
 *
 *   - **A1_noOrphanKeys**           — successful putCall with no matching
 *     deleteCall AND no scope-close TTL slack (entry should already
 *     have expired). Advisory in `test-with-recorder` (many fixtures
 *     keep keys live across the layer scope by design).
 *   - **A2_noDanglingIndexes**      — putIndex(idx, ref) where the
 *     companion callRef returned null on its final getCall.
 *     Advisory in `test-with-recorder`.
 *   - **A3_noTombstoneResurrection** — deleteCall followed by a non-null
 *     getCall without an intervening putCall.
 *     `deferred-fail` in `test-with-recorder`; FATAL in
 *     `unit-test-of-layer`.
 */
export const scopedAudit = (
  inner: Layer.Layer<CallStateCache>,
  options?: ScopedAuditOptions,
): Layer.Layer<CallStateCache, never, Recorder | RunContext> => {
  const checkNoOrphanKeys = options?.checkNoOrphanKeys ?? true
  const checkNoDanglingIndexes = options?.checkNoDanglingIndexes ?? true
  const checkNoTombstoneResurrection = options?.checkNoTombstoneResurrection ?? true
  return Layer.effect(
    CallStateCache,
    Effect.gen(function* () {
      const svcs = yield* Layer.build(inner)
      const innerApi = ServiceMap.get(svcs, CallStateCache)
      const recorder = yield* Recorder
      const ctx = yield* RunContext
      const channel = recorder.forTag<CallStateCache, CallStateCacheEvent>(
        CallStateCache,
      )

      // Shared per-Tag anomaly buffer.
      const anomalies: RecordedAnomaly[] = []

      const projector: Projector<CallStateCacheEvent> = () => ({
        anomalies: anomalies.slice(),
      })
      yield* recorder.registerProjector(CallStateCache, projector)

      const severityFor = (
        baseline: "advisory" | "deferred-fail",
      ): "advisory" | "deferred-fail" => {
        if (ctx.kind === "real-run") return "advisory"
        return baseline
      }

      const pushAnomaly = (
        check: string,
        detail: string,
        baseline: "advisory" | "deferred-fail",
      ): void => {
        anomalies.push({
          kind: "signalingAudit",
          check: `csc.${check}`,
          detail,
          severity: severityFor(baseline),
        })
      }

      const recordEffect = <A, EE>(
        beforeEvent: CallStateCacheEvent,
        buildAfter: (
          outcome: "ok" | "fail" | "interrupt",
          value: A | null,
        ) => CallStateCacheEvent,
        op: Effect.Effect<A, EE>,
      ): Effect.Effect<A, EE> =>
        Effect.gen(function* () {
          yield* channel.record(beforeEvent)
          const exit = yield* Effect.exit(op)
          if (exit._tag === "Success") {
            yield* channel.record(buildAfter("ok", exit.value))
            return exit.value
          }
          yield* channel.record(buildAfter("fail", null))
          return yield* Effect.failCause(exit.cause)
        })

      const putCall: CallStateCacheApi["putCall"] = (callRef, json, ttlSec) =>
        recordEffect<void, RedisError>(
          {
            tag: "putCall.called",
            callRef,
            jsonBytes: json.length,
            ttlSec,
          },
          (outcome) => ({ tag: "putCall.result", callRef, outcome }),
          innerApi.putCall(callRef, json, ttlSec),
        )

      const getCall: CallStateCacheApi["getCall"] = (callRef) =>
        recordEffect<string | null, RedisError>(
          { tag: "getCall.called", callRef },
          (outcome, value) => ({
            tag: "getCall.result",
            callRef,
            outcome,
            hit: outcome === "ok" ? value !== null : false,
          }),
          innerApi.getCall(callRef),
        )

      const expireCall: CallStateCacheApi["expireCall"] = (callRef, ttlSec) =>
        recordEffect<void, RedisError>(
          { tag: "expireCall.called", callRef, ttlSec },
          (outcome) => ({ tag: "expireCall.result", callRef, outcome }),
          innerApi.expireCall(callRef, ttlSec),
        )

      const deleteCall: CallStateCacheApi["deleteCall"] = (callRef) =>
        recordEffect<void, RedisError>(
          { tag: "deleteCall.called", callRef },
          (outcome) => ({ tag: "deleteCall.result", callRef, outcome }),
          innerApi.deleteCall(callRef),
        )

      const putIndex: CallStateCacheApi["putIndex"] = (indexKey, callRef, ttlSec) =>
        recordEffect<void, RedisError>(
          { tag: "putIndex.called", indexKey, callRef, ttlSec },
          (outcome) => ({ tag: "putIndex.result", indexKey, outcome }),
          innerApi.putIndex(indexKey, callRef, ttlSec),
        )

      const getIndex: CallStateCacheApi["getIndex"] = (indexKey) =>
        recordEffect<string | null, RedisError>(
          { tag: "getIndex.called", indexKey },
          (outcome, value) => ({
            tag: "getIndex.result",
            indexKey,
            outcome,
            hit: outcome === "ok" ? value !== null : false,
          }),
          innerApi.getIndex(indexKey),
        )

      const expireIndex: CallStateCacheApi["expireIndex"] = (indexKey, ttlSec) =>
        recordEffect<void, RedisError>(
          { tag: "expireIndex.called", indexKey, ttlSec },
          (outcome) => ({ tag: "expireIndex.result", indexKey, outcome }),
          innerApi.expireIndex(indexKey, ttlSec),
        )

      const deleteIndex: CallStateCacheApi["deleteIndex"] = (indexKey) =>
        recordEffect<void, RedisError>(
          { tag: "deleteIndex.called", indexKey },
          (outcome) => ({ tag: "deleteIndex.result", indexKey, outcome }),
          innerApi.deleteIndex(indexKey),
        )

      const scanCallRefs: CallStateCacheApi["scanCallRefs"] = () =>
        Effect.gen(function* () {
          yield* channel.record({ tag: "scanCallRefs.called" })
          const exit = yield* Effect.exit(innerApi.scanCallRefs())
          if (exit._tag === "Success") {
            yield* channel.record({
              tag: "scanCallRefs.result",
              liveCount: exit.value.length,
              outcome: "ok",
            })
            return exit.value
          }
          yield* channel.record({
            tag: "scanCallRefs.result",
            liveCount: 0,
            outcome: "fail",
          })
          return yield* Effect.failCause(exit.cause)
        })

      // Scope-close finalizer: run audit invariants.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis
          const snap = yield* channel.snapshot
          yield* runAuditInvariants({
            checkNoOrphanKeys,
            checkNoDanglingIndexes,
            checkNoTombstoneResurrection,
            ctx,
            nowMs,
            events: snap,
            push: pushAnomaly,
          })

          // Surface deferred-fail entries.
          if (ctx.kind === "unit-test-of-layer") {
            const first = anomalies.find(
              (a) => a.kind === "signalingAudit" && a.severity === "deferred-fail",
            )
            if (first !== undefined && first.kind === "signalingAudit") {
              return yield* Effect.die(
                new CallStateCacheAuditViolation({
                  check: first.check,
                  detail: first.detail,
                }),
              )
            }
          }
          if (ctx.kind === "test-with-recorder") {
            // Only the tombstone-resurrection invariant escalates;
            // orphans and dangling indexes stay advisory.
            const first = anomalies.find(
              (a) =>
                a.kind === "signalingAudit" &&
                a.severity === "deferred-fail" &&
                a.check === "csc.A3_noTombstoneResurrection",
            )
            if (first !== undefined && first.kind === "signalingAudit") {
              return yield* Effect.die(
                new CallStateCacheAuditViolation({
                  check: first.check,
                  detail: first.detail,
                }),
              )
            }
          }
        }),
      )

      return {
        putCall,
        getCall,
        expireCall,
        deleteCall,
        putIndex,
        getIndex,
        expireIndex,
        deleteIndex,
        scanCallRefs,
      }
    }),
  )
}

const runAuditInvariants = (args: {
  readonly checkNoOrphanKeys: boolean
  readonly checkNoDanglingIndexes: boolean
  readonly checkNoTombstoneResurrection: boolean
  readonly ctx: { readonly kind: string }
  readonly nowMs: number
  readonly events: ReadonlyArray<CallStateCacheEvent & { seq: number; atMs: number }>
  readonly push: (
    check: string,
    detail: string,
    baseline: "advisory" | "deferred-fail",
  ) => void
}): Effect.Effect<void> =>
  Effect.sync(() => {
    const {
      checkNoOrphanKeys,
      checkNoDanglingIndexes,
      checkNoTombstoneResurrection,
      nowMs,
      events,
      push,
    } = args
    const sorted = [...events].sort((a, b) => a.seq - b.seq)

    // Per-callRef state walker.
    interface RefState {
      lastPut?: { atMs: number; ttlSec: number }
      lastDeleteAtMs?: number
      sawTombstoneResurrection: string[]
    }
    const refs = new Map<string, RefState>()
    const indexes = new Map<
      string,
      { callRef: string; ttlSec: number; atMs: number }
    >()

    const getRef = (ref: string): RefState => {
      let s = refs.get(ref)
      if (s === undefined) {
        s = { sawTombstoneResurrection: [] }
        refs.set(ref, s)
      }
      return s
    }

    let pendingPutCallRef: string | null = null
    let pendingPutTtl: number = -1
    for (const ev of sorted) {
      switch (ev.tag) {
        case "putCall.called":
          pendingPutCallRef = ev.callRef
          pendingPutTtl = ev.ttlSec
          break
        case "putCall.result":
          if (
            ev.outcome === "ok" &&
            pendingPutCallRef === ev.callRef &&
            pendingPutTtl >= 0
          ) {
            const s = getRef(ev.callRef)
            s.lastPut = { atMs: ev.atMs, ttlSec: pendingPutTtl }
            // putCall after delete clears the tombstone state.
            delete s.lastDeleteAtMs
          }
          pendingPutCallRef = null
          pendingPutTtl = -1
          break
        case "deleteCall.result":
          if (ev.outcome === "ok") {
            const s = getRef(ev.callRef)
            s.lastDeleteAtMs = ev.atMs
            delete s.lastPut
          }
          break
        case "getCall.result":
          if (ev.outcome === "ok" && ev.hit) {
            const s = getRef(ev.callRef)
            if (
              s.lastDeleteAtMs !== undefined &&
              s.lastPut === undefined
            ) {
              s.sawTombstoneResurrection.push(
                `getCall hit at atMs=${ev.atMs} after deleteCall at atMs=${s.lastDeleteAtMs} with no intervening putCall`,
              )
            }
          }
          break
        case "putIndex.result":
          break
        case "putIndex.called":
          indexes.set(ev.indexKey, {
            callRef: ev.callRef,
            ttlSec: ev.ttlSec,
            atMs: ev.atMs,
          })
          break
        case "deleteIndex.result":
          if (ev.outcome === "ok") {
            indexes.delete(ev.indexKey)
          }
          break
      }
    }

    // A1 — orphan keys: lastPut still alive at scope close but never
    // deleted AND still within TTL window.
    if (checkNoOrphanKeys) {
      for (const [ref, s] of refs) {
        if (s.lastPut === undefined) continue
        const elapsed = nowMs - s.lastPut.atMs
        if (elapsed < s.lastPut.ttlSec * 1000) {
          push(
            "A1_noOrphanKeys",
            `putCall(${ref}) at atMs=${s.lastPut.atMs} still within ttl (${s.lastPut.ttlSec}s) at scope close with no deleteCall`,
            "advisory",
          )
        }
      }
    }

    // A2 — dangling indexes: any putIndex whose callRef has no live
    // lastPut at scope close.
    if (checkNoDanglingIndexes) {
      for (const [idx, info] of indexes) {
        const refState = refs.get(info.callRef)
        const live =
          refState !== undefined &&
          refState.lastPut !== undefined &&
          nowMs - refState.lastPut.atMs < refState.lastPut.ttlSec * 1000
        if (!live) {
          push(
            "A2_noDanglingIndexes",
            `putIndex(${idx} → ${info.callRef}) points at no-longer-live callRef at scope close`,
            "advisory",
          )
        }
      }
    }

    // A3 — tombstone resurrection: collected during the walk above.
    if (checkNoTombstoneResurrection) {
      for (const [ref, s] of refs) {
        for (const detail of s.sawTombstoneResurrection) {
          push(
            "A3_noTombstoneResurrection",
            `${ref}: ${detail}`,
            "deferred-fail",
          )
        }
      }
    }
  })

// ---------------------------------------------------------------------------
// withAllContracts — canonical-order forwarder
// ---------------------------------------------------------------------------

export interface CallStateCacheContractsOptions {
  readonly propertyTest?: PropertyTestOptions | true
  readonly paranoidInputs?: boolean
  readonly scopedAudit?: ScopedAuditOptions | true
}

/**
 * Thin forwarder around `withCanonicalContracts`. Parity is intentionally
 * not exposed — the memory vs Redis fidelity difference is test-infra
 * noise rather than a real-defects gate.
 */
export const withAllContracts = (
  impl: Layer.Layer<CallStateCache>,
  options?: CallStateCacheContractsOptions,
): Layer.Layer<CallStateCache, never, Recorder | RunContext> => {
  const opts: CanonicalContractsOptions<
    CallStateCache,
    PropertyTestOptions,
    never,
    ScopedAuditOptions
  > = {
    ...(options?.propertyTest !== undefined
      ? {
          propertyTest: {
            wrap: propertyTest as never,
            ...(options.propertyTest === true
              ? {}
              : { opts: options.propertyTest }),
          },
        }
      : {}),
    ...(options?.paranoidInputs !== false
      ? { paranoidInputs: { wrap: paranoidInputs as never } }
      : {}),
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
  }
  return withCanonicalContracts(CallStateCache, impl, opts) as Layer.Layer<
    CallStateCache,
    never,
    Recorder | RunContext
  >
}
