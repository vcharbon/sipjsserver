/**
 * Terminating-state rules — handle events during graceful call teardown.
 *
 * When call.state === "terminating", the B2BUA has sent BYE/CANCEL to all
 * live legs and is waiting for transaction-level confirmation (200 OK) or
 * timeout. These rules resolve individual legs by setting terminal
 * byeDisposition values. The framework (RuleExecutor) checks isFullyResolved()
 * after each rule — when all legs are resolved, it auto-promotes to "terminated".
 *
 * Priority 800: runs before default rules (900) to intercept events that
 * would otherwise be handled by active-state rules (relay-bye, etc.).
 */

import { Effect, Schema } from "effect"
import type { RuleDefinition, RuleAction } from "../framework/RuleDefinition.js"
import type { SipResponse } from "../../../sip/types.js"
import { getHeader } from "../../../sip/MessageFactory.js"

// ── Helper ────────────────────────────────────────────────────────────────

function cseqMethod(resp: SipResponse): string {
  const h = getHeader(resp.headers, "cseq") ?? ""
  return h.split(/\s+/)[1]?.toUpperCase() ?? "INVITE"
}

// ── resolve-bye-response (priority 800) ──────────────────────────────────

/**
 * Handle any final response (>=200) to a BYE we sent during termination.
 * Behavior is identical regardless of status code (200, 408, 481, 5xx) —
 * the leg is done. Only tracing/CDR records the specific code.
 */
export const resolveByeResponseRule: RuleDefinition<undefined, undefined> = {
  id: "resolve-bye-response",
  name: "Resolve BYE Response",
  alwaysActive: true,
  defaultPriority: 800,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: "BYE",
    statusClass: ["2xx", "3xx", "4xx", "5xx", "6xx"],
    callState: "terminating",
  },

  matches: (ctx) => {
    if (ctx.call.state !== "terminating") return false
    if (ctx.event.type !== "sip") return false
    const msg = ctx.event.message
    if (msg.type !== "response") return false
    if (msg.status < 200) return false
    return cseqMethod(msg) === "BYE"
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

// ── resolve-cross-bye (priority 805) ─────────────────────────────────────

/**
 * Handle BYE request arriving while we're already terminating (cross-BYE
 * race: both sides sent BYE simultaneously). Respond 200 and mark the leg.
 */
export const resolveCrossByeRule: RuleDefinition<undefined, undefined> = {
  id: "resolve-cross-bye",
  name: "Resolve Cross-BYE",
  alwaysActive: true,
  defaultPriority: 805,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "request",
    method: "BYE",
    callState: "terminating",
  },

  matches: (ctx) => {
    if (ctx.call.state !== "terminating") return false
    if (ctx.event.type !== "sip") return false
    const msg = ctx.event.message
    return msg.type === "request" && msg.method === "BYE"
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

// ── terminating-safety-timeout (priority 810) ────────────────────────────

/**
 * Safety net: force all unresolved legs to bye_timeout when the 64s
 * terminating_timeout fires. Prevents permanent call leaks from lost
 * BYE responses.
 */
export const terminatingSafetyTimeoutRule: RuleDefinition<undefined, undefined> = {
  id: "terminating-safety-timeout",
  name: "Terminating Safety Timeout",
  alwaysActive: true,
  defaultPriority: 810,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "timer",
    timerType: "terminating_timeout",
    callState: "terminating",
  },

  matches: (ctx) => {
    if (ctx.call.state !== "terminating") return false
    return ctx.event.type === "timer" && ctx.event.timerType === "terminating_timeout"
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

// ── terminating-drop (priority 999) ──────────────────────────────────────

/**
 * Catch-all for any event during terminating state that no other rule
 * handles. Absorbs silently — during teardown, only BYE responses, cross-BYE,
 * and the safety timeout matter. Everything else is noise.
 *
 * Runs at priority 999 (lowest) so all other terminating-state rules
 * and even default rules get a chance first.
 */
export const terminatingDropRule: RuleDefinition<undefined, undefined> = {
  id: "terminating-drop",
  name: "Terminating Drop",
  alwaysActive: true,
  defaultPriority: 999,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) => ctx.call.state === "terminating",

  init: () => undefined,

  handle: () =>
    Effect.succeed({ actions: [], state: undefined }),
}
