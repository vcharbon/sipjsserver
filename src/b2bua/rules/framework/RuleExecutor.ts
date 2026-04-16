/**
 * RuleExecutor — the core rule chain runner.
 *
 * For each event, builds a merged priority-sorted list of:
 * - Per-call rules (from call.activeRules — activated via HTTP API)
 * - Always-active rules (from registry — built-in B2BUA rules)
 *
 * Then iterates in priority order (ascending):
 * 1. First rule whose matches() returns true AND handle() returns non-undefined wins
 * 2. Actions are translated via ActionExecutor → InvariantEnforcer → HandlerResult
 * 3. If no rule handles → default handler (fallback)
 */

import { Effect } from "effect"
import type { Handler, HandlerResult } from "../../../sip/SipRouter.js"
import type { ResolvedContext } from "../../../sip/SipRouter.js"
import type { RuleRegistry } from "./RuleRegistry.js"
import type { RuleContext, RuleHandleResult, AnyRuleDefinition } from "./RuleDefinition.js"
import { executeActions } from "./ActionExecutor.js"
import { enforceInvariants } from "./InvariantEnforcer.js"
import { handleLimiterRefresh } from "./FrameworkLimiterRefresh.js"
import { shadowCompare } from "./ShadowMatcher.js"
import { getRuleState, setRuleState, isFullyResolved } from "../../../call/CallModel.js"
import type { Call } from "../../../call/CallModel.js"

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

// ── Unified rule entry ────────────────────────────────────────────────────

/** A merged entry representing either a per-call activated rule or an always-active built-in rule. */
interface RuleEntry {
  readonly id: string
  readonly priority: number
  readonly params: unknown
  readonly definition: AnyRuleDefinition
}

/**
 * Build a priority-sorted list merging per-call rules and always-active rules.
 * Per-call rules take priority over always-active rules with the same ID.
 */
function buildRuleList(call: Call, registry: RuleRegistry): RuleEntry[] {
  const entries: RuleEntry[] = []
  const seenIds = new Set<string>()

  // Per-call rules (from HTTP API response)
  if (call.activeRules !== undefined) {
    for (const ar of call.activeRules) {
      if (!ar.active) continue
      const def = registry.definitions.get(ar.id)
      if (def === undefined) continue
      entries.push({ id: ar.id, priority: ar.priority, params: ar.params ?? {}, definition: def })
      seenIds.add(ar.id)
    }
  }

  // Always-active rules (built-in, from registry)
  for (const [id, def] of registry.definitions) {
    if (seenIds.has(id)) continue // per-call rule overrides
    if (!def.alwaysActive) continue
    entries.push({ id, priority: def.defaultPriority ?? 900, params: {}, definition: def })
  }

  entries.sort((a, b) => a.priority - b.priority)
  return entries
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

      // ── Build merged, sorted rule list ──
      const ruleList = buildRuleList(call, registry)

      // ── Fast path: no rules at all → default handler ──
      if (ruleList.length === 0) {
        return yield* defaultHandler(ctx)
      }

      // ── Convert to RuleContext ──
      const ruleCtx = toRuleContext(ctx)

      // ── Compute which base rules are consumed for THIS event ──
      // A base rule is consumed only when its composing rule matches this event.
      // This MUST be per-event (not startup) — when the policy guard fails,
      // the composed rule doesn't match and the base rule runs normally.
      const composedBaseIds = new Set<string>()
      for (const entry of ruleList) {
        if (entry.definition.composesWith && entry.definition.matches(ruleCtx)) {
          composedBaseIds.add(entry.definition.composesWith)
        }
      }

      // Definitions view for ShadowMatcher comparison (Phase B).
      const ruleDefs = ruleList.map((e) => e.definition)

      // ── Iterate rules in priority order ──
      for (const entry of ruleList) {
        const { definition, id, params } = entry

        // Skip base rules consumed by a composing rule for this event
        if (composedBaseIds.has(id)) continue

        // Fast filter
        if (!definition.matches(ruleCtx)) continue

        // State key — rules with the same stateKey share persisted state
        const stKey = definition.stateKey ?? id

        // Decode or initialize rule state.
        // Note: `undefined` is a valid state for stateless rules (Schema.Undefined).
        // We use `null` as the sentinel for "init failed / skip this rule".
        const rawState = getRuleState(call, stKey)
        const initResult = yield* Effect.catchDefect(
          Effect.sync(() => rawState !== undefined ? rawState : definition.init(params, call)),
          (defect) => Effect.logWarning(`Rule ${id}: state init failed: ${defect}`).pipe(
            Effect.as(null as null),
          ),
        )
        if (initResult === null) continue
        const state: unknown = initResult

        // Run rule handler with defect boundary
        const outcome: RuleHandleResult<unknown> | undefined | void = yield* Effect.catchDefect(
          definition.handle(ruleCtx, state, params),
          (defect) => {
            const errorPolicy = definition.onError ?? "passthrough"
            if (errorPolicy === "terminate") {
              return Effect.logError(`Rule ${id} failed (terminating): ${defect}`).pipe(
                Effect.as({ actions: [{ type: "terminate-call" as const }], state } as RuleHandleResult<unknown>),
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
        //   2. Run the base rule's handle() with modified state
        //   3. Merge results (pre-actions + base actions)
        if (definition.composesWith) {
          const workingCall = setRuleState(ruleCtx.call, stKey, outcome.state)
          const preResult = executeActions(outcome.actions, { ...ruleCtx, call: workingCall }, id)

          // Find and run the base rule with the modified call state
          const baseDef = registry.definitions.get(definition.composesWith)
          if (baseDef) {
            const baseCtx: RuleContext = { ...ruleCtx, call: preResult.call }
            const baseStKey = baseDef.stateKey ?? definition.composesWith
            const baseRawState = getRuleState(preResult.call, baseStKey)
            const baseState = baseRawState !== undefined
              ? baseRawState : baseDef.init({}, preResult.call)

            const baseOutcome = yield* baseDef.handle(baseCtx, baseState, {})
            if (baseOutcome != null) {
              const mergedCall = setRuleState(preResult.call, baseStKey, baseOutcome.state)
              let baseResult = executeActions(baseOutcome.actions, { ...ruleCtx, call: mergedCall }, definition.composesWith)
              // Merge: pre-actions first, then base actions
              let result: HandlerResult = {
                call: baseResult.call,
                outbound: [...preResult.outbound, ...baseResult.outbound],
                effects: [...preResult.effects, ...baseResult.effects],
                spanEvents: [...(preResult.spanEvents ?? []), ...(baseResult.spanEvents ?? [])],
              }
              result = addRuleAttribution(result, id, definition.name)
              if (result.call.state === "terminating" && isFullyResolved(result.call)) {
                result = { ...result, call: { ...result.call, state: "terminated" } }
              }
              yield* shadowCompare(ruleDefs, composedBaseIds, id, ruleCtx)
              return enforceInvariants(callBefore, result)
            }
          }

          // Base rule didn't handle or doesn't exist — return just the pre-actions
          let result = addRuleAttribution(preResult, id, definition.name)
          if (result.call.state === "terminating" && isFullyResolved(result.call)) {
            result = { ...result, call: { ...result.call, state: "terminated" } }
          }
          yield* shadowCompare(ruleDefs, composedBaseIds, id, ruleCtx)
          return enforceInvariants(callBefore, result)
        }

        // ── Non-composed path ──
        const workingCall = setRuleState(ruleCtx.call, stKey, outcome.state)
        const actionCtx: RuleContext = { ...ruleCtx, call: workingCall }
        let result = executeActions(outcome.actions, actionCtx, id)
        result = addRuleAttribution(result, id, definition.name)

        // ── Framework lifecycle check: terminating → terminated ──
        if (result.call.state === "terminating" && isFullyResolved(result.call)) {
          result = {
            ...result,
            call: { ...result.call, state: "terminated" },
          }
        }

        // Enforce invariants (limiter, timer, CDR, removal guarantees)
        yield* shadowCompare(ruleDefs, composedBaseIds, id, ruleCtx)
        return enforceInvariants(callBefore, result)
      }

      // ── No rule handled — fall back to default handler ──
      yield* shadowCompare(ruleDefs, composedBaseIds, undefined, ruleCtx)
      return yield* defaultHandler(ctx)
    })
}
