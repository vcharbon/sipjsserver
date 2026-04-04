/**
 * Lifecycle rules — handle-timeout, handle-cancel.
 *
 * These handle non-SIP events that affect call lifecycle.
 */

import { Effect, Schema } from "effect"
import type { RuleDefinition, RuleHandleResult, RuleAction } from "../framework/RuleDefinition.js"
import type { SipResponse } from "../../../sip/types.js"
import { getHeader } from "../../../sip/MessageFactory.js"

// ── handle-timeout (priority 930) ─────────────────────────────────────────

/** Terminate call on transaction timeout. */
export const handleTimeoutRule: RuleDefinition<undefined, undefined> = {
  id: "handle-timeout",
  name: "Handle Transaction Timeout",
  alwaysActive: true,
  defaultPriority: 930,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) => ctx.event.type === "timeout",

  init: () => undefined,

  handle: (_ctx) =>
    Effect.succeed({
      actions: [{ type: "begin-termination" }],
      state: undefined,
    }),
}

// ── handle-cancel (priority 933) ──────────────────────────────────────────

/** Handle CANCEL from a-leg: destroy all b-legs, begin termination. */
export const handleCancelRule: RuleDefinition<undefined, undefined> = {
  id: "handle-cancel",
  name: "Handle CANCEL",
  alwaysActive: true,
  defaultPriority: 933,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) => ctx.event.type === "cancelled",

  init: () => undefined,

  handle: (ctx) => {
    const actions: RuleAction[] = []

    // Destroy all non-terminated b-legs
    for (const bLeg of ctx.call.bLegs) {
      if (bLeg.state !== "terminated") {
        actions.push({ type: "destroy-leg", legId: bLeg.legId })
      }
    }

    actions.push({ type: "add-cdr-event", eventType: "cancel" as const, legId: "a" })
    actions.push({ type: "begin-termination" })

    return Effect.succeed({ actions, state: undefined })
  },
}

// ── handle-481 (priority 850) ────────────────────────────────────────────

/**
 * Handle 481 "Call/Transaction Does Not Exist" response on any method.
 * The remote side has lost the dialog — this leg is dead. Mark it
 * terminated and begin call teardown.
 *
 * Future: an IVR-forward rule at higher priority can intercept this
 * and create a replacement leg instead of terminating the call.
 */
export const handle481Rule: RuleDefinition<undefined, undefined> = {
  id: "handle-481",
  name: "Handle 481 Dialog Not Exist",
  alwaysActive: true,
  defaultPriority: 840,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) => {
    if (ctx.call.state === "terminating") return false
    if (ctx.event.type !== "sip") return false
    const msg = ctx.event.message
    return msg.type === "response" && msg.status === 481
  },

  init: () => undefined,

  handle: (ctx) => {
    const legId = ctx.sourceLeg.legId
    return Effect.succeed({
      actions: [
        { type: "terminate-leg" as const, legId, byeDisposition: "bye_timeout" as const },
        { type: "add-cdr-event" as const, eventType: "bye" as const, legId, reason: "481 Dialog Does Not Exist" },
        { type: "begin-termination" as const },
      ],
      state: undefined,
    })
  },
}
