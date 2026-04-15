/**
 * Lifecycle rules — handle-timeout, handle-cancel.
 *
 * These handle non-SIP events that affect call lifecycle.
 */

import { Effect, Schema } from "effect"
import type { RuleDefinition, RuleHandleResult, RuleAction } from "../framework/RuleDefinition.js"
import type { SipResponse } from "../../../sip/types.js"
import { getHeader } from "../../../sip/MessageFactory.js"

// ── Helper ────────────────────────────────────────────────────────────────

function cseqMethod(resp: SipResponse): string {
  const h = getHeader(resp.headers, "cseq") ?? ""
  return h.split(/\s+/)[1]?.toUpperCase() ?? "INVITE"
}

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

    // Teardown all non-terminated b-legs.
    //   - confirmed b-leg: BYE (destroy-leg)
    //   - early/trying b-leg: CANCEL but keep the leg alive (cancel-leg)
    //     so the CANCEL/200 crossing race (RFC 3261 §9.1) can be resolved
    //     when bob's final response arrives.
    for (const bLeg of ctx.call.bLegs) {
      if (bLeg.state === "terminated") continue
      if (bLeg.state === "confirmed") {
        actions.push({ type: "destroy-leg", legId: bLeg.legId })
      } else {
        actions.push({ type: "cancel-leg", legId: bLeg.legId })
      }
    }

    actions.push({ type: "add-cdr-event", eventType: "cancel" as const, legId: "a" })
    actions.push({ type: "begin-termination" })

    return Effect.succeed({ actions, state: undefined })
  },
}

// ── resolve-cancel-response (priority 820) ───────────────────────────────

/**
 * Resolve a non-2xx final response (typically 487 Request Terminated) for a
 * b-leg INVITE that was CANCELed by handle-cancel. Marks the leg terminated
 * with byeDisposition="cancelled" so the call's isFullyResolved check can
 * complete and the call can transition to "terminated".
 *
 * We do NOT relay the response to a-leg — the a-leg INVITE transaction has
 * already completed via the 487 sent by TransactionLayer when CANCEL arrived.
 */
export const resolveCancelResponseRule: RuleDefinition<undefined, undefined> = {
  id: "resolve-cancel-response",
  name: "Resolve CANCEL Response",
  alwaysActive: true,
  defaultPriority: 820,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) => {
    if (ctx.sourceLeg.disposition !== "cancelling") return false
    if (ctx.event.type !== "sip") return false
    const msg = ctx.event.message
    if (msg.type !== "response") return false
    if (msg.status < 300) return false
    if (ctx.direction !== "from-b") return false
    return cseqMethod(msg as SipResponse) === "INVITE"
  },

  init: () => undefined,

  handle: (ctx) => {
    const legId = ctx.sourceLeg.legId
    return Effect.succeed({
      actions: [
        { type: "terminate-leg" as const, legId, byeDisposition: "cancelled" as const },
      ],
      state: undefined,
    })
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
