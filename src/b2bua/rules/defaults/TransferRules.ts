/**
 * Transfer rules — REFER-driven blind transfer on the B leg.
 *
 * The B2BUA intercepts an in-dialog REFER from the remote B leg, authorizes
 * the transfer via POST /call/refer, and either drives the outbound call to
 * the transfer target (C leg + c-realign + a-realign + merge) or rejects
 * with a terminal NOTIFY on the REFER subscription.
 *
 * References:
 *  - RFC 3515 §2.4 — REFER request/response and implicit subscription
 *  - RFC 3265 §3 — Subscription-State header values
 *  - RFC 3420 — message/sipfrag
 *  - docs/todos/REFERIMPL.md — full design and slice breakdown
 *
 * Type discipline: every rule uses `defineRule({...})` so the handler's
 * `ctx` is narrowed by the rule's `match` (event kind, direction, transfer
 * phase, in-dialog tag presence). The dispatcher and parser have already
 * enforced these invariants at runtime, so handler bodies do not re-check.
 */

import { Effect, Result, Schema } from "effect"
import { defineRule, type RuleAction, type RuleContext } from "../framework/RuleDefinition.js"
import type {
  AnyRuleDefinition,
  RequestMatch,
  ResponseMatch,
  TimerMatch,
} from "../framework/RuleDefinition.js"
import type { SipRequest } from "../../../sip/types.js"
import type { Dialog } from "../../../call/CallModel.js"
import { getHeader } from "../../../sip/MessageHelpers.js"
import { headerUpdatesFromRecord, toBareUri } from "../framework/actions/factories.js"
import { sipfragFromStatus } from "../../../sip/SipFragUtils.js"
import { buildHeldSdpFromProfile, extractCodecProfile } from "../../../sip/SdpUtils.js"

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Dialog id string exposed to the backend — `Call-ID;to-tag=…;from-tag=…`
 * from the B-leg perspective (the leg that issued the REFER).
 *
 * Receives `Dialog` (non-undefined) — callers must have already established
 * a confirmed dialog via the rule's match-criteria (legState=confirmed or
 * legDisposition=bridged), so no `?? ""` defaults.
 */
function dialogIdFor(callId: string, fromTag: string, dialog: Dialog): string {
  // B-leg perspective: dialog's "to-tag" is the peer (Bob) tag → sip.remoteTag.
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

// Filter predicates — typed per-Match-shape so the matcher's column-narrowing
// (kind, message.type) carries through. Rule bodies use the same narrowed ctx.

/** Refer-To contains a Replaces= header parameter in its embedded URI headers. */
function referToHasReplaces(ctx: RuleContext<RequestMatch>): boolean {
  const r = ctx.event.message.lazy.referTo()
  return Result.isSuccess(r) && r.success?.replaces !== undefined
}

/** REFER arrived without a Replaces parameter in the Refer-To URI. */
function referToLacksReplaces(ctx: RuleContext<RequestMatch>): boolean {
  return !referToHasReplaces(ctx)
}

/** Matches only when the inbound response is on the transfer's C leg. */
function isCLegResponse(ctx: RuleContext<ResponseMatch>): boolean {
  const cLegId = ctx.call.transfer?.cLegId
  return cLegId !== undefined && ctx.sourceLeg.legId === cLegId
}

/** Matches only when the inbound request is on the transfer's C leg. */
function isCLegRequest(ctx: RuleContext<RequestMatch>): boolean {
  const cLegId = ctx.call.transfer?.cLegId
  return cLegId !== undefined && ctx.sourceLeg.legId === cLegId
}

/**
 * Request arrived on the original referrer B leg (not the C leg) and is not a
 * BYE. BYE gets its own handling; other methods during the realigning phases
 * are rejected 481.
 */
function isReferrerBLegNonBye(ctx: RuleContext<RequestMatch>): boolean {
  if (ctx.event.message.method === "BYE") return false
  const referrerLegId = ctx.call.transfer?.referrerLegId
  return referrerLegId !== undefined && ctx.sourceLeg.legId === referrerLegId
}

/** Response arrived on the a-leg. */
function isALegResponse(ctx: RuleContext<ResponseMatch>): boolean {
  return ctx.sourceLeg.legId === "a"
}

/** Timer fired for the a-leg refer_reinvite_answer watchdog. */
function isALegReinviteTimer(ctx: RuleContext<TimerMatch>): boolean {
  return ctx.event.legId === "a"
}

/** No-answer timer for the C-leg specifically. */
function isCLegNoAnswerTimer(ctx: RuleContext<TimerMatch>): boolean {
  const cLegId = ctx.call.transfer?.cLegId
  return cLegId !== undefined && ctx.event.legId === cLegId
}

// Subscription-State fragments (RFC 3265 §3.2.4)
const SUB_STATE_ACTIVE_60 = "active;expires=60"
const SUB_STATE_TERMINATED_NORESOURCE = "terminated;reason=noresource"
const SUB_STATE_TERMINATED_TIMEOUT = "terminated;reason=timeout"

// ── transfer-reject-replaces ──────────────────────────────────────────────

/**
 * REFER with a Replaces= parameter in the Refer-To URI is attended transfer
 * (RFC 3891). Not supported in v1 — respond 501 Not Implemented.
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

// ── transfer-reject-second-refer ──────────────────────────────────────────

/**
 * A second REFER while a transfer is already in progress — respond 491
 * Request Pending (RFC 3261 §14.1) so the referrer retries after the
 * current transfer resolves.
 */
export const transferRejectSecondReferRule = defineRule({
  id: "transfer-reject-second-refer",
  name: "Reject second REFER during transfer",
  alwaysActive: true,
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
 * Intercept the first in-dialog REFER on a bridged B leg, respond 202,
 * seed TransferState, send NOTIFY 100 active, arm the subscription-expiry
 * timer, and kick /call/refer asynchronously. The HTTP response re-enters
 * the rule chain via an internal-event.
 *
 * `legState: "confirmed"` is the in-dialog gate — together with the parser
 * tightening for in-dialog requests, the handler sees an
 * `InDialogMethodRequest<"REFER">` with both From-tag and To-tag guaranteed,
 * and `sourceDialog: Dialog` (non-undefined).
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
    transferPhase: null,
    filter: referToLacksReplaces,
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.sync(() => {
      const req = ctx.event.message
      const legId = ctx.sourceLeg.legId
      const referTo = getHeader(req.headers, "refer-to") ?? ""
      const referredBy = getHeader(req.headers, "referred-by")

      const initialBody = sipfragFromStatus(100, "Trying")

      const actions: RuleAction[] = [
        { type: "respond" as const, status: 202, reason: "Accepted" },
        {
          type: "update-transfer" as const,
          update: {
            phase: "refer-authorizing" as const,
            referrerLegId: legId,
            referToUri: referTo,
            referCSeq: req.parsed.cseq.seq,
            startedAtMs: ctx.nowMs,
          },
        },
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

// ── transfer-http-reject ──────────────────────────────────────────────────

/**
 * HTTP /call/refer responded with action=reject (or the async call errored).
 * Emit a terminal NOTIFY with the rejected status and clear the transfer.
 * The A↔B call is left untouched.
 */
export const transferHttpRejectRule = defineRule({
  id: "transfer-http-reject",
  name: "Handle /call/refer reject",
  alwaysActive: true,
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
    Effect.sync(() => {
      const transfer = ctx.call.transfer
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
})

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
 * profile, create the C leg via create-leg (with bodyUpdate carrying the held
 * SDP), advance the transfer phase to `c-ringing`, and record the C leg id.
 */
export const transferHttpAllowRule = defineRule({
  id: "transfer-http-allow",
  name: "Handle /call/refer allow",
  alwaysActive: true,
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
      const payload = ctx.event.payload as AllowPayload | undefined
      if (payload === undefined || payload.action !== "allow") return undefined

      const snapshot = ctx.call.aLegInvite

      // Build the held SDP — preserves A's codec list, port 0, a=inactive.
      // If A's SDP has no parseable m=audio line, fall through: no body on
      // the INVITE to C. C will respond 488 and transfer-c-fail-initial fires.
      const profile = extractCodecProfile(snapshot.body)
      const heldSdp = profile !== undefined
        ? new TextDecoder().decode(buildHeldSdpFromProfile(profile))
        : ""

      // Refer-To arrives as a name-addr (e.g. "<sip:c@example.com>"); the
      // Request-URI must be the bare URI — toBareUri unwraps angle brackets
      // and strips header params, rejecting anything that isn't sip:/sips:.
      const rawReferTo = payload.new_refer_to ?? transfer.referToUri
      const effectiveReferTo = toBareUri(rawReferTo)
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
          bodyUpdate: heldSdp.length > 0
            ? { kind: "set" as const, value: new TextEncoder().encode(heldSdp) }
            : { kind: "drop" as const },
          ruri: { kind: "set" as const, value: effectiveReferTo },
          ...(payload.update_headers !== undefined
            ? { headerUpdates: headerUpdatesFromRecord(payload.update_headers as Record<string, string | null>) }
            : {}),
          ...(payload.no_answer_timeout_sec !== undefined ? { noAnswerTimeoutSec: payload.no_answer_timeout_sec } : {}),
          ...(payload.callback_context !== undefined ? { callbackContext: payload.callback_context } : {}),
        },
        {
          type: "update-transfer" as const,
          update: {
            phase: "c-ringing" as const,
            cLegId,
            effectiveReferToUri: effectiveReferTo as string,
            ...(payload.callback_context !== undefined ? { callbackContext: payload.callback_context } : {}),
          },
        },
      ]

      return { actions, state: undefined }
    }),
})

// ── transfer-http-timeout ─────────────────────────────────────────────────

/**
 * The subscription-expiry timer fired while we were still awaiting the
 * HTTP decision. Send NOTIFY 408/500 terminated and clear the transfer.
 */
export const transferHttpTimeoutRule = defineRule({
  id: "transfer-http-timeout",
  name: "Handle REFER subscription expiry",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "timer",
    timerType: "refer_subscription_expiry",
    transferPhase: "refer-authorizing",
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.sync(() => {
      const transfer = ctx.call.transfer
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
})

// ── transfer-c-1xx-to-notify ──────────────────────────────────────────────

/**
 * Translate a 1xx provisional from the C leg into a NOTIFY sipfrag on the
 * REFER subscription. Dedup by `lastCLegNotifiedStatus` on TransferState so a
 * repeated 180 only produces one NOTIFY.
 *
 * 100 Trying never reaches here — TransactionLayer absorbs it.
 *
 * Outranks `relay-provisional` for C-leg responses via higher specificity
 * (transfer-phase gate + filter) — a 1xx from C must not be relayed back to A.
 */
export const transferCLegProvisionalRule = defineRule({
  id: "transfer-c-1xx-to-notify",
  name: "NOTIFY referrer on C-leg 1xx",
  alwaysActive: true,
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
    Effect.sync(() => {
      const resp = ctx.event.message
      const transfer = ctx.call.transfer

      // Dedupe identical repeats (e.g. 180 followed by 180).
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
})

// ── transfer-c-200-initial ────────────────────────────────────────────────

/**
 * C answered our initial INVITE with 200 OK. Confirm the C dialog (without
 * touching A↔B peering), ACK C, send the terminal NOTIFY 200, cancel the
 * subscription-expiry timer, capture C's initial SDP for the a-realign
 * re-INVITE, transition to `c-realigning`, arm the re-INVITE watchdog, and
 * emit the B2BUA-originated re-INVITE on C carrying A's SDP so C learns A's
 * media endpoint.
 *
 * The overall-safety timer stays armed across realigning; it is only cancelled
 * when transfer completes or rollback fires.
 */
export const transferCLegAnswerRule = defineRule({
  id: "transfer-c-200-initial",
  name: "C-leg 200 OK → final NOTIFY + re-INVITE C",
  alwaysActive: true,
  overrides: "retransmit-200",
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
    Effect.sync(() => {
      const resp = ctx.event.message
      const transfer = ctx.call.transfer
      const cLegId = transfer.cLegId
      if (cLegId === undefined) return undefined

      // Capture C's 200-OK SDP — drives the a-realign re-INVITE.
      const cInitialSdp = resp.body.byteLength > 0 ? resp.body : undefined

      // A's SDP for the re-INVITE-C offer comes from the a-leg INVITE snapshot
      // (A hasn't re-INVITEd since; snapshot still reflects the live endpoint).
      const aSdp = ctx.call.aLegInvite.body

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
        { type: "cancel-timer" as const, timerId: `no-answer-${ctx.callRef}-${cLegId}` },
        {
          type: "update-transfer" as const,
          update: {
            phase: "c-realigning" as const,
            ...(cInitialSdp !== undefined ? { cInitialSdp } : {}),
          },
        },
        {
          type: "schedule-timer" as const,
          timerType: "refer_reinvite_answer" as const,
          delaySec: ctx.config.referReinviteAnswerSec,
          legId: cLegId,
        },
        {
          type: "send-reinvite" as const,
          legId: cLegId,
          bodyUpdate: aSdp !== undefined && aSdp.byteLength > 0
            ? { kind: "set" as const, value: aSdp }
            : { kind: "drop" as const },
        },
        { type: "add-cdr-event" as const, eventType: "answer" as const, legId: cLegId, statusCode: 200 },
      ]
      return { actions, state: undefined }
    }),
})

// ── transfer-c-fail-initial ──────────────────────────────────────────────

/**
 * C rejected our initial INVITE with a 3xx–6xx response. Translate the
 * failure into a terminal NOTIFY on the REFER subscription, cancel transfer
 * timers, and clear transfer state.
 */
export const transferCLegFailRule = defineRule({
  id: "transfer-c-fail-initial",
  name: "C-leg 3xx–6xx → NOTIFY terminated",
  alwaysActive: true,
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
    Effect.sync(() => {
      const resp = ctx.event.message
      const transfer = ctx.call.transfer
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
          ? [
              { type: "cancel-timer" as const, timerId: `no-answer-${ctx.callRef}-${cLegId}` },
              {
                type: "add-cdr-event" as const,
                eventType: "reject" as const,
                legId: cLegId,
                statusCode: resp.status,
                reason: resp.reason,
              },
              { type: "terminate-leg" as const, legId: cLegId, byeDisposition: "rejected" as const },
            ]
          : []),
        { type: "clear-transfer" as const },
      ]
      return { actions, state: undefined }
    }),
})

// ── transfer-c-no-answer ─────────────────────────────────────────────────

/**
 * C did not answer within the no-answer window. Translate to NOTIFY 408,
 * CANCEL the C INVITE, cancel transfer timers, and clear transfer state.
 *
 * Outranks `no-answer-failover` via transferPhase + filter so the default
 * call-level termination path never fires for transfer-driven no-answer.
 */
export const transferCLegNoAnswerRule = defineRule({
  id: "transfer-c-no-answer",
  name: "C-leg no-answer → NOTIFY 408 terminated",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "timer",
    timerType: "no_answer",
    transferPhase: "c-ringing",
    filter: isCLegNoAnswerTimer,
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.sync(() => {
      const transfer = ctx.call.transfer
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
})

// ── transfer-c-realign-200 ────────────────────────────────────────────────

/**
 * C answered our c-realigning re-INVITE with 2xx. ACK C, cancel the C-side
 * re-INVITE answer watchdog, transition to `a-realigning`, arm a fresh
 * watchdog keyed on the a-leg, and emit the B2BUA-originated re-INVITE on
 * A carrying C's captured initial SDP. A's 2xx completes the merge
 * (transfer-a-realign-200); 4xx/5xx/6xx rolls back (transfer-a-realign-fail).
 */
export const transferCRealign200Rule = defineRule({
  id: "transfer-c-realign-200",
  name: "C-leg 2xx to c-realign re-INVITE → phase a-realigning + re-INVITE A",
  alwaysActive: true,
  overrides: "retransmit-200",
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "2xx",
    direction: "from-b",
    transferPhase: "c-realigning",
    filter: isCLegResponse,
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.sync(() => {
      const transfer = ctx.call.transfer
      const cLegId = transfer.cLegId
      if (cLegId === undefined) return undefined
      const cInitialSdp = transfer.cInitialSdp

      const actions: RuleAction[] = [
        { type: "ack-leg" as const, legId: cLegId },
        {
          type: "cancel-timer" as const,
          timerId: `refer_reinvite_answer-${ctx.callRef}-${cLegId}`,
        },
        {
          type: "update-transfer" as const,
          update: { phase: "a-realigning" as const },
        },
        {
          type: "schedule-timer" as const,
          timerType: "refer_reinvite_answer" as const,
          delaySec: ctx.config.referReinviteAnswerSec,
          legId: "a",
        },
        {
          type: "send-reinvite" as const,
          legId: "a",
          bodyUpdate: cInitialSdp !== undefined && cInitialSdp.byteLength > 0
            ? { kind: "set" as const, value: cInitialSdp }
            : { kind: "drop" as const },
        },
      ]
      return { actions, state: undefined }
    }),
})

// ── transfer-c-realign-fail ───────────────────────────────────────────────

/**
 * C rejected the c-realigning re-INVITE with 4xx/5xx/6xx. The transfer
 * cannot complete — begin termination on all legs, emit a rollback CDR
 * event for diagnosis.
 */
export const transferCRealignFailRule = defineRule({
  id: "transfer-c-realign-fail",
  name: "C-leg rejects c-realign re-INVITE → rollback",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: ["4xx", "5xx", "6xx"],
    direction: "from-b",
    transferPhase: "c-realigning",
    filter: isCLegResponse,
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.sync(() => {
      const resp = ctx.event.message
      const transfer = ctx.call.transfer
      const cLegId = transfer.cLegId

      const actions: RuleAction[] = [
        ...(cLegId !== undefined
          ? [
              {
                type: "cancel-timer" as const,
                timerId: `refer_reinvite_answer-${ctx.callRef}-${cLegId}`,
              },
            ]
          : []),
        { type: "cancel-timer" as const, timerId: `refer_overall_safety-${ctx.callRef}` },
        ...(cLegId !== undefined
          ? [{
              type: "add-cdr-event" as const,
              eventType: "reject" as const,
              legId: cLegId,
              statusCode: resp.status,
              reason: "transfer-rollback-c-realign",
            }]
          : []),
        { type: "begin-termination" as const },
      ]
      return { actions, state: undefined }
    }),
})

// ── transfer-c-realign-timeout ────────────────────────────────────────────

/**
 * The refer_reinvite_answer watchdog fired during `c-realigning` — C did
 * not respond to our re-INVITE within 32s. Roll back the transfer.
 */
export const transferCRealignTimeoutRule = defineRule({
  id: "transfer-c-realign-timeout",
  name: "c-realign re-INVITE timeout → rollback",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "timer",
    timerType: "refer_reinvite_answer",
    transferPhase: "c-realigning",
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.sync(() => {
      const transfer = ctx.call.transfer
      const cLegId = transfer.cLegId

      const actions: RuleAction[] = [
        { type: "cancel-timer" as const, timerId: `refer_overall_safety-${ctx.callRef}` },
        ...(cLegId !== undefined
          ? [{
              type: "add-cdr-event" as const,
              eventType: "timeout" as const,
              legId: cLegId,
              reason: "transfer-rollback-c-realign",
            }]
          : []),
        { type: "begin-termination" as const },
      ]
      return { actions, state: undefined }
    }),
})

// ── transfer-c-glare-reinvite ────────────────────────────────────────────

/**
 * C sent its own re-INVITE while we were already driving the SDP swap
 * (phase c-realigning or a-realigning). RFC 3261 §14.1 — respond 491
 * Request Pending so C retries after our exchange completes.
 */
export const transferCGlareReinviteRule = defineRule({
  id: "transfer-c-glare-reinvite",
  name: "C-leg re-INVITE during realigning → 491",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "request",
    method: "INVITE",
    direction: "from-b",
    transferPhase: ["c-realigning", "a-realigning"],
    filter: isCLegRequest,
  },

  init: () => undefined,

  handle: () =>
    Effect.succeed({
      actions: [{ type: "respond" as const, status: 491, reason: "Request Pending" }],
      state: undefined,
    }),
})

// ── transfer-a-realign-200 ──────────────────────────────────────────────

/**
 * A answered our a-realigning re-INVITE with 2xx. The media swap is
 * complete. ACK A, cancel the answer watchdog and the overall-safety
 * timer, merge(a, cLeg) so subsequent in-dialog traffic routes to the
 * new peer, clear transfer state, and CDR the completion.
 */
export const transferARealign200Rule = defineRule({
  id: "transfer-a-realign-200",
  name: "A-leg 2xx to a-realign re-INVITE → merge(a, c), transfer complete",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "2xx",
    direction: "from-a",
    transferPhase: "a-realigning",
    filter: isALegResponse,
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.sync(() => {
      const transfer = ctx.call.transfer
      const cLegId = transfer.cLegId
      if (cLegId === undefined) return undefined

      const actions: RuleAction[] = [
        { type: "ack-leg" as const, legId: "a" },
        {
          type: "cancel-timer" as const,
          timerId: `refer_reinvite_answer-${ctx.callRef}-a`,
        },
        { type: "cancel-timer" as const, timerId: `refer_overall_safety-${ctx.callRef}` },
        { type: "merge" as const, legA: "a", legB: cLegId },
        {
          type: "add-cdr-event" as const,
          eventType: "answer" as const,
          legId: "a",
          statusCode: 200,
          reason: "transfer-completed",
        },
        { type: "clear-transfer" as const },
      ]
      return { actions, state: undefined }
    }),
})

// ── transfer-a-realign-fail ─────────────────────────────────────────────

/**
 * A rejected the a-realigning re-INVITE with 4xx/5xx/6xx. The merge
 * cannot complete — roll back all legs.
 */
export const transferARealignFailRule = defineRule({
  id: "transfer-a-realign-fail",
  name: "A-leg rejects a-realign re-INVITE → rollback",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: ["4xx", "5xx", "6xx"],
    direction: "from-a",
    transferPhase: "a-realigning",
    filter: isALegResponse,
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.sync(() => {
      const resp = ctx.event.message

      const actions: RuleAction[] = [
        {
          type: "cancel-timer" as const,
          timerId: `refer_reinvite_answer-${ctx.callRef}-a`,
        },
        { type: "cancel-timer" as const, timerId: `refer_overall_safety-${ctx.callRef}` },
        {
          type: "add-cdr-event" as const,
          eventType: "reject" as const,
          legId: "a",
          statusCode: resp.status,
          reason: "transfer-rollback-a-realign",
        },
        { type: "begin-termination" as const },
      ]
      return { actions, state: undefined }
    }),
})

// ── transfer-a-realign-timeout ──────────────────────────────────────────

/**
 * The refer_reinvite_answer watchdog fired during `a-realigning` — A did
 * not respond to our re-INVITE within 32s. Roll back all legs.
 */
export const transferARealignTimeoutRule = defineRule({
  id: "transfer-a-realign-timeout",
  name: "a-realign re-INVITE timeout → rollback",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "timer",
    timerType: "refer_reinvite_answer",
    transferPhase: "a-realigning",
    filter: isALegReinviteTimer,
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.sync(() => {
      const actions: RuleAction[] = [
        { type: "cancel-timer" as const, timerId: `refer_overall_safety-${ctx.callRef}` },
        {
          type: "add-cdr-event" as const,
          eventType: "timeout" as const,
          legId: "a",
          reason: "transfer-rollback-a-realign",
        },
        { type: "begin-termination" as const },
      ]
      return { actions, state: undefined }
    }),
})

// ── transfer-a-glare-reinvite ──────────────────────────────────────────

/**
 * A sent a re-INVITE while the B2BUA is performing the SDP swap (phase
 * c-realigning or a-realigning). RFC 3261 §14.1 — respond 491 Request
 * Pending so A retries after our exchange completes. During Regime 1
 * (refer-authorizing, c-ringing) A re-INVITEs still relay transparently
 * to B — this rule only gates Regime 2.
 */
export const transferAGlareReinviteRule = defineRule({
  id: "transfer-a-glare-reinvite",
  name: "A-leg re-INVITE during realigning → 491",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "request",
    method: "INVITE",
    direction: "from-a",
    transferPhase: ["c-realigning", "a-realigning"],
  },

  init: () => undefined,

  handle: () =>
    Effect.succeed({
      actions: [{ type: "respond" as const, status: 491, reason: "Request Pending" }],
      state: undefined,
    }),
})

// ── transfer-b-in-cre-are-reject ─────────────────────────────────────────

/**
 * Any non-BYE in-dialog request from the original REFER-sender (B leg) while
 * the B2BUA is performing the SDP swap (c-realigning / a-realigning) is
 * rejected 481. B's subscription is already terminated; further in-dialog
 * traffic on that leg has no meaningful target. BYE is excluded so the B
 * leg can still tear down (absorbed by other transfer rules / default relay).
 */
export const transferBInCrArRejectRule = defineRule({
  id: "transfer-b-in-cre-are-reject",
  name: "Referrer B-leg non-BYE during realigning → 481",
  alwaysActive: true,
  overrides: "resolve-cross-bye",
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "request",
    direction: "from-b",
    transferPhase: ["c-realigning", "a-realigning"],
    filter: isReferrerBLegNonBye,
  },

  init: () => undefined,

  handle: () =>
    Effect.succeed({
      actions: [{ type: "respond" as const, status: 481, reason: "Call/Transaction Does Not Exist" }],
      state: undefined,
    }),
})

// ── transfer-overall-timeout ──────────────────────────────────────────────

/**
 * End-to-end safety net: the overall-safety timer armed at REFER interception
 * expired while a transfer was still in progress. In a healthy flow, every
 * phase-local timeout rule (subscription-expiry, re-INVITE-answer C / A) fires
 * first and cancels `refer_overall_safety` before it can expire. If we reach
 * this rule, the transfer is genuinely stuck — force a full rollback so no
 * call is left half-swapped.
 */
export const transferOverallTimeoutRule = defineRule({
  id: "transfer-overall-timeout",
  name: "Transfer overall-safety timer → rollback",
  alwaysActive: true,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "timer",
    timerType: "refer_overall_safety",
    transferPhase: ["refer-authorizing", "c-ringing", "c-realigning", "a-realigning"],
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.sync(() => {
      const transfer = ctx.call.transfer
      const cLegId = transfer.cLegId

      const actions: RuleAction[] = [
        { type: "cancel-timer" as const, timerId: `refer_subscription_expiry-${ctx.callRef}` },
        ...(cLegId !== undefined
          ? [{
              type: "cancel-timer" as const,
              timerId: `refer_reinvite_answer-${ctx.callRef}-${cLegId}`,
            }]
          : []),
        { type: "cancel-timer" as const, timerId: `refer_reinvite_answer-${ctx.callRef}-a` },
        {
          type: "add-cdr-event" as const,
          eventType: "timeout" as const,
          legId: "a",
          reason: "transfer-overall-timeout",
        },
        { type: "begin-termination" as const },
      ]
      return { actions, state: undefined }
    }),
})

// ── Exported rule list (registration order is irrelevant — Matcher ranks) ─

export const transferRules: ReadonlyArray<AnyRuleDefinition> = [
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
  transferCRealign200Rule,
  transferCRealignFailRule,
  transferCRealignTimeoutRule,
  transferCGlareReinviteRule,
  transferBInCrArRejectRule,
  transferARealign200Rule,
  transferARealignFailRule,
  transferARealignTimeoutRule,
  transferAGlareReinviteRule,
  transferOverallTimeoutRule,
]
