/**
 * Dialog rules — relay-provisional, confirm-dialog, relay-non-invite-200, absorb-bye-200.
 *
 * Handle SIP responses that affect dialog state.
 */

import { Effect, Schema } from "effect"
import type { RuleDefinition, RuleAction } from "../framework/RuleDefinition.js"
import type { SipResponse } from "../../../sip/types.js"
import { getHeader } from "../../../sip/MessageFactory.js"
import { findPendingRequest } from "../../../call/CallModel.js"

// ── Helper: extract CSeq method from a SIP response ──────────────────────

function cseqMethod(resp: SipResponse): string {
  const h = getHeader(resp.headers, "cseq") ?? ""
  return h.split(/\s+/)[1]?.toUpperCase() ?? "INVITE"
}

// ── relay-provisional (priority 900) ──────────────────────────────────────

/** Relay 1xx provisional response from b-leg to a-leg. */
export const relayProvisionalRule: RuleDefinition<undefined, undefined> = {
  id: "relay-provisional",
  name: "Relay Provisional",
  alwaysActive: true,
  defaultPriority: 900,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "1xx",
    direction: "from-b",
  },

  init: () => undefined,

  handle: (ctx) => {
    const resp = (ctx.event as Extract<typeof ctx.event, { type: "sip" }>).message as SipResponse

    const actions: RuleAction[] = [
      { type: "relay-to-peer" },
      { type: "add-cdr-event", eventType: "provisional", legId: ctx.sourceLeg.legId, statusCode: resp.status },
    ]

    return Effect.succeed({ actions, state: undefined })
  },
}

// ── confirm-dialog (priority 903) ─────────────────────────────────────────

/**
 * Handle 200 OK INVITE from b-leg — confirm dialog, relay to a-leg,
 * cancel other pending b-legs, schedule keepalive/duration/limiter-refresh timers.
 */
export const confirmDialogRule: RuleDefinition<undefined, undefined> = {
  id: "confirm-dialog",
  name: "Confirm Dialog (200 OK INVITE)",
  alwaysActive: true,
  defaultPriority: 903,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  // Initial-INVITE 200 OK only — legState is trying/early here. On a re-INVITE
  // the source leg is already "confirmed", which steers the event to
  // retransmit-200 (no pending) or relay-reinvite-response (has pending).
  // cancel-200-crossing (legDisposition=cancelling) wins by specificity.
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "2xx",
    legState: ["trying", "early"],
    direction: "from-b",
  },

  init: () => undefined,

  handle: (ctx) => {
    const resp = (ctx.event as Extract<typeof ctx.event, { type: "sip" }>).message as SipResponse
    const bLeg = ctx.sourceLeg

    const actions: RuleAction[] = []

    // Confirm b-leg dialog + a-leg state (must precede merge and relay)
    actions.push({ type: "confirm-dialog" })

    // Merge a-leg ↔ winning b-leg
    actions.push({ type: "merge", legA: "a", legB: bLeg.legId })

    // Relay 200 OK to a-leg
    actions.push({ type: "relay-to-peer" })

    // Destroy all other non-terminated b-legs (cancel losers)
    for (const other of ctx.call.bLegs) {
      if (other.legId !== bLeg.legId && other.state !== "terminated") {
        actions.push({ type: "destroy-leg", legId: other.legId })
      }
    }

    // Cancel no-answer timer for this b-leg
    actions.push({ type: "cancel-timer", timerId: `no-answer-${ctx.callRef}-${bLeg.legId}` })

    // Schedule keepalive timer
    actions.push({
      type: "schedule-timer",
      timerType: "keepalive",
      delaySec: ctx.config.keepaliveIntervalSec,
    })

    // Schedule global duration timer
    actions.push({
      type: "schedule-timer",
      timerType: "global_duration",
      delaySec: ctx.config.callMaxDurationSec,
    })

    // Schedule limiter refresh if limiters are active
    if (ctx.call.limiterEntries.length > 0) {
      actions.push({
        type: "schedule-timer",
        timerType: "limiter_refresh",
        delaySec: ctx.config.limiterWindowSeconds,
      })
    }

    // CDR
    actions.push({ type: "add-cdr-event", eventType: "answer", legId: bLeg.legId, statusCode: 200 })

    return Effect.succeed({ actions, state: undefined })
  },
}

// ── absorb-bye-200 (priority 850) ─────────────────────────────────────────

/** Absorb 200 OK for BYE/CANCEL (B2BUA already sent its own 200). */
export const absorbBye200Rule: RuleDefinition<undefined, undefined> = {
  id: "absorb-bye-200",
  name: "Absorb BYE/CANCEL 200 OK",
  alwaysActive: true,
  defaultPriority: 835,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: ["BYE", "CANCEL"],
    statusClass: "2xx",
  },

  init: () => undefined,

  handle: () =>
    // Absorb silently — no actions needed
    Effect.succeed({ actions: [], state: undefined }),
}

// ── absorb-options-200 (priority 830) ─────────────────────────────────────

/**
 * Absorb 200 OK for a B2BUA-originated keepalive OPTIONS and cancel the
 * paired keepalive-timeout timer. Distinguished from an end-to-end relayed
 * OPTIONS by the absence of a pending-relay snapshot on the source dialog:
 * relayed OPTIONS leave an `inboundPendingRequests` entry that matches the
 * response's CSeq, keepalive OPTIONS originated by the B2BUA do not.
 */
export const absorbOptions200Rule: RuleDefinition<undefined, undefined> = {
  id: "absorb-options-200",
  name: "Absorb OPTIONS 200 OK (keepalive)",
  alwaysActive: true,
  defaultPriority: 830,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  // Filter distinguishes a B2BUA-originated keepalive OPTIONS (no pending
  // relay snapshot) from a relayed OPTIONS (snapshot present → falls through
  // to relay-non-invite-200).
  match: {
    kind: "response",
    cseqMethod: "OPTIONS",
    statusClass: "2xx",
    filter: (ctx) => {
      if (ctx.event.type !== "sip") return false
      const msg = ctx.event.message
      if (msg.type !== "response") return false
      const cseqNum = parseInt(getHeader(msg.headers, "cseq") ?? "", 10)
      if (!Number.isFinite(cseqNum)) return false
      return ctx.sourceDialog !== undefined &&
        findPendingRequest(ctx.sourceDialog, cseqNum) === undefined
    },
  },

  init: () => undefined,

  handle: (ctx) => {
    const legId = ctx.sourceLeg.legId
    return Effect.succeed({
      actions: [
        { type: "cancel-timer", timerId: `keepalive_timeout-${ctx.callRef}-${legId}` },
      ],
      state: undefined,
    })
  },
}

// ── relay-non-invite-200 (priority 927) ───────────────────────────────────

/** Relay 200 OK for non-INVITE methods (PRACK, UPDATE, INFO) to peer. */
export const relayNonInvite200Rule: RuleDefinition<undefined, undefined> = {
  id: "relay-non-invite-200",
  name: "Relay Non-INVITE 200 OK",
  alwaysActive: true,
  defaultPriority: 927,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  // OPTIONS with pending relay snapshot lands here; keepalive OPTIONS is
  // taken by absorb-options-200 (same columns + filter → more specific).
  match: {
    kind: "response",
    cseqMethod: ["OPTIONS", "INFO", "PRACK", "UPDATE", "REFER", "MESSAGE", "NOTIFY", "SUBSCRIBE"],
    statusClass: "2xx",
  },

  init: () => undefined,

  handle: () =>
    // ActionExecutor resolves the target via activePeer or To-tag fallback
    Effect.succeed({
      actions: [{ type: "relay-to-peer" as const }],
      state: undefined,
    }),
}
