/**
 * InitialInviteHandler — handles the first INVITE for a new call.
 *
 * Calls the routing API, creates the b-leg, schedules no-answer timer.
 * Returns a HandlerResult — pure data, no side effects.
 */

import { Effect } from "effect"
import type { SipHeader, SipRequest } from "../sip/types.js"
import type { HandlerResult, OutboundEnvelope, Handler } from "../sip/SipRouter.js"
import {
  getHeader,
  getHeaders,
  newTag,
} from "../sip/MessageHelpers.js"
import { generateResponse } from "../sip/generators.js"
import { addCdrEvent } from "../call/CallModel.js"
import { terminateCallEffects } from "./helpers.js"
import { buildCallContact } from "./stack-identity.js"
import { applyRoute } from "../decision/apply/applyRoute.js"

/**
 * Translate a `NewCallRejectResponse.update_headers` map into a flat
 * `SipHeader[]` for {@link generateResponse}'s `extraHeaders` slot. On
 * the reject path there is no called-side response to merge with, so
 * `null`-valued entries are no-ops (nothing to delete) — silently
 * dropped, matching the plan's stated semantic for Issue 9.
 */
function rejectExtraHeaders(
  updates: Record<string, string | null> | undefined,
): SipHeader[] {
  if (updates === undefined) return []
  const out: SipHeader[] = []
  for (const [name, value] of Object.entries(updates)) {
    if (value === null) continue
    out.push({ name, value })
  }
  return out
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract SIP headers as a flat record for the call control request. */
function extractSipHeaders(req: SipRequest): Record<string, string> {
  const result: Record<string, string> = {}
  for (const h of req.headers) {
    const name = h.name.toLowerCase()
    // Skip standard headers already sent as top-level fields
    if (name === "from" || name === "to" || name === "via" || name === "contact" ||
        name === "content-type" || name === "call-id" || name === "cseq" ||
        name === "max-forwards" || name === "content-length") continue
    result[h.name] = h.value
  }
  return result
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleInitialInvite: Handler = (ctx) =>
  Effect.gen(function* () {
    const { call, callRef, event, config, nowMs } = ctx

    if (event.type !== "sip" || event.message.type !== "request") {
      return { call, outbound: [], effects: [] } satisfies HandlerResult
    }

    const req = event.message
    const rinfo = event.rinfo

    // Contact for UAS responses we emit toward the a-leg peer.
    // B2BUA a-leg identity: leg="a", callRef stamped for inbound routing.
    const aLegContact = buildCallContact({
      localIp: config.sipLocalIp,
      localPort: config.sipLocalPort,
      callRef,
      leg: "a",
      isEmergency: call.emergency === true,
    })

    // Call external call control API for routing decision
    const newCallReq = {
      call_id: call.aLeg.callId,
      ruri: req.uri,
      from: getHeader(req.headers, "from") ?? "",
      to: getHeader(req.headers, "to") ?? "",
      via: getHeaders(req.headers, "via"),
      contact: getHeader(req.headers, "contact"),
      content_type: getHeader(req.headers, "content-type"),
      sip_headers: extractSipHeaders(req),
    }

    const routing = yield* ctx.callControl.newCall(newCallReq).pipe(
      // Adapter already logged + metric'd the failure. Fall through to the
      // `routing === undefined` branch below to emit 503.
      Effect.catchTag("CallDecisionError", () => Effect.void),
    )

    // Call control unavailable — reject 503
    if (routing === undefined) {
      const rejectResp = generateResponse(req, 503, "Service Unavailable", {
        toTag: newTag(),
        contact: aLegContact,
      })
      const outbound: OutboundEnvelope[] = [{
        message: rejectResp,
        destination: { host: rinfo.address, port: rinfo.port },
        label: "reject 503 (call control unavailable)",
        legId: "a",
      }]
      return {
        call, outbound, effects: terminateCallEffects(call),
        spanEvents: [{ name: "route_decision", attributes: { "route.action": "error", "route.reason": "call_control_unavailable" } }],
      } satisfies HandlerResult
    }

    // Rejected by routing
    if (routing.action === "reject") {
      const code = routing.reject_code
      const reason = routing.reject_reason ?? "Rejected"
      yield* Effect.logDebug(`Call ${callRef} rejected by call control: ${code} ${reason}`)
      const extraHeaders = rejectExtraHeaders(
        routing.update_headers as Record<string, string | null> | undefined,
      )
      // Consumer-supplied Contact (e.g. on a 302 redirect) should
      // override the B2BUA's a-leg contact — pass `contact: undefined`
      // when the consumer authored their own.
      const consumerContact = extraHeaders.some((h) => h.name.toLowerCase() === "contact")
      const responseOpts: Parameters<typeof generateResponse>[3] = consumerContact
        ? { toTag: newTag(), extraHeaders }
        : { toTag: newTag(), contact: aLegContact, extraHeaders }
      const rejectResp = generateResponse(req, code, reason, responseOpts)
      const outbound: OutboundEnvelope[] = [{
        message: rejectResp,
        destination: { host: rinfo.address, port: rinfo.port },
        label: `reject ${code}`,
        legId: "a",
      }]
      const updated = addCdrEvent(call, { type: "reject", timestamp: nowMs, legId: "a", statusCode: code, reason })
      return {
        call: updated, outbound, effects: terminateCallEffects(updated),
        spanEvents: [{ name: "route_decision", attributes: { "route.action": "reject", "route.reject_code": code, "route.reject_reason": reason } }],
      } satisfies HandlerResult
    }

    // action === "route" — delegate post-HTTP shaping (features, policy
    // header merge, limiter acquisition, failover fallback, b-leg creation)
    // to the decision/apply module.
    return yield* applyRoute({
      routing,
      call,
      req,
      aLegContact,
      rinfo,
      nowMs,
      config,
      callControl: ctx.callControl,
      limiter: ctx.limiter,
    })
  })
