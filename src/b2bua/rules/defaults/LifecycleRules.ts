/**
 * Lifecycle rules — handle-timeout, handle-cancel.
 *
 * These handle non-SIP events that affect call lifecycle.
 */

import { Effect } from "effect"
import type { RuleDefinition, RuleAction } from "../framework/RuleDefinition.js"

// ── handle-timeout ─────────────────────────────────────────

/** Terminate call on transaction timeout. */
export const handleTimeoutRule: RuleDefinition = {
  id: "handle-timeout",
  name: "Handle Transaction Timeout",
  alwaysActive: true,

  match: { kind: "timeout" },


  handle: (_ctx) =>
    Effect.succeed({
      actions: [{ type: "begin-termination" }],
    }),
}

// ── handle-cancel ──────────────────────────────────────────

/** Handle CANCEL from a-leg: destroy all b-legs, begin termination. */
export const handleCancelRule: RuleDefinition = {
  id: "handle-cancel",
  name: "Handle CANCEL",
  alwaysActive: true,

  match: { kind: "cancelled" },


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

    return Effect.succeed({ actions })
  },
}

// ── resolve-cancel-response ───────────────────────────────

/**
 * Resolve a non-2xx final response (typically 487 Request Terminated) for a
 * b-leg INVITE that was CANCELed by handle-cancel. Marks the leg terminated
 * with byeDisposition="cancelled" so the call's isFullyResolved check can
 * complete and the call can transition to "terminated".
 *
 * We do NOT relay the response to a-leg — the a-leg INVITE transaction has
 * already completed via the 487 sent by TransactionLayer when CANCEL arrived.
 */
export const resolveCancelResponseRule: RuleDefinition = {
  id: "resolve-cancel-response",
  name: "Resolve CANCEL Response",
  alwaysActive: true,
  overrides: "absorb-stale-failure",

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: ["3xx", "4xx", "5xx", "6xx"],
    legDisposition: "cancelling",
    direction: "from-b",
  },


  handle: (ctx) => {
    const legId = ctx.sourceLeg.legId
    return Effect.succeed({
      actions: [
        { type: "terminate-leg" as const, legId, byeDisposition: "cancelled" as const },
      ],
    })
  },
}

// ── handle-481 ────────────────────────────────────────────

/**
 * Handle 481 "Call/Transaction Does Not Exist" response on any method.
 * The remote side has lost the dialog — this leg is dead. Mark it
 * terminated and begin call teardown.
 *
 * Future: an IVR-forward rule with a narrower match (or `overrides:
 * "handle-481"`) can intercept this and create a replacement leg instead
 * of terminating the call.
 */
export const handle481Rule: RuleDefinition = {
  id: "handle-481",
  name: "Handle 481 Dialog Not Exist",
  alwaysActive: true,

  // cseqMethod left unconstrained — 481 on any method tears the call down.
  // terminating-state override happens via resolve-bye-response (which is
  // more specific: callState + cseqMethod) when cseqMethod is BYE; for other
  // methods during terminating, terminating-drop catches the noise.
  match: {
    kind: "response",
    cseqMethod: ["INVITE", "BYE", "CANCEL", "OPTIONS", "INFO", "PRACK", "UPDATE", "REFER", "MESSAGE", "NOTIFY", "SUBSCRIBE"],
    status: 481,
    callState: "active",
  },


  handle: (ctx) => {
    const legId = ctx.sourceLeg.legId
    return Effect.succeed({
      actions: [
        { type: "terminate-leg" as const, legId, byeDisposition: "bye_timeout" as const },
        { type: "add-cdr-event" as const, eventType: "bye" as const, legId, reason: "481 Dialog Does Not Exist" },
        { type: "begin-termination" as const },
      ],
    })
  },
}
