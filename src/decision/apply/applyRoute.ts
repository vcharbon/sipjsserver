/**
 * applyRoute — post-HTTP shaping for a successful `/call/new` routing decision
 * (SplitServiceLogic.md §B.5).
 *
 * The `InitialInviteHandler` used to inline:
 *   - synthesise `FeatureActivations` from the vendor flat flags
 *   - merge `relay_first_18x_to_180` → policy-level header overrides
 *   - acquire every `call_limiter` entry, fall back to `/call/failure` on a
 *     limiter rejection, otherwise emit 486
 *   - call `createBLegFromRoute` to spawn the b-leg INVITE
 *
 * That mix of orchestration belongs in the decision layer, not the handler.
 * The handler is reduced to: parse INVITE → build canonical request → call
 * engine → validate → `applyRoute` → assemble `HandlerResult`.
 *
 * This module returns a fully-assembled `HandlerResult` — outbound messages,
 * side effects, span events, and the updated `Call`. It never throws on a
 * limiter miss: it always yields a concrete HandlerResult (either failover
 * b-leg, or 486 reject).
 */
import { Effect } from "effect"
import type { Call } from "../../call/CallModel.js"
import { addCdrEvent } from "../../call/CallModel.js"
import type { CallLimiter } from "../../call/CallLimiter.js"
import type { AppConfigData } from "../../config/AppConfig.js"
import { newTag } from "../../sip/MessageHelpers.js"
import { getHeader } from "../../sip/MessageHelpers.js"
import { splitTopLevelCommas } from "../../sip/parsers/custom/structured-headers.js"
import { generateResponse } from "../../sip/generators.js"
import type { ContactSpec } from "../../sip/generators.js"
import type { RemoteInfo, SipRequest } from "../../sip/types.js"
import type { HandlerResult, OutboundEnvelope } from "../../sip/SipRouter.js"
import { createBLegFromRoute, terminateCallEffects } from "../../b2bua/helpers.js"
import type { CallDecisionEngine } from "../CallDecisionEngine.js"
import type { NewCallResponse } from "../schemas/responses.js"

type NewCallRouteResponse = Extract<NewCallResponse, { action: "route" }>

export interface ApplyRouteArgs {
  readonly routing: NewCallRouteResponse
  readonly call: Call
  readonly req: SipRequest
  /** Contact spec to stamp on any B2BUA-generated UAS response (e.g. 486). */
  readonly aLegContact: ContactSpec
  /** Source address of the inbound INVITE — used when emitting a 486 back. */
  readonly rinfo: RemoteInfo
  readonly nowMs: number
  readonly config: AppConfigData
  readonly callControl: CallDecisionEngine["Service"]
  readonly limiter: CallLimiter["Service"]
}

export function applyRoute(
  args: ApplyRouteArgs,
): Effect.Effect<HandlerResult, never, never> {
  const { routing, req, aLegContact, rinfo, nowMs, config, callControl, limiter } = args
  const destination = {
    host: routing.destination.host,
    port: routing.destination.port ?? 5060,
  }

  return Effect.gen(function* () {
    // ── Feature activations ────────────────────────────────────────────────
    //
    // The adapter is responsible for producing canonical `features` by
    // translating whatever vendor-flat fields it decoded (B.7). We attach
    // them verbatim. If an adapter omits `features` (e.g. a vendor that
    // returns only a legacy flat payload), fail loudly — a platform
    // without a keepalive / maxDuration guard is unsafe.
    if (routing.features === undefined) {
      yield* Effect.logError(
        `Adapter returned a routing decision without features — refusing to proceed (callRef=${args.call.callRef})`,
      )
      const rejectResp = generateResponse(req, 500, "Server Internal Error", {
        toTag: newTag(),
        contact: aLegContact,
      })
      return {
        call: args.call,
        outbound: [{
          message: rejectResp,
          destination: { host: rinfo.address, port: rinfo.port },
          label: "reject 500 (adapter missing features)",
          legId: "a",
        }] as OutboundEnvelope[],
        effects: terminateCallEffects(args.call),
        spanEvents: [{
          name: "route_decision",
          attributes: { "route.action": "error", "route.reason": "missing_features" },
        }],
      } satisfies HandlerResult
    }

    let updated: Call = { ...args.call, features: routing.features }

    // ── 18x-relay → strategy-aware Supported: 100rel handling ──────────────
    //
    // drop-sdp / keep-sdp: strip 100rel from Supported. We don't relay PRACK
    //   in those strategies and Alice was never told to expect 100rel, so
    //   forcing Bob off reliable provisional avoids a hung handshake.
    //
    // fake-prack with Alice SDP: keep 100rel intact — we want Bob to use
    //   reliable provisional so we can originate PRACK locally and cache
    //   Bob's SDP per-dialog.
    //
    // fake-prack with no Alice SDP (delayed offer): strip 100rel. The policy
    //   module self-disables in this case; falling back to standard relay
    //   without 100rel avoids us silently keeping a half-active state.
    //
    // promote-pem-to-200 with Alice SDP: keep 100rel — Bob may flag the
    //   183+PEM as reliable, and the policy module originates PRACK locally
    //   the same way fake-prack does.
    const strategy = routing.features.relayFirst18xTo180?.strategy
    if (strategy !== undefined) {
      const ct = getHeader(req.headers, "content-type") ?? ""
      const aliceHasSdp =
        req.body.byteLength > 0 && ct.toLowerCase().includes("application/sdp")
      const keep100Rel =
        (strategy === "fake-prack" || strategy === "promote-pem-to-200") && aliceHasSdp
      if (!keep100Rel) {
        const supported = getHeader(req.headers, "supported")
        if (supported) {
          const tokens = splitTopLevelCommas(supported)
            .filter((t) => t.toLowerCase() !== "100rel")
          updated = {
            ...updated,
            policyUpdateHeaders: {
              ...(updated.policyUpdateHeaders as Record<string, string | null> ?? {}),
              Supported: tokens.length > 0 ? tokens.join(", ") : null,
            },
          }
        }
      }
    }

    // ── Limiter acquisition ────────────────────────────────────────────────
    const limiterEntries: Array<{ limiterId: string; limit: number; originWindow: number }> = []
    if (routing.call_limiter) {
      for (const entry of routing.call_limiter) {
        const result = yield* limiter.checkAndIncrement(entry.id, entry.limit).pipe(
          Effect.catchTag("RedisError", (e) =>
            Effect.logError(`Failed to acquire limiter ${entry.id}: ${e.reason}`).pipe(
              Effect.as(undefined as { allowed: boolean; currentWindow: number } | undefined),
            ),
          ),
        )
        if (result === undefined) continue
        if (!result.allowed) {
          yield* Effect.logDebug(`Call ${args.call.callRef} rejected by limiter ${entry.id}`)

          // Try /call/failure for potential failover.
          if (routing.callback_context !== undefined) {
            const failureResp = yield* callControl.callFailure({
              call_id: args.call.aLeg.callId,
              callback_context: routing.callback_context,
              failure: { origin: "call_limiter" as const, limiter_id: entry.id },
            }).pipe(
              Effect.catchTag("CallDecisionError", () => Effect.void),
            )

            if (failureResp !== undefined && failureResp.action === "failover") {
              // Failover: skip this limiter and try a different route.
              // aLegInvite is already populated at call creation (SipRouter) —
              // we just thread the callback context through.
              const failoverCall: Call = {
                ...args.call,
                callbackContext: failureResp.callback_context ?? routing.callback_context,
              }
              const bLegResult = createBLegFromRoute({
                call: failoverCall,
                baseInvite: req,
                route: {
                  destination: {
                    host: failureResp.destination.host,
                    port: failureResp.destination.port ?? 5060,
                  },
                  new_ruri: failureResp.new_ruri,
                  update_headers: failureResp.update_headers as Record<string, string | null> | undefined,
                  no_answer_timeout_sec: failureResp.no_answer_timeout_sec,
                  callback_context: failureResp.callback_context,
                },
                config,
                nowMs,
              })
              for (const w of bLegResult.warnings) {
                yield* Effect.logWarning(`[update_headers/failover ${args.call.callRef}] ${w}`)
              }
              yield* Effect.logDebug(
                `Failover after limiter rejection: creating ${bLegResult.call.bLegs[0]?.legId}`,
              )
              return {
                call: bLegResult.call,
                outbound: bLegResult.outbound,
                effects: bLegResult.effects,
              } satisfies HandlerResult
            }
          }

          // No failover available — 486 Busy Here.
          const rejectResp = generateResponse(req, 486, "Busy Here", {
            toTag: newTag(),
            contact: aLegContact,
          })
          const rejected = addCdrEvent(args.call, {
            type: "reject",
            timestamp: nowMs,
            legId: "a",
            statusCode: 486,
            reason: "limiter",
          })
          return {
            call: rejected,
            outbound: [{
              message: rejectResp,
              destination: { host: rinfo.address, port: rinfo.port },
              label: "reject 486 (limiter)",
              legId: "a",
            }] as OutboundEnvelope[],
            effects: terminateCallEffects(rejected),
          } satisfies HandlerResult
        }
        limiterEntries.push({
          limiterId: entry.id,
          limit: entry.limit,
          originWindow: result.currentWindow,
        })
      }
      updated = { ...updated, limiterEntries }
    }

    // ── Create the b-leg ──────────────────────────────────────────────────
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

    for (const w of bLegResult.warnings) {
      yield* Effect.logWarning(`[update_headers/route ${args.call.callRef}] ${w}`)
    }
    yield* Effect.logDebug(
      `New call: callRef=${args.call.callRef} a-leg=${args.call.aLeg.callId} -> b-leg=${bLegResult.call.bLegs[0]?.callId}`,
    )

    return {
      call: bLegResult.call,
      outbound: bLegResult.outbound,
      effects: bLegResult.effects,
      spanEvents: [{
        name: "route_decision",
        attributes: {
          "route.action": "route",
          "route.destination": `${destination.host}:${destination.port}`,
        },
      }],
    } satisfies HandlerResult
  })
}
