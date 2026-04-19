/**
 * InitialInviteHandler — handles the first INVITE for a new call.
 *
 * Calls the routing API, creates the b-leg, schedules no-answer timer.
 * Returns a HandlerResult — pure data, no side effects.
 */

import { Effect } from "effect"
import type { SipRequest } from "../sip/types.js"
import type { HandlerResult, OutboundEnvelope, Handler } from "../sip/SipRouter.js"
import {
  getHeader,
  getHeaders,
  newTag,
} from "../sip/MessageHelpers.js"
import { generateResponse } from "../sip/generators.js"
import { addCdrEvent } from "../call/CallModel.js"
import { terminateCallEffects, createBLegFromRoute } from "./helpers.js"
import { buildCallContact } from "./stack-identity.js"

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
      Effect.catchTag("CallControlError", (e) =>
        Effect.logError(`Call control API failed: ${e.reason}`).pipe(
          Effect.as(undefined as undefined)
        )
      )
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
      const rejectResp = generateResponse(req, code, reason, {
        toTag: newTag(),
        contact: aLegContact,
      })
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

    // action === "route"
    const destination = { host: routing.destination.host, port: routing.destination.port ?? 5060 }

    // Acquire limiters before creating b-leg.
    // Emergency exemption is enforced by the HTTP backend (it simply omits
    // call_limiter for emergency calls). The SIP stack always applies any
    // limiters the backend returned — emergency handling at this layer is
    // limited to Tier 3 / dispatcher / `;emerg=1` plumbing.
    let updated = call

    // ── Policy flags from routing response ──
    if (routing.relay_first_18x_to_180) {
      updated = { ...updated, policies: { ...updated.policies, relayFirst18xTo180: true } }

      // Strip "100rel" token from Supported header for b-leg INVITE.
      // This prevents the far side from offering reliable provisionals,
      // which we cannot relay when transforming 18x → bare 180.
      const supported = getHeader(req.headers, "supported")
      if (supported) {
        const tokens = supported.split(",").map(t => t.trim())
          .filter(t => t.toLowerCase() !== "100rel")
        updated = {
          ...updated,
          policyUpdateHeaders: {
            ...(updated.policyUpdateHeaders as Record<string, string | null> ?? {}),
            Supported: tokens.length > 0 ? tokens.join(", ") : null,
          },
        }
      }
    }
    const limiterEntries: Array<{ limiterId: string; limit: number; originWindow: number }> = []
    if (routing.call_limiter) {
      for (const entry of routing.call_limiter) {
        const result = yield* ctx.limiter.checkAndIncrement(entry.id, entry.limit).pipe(
          Effect.catchTag("RedisError", (e) =>
            Effect.logError(`Failed to acquire limiter ${entry.id}: ${e.reason}`).pipe(
              Effect.as(undefined as { allowed: boolean; currentWindow: number } | undefined)
            )
          )
        )
        if (result === undefined) continue
        if (!result.allowed) {
          yield* Effect.logDebug(`Call ${callRef} rejected by limiter ${entry.id}`)

          // Try /call/failure for potential failover
          if (routing.callback_context !== undefined) {
            const failureResp = yield* ctx.callControl.callFailure({
              call_id: call.aLeg.callId,
              callback_context: routing.callback_context,
              failure: { origin: "call_limiter" as const, limiter_id: entry.id }
            }).pipe(
              Effect.catchTag("CallControlError", (e) =>
                Effect.logError(`/call/failure failed: ${e.reason}`).pipe(
                  Effect.as(undefined as undefined)
                )
              )
            )

            if (failureResp !== undefined && failureResp.action === "failover") {
              // Failover: skip this limiter and try a different route.
              // aLegInvite is already set at call creation (SipRouter) — we just
              // need to thread the callback context through.
              let failoverCall = { ...call, callbackContext: failureResp.callback_context ?? routing.callback_context }
              const bLegResult = createBLegFromRoute({
                call: failoverCall,
                baseInvite: req,
                route: {
                  destination: { host: failureResp.destination.host, port: failureResp.destination.port ?? 5060 },
                  new_ruri: failureResp.new_ruri,
                  update_headers: failureResp.update_headers as Record<string, string | null> | undefined,
                  no_answer_timeout_sec: failureResp.no_answer_timeout_sec,
                  callback_context: failureResp.callback_context,
                },
                config,
                nowMs,
              })
              yield* Effect.logDebug(`Failover after limiter rejection: creating ${bLegResult.call.bLegs[0]?.legId}`)
              return bLegResult satisfies HandlerResult
            }
          }

          const rejectResp = generateResponse(req, 486, "Busy Here", {
            toTag: newTag(),
            contact: aLegContact,
          })
          const rejected = addCdrEvent(call, { type: "reject", timestamp: nowMs, legId: "a", statusCode: 486, reason: "limiter" })
          return {
            call: rejected,
            outbound: [{ message: rejectResp, destination: { host: rinfo.address, port: rinfo.port }, label: "reject 486 (limiter)", legId: "a" }],
            effects: terminateCallEffects(rejected)
          } satisfies HandlerResult
        }
        limiterEntries.push({ limiterId: entry.id, limit: entry.limit, originWindow: result.currentWindow })
      }
      updated = { ...updated, limiterEntries }
    }

    // aLegInvite already populated at call creation (SipRouter) — no-op here.

    // Create b-leg using shared helper
    const bLegResult = createBLegFromRoute({
      call: updated,
      baseInvite: req,
      route: {
        destination,
        new_ruri: routing.new_ruri,
        update_headers: routing.update_headers as Record<string, string | null> | undefined,
        no_answer_timeout_sec: routing.no_answer_timeout_sec,
        callback_context: routing.callback_context,
      },
      config,
      nowMs,
    })

    yield* Effect.logDebug(`New call: callRef=${callRef} a-leg=${call.aLeg.callId} -> b-leg=${bLegResult.call.bLegs[0]?.callId}`)

    return {
      call: bLegResult.call, outbound: bLegResult.outbound, effects: bLegResult.effects,
      spanEvents: [{ name: "route_decision", attributes: { "route.action": "route", "route.destination": `${destination.host}:${destination.port}` } }],
    } satisfies HandlerResult
  })
