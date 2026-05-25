/**
 * **TEST-ONLY exports.** Production composition uses the bare
 * `CallLimiter.{memoryLayer,sharedMemoryLayer,redisLayer}` directly.
 * Every wrapper here adds `Recorder | RunContext` to the dependency
 * channel — services production does not provide, so applying any
 * wrapper inside `src/main.ts` or the equivalent process entrypoint
 * will refuse to build the layer at startup. No automated guard;
 * reviewers must reject any import of these symbols from `src/main.ts`
 * / `bin/*`. See SURPRISES T2.
 *
 * CallLimiter contract wrappers — extend a limiter Layer with
 * typed-channel recording, caller-side precondition checks, and a
 * scope-close audit that enforces ADR-0004's counter-back-to-zero
 * invariant.
 *
 * Wrapper composition (canonical order — see effectLayerTest):
 *
 *   paranoidInputs(scopedAudit(impl))
 *
 * `propertyTest` is intentionally skipped — the limiter's natural
 * properties (cap-honoring under chaos, fail-open, window rollover) are
 * exercised by integration tests with their own time-pacing; a generic
 * propertyTest would mostly duplicate the audit invariant below or
 * mis-fire under TestClock window-rollover sweeps.
 *
 * `parity` (memory vs redis) is opt-in: build the parity Layer first
 * via `CallLimiter.parity(blue, green)` (memory vs redis), then pass it
 * as `impl` to `withAllContracts`. Stays outside the canonical helper
 * per D7.
 *
 * Recording
 * ---------
 * Every public method emits a typed event on the per-Tag channel
 * `Recorder.forTag(CallLimiter)`. `.called` carries the input shape
 * (`limiterId`, `limit`, `originWindow`); `.result` carries the
 * outcome plus the typed decision tag on `checkAndIncrement`.
 *
 * Severity tiers (D5)
 * -------------------
 *   - `unit-test-of-layer`  audit findings are FATAL.
 *   - `test-with-recorder`  audit findings are `deferred-fail` and
 *                            surface at scope close via
 *                            `CallLimiterAuditViolation`.
 *   - `real-run`            findings are recorded `advisory`.
 *
 * ADR-0004 carve-out
 * ------------------
 * ADR-0004 makes counter symmetry a structural invariant AND documents
 * the operational-contract carve-outs: phantom INCRs left by dead
 * workers age out via window rotation (~15 min) or are reaped by a
 * peer's OPTIONS-driven takeover (~10 min). The audit here looks only
 * at observed `checkAndIncrement` outcomes vs `decrement` calls on the
 * SAME scope. Fail-open admissions (`LimiterTimeout` / `RedisError`)
 * do NOT increment a counter and MUST NOT decrement one — those are
 * tracked separately so the audit doesn't false-positive on the
 * well-documented design trade-off.
 */

import { Cause, Data, Effect, Layer, Option, ServiceMap } from "effect"
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
import { mkAuditContext } from "../test-harness/framework/auditContext.js"
import {
  CallLimiter,
  type LimiterDecision,
} from "./CallLimiter.js"

// ---------------------------------------------------------------------------
// Typed event union
// ---------------------------------------------------------------------------

/**
 * One observation on the `CallLimiter` typed channel. Recording only
 * runs in tests — payload size is intentional and minimal.
 *
 * Variants:
 *   - `checkAndIncrement.{called,result}` — `.result` carries
 *     `decision` (the typed `LimiterDecision` tag) AND the wider
 *     `outcome` (ok / fail / interrupt). On `fail`, `errorTag`
 *     distinguishes `RedisError` from `LimiterTimeout` so the audit
 *     can exclude fail-open admissions from the counter ledger.
 *   - `decrement.{called,result}`         — caller's claimed
 *     `originWindow` is the bookkeeping key the audit uses to pair
 *     `+1` (admission) with `-1` (release).
 *   - `refresh.{called,result}`           — `.result` carries the
 *     new `currentWindow`. Refresh migrates a count from
 *     `originWindow` to `currentWindow`; from the audit's perspective
 *     this is an atomic `(−1 from origin, +1 to new)` pair.
 *   - `currentWindow.{called,result}`     — read-only; recorded for
 *     completeness, not used by audit invariants.
 */
export type CallLimiterEvent =
  | {
      readonly tag: "checkAndIncrement.called"
      readonly limiterId: string
      readonly limit: number
    }
  | {
      readonly tag: "checkAndIncrement.result"
      readonly limiterId: string
      readonly limit: number
      readonly outcome: "ok" | "fail" | "interrupt"
      /** Only populated on `ok` outcomes. */
      readonly decision?: LimiterDecision["_tag"]
      /** Only populated on `ok`+`Allowed`. */
      readonly currentWindow?: number
      /** Only populated on `fail`. */
      readonly errorTag?: "RedisError" | "LimiterTimeout"
    }
  | {
      readonly tag: "decrement.called"
      readonly limiterId: string
      readonly originWindow: number
    }
  | {
      readonly tag: "decrement.result"
      readonly limiterId: string
      readonly originWindow: number
      readonly outcome: "ok" | "fail" | "interrupt"
    }
  | {
      readonly tag: "refresh.called"
      readonly limiterId: string
      readonly originWindow: number
    }
  | {
      readonly tag: "refresh.result"
      readonly limiterId: string
      readonly originWindow: number
      readonly outcome: "ok" | "fail" | "interrupt"
      /** Only populated on `ok` — the window the count was migrated to. */
      readonly newWindow?: number
    }
  | { readonly tag: "currentWindow.called" }
  | {
      readonly tag: "currentWindow.result"
      readonly outcome: "ok" | "fail" | "interrupt"
      readonly window?: number
    }

export type CallLimiterChannel = TaggedChannel<CallLimiterEvent>

// ---------------------------------------------------------------------------
// Failure shapes
// ---------------------------------------------------------------------------

export class CallLimiterParanoidInputViolation extends Error {
  readonly _tag = "CallLimiterParanoidInputViolation"
  constructor(
    readonly check: string,
    readonly detail: string,
  ) {
    super(`call-limiter ${check}: ${detail}`)
  }
}

export class CallLimiterAuditViolation extends Data.TaggedError(
  "CallLimiterAuditViolation",
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

const isFiniteInt = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && Number.isFinite(n)

type CallLimiterApi = CallLimiter["Service"]

// ---------------------------------------------------------------------------
// paranoidInputs
// ---------------------------------------------------------------------------

/**
 * Wrap a `CallLimiter` Layer with caller-side precondition checks.
 * Violations are programmer error → `Effect.die`.
 *
 * Checks:
 *   PA1_validLimiterId   — limiterId is a non-empty string
 *   PA2_validLimit       — limit is a finite positive integer
 *   PA3_validOriginWin   — originWindow is a finite integer (windows
 *                          can be 0 at t=0; >=0 is the only sensible
 *                          floor)
 */
export const paranoidInputs = (
  inner: Layer.Layer<CallLimiter>,
): Layer.Layer<CallLimiter> =>
  Layer.effect(
    CallLimiter,
    Effect.gen(function* () {
      const svcs = yield* Layer.build(inner)
      const innerApi = ServiceMap.get(svcs, CallLimiter)

      const dieIfBadLimiterId = (
        method: string,
        limiterId: unknown,
      ): Effect.Effect<void, never, never> => {
        if (isNonEmptyString(limiterId)) return Effect.void
        return Effect.die(
          new CallLimiterParanoidInputViolation(
            "PA1_validLimiterId",
            `${method}: limiterId must be non-empty string (got ${typeof limiterId})`,
          ),
        )
      }

      const dieIfBadLimit = (
        limit: unknown,
      ): Effect.Effect<void, never, never> => {
        if (isPositiveInt(limit)) return Effect.void
        return Effect.die(
          new CallLimiterParanoidInputViolation(
            "PA2_validLimit",
            `checkAndIncrement: limit must be a finite positive integer (got ${String(limit)})`,
          ),
        )
      }

      const dieIfBadOriginWindow = (
        method: string,
        originWindow: unknown,
      ): Effect.Effect<void, never, never> => {
        if (isFiniteInt(originWindow) && originWindow >= 0) return Effect.void
        return Effect.die(
          new CallLimiterParanoidInputViolation(
            "PA3_validOriginWin",
            `${method}: originWindow must be a finite non-negative integer (got ${String(originWindow)})`,
          ),
        )
      }

      const checkAndIncrement: CallLimiterApi["checkAndIncrement"] = (
        limiterId,
        limit,
      ) =>
        Effect.gen(function* () {
          yield* dieIfBadLimiterId("checkAndIncrement", limiterId)
          yield* dieIfBadLimit(limit)
          return yield* innerApi.checkAndIncrement(limiterId, limit)
        })

      const decrement: CallLimiterApi["decrement"] = (
        limiterId,
        originWindow,
      ) =>
        Effect.gen(function* () {
          yield* dieIfBadLimiterId("decrement", limiterId)
          yield* dieIfBadOriginWindow("decrement", originWindow)
          return yield* innerApi.decrement(limiterId, originWindow)
        })

      const refresh: CallLimiterApi["refresh"] = (limiterId, originWindow) =>
        Effect.gen(function* () {
          yield* dieIfBadLimiterId("refresh", limiterId)
          yield* dieIfBadOriginWindow("refresh", originWindow)
          return yield* innerApi.refresh(limiterId, originWindow)
        })

      return {
        checkAndIncrement,
        decrement,
        refresh,
        currentWindow: innerApi.currentWindow,
      }
    }),
  )

// ---------------------------------------------------------------------------
// scopedAudit
// ---------------------------------------------------------------------------

export interface ScopedAuditOptions {
  /**
   * When `true` (default) the audit verifies that every counter that
   * incremented decremented back to 0 by scope close. Net delta per
   * `(limiterId, window)` key must be 0. This is ADR-0004's load-bearing
   * invariant.
   *
   * Fail-open admissions (`checkAndIncrement` ended with
   * `LimiterTimeout` or `RedisError`) are EXCLUDED from the ledger:
   * they do not increment a Redis counter and must not decrement one.
   * The audit also excludes `decrement` calls that don't match any
   * observed admission — these are the "stale terminate" path the
   * caller filters via `incrementSucceeded !== false` per ADR-0004's
   * Rule 1. Such mismatches would surface as `A2_orphanDecrement`.
   */
  readonly checkCounterBackToZero?: boolean
  /**
   * When `true` (default) the audit also flags `decrement` calls that
   * don't pair with any observed `checkAndIncrement` admission within
   * the scope. Advisory by default — ADR-0004 documents that phantom
   * INCRs from dead workers can be DECR'd by a peer's takeover path,
   * which produces exactly this pattern; it isn't a defect.
   */
  readonly checkNoOrphanDecrement?: boolean
  /**
   * Optional predicate keyed by `limiterId`. Returning `true` excludes
   * that limiterId from the counter-back-to-zero check. Used by SUTs
   * that intentionally leak counters as part of their scenario (chaos
   * fixtures exercising ADR-0004's reconcile bound).
   */
  readonly skipLimiterId?: (limiterId: string) => boolean
}

/**
 * Wrap a `CallLimiter` Layer with typed recording + scope-close audit
 * invariants. Reads `Recorder` + `RunContext` from the surrounding
 * scope.
 *
 * Invariants checked at scope close:
 *
 *   - **A1_counterBackToZero** — every `(limiterId, window)` key whose
 *     net delta is nonzero at scope close. Successful admissions
 *     contribute `+1` keyed by `currentWindow`; `decrement(id,
 *     originWindow)` contributes `−1` keyed by `originWindow`;
 *     `refresh(id, origin)` is atomic `(−1 from origin, +1 to
 *     newWindow)`. Severity per D5 — `deferred-fail` in
 *     `test-with-recorder` (ADR-0004 says this should be structural);
 *     `advisory` in `real-run` (chaos paths produce intentional
 *     overshoot per ADR-0004).
 *
 *   - **A2_orphanDecrement** — `decrement` calls with no matching
 *     observed admission. Advisory — peer takeover legitimately
 *     decrements dead-worker counters this scope never admitted.
 */
export const scopedAudit = (
  inner: Layer.Layer<CallLimiter>,
  options?: ScopedAuditOptions,
): Layer.Layer<CallLimiter, never, Recorder | RunContext> => {
  const checkCounterBackToZero = options?.checkCounterBackToZero ?? true
  const checkNoOrphanDecrement = options?.checkNoOrphanDecrement ?? true
  const skipLimiterId = options?.skipLimiterId ?? (() => false)
  return Layer.effect(
    CallLimiter,
    Effect.gen(function* () {
      const {
        innerApi,
        recorder,
        channel,
        ctx,
        anomalies,
        pushAnomaly,
      } = yield* mkAuditContext<CallLimiterEvent, CallLimiter, CallLimiterApi>(
        CallLimiter,
        inner,
        "lim",
      )

      const projector: Projector<CallLimiterEvent> = () => ({
        anomalies: anomalies.slice(),
      })
      yield* recorder.registerProjector(CallLimiter, projector)

      const checkAndIncrement: CallLimiterApi["checkAndIncrement"] = (
        limiterId,
        limit,
      ) =>
        Effect.gen(function* () {
          yield* channel.record({
            tag: "checkAndIncrement.called",
            limiterId,
            limit,
          })
          const exit = yield* Effect.exit(innerApi.checkAndIncrement(limiterId, limit))
          if (exit._tag === "Success") {
            const decision = exit.value
            yield* channel.record({
              tag: "checkAndIncrement.result",
              limiterId,
              limit,
              outcome: "ok",
              decision: decision._tag,
              ...(decision._tag === "Allowed"
                ? { currentWindow: decision.currentWindow }
                : {}),
            })
            return decision
          }
          // Distinguish typed fail (RedisError / LimiterTimeout) from
          // interrupt / defect so the audit ledger can exclude
          // fail-open admissions per ADR-0004.
          const failCause = exit.cause
          let errorTag: "RedisError" | "LimiterTimeout" | undefined
          const failOpt = Cause.findErrorOption(failCause)
          if (Option.isSome(failOpt)) {
            const err = failOpt.value
            if (
              err !== null &&
              typeof err === "object" &&
              "_tag" in err &&
              typeof (err as { _tag: unknown })._tag === "string"
            ) {
              const t = (err as { _tag: string })._tag
              errorTag = t === "LimiterTimeout" ? "LimiterTimeout" : "RedisError"
            }
          }
          yield* channel.record({
            tag: "checkAndIncrement.result",
            limiterId,
            limit,
            outcome: "fail",
            ...(errorTag !== undefined ? { errorTag } : {}),
          })
          return yield* Effect.failCause(failCause)
        })

      const decrement: CallLimiterApi["decrement"] = (limiterId, originWindow) =>
        Effect.gen(function* () {
          yield* channel.record({
            tag: "decrement.called",
            limiterId,
            originWindow,
          })
          const exit = yield* Effect.exit(innerApi.decrement(limiterId, originWindow))
          yield* channel.record({
            tag: "decrement.result",
            limiterId,
            originWindow,
            outcome: exit._tag === "Success" ? "ok" : "fail",
          })
          if (exit._tag === "Success") return
          return yield* Effect.failCause(exit.cause)
        })

      const refresh: CallLimiterApi["refresh"] = (limiterId, originWindow) =>
        Effect.gen(function* () {
          yield* channel.record({
            tag: "refresh.called",
            limiterId,
            originWindow,
          })
          const exit = yield* Effect.exit(innerApi.refresh(limiterId, originWindow))
          if (exit._tag === "Success") {
            yield* channel.record({
              tag: "refresh.result",
              limiterId,
              originWindow,
              outcome: "ok",
              newWindow: exit.value,
            })
            return exit.value
          }
          yield* channel.record({
            tag: "refresh.result",
            limiterId,
            originWindow,
            outcome: "fail",
          })
          return yield* Effect.failCause(exit.cause)
        })

      const currentWindow = Effect.gen(function* () {
        yield* channel.record({ tag: "currentWindow.called" })
        const exit = yield* Effect.exit(innerApi.currentWindow)
        if (exit._tag === "Success") {
          yield* channel.record({
            tag: "currentWindow.result",
            outcome: "ok",
            window: exit.value,
          })
          return exit.value
        }
        yield* channel.record({
          tag: "currentWindow.result",
          outcome: "fail",
        })
        return yield* Effect.failCause(exit.cause)
      })

      // Scope-close finalizer: run audit invariants.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const snap = yield* channel.snapshot
          yield* runAuditInvariants({
            checkCounterBackToZero,
            checkNoOrphanDecrement,
            skipLimiterId,
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
                new CallLimiterAuditViolation({
                  check: first.check,
                  detail: first.detail,
                }),
              )
            }
          }
          if (ctx.kind === "test-with-recorder") {
            // Counter-back-to-zero is ADR-0004's load-bearing invariant —
            // escalate that one specifically.
            const first = anomalies.find(
              (a) =>
                a.kind === "signalingAudit" &&
                a.severity === "deferred-fail" &&
                a.check === "lim.A1_counterBackToZero",
            )
            if (first !== undefined && first.kind === "signalingAudit") {
              return yield* Effect.die(
                new CallLimiterAuditViolation({
                  check: first.check,
                  detail: first.detail,
                }),
              )
            }
          }
        }),
      )

      return {
        checkAndIncrement,
        decrement,
        refresh,
        currentWindow,
      }
    }),
  )
}

/**
 * Walk the channel snapshot and apply ADR-0004's counter-back-to-zero
 * ledger. The ledger key is `${limiterId}:${window}`. Successful
 * admissions contribute `+1` at `currentWindow`; `decrement`
 * contributes `-1` at `originWindow`; `refresh` contributes a paired
 * `(−1 from origin, +1 to new)`.
 */
const runAuditInvariants = (args: {
  readonly checkCounterBackToZero: boolean
  readonly checkNoOrphanDecrement: boolean
  readonly skipLimiterId: (limiterId: string) => boolean
  readonly events: ReadonlyArray<CallLimiterEvent & { seq: number; atMs: number }>
  readonly push: (
    check: string,
    detail: string,
    baseline: "advisory" | "deferred-fail",
  ) => void
}): Effect.Effect<void> =>
  Effect.sync(() => {
    const {
      checkCounterBackToZero,
      checkNoOrphanDecrement,
      skipLimiterId,
      events,
      push,
    } = args
    const sorted = [...events].sort((a, b) => a.seq - b.seq)

    // Net delta ledger keyed by `${limiterId}:${window}`.
    const ledger = new Map<string, { limiterId: string; window: number; delta: number }>()
    // Track total admissions / decrements per limiterId for orphan detection.
    const admissionsByLimiter = new Map<string, number>()
    const decrementsByLimiter = new Map<string, number>()

    const bump = (limiterId: string, window: number, by: number): void => {
      const k = `${limiterId}:${window}`
      const entry = ledger.get(k)
      if (entry !== undefined) {
        entry.delta += by
      } else {
        ledger.set(k, { limiterId, window, delta: by })
      }
    }

    for (const ev of sorted) {
      switch (ev.tag) {
        case "checkAndIncrement.result":
          if (
            ev.outcome === "ok" &&
            ev.decision === "Allowed" &&
            typeof ev.currentWindow === "number"
          ) {
            bump(ev.limiterId, ev.currentWindow, +1)
            admissionsByLimiter.set(
              ev.limiterId,
              (admissionsByLimiter.get(ev.limiterId) ?? 0) + 1,
            )
          }
          // Rejected / fail-open / interrupt all contribute nothing —
          // no counter changed.
          break
        case "decrement.result":
          if (ev.outcome === "ok") {
            bump(ev.limiterId, ev.originWindow, -1)
            decrementsByLimiter.set(
              ev.limiterId,
              (decrementsByLimiter.get(ev.limiterId) ?? 0) + 1,
            )
          }
          break
        case "refresh.result":
          if (ev.outcome === "ok" && typeof ev.newWindow === "number") {
            // Atomic migration: -1 origin, +1 new. The +1/-1 is on the
            // SAME limiterId so net change per limiterId is 0.
            if (ev.originWindow !== ev.newWindow) {
              bump(ev.limiterId, ev.originWindow, -1)
              bump(ev.limiterId, ev.newWindow, +1)
            }
            // origin === new is a no-op migration.
          }
          break
      }
    }

    // A1 — counter back to zero
    if (checkCounterBackToZero) {
      for (const [, entry] of ledger) {
        if (entry.delta === 0) continue
        if (skipLimiterId(entry.limiterId)) continue
        push(
          "A1_counterBackToZero",
          `(${entry.limiterId}, window=${entry.window}) net delta=${entry.delta} at scope close (ADR-0004: every successful INCR must be matched by exactly one DECR)`,
          "deferred-fail",
        )
      }
    }

    // A2 — orphan decrements (per-limiterId totals; not window-keyed)
    if (checkNoOrphanDecrement) {
      for (const [limiterId, decs] of decrementsByLimiter) {
        const admits = admissionsByLimiter.get(limiterId) ?? 0
        if (decs > admits && !skipLimiterId(limiterId)) {
          push(
            "A2_orphanDecrement",
            `(${limiterId}) ${decs} decrement(s) observed but only ${admits} admission(s); excess ${decs - admits} may be peer-takeover (ADR-0004)`,
            "advisory",
          )
        }
      }
    }
  })

// ---------------------------------------------------------------------------
// parity (memory vs redis)
// ---------------------------------------------------------------------------

/**
 * Programmer-error surface for parity divergences. Mirrors the codec /
 * PartitionedRelayStorage shape — the limiter is Effect-returning, so
 * mismatches surface via `Effect.die` (not `Effect.fail`). Putting it on
 * the typed error channel would force every caller of `checkAndIncrement`
 * etc. to widen its `catchTags` set to a defect-class error that only
 * exists in tests; `die` keeps the service signature identical between
 * raw and parity-wrapped layers.
 */
export class CallLimiterParityViolation extends Error {
  readonly _tag = "CallLimiterParityViolation"
  constructor(
    readonly method: string,
    readonly side: "memory-vs-redis",
    readonly detail: string,
  ) {
    super(`call-limiter parity ${method} ${side}: ${detail}`)
  }
}

export interface ParityOptions {
  /** Which side's result the wrapped layer returns. Default `"blue"` (memory). */
  readonly returnSide?: "blue" | "green"
}

/**
 * Compare a `LimiterDecision` pair from blue (memory) vs green (redis).
 * `Allowed` decisions match only when their `currentWindow` matches.
 * `Rejected` matches `Rejected`. The two outcomes never mix.
 */
const decisionsEqual = (
  b: LimiterDecision,
  g: LimiterDecision,
): boolean => {
  if (b._tag === "Rejected" && g._tag === "Rejected") return true
  if (b._tag === "Allowed" && g._tag === "Allowed") {
    return b.currentWindow === g.currentWindow
  }
  return false
}

const renderDecision = (d: LimiterDecision): string =>
  d._tag === "Allowed" ? `Allowed(currentWindow=${d.currentWindow})` : "Rejected"

/**
 * Wrap TWO `CallLimiter` impls (memory + redis) and assert deep-equal
 * outcomes on each Effect-returning method. Returns the `blue` (memory)
 * side's result by default; pass `returnSide: "green"` to switch.
 *
 * Comparison semantics
 * --------------------
 *
 *   - `checkAndIncrement` — both sides run in parallel; outcomes must
 *     match on `_tag` and (for `Allowed`) `currentWindow`. Typed
 *     failures (`LimiterTimeout` / `RedisError`) on one side and a
 *     success on the other are a parity violation; failures on both
 *     sides are NOT compared in detail (the failure shape itself is a
 *     fail-open admission and ADR-0004 says no counter change follows
 *     either way).
 *
 *   - `decrement` — both sides run in parallel; success/failure outcome
 *     must match.
 *
 *   - `refresh` — both sides run in parallel; the migrated
 *     `currentWindow` numeric values must match. Same comparator shape
 *     as the other Effect-returning methods. (The Tag declares
 *     `Effect<number, RedisError>` and both impls honour it; the
 *     memory `Effect.sync` vs Redis two-step Lua difference is an
 *     implementation detail not observable through the typed channel.)
 *
 *   - `currentWindow` — both sides run in parallel; numeric values must
 *     match.
 *
 * On any mismatch the wrapper `Effect.die`s with a
 * `CallLimiterParityViolation` defect (matches the
 * `PartitionedRelayStorage.parity` shape) AND records a
 * `signalingAudit`-kind anomaly via the Recorder before dying so the
 * scenario report carries the diagnostic.
 */
export const parity = (
  blue: Layer.Layer<CallLimiter>,
  green: Layer.Layer<CallLimiter>,
  options?: ParityOptions,
): Layer.Layer<CallLimiter, never, Recorder> => {
  const returnSide = options?.returnSide ?? "blue"
  return Layer.effect(
    CallLimiter,
    Effect.gen(function* () {
      const blueMap = yield* Layer.build(blue)
      const greenMap = yield* Layer.build(green)
      const blueApi = ServiceMap.get(blueMap, CallLimiter)
      const greenApi = ServiceMap.get(greenMap, CallLimiter)
      const recorder = yield* Recorder

      // Parity uses a dedicated anomaly buffer + projector so a parity
      // wrapper used standalone (without scopedAudit underneath) still
      // surfaces violations through `Recorder.snapshot.anomalies`. When
      // scopedAudit is also in the stack the projectors are registered
      // first-wins (see Recorder.registerProjector), so this projector
      // only takes effect when parity is the sole wrapper consumer of
      // the CallLimiter channel.
      const anomalies: RecordedAnomaly[] = []
      const projector: Projector<CallLimiterEvent> = () => ({
        anomalies: anomalies.slice(),
      })
      yield* recorder.registerProjector(CallLimiter, projector)

      const pushParityAnomaly = (
        method: string,
        detail: string,
      ): void => {
        anomalies.push({
          kind: "signalingAudit",
          check: `lim.parity.${method}`,
          detail,
          severity: "deferred-fail",
        })
      }

      const dieWith = (
        method: string,
        detail: string,
      ): Effect.Effect<never> => {
        pushParityAnomaly(method, detail)
        return Effect.die(
          new CallLimiterParityViolation(method, "memory-vs-redis", detail),
        )
      }

      const checkAndIncrement: CallLimiterApi["checkAndIncrement"] = (
        limiterId,
        limit,
      ) =>
        Effect.gen(function* () {
          // Run both in parallel — the Redis side carries a 150 ms
          // outer budget, so a clock-frozen test that doesn't advance
          // would otherwise serialise wall-clock budget consumption.
          const [bExit, gExit] = yield* Effect.all(
            [
              Effect.exit(blueApi.checkAndIncrement(limiterId, limit)),
              Effect.exit(greenApi.checkAndIncrement(limiterId, limit)),
            ],
            { concurrency: "unbounded" },
          )
          if (bExit._tag === "Success" && gExit._tag === "Success") {
            if (!decisionsEqual(bExit.value, gExit.value)) {
              return yield* dieWith(
                "checkAndIncrement",
                `(${limiterId}, limit=${limit}) memory=${renderDecision(bExit.value)} vs redis=${renderDecision(gExit.value)}`,
              )
            }
            return returnSide === "blue" ? bExit.value : gExit.value
          }
          // Mixed outcome: one side succeeded, the other failed.
          if (bExit._tag !== gExit._tag) {
            return yield* dieWith(
              "checkAndIncrement",
              `(${limiterId}, limit=${limit}) outcome divergence: memory=${bExit._tag} vs redis=${gExit._tag}`,
            )
          }
          // Both failed — fail-open path on BOTH sides. ADR-0004 says no
          // counter follows either way; the specific failure shape
          // (LimiterTimeout vs RedisError) isn't a parity property.
          // Re-raise the chosen side's Cause so the typed error channel
          // remains usable by the caller's catchTags.
          const chosen = returnSide === "blue" ? bExit : gExit
          if (chosen._tag === "Failure") {
            return yield* Effect.failCause(chosen.cause)
          }
          // unreachable — both are Failure here
          return yield* Effect.die("unreachable parity branch")
        })

      const decrement: CallLimiterApi["decrement"] = (limiterId, originWindow) =>
        Effect.gen(function* () {
          const [bExit, gExit] = yield* Effect.all(
            [
              Effect.exit(blueApi.decrement(limiterId, originWindow)),
              Effect.exit(greenApi.decrement(limiterId, originWindow)),
            ],
            { concurrency: "unbounded" },
          )
          if (bExit._tag !== gExit._tag) {
            return yield* dieWith(
              "decrement",
              `(${limiterId}, originWindow=${originWindow}) outcome divergence: memory=${bExit._tag} vs redis=${gExit._tag}`,
            )
          }
          const chosen = returnSide === "blue" ? bExit : gExit
          if (chosen._tag === "Success") return
          return yield* Effect.failCause(chosen.cause)
        })

      const refresh: CallLimiterApi["refresh"] = (limiterId, originWindow) =>
        Effect.gen(function* () {
          const [bExit, gExit] = yield* Effect.all(
            [
              Effect.exit(blueApi.refresh(limiterId, originWindow)),
              Effect.exit(greenApi.refresh(limiterId, originWindow)),
            ],
            { concurrency: "unbounded" },
          )
          if (bExit._tag === "Success" && gExit._tag === "Success") {
            // Refresh returns the migrated `currentWindow`. Both sides
            // observe the same `Clock`, so the windows must match.
            if (bExit.value !== gExit.value) {
              return yield* dieWith(
                "refresh",
                `(${limiterId}, originWindow=${originWindow}) newWindow divergence: memory=${bExit.value} vs redis=${gExit.value}`,
              )
            }
            return returnSide === "blue" ? bExit.value : gExit.value
          }
          // Outcome-tag divergence is a parity violation; both-failed
          // re-raises the chosen side's Cause without comparing failure
          // shape (matches the other Effect-returning methods).
          if (bExit._tag !== gExit._tag) {
            return yield* dieWith(
              "refresh",
              `(${limiterId}, originWindow=${originWindow}) outcome divergence: memory=${bExit._tag} vs redis=${gExit._tag}`,
            )
          }
          const chosen = returnSide === "blue" ? bExit : gExit
          if (chosen._tag === "Failure") {
            return yield* Effect.failCause(chosen.cause)
          }
          // unreachable
          return yield* Effect.die("unreachable parity branch")
        })

      const currentWindow = Effect.gen(function* () {
        const [bExit, gExit] = yield* Effect.all(
          [Effect.exit(blueApi.currentWindow), Effect.exit(greenApi.currentWindow)],
          { concurrency: "unbounded" },
        )
        if (bExit._tag === "Success" && gExit._tag === "Success") {
          if (bExit.value !== gExit.value) {
            return yield* dieWith(
              "currentWindow",
              `memory=${bExit.value} vs redis=${gExit.value}`,
            )
          }
          return returnSide === "blue" ? bExit.value : gExit.value
        }
        if (bExit._tag !== gExit._tag) {
          return yield* dieWith(
            "currentWindow",
            `outcome divergence: memory=${bExit._tag} vs redis=${gExit._tag}`,
          )
        }
        const chosen = returnSide === "blue" ? bExit : gExit
        if (chosen._tag === "Failure") {
          return yield* Effect.failCause(chosen.cause)
        }
        return yield* Effect.die("unreachable parity branch")
      })

      return {
        checkAndIncrement,
        decrement,
        refresh,
        currentWindow,
      }
    }),
  )
}

// ---------------------------------------------------------------------------
// withAllContracts — canonical-order forwarder
// ---------------------------------------------------------------------------

export interface CallLimiterContractsOptions {
  readonly paranoidInputs?: boolean
  readonly scopedAudit?: ScopedAuditOptions | true
}

/**
 * Thin forwarder around `withCanonicalContracts`. `propertyTest` is
 * intentionally not exposed (no natural input domain — limit / window
 * arithmetic is uninteresting at the unit level). `parity` stays
 * outside this helper per D7 — build a parity layer first via
 * `CallLimiter.parity(...)` and pass it as `impl`.
 */
export const withAllContracts = (
  impl: Layer.Layer<CallLimiter>,
  options?: CallLimiterContractsOptions,
): Layer.Layer<CallLimiter, never, Recorder | RunContext> => {
  const opts: CanonicalContractsOptions<
    CallLimiter,
    never,
    never,
    ScopedAuditOptions
  > = {
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
  return withCanonicalContracts(CallLimiter, impl, opts) as Layer.Layer<
    CallLimiter,
    never,
    Recorder | RunContext
  >
}

// ---------------------------------------------------------------------------
// Static bolt-on — make `CallLimiter.parity(...)` callable on the Tag
// ---------------------------------------------------------------------------
//
// Side-effect import: importing this file augments the `CallLimiter`
// class with the `parity` static. Consumers that call
// `CallLimiter.parity(...)` MUST import this module (the test
// `testLayers.ts` bundle already does, transitively via
// `withCallLimiterContracts`). Same pattern as `CallBodyCodec`'s
// `index.ts` Object.assign bolt-on — defers the parity wiring outside
// the Tag's own module to avoid a load cycle.
Object.assign(CallLimiter, { parity })
