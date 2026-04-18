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
import { extractNameAddrUri, getHeader } from "../../../sip/MessageFactory.js"
import { sipfragFromStatus } from "../../../sip/SipFragUtils.js"
import { buildHeldSdpFromProfile, extractCodecProfile } from "../../../sip/SdpUtils.js"

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
const PRIO_C_LEG_FAIL_INITIAL = 135
const PRIO_C_LEG_ANSWER_INITIAL = 140
const PRIO_C_LEG_PROVISIONAL = 145
const PRIO_C_LEG_NO_ANSWER = 150

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

// ── transfer-http-allow ───────────────────────────────────────────────────

interface AllowPayload {
  readonly action: "allow"
  readonly destination: { readonly host: string; readonly port?: number; readonly transport?: string }
  readonly new_refer_to?: string
  readonly update_headers?: Record<string, string | null>
  readonly no_answer_timeout_sec?: number
  readonly callback_context?: string
}

/**
 * /call/refer responded with action=allow. Build the held SDP from A's codec
 * profile, create the C leg via create-leg (with updateBody carrying the held
 * SDP), advance the transfer phase to `c-ringing`, and record the C leg id.
 *
 * When REFER_ALLOW_ENABLED=false, degrade to NOTIFY 501 Not Implemented so the
 * reject path covers the slice without touching C-leg creation (used only
 * before slice 5 rules land; left as a safety net for operators who explicitly
 * disable the feature flag).
 */
export const transferHttpAllowRule: RuleDefinition<undefined, undefined> = {
  id: "transfer-http-allow",
  name: "Handle /call/refer allow",
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
      const transfer = ctx.call.transfer
      if (transfer === null || transfer === undefined) return undefined
      const legId = transfer.referrerLegId

      if (!ctx.config.referAllowEnabled) {
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

      if (ctx.event.type !== "internal-event") return undefined
      const payload = ctx.event.payload as AllowPayload | undefined
      if (payload === undefined || payload.action !== "allow") return undefined

      const snapshot = ctx.call.aLegInviteSnapshot
      if (snapshot === undefined) return undefined

      // Build the held SDP — preserves A's codec list, port 0, a=inactive.
      // If A's SDP has no parseable m=audio line, fall through: no body on
      // the INVITE to C. C will respond 488 and transfer-c-fail-initial fires.
      const profile = extractCodecProfile(snapshot.body)
      const heldSdp = profile !== undefined
        ? new TextDecoder().decode(buildHeldSdpFromProfile(profile))
        : ""

      // Refer-To arrives as a name-addr (e.g. "<sip:c@example.com>"); the
      // Request-URI must be the bare URI, so unwrap angle brackets.
      const rawReferTo = payload.new_refer_to ?? transfer.referToUri
      const effectiveReferTo = extractNameAddrUri(rawReferTo)
      // C leg id anticipates the b-leg slot createBLegFromRoute will fill.
      const cLegId = `b-${ctx.call.bLegs.length + 1}`

      const actions: RuleAction[] = [
        {
          type: "create-leg" as const,
          destination: {
            host: payload.destination.host,
            ...(payload.destination.port !== undefined ? { port: payload.destination.port } : {}),
            ...(payload.destination.transport !== undefined ? { transport: payload.destination.transport } : {}),
          },
          fromInvite: "snapshot" as const,
          updateBody: heldSdp,
          newRuri: effectiveReferTo,
          ...(payload.update_headers !== undefined ? { updateHeaders: payload.update_headers } : {}),
          ...(payload.no_answer_timeout_sec !== undefined ? { noAnswerTimeoutSec: payload.no_answer_timeout_sec } : {}),
          ...(payload.callback_context !== undefined ? { callbackContext: payload.callback_context } : {}),
        },
        {
          type: "update-transfer" as const,
          update: {
            phase: "c-ringing" as const,
            cLegId,
            effectiveReferToUri: effectiveReferTo,
            ...(payload.callback_context !== undefined ? { callbackContext: payload.callback_context } : {}),
          },
        },
      ]

      return { actions, state: undefined }
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

// ── C-leg predicate (filter for all three transfer-c-* rules) ────────────

/** Matches only when the inbound response is on the transfer's C leg. */
function isCLegResponse(ctx: RuleContext): boolean {
  if (ctx.event.type !== "sip") return false
  const msg = ctx.event.message
  if (msg.type !== "response") return false
  const transfer = ctx.call.transfer
  if (transfer === null || transfer === undefined) return false
  if (transfer.cLegId === undefined) return false
  return ctx.sourceLeg.legId === transfer.cLegId
}

// ── transfer-c-1xx-to-notify ──────────────────────────────────────────────

/**
 * Translate a 1xx provisional from the C leg into a NOTIFY sipfrag on the
 * REFER subscription. Dedup by `lastCLegNotifiedStatus` on TransferState so a
 * repeated 180 only produces one NOTIFY.
 *
 * Outranks `relay-provisional` for C-leg responses via higher specificity
 * (transfer-phase gate + filter) — a 1xx from C must not be relayed back to A.
 */
export const transferCLegProvisionalRule: RuleDefinition<undefined, undefined> = {
  id: "transfer-c-1xx-to-notify",
  name: "NOTIFY referrer on C-leg 1xx",
  alwaysActive: true,
  defaultPriority: PRIO_C_LEG_PROVISIONAL,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "1xx",
    direction: "from-b",
    transferPhase: "c-ringing",
    filter: isCLegResponse,
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.gen(function* () {
      if (ctx.event.type !== "sip") return undefined
      const resp = ctx.event.message
      if (resp.type !== "response") return undefined
      const transfer = ctx.call.transfer
      if (transfer === null || transfer === undefined) return undefined

      // Skip 100 Trying — it's a hop-by-hop transaction progress indicator,
      // not an end-to-end subscription update. Also dedupe identical repeats.
      if (resp.status === 100) return { actions: [], state: undefined }
      if (transfer.lastCLegNotifiedStatus === resp.status) {
        return { actions: [], state: undefined }
      }

      const body = sipfragFromStatus(resp.status, resp.reason)
      const actions: RuleAction[] = [
        {
          type: "send-notify" as const,
          legId: transfer.referrerLegId,
          event: "refer",
          subscriptionState: SUB_STATE_ACTIVE_60,
          contentType: "message/sipfrag;version=2.0",
          body,
        },
        {
          type: "update-transfer" as const,
          update: { lastCLegNotifiedStatus: resp.status },
        },
      ]
      return { actions, state: undefined }
    }),
}

// ── transfer-c-200-initial ────────────────────────────────────────────────

/**
 * C answered our initial INVITE with 200 OK. Confirm the C dialog (without
 * touching A↔B peering), ACK C, send the terminal NOTIFY 200, cancel the
 * subscription-expiry + overall-safety timers, and clear the transfer state.
 *
 * Slice 5 scope: stop before re-INVITE(s). The C leg stays confirmed but
 * unpeered with A; the A↔B peer continues until either side BYEs. Slice 6
 * replaces this rule with one that also kicks off the c-realigning re-INVITE.
 */
export const transferCLegAnswerRule: RuleDefinition<undefined, undefined> = {
  id: "transfer-c-200-initial",
  name: "C-leg 200 OK → final NOTIFY (slice 5)",
  alwaysActive: true,
  defaultPriority: PRIO_C_LEG_ANSWER_INITIAL,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "2xx",
    direction: "from-b",
    transferPhase: "c-ringing",
    filter: isCLegResponse,
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.gen(function* () {
      const transfer = ctx.call.transfer
      if (transfer === null || transfer === undefined) return undefined
      const cLegId = transfer.cLegId
      if (cLegId === undefined) return undefined

      const body = sipfragFromStatus(200, "OK")
      const actions: RuleAction[] = [
        {
          type: "update-leg-state" as const,
          legId: cLegId,
          state: "confirmed",
          disposition: "bridged",
        },
        { type: "confirm-dialog" as const, legId: cLegId },
        { type: "ack-leg" as const, legId: cLegId },
        {
          type: "send-notify" as const,
          legId: transfer.referrerLegId,
          event: "refer",
          subscriptionState: SUB_STATE_TERMINATED_NORESOURCE,
          contentType: "message/sipfrag;version=2.0",
          body,
        },
        { type: "cancel-timer" as const, timerId: `refer_subscription_expiry-${ctx.callRef}` },
        { type: "cancel-timer" as const, timerId: `refer_overall_safety-${ctx.callRef}` },
        { type: "cancel-timer" as const, timerId: `no-answer-${ctx.callRef}-${cLegId}` },
        { type: "clear-transfer" as const },
        { type: "add-cdr-event" as const, eventType: "answer" as const, legId: cLegId, statusCode: 200 },
      ]
      return { actions, state: undefined }
    }),
}

// ── transfer-c-fail-initial ──────────────────────────────────────────────

/**
 * C rejected our initial INVITE with a 3xx–6xx response. Translate the
 * failure into a terminal NOTIFY on the REFER subscription, cancel transfer
 * timers, and clear transfer state. The C leg itself is terminated by the
 * framework's standard failure path (`route-failure` / `absorb-stale-failure`)
 * running after this rule via rule passthrough.
 */
export const transferCLegFailRule: RuleDefinition<undefined, undefined> = {
  id: "transfer-c-fail-initial",
  name: "C-leg 3xx–6xx → NOTIFY terminated",
  alwaysActive: true,
  defaultPriority: PRIO_C_LEG_FAIL_INITIAL,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: ["3xx", "4xx", "5xx", "6xx"],
    direction: "from-b",
    transferPhase: "c-ringing",
    filter: isCLegResponse,
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.gen(function* () {
      if (ctx.event.type !== "sip") return undefined
      const resp = ctx.event.message
      if (resp.type !== "response") return undefined
      const transfer = ctx.call.transfer
      if (transfer === null || transfer === undefined) return undefined
      const cLegId = transfer.cLegId

      const body = sipfragFromStatus(resp.status, resp.reason)
      const actions: RuleAction[] = [
        {
          type: "send-notify" as const,
          legId: transfer.referrerLegId,
          event: "refer",
          subscriptionState: SUB_STATE_TERMINATED_NORESOURCE,
          contentType: "message/sipfrag;version=2.0",
          body,
        },
        { type: "cancel-timer" as const, timerId: `refer_subscription_expiry-${ctx.callRef}` },
        { type: "cancel-timer" as const, timerId: `refer_overall_safety-${ctx.callRef}` },
        ...(cLegId !== undefined
          ? [{ type: "cancel-timer" as const, timerId: `no-answer-${ctx.callRef}-${cLegId}` }]
          : []),
        ...(cLegId !== undefined
          ? [{
              type: "add-cdr-event" as const,
              eventType: "reject" as const,
              legId: cLegId,
              statusCode: resp.status,
              reason: resp.reason,
            }]
          : []),
        ...(cLegId !== undefined
          ? [{ type: "terminate-leg" as const, legId: cLegId, byeDisposition: "rejected" as const }]
          : []),
        { type: "clear-transfer" as const },
      ]
      return { actions, state: undefined }
    }),
}

// ── transfer-c-no-answer ─────────────────────────────────────────────────

/**
 * C did not answer within the no-answer window. Translate to NOTIFY 408,
 * CANCEL the C INVITE, cancel transfer timers, and clear transfer state.
 * A↔B stays alive — the transfer simply reports 408 on the subscription.
 *
 * Outranks `no-answer-failover` via transferPhase + filter so the default
 * call-level termination path never fires for transfer-driven no-answer.
 */
export const transferCLegNoAnswerRule: RuleDefinition<undefined, undefined> = {
  id: "transfer-c-no-answer",
  name: "C-leg no-answer → NOTIFY 408 terminated",
  alwaysActive: true,
  defaultPriority: PRIO_C_LEG_NO_ANSWER,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "timer",
    timerType: "no_answer",
    transferPhase: "c-ringing",
    filter: (ctx) => {
      if (ctx.event.type !== "timer") return false
      const transfer = ctx.call.transfer
      if (transfer === null || transfer === undefined) return false
      return ctx.event.legId !== undefined && ctx.event.legId === transfer.cLegId
    },
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.gen(function* () {
      const transfer = ctx.call.transfer
      if (transfer === null || transfer === undefined) return undefined
      const cLegId = transfer.cLegId
      if (cLegId === undefined) return undefined

      const body = sipfragFromStatus(408, "Request Timeout")
      const actions: RuleAction[] = [
        {
          type: "send-notify" as const,
          legId: transfer.referrerLegId,
          event: "refer",
          subscriptionState: SUB_STATE_TERMINATED_TIMEOUT,
          contentType: "message/sipfrag;version=2.0",
          body,
        },
        { type: "add-cdr-event" as const, eventType: "timeout" as const, legId: cLegId, reason: "no_answer_timeout" },
        { type: "destroy-leg" as const, legId: cLegId },
        { type: "cancel-timer" as const, timerId: `refer_subscription_expiry-${ctx.callRef}` },
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
  transferCLegProvisionalRule,
  transferCLegAnswerRule,
  transferCLegFailRule,
  transferCLegNoAnswerRule,
]
