/**
 * Corner case rules — cancel-200-crossing, retransmit-200, reinvite-glare.
 *
 * These run at priority 850, before default rules at 900, to catch
 * edge cases that would otherwise be mishandled by the normal path.
 */

import { Effect, Schema } from "effect"
import type { RuleDefinition } from "../framework/RuleDefinition.js"
import type { SipResponse } from "../../../sip/types.js"
import { getHeader, newTag } from "../../../sip/MessageHelpers.js"
import { findByBTag, findPendingRequest } from "../../../call/CallModel.js"
import { confirmBridgedCall } from "../framework/actions/composites.js"

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

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "2xx",
    legDisposition: "cancelling",
    direction: "from-b",
  },

  init: () => undefined,

  handle: (ctx) => {
    const resp = (ctx.event as Extract<typeof ctx.event, { type: "sip" }>).message as SipResponse
    const bLeg = ctx.sourceLeg
    const bTag = resp.parsed?.to?.tag ?? ""
    const existingMapping = findByBTag(ctx.call, bLeg.legId, bTag)
    const aFacingTag = existingMapping?.aTag ?? newTag()

    return Effect.succeed({
      actions: [
        ...confirmBridgedCall({
          sourceLegId: bLeg.legId,
          sourceTag: bTag,
          aFacingTag,
          aLegId: "a",
          mappingAlreadyExists: existingMapping !== undefined,
        }),
        { type: "ack-leg", legId: bLeg.legId },
        { type: "destroy-leg", legId: bLeg.legId },
      ],
      state: undefined,
    })
  },
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

  // Distinguish retransmitted initial 200 OK (no pending request snapshot)
  // from re-INVITE response (pending snapshot) — the latter is handled by
  // relay-reinvite-response which has the inverse filter at the same columns.
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "2xx",
    legState: "confirmed",
    direction: "from-b",
    filter: (ctx) => {
      if (ctx.sourceDialog === undefined) return false
      if (ctx.event.type !== "sip") return false
      const msg = ctx.event.message
      if (msg.type !== "response") return false
      const cseqNum = parseInt(getHeader(msg.headers, "cseq") ?? "0", 10)
      return findPendingRequest(ctx.sourceDialog, cseqNum) === undefined
    },
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

  // More specific than relay-reinvite (which has no filter) — wins on glare.
  match: {
    kind: "request",
    method: "INVITE",
    filter: (ctx) =>
      ctx.sourceDialog !== undefined &&
      ctx.sourceDialog.ext.inboundPendingRequests.some((p) => p.method === "INVITE"),
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

  // Covers all status classes of a re-INVITE response (1xx/2xx/3xx+). Filter
  // matches presence of a pending relay snapshot — the re-INVITE originated
  // from the peer side. Without this column, relay-provisional (1xx) and
  // confirm-dialog/route-failure would claim these.
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    filter: (ctx) => {
      if (ctx.sourceDialog === undefined) return false
      if (ctx.event.type !== "sip") return false
      const msg = ctx.event.message
      if (msg.type !== "response") return false
      const cseqNum = parseInt(getHeader(msg.headers, "cseq") ?? "0", 10)
      return findPendingRequest(ctx.sourceDialog, cseqNum) !== undefined
    },
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
