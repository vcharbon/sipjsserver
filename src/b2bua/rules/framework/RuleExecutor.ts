/**
 * RuleExecutor — the core rule chain runner.
 *
 * For each event, builds a merged list of rules active for the call
 * (per-call activated + always-active built-ins), then lets the Matcher
 * pick the candidates ordered by specificity desc.
 *
 * Iteration contract:
 * 1. First candidate whose handle() returns non-undefined wins
 * 2. Actions are translated via ActionExecutor → InvariantEnforcer → HandlerResult
 * 3. If no candidate handles → default handler (fallback)
 *
 * Composition: a rule declaring `composesWith: baseId` runs before the base;
 * the base rule is skipped from the iteration for this event and its actions
 * are appended after the composing rule's actions.
 */

import { Effect, Schema } from "effect"
import type { CallEvent, Handler, HandlerResult } from "../../../sip/SipRouter.js"
import type { ResolvedContext } from "../../../sip/SipRouter.js"
import type { RuleRegistry } from "./RuleRegistry.js"
import type { RuleContext, RuleHandleResult, AnyRuleDefinition } from "./RuleDefinition.js"
import { executeActions } from "./ActionExecutor.js"
import { enforceInvariants } from "./InvariantEnforcer.js"
import { enforceByeDispositionInvariant, type ByeDispositionViolation } from "./ByeDispositionInvariant.js"
import { handleLimiterRefresh } from "./FrameworkLimiterRefresh.js"
import { pickRanked } from "./Matcher.js"
import { isFullyResolved } from "../../../call/CallModel.js"
import type { Call, Leg } from "../../../call/CallModel.js"

// ── Context conversion ─────────────────────────────────────────────────────

/** Convert ResolvedContext (from SipRouter) to RuleContext (for rules). */
function toRuleContext(ctx: ResolvedContext): RuleContext {
  return {
    call: ctx.call,
    callRef: ctx.callRef,
    event: ctx.event,
    sourceLeg: ctx.leg,
    sourceDialog: ctx.dialog,
    direction: ctx.direction,
    config: ctx.config,
    callControl: ctx.callControl,
    limiter: ctx.limiter,
    nowMs: ctx.nowMs,
  }
}

// ── Callflow-service ext decode (ADR-0016) ────────────────────────────────
//
// Before matching, decode each ACTIVE service's `call.ext[id]` / source
// `leg.ext[id]` (Encoded → typed) so filters and handlers read a checked
// projection. A service is active when its `call.ext` key is present (or it's
// `alwaysActive`). Decode is synchronous Schema work wrapped like the existing
// init hop (ADR-0003: sync JS in the dispatch region is permitted). A decode
// defect makes that service inert this event (its key is omitted from the
// decoded maps, so its guard/filters see `undefined`).

/** Sentinel for "decode failed → skip this service this event". */
const DECODE_SKIP: unique symbol = Symbol.for("b2bua/service-ext-decode-skip")

function decodeServiceExt(
  registry: RuleRegistry,
  call: Call,
  sourceLeg: Leg,
): Effect.Effect<{ readonly callExt: Record<string, unknown>; readonly legExt: Record<string, unknown> }> {
  return Effect.gen(function* () {
    const callExt: Record<string, unknown> = {}
    const legExt: Record<string, unknown> = {}
    for (const [sid, svc] of registry.services) {
      const rawCall = call.ext?.[sid]
      if (rawCall === undefined && svc.alwaysActive !== true) continue

      if (svc.callExtSchema !== undefined && rawCall !== undefined) {
        const decoded = yield* Effect.catchDefect(
          Effect.sync(() => Schema.decodeUnknownSync(svc.callExtSchema!)(rawCall)),
          (defect) =>
            Effect.logWarning(`Service ${sid}: call-ext decode failed: ${defect}`).pipe(
              Effect.as(DECODE_SKIP as typeof DECODE_SKIP),
            ),
        )
        if (decoded === DECODE_SKIP) continue
        callExt[sid] = decoded
      }

      if (svc.legExtSchema !== undefined) {
        const rawLeg = sourceLeg.ext?.[sid]
        if (rawLeg !== undefined) {
          const decoded = yield* Effect.catchDefect(
            Effect.sync(() => Schema.decodeUnknownSync(svc.legExtSchema!)(rawLeg)),
            (defect) =>
              Effect.logWarning(`Service ${sid}: leg-ext decode failed: ${defect}`).pipe(
                Effect.as(DECODE_SKIP as typeof DECODE_SKIP),
              ),
          )
          if (decoded !== DECODE_SKIP) legExt[sid] = decoded
        }
      }
    }
    return { callExt, legExt }
  })
}

// ── Per-call entry bookkeeping ────────────────────────────────────────────

/**
 * Collect the rule definitions active for this call: per-call activations
 * (from `Call.activeRules`) plus always-active built-ins.
 */
function collectActivations(
  call: Call,
  registry: RuleRegistry,
): AnyRuleDefinition[] {
  const defs: AnyRuleDefinition[] = []
  const seen = new Set<string>()

  if (call.activeRules !== undefined) {
    for (const ar of call.activeRules) {
      if (!ar.active) continue
      const def = registry.definitions.get(ar.id)
      if (def === undefined) continue
      defs.push(def)
      seen.add(ar.id)
    }
  }

  for (const [id, def] of registry.definitions) {
    if (seen.has(id)) continue
    if (!def.alwaysActive) continue
    defs.push(def)
  }

  return defs
}

// ── Rule attribution ──────────────────────────────────────────────────────

/** Add a span event recording which rule handled the event. */
function addRuleAttribution(result: HandlerResult, ruleId: string, ruleName: string): HandlerResult {
  return {
    ...result,
    spanEvents: [
      ...(result.spanEvents ?? []),
      { name: "rule_handled", attributes: { "rule.id": ruleId, "rule.name": ruleName } },
    ],
  }
}

// ── Termination promotion + bye-disposition invariant ───────────────────
//
// Every rule firing funnels through `finalizeTermination`: it runs the
// bye-disposition invariant (catches rules that absorbed a BYE-resolution
// event without emitting terminate-leg, force-corrects the disposition),
// then performs the terminating → terminated promotion. Returns a tuple
// because the WARN log for any violation has to be emitted by the caller's
// generator (Effect-aware) rather than by a sync helper.
function finalizeTermination(
  callBefore: Call,
  event: CallEvent,
  result: HandlerResult,
): { readonly result: HandlerResult; readonly violations: ReadonlyArray<ByeDispositionViolation> } {
  const { call, violations } = enforceByeDispositionInvariant(callBefore, event, result.call)
  let next: HandlerResult = call === result.call ? result : { ...result, call }
  if (next.call.state === "terminating" && isFullyResolved(next.call)) {
    next = { ...next, call: { ...next.call, state: "terminated" } }
  }
  return { result: next, violations }
}

function logByeDispositionViolations(
  violations: ReadonlyArray<ByeDispositionViolation>,
  ruleId: string,
  callRef: string,
  eventType: string,
): Effect.Effect<void> {
  if (violations.length === 0) return Effect.void
  return Effect.forEach(
    violations,
    (v) =>
      Effect.logWarning(
        `bye-disposition invariant: rule ${ruleId} consumed ${eventType} for call ${callRef} ` +
          `leg ${v.legId} without terminating it; framework forced ${v.forced}`
      ),
    { discard: true }
  )
}

// ── Auto-flush ───────────────────────────────────────────────────────────
//
// If a rule mutated the call (reference inequality with the pre-rule call)
// and didn't already emit `flush-redis`, append one. This guarantees that
// every state-mutating rule persists the call to the call-state cache (and
// thence the replication peer) before the next event lands.
//
// Action mutations always produce a new Call via immutable updateLeg /
// updateDialog helpers, so reference equality is sound.
//
// Fix #4 — content-meaningful diff gate. Reference inequality alone
// over-fires: the SipRouter's per-event `messageCount` bump (cap-
// defense bookkeeping that piggybacks on the rule pipeline) creates
// a new Call ref on every relayed message. If *only* `messageCount`
// changed, skip the flush — the field is restart-tolerant and a
// missed write will be re-stamped by the next genuine mutation. Any
// other change (legs, dialogs, timers, ext, ...) still flushes via the
// shallow reference-inequality test below.

// `messageCount` is the only field whose mutation alone does NOT
// warrant a Redis write. Every other persisted field on the Call
// schema is safety- or correctness-relevant on restart / takeover.
const NON_FLUSH_RELEVANT_KEYS: ReadonlySet<string> = new Set(["messageCount"])

function persistedFieldsEqual(a: Call, b: Call): boolean {
  // Quick reference test — most no-mutation paths bail out here.
  if (a === b) return true
  // Shallow per-field reference compare, skipping the non-relevant set.
  // Immutable update helpers re-use sub-trees when their content is
  // unchanged, so reference equality on a top-level field IS a content
  // equality test on the sub-tree.
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const k of aKeys) {
    if (NON_FLUSH_RELEVANT_KEYS.has(k)) continue
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) {
      return false
    }
  }
  return true
}

function appendAutoFlush(callBefore: Call, result: HandlerResult): HandlerResult {
  if (result.call === callBefore) return result
  if (result.effects.critical.some((e) => e.type === "flush-redis")) return result
  if (persistedFieldsEqual(callBefore, result.call)) return result
  return {
    ...result,
    effects: {
      ...result.effects,
      critical: [...result.effects.critical, { type: "flush-redis" }],
    },
  }
}

// ── Rule executor factory ──────────────────────────────────────────────────

/**
 * Create a Handler that runs active rules before falling back to a default handler.
 *
 * Usage in main.ts:
 *   const handlers: HandlerRegistry = {
 *     initialInvite: handleInitialInvite,
 *     inDialog: executeRules(registry, noopFallback),
 *   }
 */
export function executeRules(
  registry: RuleRegistry,
  defaultHandler: Handler,
): Handler {
  return (ctx: ResolvedContext): Effect.Effect<HandlerResult, never, never> =>
    Effect.gen(function* () {
      // ── Framework intercept: limiter_refresh ──
      // Periodic limiter window migration is a framework concern (touches
      // Redis, deals with window-rotation internals). It bypasses the rule
      // chain entirely. See FrameworkLimiterRefresh.ts and
      // AdvancedCallModel.md §"Limitations and Not Yet Implemented".
      if (ctx.event.type === "timer" && ctx.event.timerType === "limiter_refresh") {
        return yield* handleLimiterRefresh(ctx)
      }

      const { call } = ctx
      const callBefore = call

      const defs = collectActivations(call, registry)
      if (defs.length === 0) {
        return yield* defaultHandler(ctx)
      }

      const ruleCtx = toRuleContext(ctx)

      // Decode active services' ext into a rule-facing projection used for
      // matching + filters + handlers. The original `ruleCtx` (Encoded ext) is
      // what reaches executeActions / persistence — the minted service-rule
      // closures re-encode their slices via set-call-ext / set-leg-ext, so only
      // Encoded values ever cross the codec.
      const decodedExt = registry.services.size === 0
        ? undefined
        : yield* decodeServiceExt(registry, call, ctx.leg)
      const matchCtx: RuleContext =
        decodedExt === undefined ||
        (Object.keys(decodedExt.callExt).length === 0 && Object.keys(decodedExt.legExt).length === 0)
          ? ruleCtx
          : {
              ...ruleCtx,
              call: { ...ruleCtx.call, ext: decodedExt.callExt },
              sourceLeg: { ...ruleCtx.sourceLeg, ext: decodedExt.legExt },
            }

      const candidates = pickRanked(defs, matchCtx)

      if (candidates.length === 0) {
        return yield* defaultHandler(ctx)
      }

      // ── Composition: skip any base rule whose composing rule is also a candidate ──
      const composedBaseIds = new Set<string>()
      for (const def of candidates) {
        if (def.composesWith !== undefined) composedBaseIds.add(def.composesWith)
      }

      // ── Iterate candidates: first one whose handle() returns non-undefined wins ──
      for (const definition of candidates) {
        const id = definition.id
        if (composedBaseIds.has(id)) continue

        // Run rule handler with defect boundary. The handler reads decoded
        // service ext via `matchCtx`; persistence below uses `ruleCtx`.
        const outcome: RuleHandleResult | undefined | void = yield* Effect.catchDefect(
          definition.handle(matchCtx),
          (defect) => {
            const errorPolicy = definition.onError ?? "passthrough"
            if (errorPolicy === "terminate") {
              return Effect.logError(`Rule ${id} failed (terminating): ${defect}`).pipe(
                Effect.as({ actions: [{ type: "terminate-call" as const }] } as RuleHandleResult),
              )
            }
            return Effect.logError(`Rule ${id} failed (passing through): ${defect}`).pipe(
              Effect.as(undefined),
            )
          },
        )

        if (outcome == null) continue

        // ── Rule handled the event — execute actions ──

        // ── Composed execution path ──
        // When a rule declares composesWith, it runs BEFORE the base rule:
        //   1. Execute this rule's pre-actions (updating working call state)
        //   2. Run the base rule's handle() on the post-pre-action call
        //   3. Merge results (pre-actions + base actions)
        if (definition.composesWith) {
          const preResult = executeActions(outcome.actions, ruleCtx, id)

          // Find and run the base rule with the modified call state
          const baseDef = registry.definitions.get(definition.composesWith)
          if (baseDef) {
            const baseCtx: RuleContext = { ...ruleCtx, call: preResult.call }

            const baseOutcome = yield* baseDef.handle(baseCtx)
            if (baseOutcome != null) {
              const baseResult = executeActions(baseOutcome.actions, baseCtx, definition.composesWith)
              // Merge: pre-actions first, then base actions
              const merged = addRuleAttribution(
                {
                  call: baseResult.call,
                  effects: {
                    critical: [...preResult.effects.critical, ...baseResult.effects.critical],
                    outbound: [...preResult.effects.outbound, ...baseResult.effects.outbound],
                    soft: [...preResult.effects.soft, ...baseResult.effects.soft],
                    buffered: [...preResult.effects.buffered, ...baseResult.effects.buffered],
                    fireAndForget: [
                      ...preResult.effects.fireAndForget,
                      ...baseResult.effects.fireAndForget,
                    ],
                  },
                  spanEvents: [...(preResult.spanEvents ?? []), ...(baseResult.spanEvents ?? [])],
                },
                id,
                definition.name,
              )
              const finalized = finalizeTermination(callBefore, ctx.event, merged)
              yield* logByeDispositionViolations(finalized.violations, id, ctx.callRef, ctx.event.type)
              return enforceInvariants(callBefore, appendAutoFlush(callBefore, finalized.result))
            }
          }

          // Base rule didn't handle or doesn't exist — return just the pre-actions
          const preFinal = finalizeTermination(
            callBefore,
            ctx.event,
            addRuleAttribution(preResult, id, definition.name),
          )
          yield* logByeDispositionViolations(preFinal.violations, id, ctx.callRef, ctx.event.type)
          return enforceInvariants(callBefore, appendAutoFlush(callBefore, preFinal.result))
        }

        // ── Non-composed path ──
        const attributed = addRuleAttribution(executeActions(outcome.actions, ruleCtx, id), id, definition.name)
        const finalized = finalizeTermination(callBefore, ctx.event, attributed)
        yield* logByeDispositionViolations(finalized.violations, id, ctx.callRef, ctx.event.type)
        return enforceInvariants(callBefore, appendAutoFlush(callBefore, finalized.result))
      }

      // ── No rule handled — fall back to default handler ──
      return yield* defaultHandler(ctx)
    })
}
