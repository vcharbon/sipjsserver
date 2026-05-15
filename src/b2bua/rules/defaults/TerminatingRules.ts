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
import type { RuleDefinition } from "../framework/RuleDefinition.js"

// ── resolve-bye-response ──────────────────────────────────

/**
 * Handle any final response (>=200) to a BYE we sent.
 *
 * Match is bound to the leg's `byeDisposition === "bye_sent"` rather than
 * `callState: "terminating"` so this rule wins in active state too — e.g.
 * after a single-leg `destroy-leg` action, where the call stays active
 * but a BYE is in flight on the destroyed leg. Without that, the lower-
 * specificity `absorb-bye-200` would silently consume the 200 OK and the
 * leg would never reach a terminal disposition.
 *
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
    filter: (ctx) => ctx.sourceLeg.byeDisposition === "bye_sent",
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

// ── terminating-safety-timeout (canary) ───────────────────────────────

/**
 * Phase 5 + 6: the structural safety net is now installed by
 * `CallState.update` whenever a call transitions into `terminating`,
 * and its handler calls `forcePurge(callRef, "safety_timer")` directly
 * (see SipRouter.timerHandler). Reaching this rule means the structural
 * path didn't recover the call — every confirmed transition into
 * `terminating` should pass through CallState's auto-arm path before
 * the rule chain runs.
 *
 * Kept active as a canary: a single firing in production would prove
 * the structural invariant is broken (auto-arm bypassed, or the
 * timer's handler crashed without reaching forcePurge).
 */
export const terminatingSafetyTimeoutRule: RuleDefinition<undefined, undefined> = {
  id: "terminating-safety-timeout",
  name: "Terminating Safety Timeout (canary)",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "timer",
    timerType: "terminating_timeout",
    callState: "terminating",
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.gen(function* () {
      yield* Effect.logWarning(
        `[terminating-safety-timeout canary] structural safety net missed; rule-chain fell through for call ${ctx.callRef}`,
      )
      return { actions: [], state: undefined }
    }),
}

