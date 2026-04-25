/**
 * Terminating-state rules — handle events during graceful call teardown.
 *
 * When call.state === "terminating", the B2BUA has sent BYE/CANCEL to all
 * live legs and is waiting for transaction-level confirmation (200 OK) or
 * timeout. These rules resolve individual legs by setting terminal
 * byeDisposition values. The framework (RuleExecutor) checks isFullyResolved()
 * after each rule — when all legs are resolved, it auto-promotes to "terminated".
 *
 * Each rule narrows on `callState: "terminating"`, so they outrank active-state
 * relay rules (relay-bye, etc.) by specificity whenever both can match.
 */

import { Effect, Schema } from "effect"
import type { RuleDefinition, RuleAction } from "../framework/RuleDefinition.js"

// ── resolve-bye-response ──────────────────────────────────

/**
 * Handle any final response (>=200) to a BYE we sent during termination.
 * Behavior is identical regardless of status code (200, 408, 481, 5xx) —
 * the leg is done. Only tracing/CDR records the specific code.
 */
export const resolveByeResponseRule: RuleDefinition<undefined, undefined> = {
  id: "resolve-bye-response",
  name: "Resolve BYE Response",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: "BYE",
    statusClass: ["2xx", "3xx", "4xx", "5xx", "6xx"],
    callState: "terminating",
  },

  init: () => undefined,

  handle: (ctx) => {
    const legId = ctx.sourceLeg.legId
    return Effect.succeed({
      actions: [
        { type: "terminate-leg" as const, legId, byeDisposition: "bye_confirmed" as const },
      ],
      state: undefined,
    })
  },
}

// ── resolve-cross-bye ─────────────────────────────────────

/**
 * Handle BYE request arriving while we're already terminating (cross-BYE
 * race: both sides sent BYE simultaneously). Respond 200 and mark the leg.
 */
export const resolveCrossByeRule: RuleDefinition<undefined, undefined> = {
  id: "resolve-cross-bye",
  name: "Resolve Cross-BYE",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "request",
    method: "BYE",
    callState: "terminating",
  },

  init: () => undefined,

  handle: (ctx) => {
    const legId = ctx.sourceLeg.legId
    return Effect.succeed({
      actions: [
        { type: "respond" as const, status: 200, reason: "OK" },
        { type: "terminate-leg" as const, legId, byeDisposition: "bye_received" as const },
      ],
      state: undefined,
    })
  },
}

// ── terminating-safety-timeout ────────────────────────────

/**
 * Safety net: force all unresolved legs to bye_timeout when the 64s
 * terminating_timeout fires. Prevents permanent call leaks from lost
 * BYE responses.
 */
export const terminatingSafetyTimeoutRule: RuleDefinition<undefined, undefined> = {
  id: "terminating-safety-timeout",
  name: "Terminating Safety Timeout",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "timer",
    timerType: "terminating_timeout",
    callState: "terminating",
  },

  init: () => undefined,

  handle: (ctx) => {
    const actions: RuleAction[] = []

    // Force-resolve all legs that haven't reached a terminal disposition
    for (const leg of [ctx.call.aLeg, ...ctx.call.bLegs]) {
      if (leg.state === "terminated") continue
      const bd = leg.byeDisposition
      if (bd === undefined || bd === "bye_sent") {
        actions.push({ type: "terminate-leg", legId: leg.legId, byeDisposition: "bye_timeout" })
      }
    }

    return Effect.succeed({ actions, state: undefined })
  },
}

