/**
 * Dialog rules — relay-provisional, confirm-dialog, relay-non-invite-200, absorb-bye-200.
 *
 * Handle SIP responses that affect dialog state. Each rule uses
 * `defineRule({...})`, so handler bodies see a `ctx` whose event/message
 * are already narrowed by the match — no defensive `event.type !== "sip"`
 * or `(msg as SipResponse)` casts in the body.
 */

import { Effect, Schema } from "effect"
import { defineRule, type RuleAction } from "../framework/RuleDefinition.js"
import type { AnyRuleDefinition } from "../framework/RuleDefinition.js"
import { newTag } from "../../../sip/MessageHelpers.js"
import { findByBTag, findPendingRequest } from "../../../call/CallModel.js"
import { confirmBridgedCall } from "../framework/actions/composites.js"

// ── relay-provisional ──────────────────────────────────────

/** Relay 1xx provisional response from b-leg to a-leg. */
export const relayProvisionalRule = defineRule({
  id: "relay-provisional",
  name: "Relay Provisional",
  alwaysActive: true,
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
    const resp = ctx.event.message
    const actions: RuleAction[] = [
      { type: "relay-to-peer" },
      { type: "add-cdr-event", eventType: "provisional", legId: ctx.sourceLeg.legId, statusCode: resp.status },
    ]
    return Effect.succeed({ actions, state: undefined })
  },
})

// ── confirm-dialog ─────────────────────────────────────────

/**
 * Handle 200 OK INVITE from b-leg — confirm dialog, relay to a-leg,
 * cancel other pending b-legs, schedule keepalive/duration/limiter-refresh
 * timers.
 *
 * Narrowed: response → SipResponseTagged → `resp.getHeader("to").tag` is `string`
 * (not `string | undefined`) because the parser rejects non-100 responses
 * missing a To-tag.
 */
export const confirmDialogRule = defineRule({
  id: "confirm-dialog",
  name: "Confirm Dialog (200 OK INVITE)",
  alwaysActive: true,
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
    const resp = ctx.event.message
    const bLeg = ctx.sourceLeg
    const bTag = resp.getHeader("to").tag

    // Resolve or create the a-facing tag for this (bLeg, bTag). Policy
    // modules such as relayFirst18xTo180 pre-seed the mapping via the
    // composition hook, so the mapping may already exist with a chosen
    // tag — reuse its aTag to keep the caller's dialog identity stable.
    const existingMapping = findByBTag(ctx.call, bLeg.legId, bTag)
    const aFacingTag = existingMapping?.aTag ?? newTag()

    const actions: RuleAction[] = []

    // Confirm b-leg dialog + a-leg state (must precede merge and relay)
    actions.push(...confirmBridgedCall({
      sourceLegId: bLeg.legId,
      sourceTag: bTag,
      aFacingTag,
      aLegId: "a",
      mappingAlreadyExists: existingMapping !== undefined,
    }))

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
})

// ── absorb-bye-200 ─────────────────────────────────────────

/** Absorb 200 OK for BYE/CANCEL (B2BUA already sent its own 200). */
export const absorbBye200Rule = defineRule({
  id: "absorb-bye-200",
  name: "Absorb BYE/CANCEL 200 OK",
  alwaysActive: true,
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
})

// ── absorb-options-200 ─────────────────────────────────────

/**
 * Absorb 200 OK for a B2BUA-originated keepalive OPTIONS and cancel the
 * paired keepalive-timeout timer. Distinguished from an end-to-end relayed
 * OPTIONS by the absence of a pending-relay snapshot on the source dialog:
 * relayed OPTIONS leave an `inboundPendingRequests` entry that matches the
 * response's CSeq; keepalive OPTIONS originated by the B2BUA do not.
 */
export const absorbOptions200Rule = defineRule({
  id: "absorb-options-200",
  name: "Absorb OPTIONS 200 OK (keepalive)",
  alwaysActive: true,
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
      const cseqNum = ctx.event.message.getHeader("cseq").seq
      return ctx.sourceDialog !== undefined &&
        findPendingRequest(ctx.sourceDialog, cseqNum) === undefined
    },
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.succeed({
      actions: [
        { type: "cancel-timer", timerId: `keepalive_timeout-${ctx.callRef}-${ctx.sourceLeg.legId}` },
      ],
      state: undefined,
    }),
})

// ── absorb-notify-200 ──────────────────────────────────────

/**
 * Absorb 200 OK for a B2BUA-originated NOTIFY (REFER-subscription sipfrag).
 *
 * The B2BUA never relays NOTIFY end-to-end in v1 — NOTIFY is only emitted
 * locally by TransferRules to report subscription progress. The remote UA's
 * 200 OK for that NOTIFY must be absorbed so `relay-non-invite-200` does
 * not forward it to the opposite leg as a spurious response.
 */
export const absorbNotify200Rule = defineRule({
  id: "absorb-notify-200",
  name: "Absorb NOTIFY 200 OK",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: "NOTIFY",
    statusClass: "2xx",
  },

  init: () => undefined,

  handle: () => Effect.succeed({ actions: [], state: undefined }),
})

// ── relay-non-invite-200 ───────────────────────────────────

/** Relay 200 OK for non-INVITE methods (PRACK, UPDATE, INFO) to peer. */
export const relayNonInvite200Rule = defineRule({
  id: "relay-non-invite-200",
  name: "Relay Non-INVITE 200 OK",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  // OPTIONS with pending relay snapshot lands here; keepalive OPTIONS is
  // taken by absorb-options-200 (same columns + filter → more specific).
  // NOTIFY is taken by absorb-notify-200 (B2BUA-originated sipfrag).
  match: {
    kind: "response",
    cseqMethod: ["OPTIONS", "INFO", "PRACK", "UPDATE", "REFER", "MESSAGE", "SUBSCRIBE"],
    statusClass: "2xx",
  },

  init: () => undefined,

  handle: () =>
    // ActionExecutor resolves the target via activePeer or To-tag fallback
    Effect.succeed({
      actions: [{ type: "relay-to-peer" as const }],
      state: undefined,
    }),
})

// Compile-time grouping — keeps the rule list typed as AnyRuleDefinition.
export const dialogRules: ReadonlyArray<AnyRuleDefinition> = [
  relayProvisionalRule,
  confirmDialogRule,
  absorbBye200Rule,
  absorbOptions200Rule,
  absorbNotify200Rule,
  relayNonInvite200Rule,
]
