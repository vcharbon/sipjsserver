/**
 * Transfer default rules — the seed/unconditional REFER rules that must fire
 * BEFORE the transfer service's call-ext slice exists (so they cannot be
 * service rules: the service `matchFilter` goes inert when `call.ext.transfer`
 * is absent). The remaining phase-gated rules live in
 * `src/b2bua/rules/custom/referTransfer.ts` as a callflow service (ADR-0016).
 *
 *  - transfer-reject-replaces   — REFER (from-b) with Replaces → 501.
 *  - transfer-reject-a-leg-refer — REFER from the A leg → 501.
 *  - transfer-intercept-refer    — first in-dialog REFER on a bridged B leg →
 *      202 + SEED the transfer service (set-call-ext) + timers + NOTIFY +
 *      async /call/refer. Activation point for the service.
 *
 * References:
 *  - RFC 3515 §2.4 — REFER request/response and implicit subscription
 *  - RFC 3265 §3 — Subscription-State header values
 *  - RFC 3420 — message/sipfrag
 *  - RFC 3891 — Replaces (attended transfer, not supported in v1)
 */

import { Effect, Result, Schema } from "effect"
import { defineRule, type RuleAction, type RuleContext } from "../framework/RuleDefinition.js"
import type { AnyRuleDefinition, RequestMatch } from "../framework/RuleDefinition.js"
import type { SipRequest } from "../../../sip/types.js"
import type { Dialog } from "../../../call/CallModel.js"
import { getHeader } from "../../../sip/MessageHelpers.js"
import { sipfragFromStatus } from "../../../sip/SipFragUtils.js"
import {
  TRANSFER_SERVICE_ID,
  encodeTransferCallExt,
} from "../custom/referTransfer.js"

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Dialog id string exposed to the backend — `Call-ID;to-tag=…;from-tag=…`
 * from the B-leg perspective (the leg that issued the REFER).
 */
function dialogIdFor(callId: string, fromTag: string, dialog: Dialog): string {
  return `${callId};to-tag=${dialog.sip.remoteTag};from-tag=${fromTag}`
}

/** Non-standard headers on the REFER forwarded verbatim to /call/refer. */
function extractSipHeaders(req: SipRequest): Record<string, string> {
  const result: Record<string, string> = {}
  for (const h of req.headers) {
    const name = h.name.toLowerCase()
    if (name === "from" || name === "to" || name === "via" || name === "contact" ||
        name === "content-type" || name === "call-id" || name === "cseq" ||
        name === "max-forwards" || name === "content-length" ||
        name === "refer-to" || name === "referred-by") continue
    result[h.name] = h.value
  }
  return result
}

/** Refer-To contains a Replaces= header parameter in its embedded URI headers. */
function referToHasReplaces(ctx: RuleContext<RequestMatch>): boolean {
  const r = ctx.event.message.getHeader("refer-to")
  return Result.isSuccess(r) && r.success?.replaces !== undefined
}

/** REFER arrived without a Replaces parameter in the Refer-To URI. */
function referToLacksReplaces(ctx: RuleContext<RequestMatch>): boolean {
  return !referToHasReplaces(ctx)
}

/** No transfer service slice present yet (no transfer in progress). */
function noTransferActive(ctx: RuleContext<RequestMatch>): boolean {
  return ctx.call.ext?.[TRANSFER_SERVICE_ID] === undefined
}

// Subscription-State fragment (RFC 3265 §3.2.4)
const SUB_STATE_ACTIVE_60 = "active;expires=60"

// ── transfer-reject-replaces ──────────────────────────────────────────────

/**
 * REFER with a Replaces= parameter in the Refer-To URI is attended transfer
 * (RFC 3891). Not supported in v1 — respond 501 Not Implemented.
 *
 * Overrides the service rule `transfer-reject-second-refer` so a REFER with
 * Replaces during an active transfer is rejected 501 (attended) rather than
 * 491 (request pending).
 */
export const transferRejectReplacesRule = defineRule({
  id: "transfer-reject-replaces",
  name: "Reject REFER with Replaces (attended transfer)",
  alwaysActive: true,
  overrides: "transfer-reject-second-refer",
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "request",
    method: "REFER",
    direction: "from-b",
    filter: referToHasReplaces,
  },

  init: () => undefined,

  handle: () =>
    Effect.succeed({
      actions: [{ type: "respond" as const, status: 501, reason: "Not Implemented" }],
      state: undefined,
    }),
})

// ── transfer-reject-a-leg-refer ───────────────────────────────────────────

/** REFER originated from the A leg — out of scope for v1. Respond 501. */
export const transferRejectALegReferRule = defineRule({
  id: "transfer-reject-a-leg-refer",
  name: "Reject REFER from A leg",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "request",
    method: "REFER",
    direction: "from-a",
  },

  init: () => undefined,

  handle: () =>
    Effect.succeed({
      actions: [{ type: "respond" as const, status: 501, reason: "Not Implemented" }],
      state: undefined,
    }),
})

// ── transfer-intercept-refer ──────────────────────────────────────────────

/**
 * Intercept the first in-dialog REFER on a bridged B leg, respond 202, SEED the
 * transfer service (set-call-ext with the initial slice — the referrer leg id
 * rides in `referrerLegId`), send NOTIFY 100 active, arm the subscription +
 * overall-safety timers, and kick /call/refer asynchronously. The HTTP
 * response re-enters the rule chain via an internal-event handled by the
 * service rules (now active because the slice is present).
 *
 * `legState: "confirmed"` is the in-dialog gate; the `noTransferActive` filter
 * carves out the second-REFER case (which the service's
 * `transfer-reject-second-refer` owns once the slice exists).
 */
export const transferInterceptReferRule = defineRule({
  id: "transfer-intercept-refer",
  name: "Intercept REFER on bridged B leg",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "request",
    method: "REFER",
    direction: "from-b",
    legState: "confirmed",
    legDisposition: "bridged",
    filter: (ctx) => referToLacksReplaces(ctx) && noTransferActive(ctx),
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.sync(() => {
      const req = ctx.event.message
      const legId = ctx.sourceLeg.legId
      const referTo = getHeader(req.headers, "refer-to") ?? ""
      const referredBy = getHeader(req.headers, "referred-by")

      const initialBody = sipfragFromStatus(100, "Trying")

      // Seed the transfer service call-ext (Encoded) + stamp the referrer leg
      // role (Encoded). Both ride the generic ext carry; encoding via the
      // service schemas keeps only JSON-safe values at rest.
      const seed = encodeTransferCallExt({
        phase: "refer-authorizing",
        referrerLegId: legId,
        referToUri: referTo,
        referCSeq: req.getHeader("cseq").seq,
        startedAtMs: ctx.nowMs,
      })

      const actions: RuleAction[] = [
        { type: "respond" as const, status: 202, reason: "Accepted" },
        { type: "set-call-ext" as const, serviceId: TRANSFER_SERVICE_ID, value: seed },
        {
          type: "schedule-timer" as const,
          timerType: "refer_subscription_expiry" as const,
          delaySec: ctx.config.referSubscriptionExpirySec,
        },
        {
          type: "schedule-timer" as const,
          timerType: "refer_overall_safety" as const,
          delaySec: ctx.config.referOverallSafetySec,
        },
        {
          type: "send-notify" as const,
          legId,
          event: "refer",
          subscriptionState: SUB_STATE_ACTIVE_60,
          contentType: "message/sipfrag;version=2.0",
          body: initialBody,
        },
        {
          type: "refer-async-http" as const,
          request: {
            call_id: ctx.call.aLeg.callId,
            dialog_id: dialogIdFor(ctx.sourceLeg.callId, ctx.sourceLeg.fromTag, ctx.sourceDialog),
            refer_to: referTo,
            ...(referredBy !== undefined ? { referred_by: referredBy } : {}),
            sip_headers: extractSipHeaders(req),
          },
        },
      ]

      return { actions, state: undefined }
    }),
})

// ── Exported default rule list ─────────────────────────────────────────────

export const transferDefaultRules: ReadonlyArray<AnyRuleDefinition> = [
  transferRejectReplacesRule,
  transferRejectALegReferRule,
  transferInterceptReferRule,
]
