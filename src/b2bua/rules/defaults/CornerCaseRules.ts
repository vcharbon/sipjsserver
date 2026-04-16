/**
 * Corner case rules — cancel-200-crossing, retransmit-200, reinvite-glare.
 *
 * These run at priority 850, before default rules at 900, to catch
 * edge cases that would otherwise be mishandled by the normal path.
 */

import { Effect, Schema } from "effect"
import type { RuleDefinition } from "../framework/RuleDefinition.js"
import type { SipResponse } from "../../../sip/types.js"
import { getHeader } from "../../../sip/MessageFactory.js"
import { findPendingRequest } from "../../../call/CallModel.js"

// ── Helper ────────────────────────────────────────────────────────────────

function cseqMethod(resp: SipResponse): string {
  const h = getHeader(resp.headers, "cseq") ?? ""
  return h.split(/\s+/)[1]?.toUpperCase() ?? "INVITE"
}

// ── cancel-200-crossing (priority 850) ────────────────────────────────────

/**
 * CANCEL/200 OK crossing: 200 OK INVITE arrives on a b-leg that is
 * being cancelled (disposition === "cancelling"). RFC 3261 §9.1: once
 * the UAS has committed a final response, CANCEL has no effect — we
 * must ACK the 2xx (to stop retransmissions) and then BYE the dialog.
 * Do NOT relay to a-leg (already got 487 Request Terminated).
 *
 * Action sequence:
 *   confirm-dialog → updates b-leg state to "confirmed", seeds dialog
 *                    from the 2xx toTag/contact so ack-leg/destroy-leg
 *                    have the right dialog state.
 *   ack-leg        → ACK the 2xx end-to-end.
 *   destroy-leg    → BYE (state is now "confirmed", so destroy-leg BYEs).
 */
export const cancel200CrossingRule: RuleDefinition<undefined, undefined> = {
  id: "cancel-200-crossing",
  name: "CANCEL/200 Crossing",
  alwaysActive: true,
  defaultPriority: 860,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) => {
    if (ctx.event.type !== "sip") return false
    const msg = ctx.event.message
    if (msg.type !== "response") return false
    if (msg.status < 200 || msg.status >= 300) return false
    if (ctx.direction !== "from-b") return false
    if (cseqMethod(msg) !== "INVITE") return false
    return ctx.sourceLeg.disposition === "cancelling"
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.succeed({
      actions: [
        { type: "confirm-dialog" },
        { type: "ack-leg", legId: ctx.sourceLeg.legId },
        { type: "destroy-leg", legId: ctx.sourceLeg.legId },
      ],
      state: undefined,
    }),
}

// ── retransmit-200 (priority 850) ─────────────────────────────────────────

/**
 * Retransmitted 200 OK on an already-confirmed b-leg — re-ACK only.
 * Do NOT relay (already relayed the first 200 OK).
 */
export const retransmit200Rule: RuleDefinition<undefined, undefined> = {
  id: "retransmit-200",
  name: "Retransmit 200 OK",
  alwaysActive: true,
  defaultPriority: 855,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) => {
    if (ctx.event.type !== "sip") return false
    const msg = ctx.event.message
    if (msg.type !== "response") return false
    if (msg.status < 200 || msg.status >= 300) return false
    if (ctx.direction !== "from-b") return false
    if (cseqMethod(msg) !== "INVITE") return false
    if (ctx.sourceLeg.state !== "confirmed") return false
    // Exclude re-INVITE responses — those are handled by relayReinviteResponseRule
    if (ctx.sourceDialog !== undefined) {
      const cseqNum = parseInt(getHeader(msg.headers, "cseq") ?? "0", 10)
      if (findPendingRequest(ctx.sourceDialog, cseqNum) !== undefined) return false
    }
    return true
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.succeed({
      actions: [
        { type: "ack-leg", legId: ctx.sourceLeg.legId },
      ],
      state: undefined,
    }),
}

// ── reinvite-glare (priority 890) ─────────────────────────────────────────

/**
 * Re-INVITE glare detection: reject with 491 if there's already a
 * pending re-INVITE on the target dialog.
 */
export const reinviteGlareRule: RuleDefinition<undefined, undefined> = {
  id: "reinvite-glare",
  name: "Re-INVITE Glare Detection",
  alwaysActive: true,
  defaultPriority: 890,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) => {
    if (ctx.event.type !== "sip") return false
    const msg = ctx.event.message
    if (msg.type !== "request") return false
    if (msg.method !== "INVITE") return false
    // Glare: there's already a pending inbound re-INVITE on this dialog
    if (ctx.sourceDialog === undefined) return false
    // Glare applies only to re-INVITE (RFC 3261 §14.1) — ignore pending
    // non-INVITE transparent relays (OPTIONS/INFO/UPDATE/…) on the same dialog.
    return ctx.sourceDialog.inboundPendingRequests.some((p) => p.method === "INVITE")
  },

  init: () => undefined,

  handle: () =>
    Effect.succeed({
      actions: [
        { type: "respond", status: 491, reason: "Request Pending" },
      ],
      state: undefined,
    }),
}

// ── relay-reinvite-response (priority 850) ────────────────────────────────

/**
 * Relay re-INVITE response (provisional, 2xx, error) back to the
 * originator using pendingReInvite correlation.
 *
 * This matches INVITE responses where a pendingReInvite exists on
 * the receiving leg's dialog. It runs at 850 so it catches re-INVITE
 * responses before the general provisional/confirm-dialog/failure rules.
 */
export const relayReinviteResponseRule: RuleDefinition<undefined, undefined> = {
  id: "relay-reinvite-response",
  name: "Relay re-INVITE Response",
  alwaysActive: true,
  defaultPriority: 845,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  matches: (ctx) => {
    if (ctx.event.type !== "sip") return false
    const msg = ctx.event.message
    if (msg.type !== "response") return false
    if (cseqMethod(msg) !== "INVITE") return false
    // Check if this is a response to a pending re-INVITE
    const dialog = ctx.sourceDialog
    if (dialog === undefined) return false
    const cseqNum = parseInt(getHeader(msg.headers, "cseq") ?? "0", 10)
    return findPendingRequest(dialog, cseqNum) !== undefined
  },

  init: () => undefined,

  handle: (_ctx) => {
    // ActionExecutor.relayResponseMsg auto-detects the pending re-INVITE on
    // the source dialog (matching CSeq) and rebuilds Call-ID, Vias, From, To,
    // and CSeq from the snapshot captured at request-relay time. It also
    // updates the source dialog's contact on 2xx and removes the pending
    // entry on any final response. This rule just signals "yes, relay it".
    return Effect.succeed({
      actions: [{ type: "relay-to-peer" }],
      state: undefined,
    })
  },
}
