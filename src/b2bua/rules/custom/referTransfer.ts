/**
 * referTransfer — callflow service for the REFER-driven blind transfer
 * (ADR-0016). Migrated from the bespoke `Call.transfer` named field + the
 * `Match.transferPhase` gate column onto the typed-ext service template.
 *
 * The transfer service owns a typed CALL-ext slice (`TransferCallExt`) carrying
 * the phase machine (`phase`), the addressable leg ids (referrer B = the
 * `referrerLegId`, target C = `cLegId`, transferee = the A leg), and the
 * per-transfer payload data. Legs are addressed by id — no per-leg ext.
 *
 * Activation is ext-presence: the seed rule `transfer-intercept-refer`
 * (a default rule, see TransferRules.ts) writes `call.ext["transfer"]` on the
 * first authorized REFER; from then on these service rules are live (in the
 * SERVICE_LAYER, so they automatically take precedence over core rules for the
 * same event) until a rule returns `clearCallExt: true`. Each rule's `filter`
 * reads the decoded `ext.phase` (the former `Match.transferPhase` gate) and
 * identifies the source leg by id (`ctx.sourceLeg.legId === ext.cLegId`, etc.).
 *
 * References:
 *  - RFC 3515 §2.4 — REFER request/response and implicit subscription
 *  - RFC 3265 §3 — Subscription-State header values
 *  - RFC 3420 — message/sipfrag
 *  - docs/todos/REFERIMPL.md — full design and slice breakdown
 */

import { Effect, Schema } from "effect"
import { defineService } from "../framework/Service.js"
import type { RuleAction } from "../framework/RuleDefinition.js"
import { sipfragFromStatus } from "../../../sip/SipFragUtils.js"
import { headerUpdatesFromRecord, toBareUri } from "../framework/actions/factories.js"
import { buildHeldSdpFromProfile, extractCodecProfile } from "../../../sip/SdpUtils.js"

// ── Service id + schemas ───────────────────────────────────────────────────

export const TRANSFER_SERVICE_ID = "transfer"

/** Phase marker for the REFER-driven transfer state machine. */
export const TransferPhase = Schema.Literals([
  /** REFER received, awaiting HTTP authorization decision. */
  "refer-authorizing",
  /** C-leg INVITE sent, awaiting final response. */
  "c-ringing",
  /** Re-INVITE toward C with A's SDP in flight. */
  "c-realigning",
  /** Re-INVITE toward A with C's endpoint in flight. */
  "a-realigning",
])
export type TransferPhase = typeof TransferPhase.Type

/**
 * Per-call transfer state. Holds the phase + addressable leg ids (actions and
 * filters address legs by id: send-notify legId, send-reinvite legId,
 * cancel-timer `…-${cLegId}`, `ctx.sourceLeg.legId === ext.cLegId`) and the
 * payload carried across phases.
 */
export const TransferCallExt = Schema.Struct({
  /** Current transfer phase — gates which service rules can match (filter). */
  phase: TransferPhase,
  /** B-leg that issued the REFER (origin of the implicit subscription). */
  referrerLegId: Schema.String,
  /** Raw Refer-To URI as received from the referrer. */
  referToUri: Schema.String,
  /** Refer-To URI after any HTTP-driven rewrite (`new_refer_to`). */
  effectiveReferToUri: Schema.optional(Schema.String),
  /** Callback context propagated from the /call/refer response. */
  callbackContext: Schema.optional(Schema.String),
  /** Newly-created C-leg identifier (set when create-leg fires). */
  cLegId: Schema.optional(Schema.String),
  /** CSeq of the REFER request on the referrer's dialog (for NOTIFY correlation). */
  referCSeq: Schema.optional(Schema.Int),
  /** Wall-clock ms when the REFER was received — drives the overall safety timer. */
  startedAtMs: Schema.Number,
  /**
   * Last 1xx status code forwarded on the REFER subscription as a NOTIFY
   * sipfrag. Used by `transfer-c-1xx-to-notify` to dedupe repeats.
   */
  lastCLegNotifiedStatus: Schema.optional(Schema.Int),
  /**
   * C-leg's initial answer SDP (captured from C's 200 OK to the initial
   * INVITE). Carried across c-realigning so the a-realign re-INVITE can offer
   * it back to A. Rides as base64 at rest (JSON-safe).
   */
  cInitialSdp: Schema.optional(Schema.Uint8ArrayFromBase64),
})
export type TransferCallExt = typeof TransferCallExt.Type

/** Encode a TransferCallExt to its at-rest (Encoded) form (used by the seed). */
export const encodeTransferCallExt = Schema.encodeSync(TransferCallExt)

// Legs are addressed by id throughout: the referrer B leg is `ext.referrerLegId`,
// the created C leg is `ext.cLegId`, and the transferee is the A leg ("a"). The
// transfer service therefore needs no per-leg ext (call-ext alone identifies
// every participant) — see dev_docs/refer-rebuild-findings.md.
const transfer = defineService({
  id: TRANSFER_SERVICE_ID,
  callExt: TransferCallExt,
})

// Subscription-State fragments (RFC 3265 §3.2.4)
const SUB_STATE_ACTIVE_60 = "active;expires=60"
const SUB_STATE_TERMINATED_NORESOURCE = "terminated;reason=noresource"
const SUB_STATE_TERMINATED_TIMEOUT = "terminated;reason=timeout"

function isRealigning(phase: TransferPhase): boolean {
  return phase === "c-realigning" || phase === "a-realigning"
}

// ── transfer-reject-second-refer ──────────────────────────────────────────
//
// A second REFER while a transfer is already active — respond 491 Request
// Pending (RFC 3261 §14.1). Active = the slice is present (the service guard);
// phase-agnostic. `transfer-reject-replaces` (a default rule) overrides this
// when the Refer-To carries Replaces.

transfer.rule({
  id: "transfer-reject-second-refer",
  name: "Reject second REFER during transfer",
  match: {
    kind: "request",
    method: "REFER",
    direction: "from-b",
  },
  handle: () =>
    Effect.succeed({
      actions: [{ type: "respond" as const, status: 491, reason: "Request Pending" }],
    }),
})

// ── transfer-http-reject ──────────────────────────────────────────────────

transfer.rule({
  id: "transfer-http-reject",
  name: "Handle /call/refer reject",
  match: {
    kind: "internal-event",
    topic: "refer-http-result",
    outcome: ["reject", "error"],
  },
  filter: (_ctx, ext) => ext.phase === "refer-authorizing",
  handle: (ctx, ext) =>
    Effect.sync(() => {
      const legId = ext.referrerLegId

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
      ]
      return { actions, clearCallExt: true }
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

transfer.rule({
  id: "transfer-http-allow",
  name: "Handle /call/refer allow",
  match: {
    kind: "internal-event",
    topic: "refer-http-result",
    outcome: "allow",
  },
  filter: (_ctx, ext) => ext.phase === "refer-authorizing",
  handle: (ctx, ext) =>
    Effect.gen(function* () {
      const payload = ctx.event.payload as AllowPayload | undefined
      if (payload === undefined || payload.action !== "allow") return undefined

      const snapshot = ctx.call.aLegInvite

      // Build the held SDP — preserves A's codec list, port 0, a=inactive.
      const profile = extractCodecProfile(snapshot.body)
      const heldSdp = profile !== undefined
        ? new TextDecoder().decode(
            buildHeldSdpFromProfile(profile, {
              localIp: ctx.config.sipLocalIp,
              nowMs: ctx.nowMs,
            })
          )
        : ""

      const rawReferTo = payload.new_refer_to ?? ext.referToUri
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
      ]

      const callExt: TransferCallExt = {
        ...ext,
        phase: "c-ringing",
        cLegId,
        effectiveReferToUri: effectiveReferTo as string,
        ...(payload.callback_context !== undefined ? { callbackContext: payload.callback_context } : {}),
      }

      return { actions, callExt }
    }),
})

// ── transfer-http-timeout ─────────────────────────────────────────────────

transfer.rule({
  id: "transfer-http-timeout",
  name: "Handle REFER subscription expiry",
  match: {
    kind: "timer",
    timerType: "refer_subscription_expiry",
  },
  filter: (_ctx, ext) => ext.phase === "refer-authorizing",
  handle: (ctx, ext) =>
    Effect.sync(() => {
      const legId = ext.referrerLegId
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
      ]
      return { actions, clearCallExt: true }
    }),
})

// ── transfer-c-1xx-to-notify ──────────────────────────────────────────────

transfer.rule({
  id: "transfer-c-1xx-to-notify",
  name: "NOTIFY referrer on C-leg 1xx",
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "1xx",
    direction: "from-b",
  },
  filter: (ctx, ext) =>
    ext.phase === "c-ringing" && ctx.sourceLeg.legId === ext.cLegId,
  handle: (ctx, ext) =>
    Effect.sync(() => {
      const resp = ctx.event.message

      // Dedupe identical repeats (e.g. 180 followed by 180).
      if (ext.lastCLegNotifiedStatus === resp.status) {
        return { actions: [] }
      }

      const body = sipfragFromStatus(resp.status, resp.reason)
      const actions: RuleAction[] = [
        {
          type: "send-notify" as const,
          legId: ext.referrerLegId,
          event: "refer",
          subscriptionState: SUB_STATE_ACTIVE_60,
          contentType: "message/sipfrag;version=2.0",
          body,
        },
      ]
      return { actions, callExt: { ...ext, lastCLegNotifiedStatus: resp.status } }
    }),
})

// ── transfer-c-200-initial ────────────────────────────────────────────────

transfer.rule({
  id: "transfer-c-200-initial",
  name: "C-leg 200 OK → final NOTIFY + re-INVITE C",
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "2xx",
    direction: "from-b",
    // C leg is still trying/early when its initial INVITE final response
    // arrives — distinguishes this from transfer-c-realign-200 (confirmed).
    legState: ["trying", "early"],
  },
  filter: (ctx, ext) =>
    ext.phase === "c-ringing" && ctx.sourceLeg.legId === ext.cLegId,
  handle: (ctx, ext) =>
    Effect.sync(() => {
      const resp = ctx.event.message
      const cLegId = ext.cLegId
      if (cLegId === undefined) return undefined

      // Capture C's 200-OK SDP — drives the a-realign re-INVITE.
      const cInitialSdp = resp.body.byteLength > 0 ? resp.body : undefined

      // A's SDP for the re-INVITE-C offer comes from the a-leg INVITE snapshot.
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
          legId: ext.referrerLegId,
          event: "refer",
          subscriptionState: SUB_STATE_TERMINATED_NORESOURCE,
          contentType: "message/sipfrag;version=2.0",
          body,
        },
        { type: "cancel-timer" as const, timerId: `refer_subscription_expiry-${ctx.callRef}` },
        { type: "cancel-timer" as const, timerId: `no-answer-${ctx.callRef}-${cLegId}` },
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
      const callExt: TransferCallExt = {
        ...ext,
        phase: "c-realigning",
        ...(cInitialSdp !== undefined ? { cInitialSdp } : {}),
      }
      return { actions, callExt }
    }),
})

// ── transfer-c-fail-initial ──────────────────────────────────────────────

transfer.rule({
  id: "transfer-c-fail-initial",
  name: "C-leg 3xx–6xx → NOTIFY terminated",
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: ["3xx", "4xx", "5xx", "6xx"],
    direction: "from-b",
    // C leg is still trying/early on its initial INVITE failure response —
    // distinguishes this from transfer-c-realign-fail (confirmed).
    legState: ["trying", "early"],
  },
  filter: (ctx, ext) =>
    ext.phase === "c-ringing" && ctx.sourceLeg.legId === ext.cLegId,
  handle: (ctx, ext) =>
    Effect.sync(() => {
      const resp = ctx.event.message
      const cLegId = ext.cLegId

      const body = sipfragFromStatus(resp.status, resp.reason)
      const actions: RuleAction[] = [
        {
          type: "send-notify" as const,
          legId: ext.referrerLegId,
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
      ]
      return { actions, clearCallExt: true }
    }),
})

// ── transfer-c-no-answer ─────────────────────────────────────────────────

transfer.rule({
  id: "transfer-c-no-answer",
  name: "C-leg no-answer → NOTIFY 408 terminated",
  match: {
    kind: "timer",
    timerType: "no_answer",
  },
  filter: (ctx, ext) =>
    ext.phase === "c-ringing" &&
    ext.cLegId !== undefined &&
    ctx.event.legId === ext.cLegId,
  handle: (ctx, ext) =>
    Effect.sync(() => {
      const cLegId = ext.cLegId
      if (cLegId === undefined) return undefined

      const body = sipfragFromStatus(408, "Request Timeout")
      const actions: RuleAction[] = [
        {
          type: "send-notify" as const,
          legId: ext.referrerLegId,
          event: "refer",
          subscriptionState: SUB_STATE_TERMINATED_TIMEOUT,
          contentType: "message/sipfrag;version=2.0",
          body,
        },
        { type: "add-cdr-event" as const, eventType: "timeout" as const, legId: cLegId, reason: "no_answer_timeout" },
        { type: "destroy-leg" as const, legId: cLegId },
        { type: "cancel-timer" as const, timerId: `refer_subscription_expiry-${ctx.callRef}` },
        { type: "cancel-timer" as const, timerId: `refer_overall_safety-${ctx.callRef}` },
      ]
      return { actions, clearCallExt: true }
    }),
})

// ── transfer-c-realign-200 ────────────────────────────────────────────────

transfer.rule({
  id: "transfer-c-realign-200",
  name: "C-leg 2xx to c-realign re-INVITE → phase a-realigning + re-INVITE A",
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "2xx",
    direction: "from-b",
    // C leg is confirmed when answering the c-realign re-INVITE —
    // distinguishes this from transfer-c-200-initial (trying/early).
    legState: "confirmed",
  },
  filter: (ctx, ext) =>
    ext.phase === "c-realigning" && ctx.sourceLeg.legId === ext.cLegId,
  handle: (ctx, ext) =>
    Effect.sync(() => {
      const cLegId = ext.cLegId
      if (cLegId === undefined) return undefined

      // Offer A the active SDP C just answered on the c-realign re-INVITE
      // (sendrecv, C's real port/codec) so A enables its send path. Using C's
      // initial held-INVITE answer here would leave A on inactive → one-way audio.
      const cRealignSdp = ctx.event.message.body

      const actions: RuleAction[] = [
        { type: "ack-leg" as const, legId: cLegId },
        {
          type: "cancel-timer" as const,
          timerId: `refer_reinvite_answer-${ctx.callRef}-${cLegId}`,
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
          bodyUpdate: cRealignSdp.byteLength > 0
            ? { kind: "set" as const, value: cRealignSdp }
            : { kind: "drop" as const },
        },
      ]
      return { actions, callExt: { ...ext, phase: "a-realigning" } }
    }),
})

// ── transfer-c-realign-fail ───────────────────────────────────────────────

transfer.rule({
  id: "transfer-c-realign-fail",
  name: "C-leg rejects c-realign re-INVITE → rollback",
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: ["4xx", "5xx", "6xx"],
    direction: "from-b",
    // C leg is confirmed when rejecting the c-realign re-INVITE —
    // distinguishes this from transfer-c-fail-initial (trying/early).
    legState: "confirmed",
  },
  filter: (ctx, ext) =>
    ext.phase === "c-realigning" && ctx.sourceLeg.legId === ext.cLegId,
  handle: (ctx, ext) =>
    Effect.sync(() => {
      const resp = ctx.event.message
      const cLegId = ext.cLegId

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
      return { actions }
    }),
})

// ── transfer-c-realign-timeout ────────────────────────────────────────────

transfer.rule({
  id: "transfer-c-realign-timeout",
  name: "c-realign re-INVITE timeout → rollback",
  match: {
    kind: "timer",
    timerType: "refer_reinvite_answer",
  },
  filter: (_ctx, ext) => ext.phase === "c-realigning",
  handle: (ctx, ext) =>
    Effect.sync(() => {
      const cLegId = ext.cLegId

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
      return { actions }
    }),
})

// ── transfer-c-glare-reinvite ────────────────────────────────────────────

transfer.rule({
  id: "transfer-c-glare-reinvite",
  name: "C-leg re-INVITE during realigning → 491",
  match: {
    kind: "request",
    method: "INVITE",
    direction: "from-b",
  },
  filter: (ctx, ext) =>
    isRealigning(ext.phase) && ctx.sourceLeg.legId === ext.cLegId,
  handle: () =>
    Effect.succeed({
      actions: [{ type: "respond" as const, status: 491, reason: "Request Pending" }],
    }),
})

// ── transfer-a-realign-200 ──────────────────────────────────────────────

transfer.rule({
  id: "transfer-a-realign-200",
  name: "A-leg 2xx to a-realign re-INVITE → merge(a, c), transfer complete",
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: "2xx",
    direction: "from-a",
  },
  filter: (ctx, ext) =>
    ext.phase === "a-realigning" && ctx.sourceLeg.legId === "a",
  handle: (ctx, ext) =>
    Effect.sync(() => {
      const cLegId = ext.cLegId
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
      ]
      return { actions, clearCallExt: true }
    }),
})

// ── transfer-a-realign-fail ─────────────────────────────────────────────

transfer.rule({
  id: "transfer-a-realign-fail",
  name: "A-leg rejects a-realign re-INVITE → rollback",
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: ["4xx", "5xx", "6xx"],
    direction: "from-a",
  },
  filter: (ctx, ext) =>
    ext.phase === "a-realigning" && ctx.sourceLeg.legId === "a",
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
      return { actions }
    }),
})

// ── transfer-a-realign-timeout ──────────────────────────────────────────

transfer.rule({
  id: "transfer-a-realign-timeout",
  name: "a-realign re-INVITE timeout → rollback",
  // Same timer type as transfer-c-realign-timeout; the phase filters keep the
  // two mutually exclusive at runtime (c-realigning vs a-realigning), so no
  // explicit ordering is needed — at most one accepts any given firing.
  match: {
    kind: "timer",
    timerType: "refer_reinvite_answer",
  },
  filter: (ctx, ext) =>
    ext.phase === "a-realigning" && ctx.event.legId === "a",
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
      return { actions }
    }),
})

// ── transfer-a-glare-reinvite ──────────────────────────────────────────

transfer.rule({
  id: "transfer-a-glare-reinvite",
  name: "A-leg re-INVITE during realigning → 491",
  match: {
    kind: "request",
    method: "INVITE",
    direction: "from-a",
  },
  filter: (_ctx, ext) => isRealigning(ext.phase),
  handle: () =>
    Effect.succeed({
      actions: [{ type: "respond" as const, status: 491, reason: "Request Pending" }],
    }),
})

// ── transfer-b-in-cre-are-reject ─────────────────────────────────────────

transfer.rule({
  id: "transfer-b-in-cre-are-reject",
  name: "Referrer B-leg non-BYE during realigning → 481",
  match: {
    kind: "request",
    direction: "from-b",
  },
  filter: (ctx, ext) =>
    isRealigning(ext.phase) &&
    ctx.sourceLeg.legId === ext.referrerLegId &&
    ctx.event.message.method !== "BYE",
  handle: () =>
    Effect.succeed({
      actions: [{ type: "respond" as const, status: 481, reason: "Call/Transaction Does Not Exist" }],
    }),
})

// ── transfer-overall-timeout ──────────────────────────────────────────────

transfer.rule({
  id: "transfer-overall-timeout",
  name: "Transfer overall-safety timer → rollback",
  match: {
    kind: "timer",
    timerType: "refer_overall_safety",
  },
  filter: (_ctx, ext) =>
    ext.phase === "refer-authorizing" ||
    ext.phase === "c-ringing" ||
    ext.phase === "c-realigning" ||
    ext.phase === "a-realigning",
  handle: (ctx, ext) =>
    Effect.sync(() => {
      const cLegId = ext.cLegId

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
      return { actions }
    }),
})

// ── Single export: the PolicyModule (ext-presence activation) ────────────

export const referTransfer = transfer.toPolicyModule()
