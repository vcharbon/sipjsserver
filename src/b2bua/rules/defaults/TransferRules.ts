/**
 * Transfer rules — REFER-driven blind transfer on the B leg (slice 4: reject paths).
 *
 * The B2BUA intercepts an in-dialog REFER from the remote B leg, authorizes
 * the transfer via POST /call/refer, and either drives the outbound call to
 * the transfer target (C leg, implemented across slices 5–7) or rejects with
 * a terminal NOTIFY. Slice 4 wires up the reject paths plus the initial
 * intercept+NOTIFY-100 handshake. When REFER_ALLOW_ENABLED=false, an allow
 * outcome is also treated as a reject (NOTIFY 501) so the slice is
 * self-contained.
 *
 * References:
 *  - RFC 3515 §2.4 — REFER request/response and implicit subscription
 *  - RFC 3265 §3 — Subscription-State header values
 *  - RFC 3420 — message/sipfrag
 *  - docs/todos/REFERIMPL.md — full design and slice breakdown
 */

import { Effect, Schema } from "effect"
import type { RuleDefinition, RuleAction, RuleContext } from "../framework/RuleDefinition.js"
import type { SipRequest } from "../../../sip/types.js"
import { getHeader } from "../../../sip/MessageFactory.js"
import { sipfragFromStatus } from "../../../sip/SipFragUtils.js"

// ── Helpers ───────────────────────────────────────────────────────────────

/** Pull the Refer-To header value, or undefined when absent. */
function referToOf(ctx: RuleContext): string | undefined {
  if (ctx.event.type !== "sip") return undefined
  const msg = ctx.event.message
  if (msg.type !== "request") return undefined
  return getHeader(msg.headers, "refer-to")
}

/** Refer-To contains a Replaces header parameter in its URI query. */
function referToHasReplaces(ctx: RuleContext): boolean {
  const referTo = referToOf(ctx)
  if (referTo === undefined) return false
  return /[?&]replaces=/i.test(referTo)
}

/** REFER arrived without a Replaces parameter in the Refer-To URI. */
function referToLacksReplaces(ctx: RuleContext): boolean {
  return !referToHasReplaces(ctx)
}

/** Dialog id string exposed to the backend — Call-ID;to-tag=…;from-tag=… (B-leg perspective). */
function dialogIdFor(ctx: RuleContext): string {
  const leg = ctx.sourceLeg
  const toTag = ctx.sourceDialog?.toTag ?? ""
  return `${leg.callId};to-tag=${toTag};from-tag=${leg.fromTag}`
}

/** CSeq number on the inbound REFER, or 0 when missing/unparseable. */
function inboundCSeq(req: SipRequest): number {
  const h = getHeader(req.headers, "cseq") ?? ""
  const n = parseInt(h, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
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

// ── Priority band — custom transfer rules live in 100–199 ─────────────────

const PRIO_REJECT_REPLACES = 100
const PRIO_REJECT_SECOND = 105
const PRIO_REJECT_A_LEG = 110
const PRIO_INTERCEPT = 115
const PRIO_HTTP_REJECT = 120
const PRIO_HTTP_ALLOW = 125
const PRIO_HTTP_TIMEOUT = 130

// Subscription-State fragments (RFC 3265 §3.2.4)
const SUB_STATE_ACTIVE_60 = "active;expires=60"
const SUB_STATE_TERMINATED_NORESOURCE = "terminated;reason=noresource"
const SUB_STATE_TERMINATED_TIMEOUT = "terminated;reason=timeout"

// ── transfer-reject-replaces ──────────────────────────────────────────────

/**
 * REFER with a Replaces= parameter in the Refer-To URI is attended transfer
 * (RFC 3891). Not supported in v1 — respond 501 Not Implemented.
 */
export const transferRejectReplacesRule: RuleDefinition<undefined, undefined> = {
  id: "transfer-reject-replaces",
  name: "Reject REFER with Replaces (attended transfer)",
  alwaysActive: true,
  defaultPriority: PRIO_REJECT_REPLACES,
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
}

// ── transfer-reject-second-refer ──────────────────────────────────────────

/**
 * A second REFER while a transfer is already in progress — respond 491
 * Request Pending (RFC 3261 §14.1) so the referrer retries after the
 * current transfer resolves.
 */
export const transferRejectSecondReferRule: RuleDefinition<undefined, undefined> = {
  id: "transfer-reject-second-refer",
  name: "Reject second REFER during transfer",
  alwaysActive: true,
  defaultPriority: PRIO_REJECT_SECOND,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "request",
    method: "REFER",
    direction: "from-b",
    transferPhase: ["refer-authorizing", "c-ringing", "c-realigning", "a-realigning"],
  },

  init: () => undefined,

  handle: () =>
    Effect.succeed({
      actions: [{ type: "respond" as const, status: 491, reason: "Request Pending" }],
      state: undefined,
    }),
}

// ── transfer-reject-a-leg-refer ───────────────────────────────────────────

/**
 * REFER originated from the A leg — out of scope for v1. Respond 501.
 */
export const transferRejectALegReferRule: RuleDefinition<undefined, undefined> = {
  id: "transfer-reject-a-leg-refer",
  name: "Reject REFER from A leg",
  alwaysActive: true,
  defaultPriority: PRIO_REJECT_A_LEG,
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
}

// ── transfer-intercept-refer ──────────────────────────────────────────────

/**
 * Intercept the first in-dialog REFER on a bridged B leg, respond 202,
 * seed TransferState, send NOTIFY 100 active, arm the subscription-expiry
 * timer, and kick /call/refer asynchronously. The HTTP response re-enters
 * the rule chain via an internal-event.
 */
export const transferInterceptReferRule: RuleDefinition<undefined, undefined> = {
  id: "transfer-intercept-refer",
  name: "Intercept REFER on bridged B leg",
  alwaysActive: true,
  defaultPriority: PRIO_INTERCEPT,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "request",
    method: "REFER",
    direction: "from-b",
    legDisposition: "bridged",
    transferPhase: null,
    filter: referToLacksReplaces,
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.gen(function* () {
      if (ctx.event.type !== "sip") return undefined
      const req = ctx.event.message
      if (req.type !== "request") return undefined

      const referTo = referToOf(ctx) ?? ""
      const referredBy = getHeader(req.headers, "referred-by")
      const referCSeq = inboundCSeq(req)
      const legId = ctx.sourceLeg.legId

      const initialBody = sipfragFromStatus(100, "Trying")

      const actions: RuleAction[] = [
        { type: "respond" as const, status: 202, reason: "Accepted" },
        {
          type: "update-transfer" as const,
          update: {
            phase: "refer-authorizing" as const,
            referrerLegId: legId,
            referToUri: referTo,
            referCSeq,
            startedAtMs: ctx.nowMs,
          },
        },
        {
          type: "schedule-timer" as const,
          timerType: "refer_subscription_expiry" as const,
          delaySec: 60,
        },
        {
          type: "schedule-timer" as const,
          timerType: "refer_overall_safety" as const,
          delaySec: 120,
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
            dialog_id: dialogIdFor(ctx),
            refer_to: referTo,
            ...(referredBy !== undefined ? { referred_by: referredBy } : {}),
            sip_headers: extractSipHeaders(req),
          },
        },
      ]

      return { actions, state: undefined }
    }),
}

// ── transfer-http-reject ──────────────────────────────────────────────────

/**
 * HTTP /call/refer responded with action=reject (or the async call errored).
 * Emit a terminal NOTIFY with the rejected status and clear the transfer.
 * The A↔B call is left untouched.
 */
export const transferHttpRejectRule: RuleDefinition<undefined, undefined> = {
  id: "transfer-http-reject",
  name: "Handle /call/refer reject",
  alwaysActive: true,
  defaultPriority: PRIO_HTTP_REJECT,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "internal-event",
    topic: "refer-http-result",
    outcome: ["reject", "error"],
    transferPhase: "refer-authorizing",
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.gen(function* () {
      if (ctx.event.type !== "internal-event") return undefined
      const transfer = ctx.call.transfer
      if (transfer === null || transfer === undefined) return undefined
      const legId = transfer.referrerLegId

      const payload = ctx.event.payload as Record<string, unknown> | undefined
      const isReject = ctx.event.outcome === "reject"
      const code = isReject && typeof payload?.reject_code === "number"
        ? payload.reject_code
        : isReject ? 603 : 500
      const reason = isReject && typeof payload?.reject_reason === "string"
        ? payload.reject_reason
        : isReject ? "Declined" : "Server Internal Error"

      const body = sipfragFromStatus(code, reason)

      const actions: RuleAction[] = [
        {
          type: "send-notify" as const,
          legId,
          event: "refer",
          subscriptionState: SUB_STATE_TERMINATED_NORESOURCE,
          contentType: "message/sipfrag;version=2.0",
          body,
        },
        { type: "cancel-timer" as const, timerId: `refer_subscription_expiry-${ctx.callRef}` },
        { type: "cancel-timer" as const, timerId: `refer_overall_safety-${ctx.callRef}` },
        { type: "clear-transfer" as const },
      ]

      return { actions, state: undefined }
    }),
}

// ── transfer-http-allow (feature-flag gated in slice 4) ───────────────────

/**
 * Slice 4 stub: when REFER_ALLOW_ENABLED=false, treat an allow response as
 * 501 Not Implemented so the reject path fully covers the slice without
 * touching C-leg creation. Slices 5–7 replace this rule with the real
 * allow-path handlers.
 */
export const transferHttpAllowRule: RuleDefinition<undefined, undefined> = {
  id: "transfer-http-allow",
  name: "Handle /call/refer allow (slice 4 stub)",
  alwaysActive: true,
  defaultPriority: PRIO_HTTP_ALLOW,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "internal-event",
    topic: "refer-http-result",
    outcome: "allow",
    transferPhase: "refer-authorizing",
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.gen(function* () {
      if (!ctx.config.referAllowEnabled) {
        const transfer = ctx.call.transfer
        if (transfer === null || transfer === undefined) return undefined
        const legId = transfer.referrerLegId
        const body = sipfragFromStatus(501, "Not Implemented")
        const actions: RuleAction[] = [
          {
            type: "send-notify" as const,
            legId,
            event: "refer",
            subscriptionState: SUB_STATE_TERMINATED_NORESOURCE,
            contentType: "message/sipfrag;version=2.0",
            body,
          },
          { type: "cancel-timer" as const, timerId: `refer_subscription_expiry-${ctx.callRef}` },
          { type: "cancel-timer" as const, timerId: `refer_overall_safety-${ctx.callRef}` },
          { type: "clear-transfer" as const },
        ]
        return { actions, state: undefined }
      }
      // Feature flag on: slices 5–7 supply the real handler. Pass through so a
      // later-registered rule (or a no-op) can take over.
      return undefined
    }),
}

// ── transfer-http-timeout ─────────────────────────────────────────────────

/**
 * The subscription-expiry timer fired while we were still awaiting the
 * HTTP decision. Send NOTIFY 408/500 terminated and clear the transfer.
 */
export const transferHttpTimeoutRule: RuleDefinition<undefined, undefined> = {
  id: "transfer-http-timeout",
  name: "Handle REFER subscription expiry",
  alwaysActive: true,
  defaultPriority: PRIO_HTTP_TIMEOUT,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "timer",
    timerType: "refer_subscription_expiry",
    transferPhase: "refer-authorizing",
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.gen(function* () {
      const transfer = ctx.call.transfer
      if (transfer === null || transfer === undefined) return undefined
      const legId = transfer.referrerLegId
      const body = sipfragFromStatus(500, "Server Internal Error")

      const actions: RuleAction[] = [
        {
          type: "send-notify" as const,
          legId,
          event: "refer",
          subscriptionState: SUB_STATE_TERMINATED_TIMEOUT,
          contentType: "message/sipfrag;version=2.0",
          body,
        },
        { type: "cancel-timer" as const, timerId: `refer_overall_safety-${ctx.callRef}` },
        { type: "clear-transfer" as const },
      ]

      return { actions, state: undefined }
    }),
}

// ── Exported rule list (registration order is irrelevant — Matcher ranks) ─

export const transferRules: ReadonlyArray<RuleDefinition<undefined, undefined>> = [
  transferRejectReplacesRule,
  transferRejectSecondReferRule,
  transferRejectALegReferRule,
  transferInterceptReferRule,
  transferHttpRejectRule,
  transferHttpAllowRule,
  transferHttpTimeoutRule,
]
