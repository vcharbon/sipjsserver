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
import { Duration, Effect, Exit } from "effect"
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
import type { HandlerResult, OutboundSipEffect } from "../../sip/SipRouter.js"
import { createBLegFromRoute, terminateCallEffects } from "../../b2bua/helpers.js"
import { classifyAdmission } from "../../b2bua/TargetAdmission.js"
import type { CallDecisionEngine } from "../CallDecisionEngine.js"
import type { NewCallResponse } from "../schemas/responses.js"

const buildAdmissionRejectResult = (
  call: Call,
  req: SipRequest,
  aLegContact: ContactSpec,
  rinfo: RemoteInfo,
  host: string,
): HandlerResult => {
  const rejectResp = generateResponse(req, 503, "Service Unavailable", {
    toTag: newTag(),
    contact: aLegContact,
  })
  const outbound: OutboundSipEffect[] = [{
    type: "send-sip",
    message: rejectResp,
    destination: { host: rinfo.address, port: rinfo.port },
    label: `reject 503 (admission: host=${host} not allow-listed)`,
    legId: "a",
  }]
  const term = terminateCallEffects(call)
  return {
    call,
    effects: { ...term, outbound },
    spanEvents: [{
      name: "route_decision",
      attributes: {
        "route.action": "error",
        "route.reason": "admission_reject",
        "route.host": host,
      },
    }],
  } satisfies HandlerResult
}

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

  // Strong invariant: a successful limiter INCR is matched by exactly one
  // DECR. On the happy path (call admitted) the DECR fires from the
  // terminate flow via InvariantEnforcer reading `Call.limiterEntries`.
  // On every error path BEFORE the call state is durably stamped with
  // those entries, this local list lets us roll the INCRs back eagerly
  // — either inside the rejection branch (limit-hit on a later iteration)
  // or via the outer `tapErrorCause` (defect / Cause-failure anywhere
  // after the INCR). Without this, an INCR'd entry that never makes it
  // onto the Call would leak the cluster counter (cause (2b) of the
  // 2026-05-15 cascade post-mortem, post-Stage-1 residual).
  const successfulIncrements: Array<{ limiterId: string; originWindow: number }> = []
  const eagerDecrement = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const e of successfulIncrements) {
        yield* limiter.decrement(e.limiterId, e.originWindow).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(config.limiterDecrementTimeoutMs),
            orElse: () =>
              Effect.logWarning(
                `applyRoute eager-DECR timed out for ${e.limiterId} ` +
                  `(${config.limiterDecrementTimeoutMs}ms)`,
              ),
          }),
          Effect.catchTag("RedisError", (re) =>
            Effect.logWarning(
              `applyRoute eager-DECR failed for ${e.limiterId}: ${re.reason}`,
            ),
          ),
        )
      }
    })

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
      const outbound: OutboundSipEffect[] = [{
        type: "send-sip",
        message: rejectResp,
        destination: { host: rinfo.address, port: rinfo.port },
        label: "reject 500 (adapter missing features)",
        legId: "a",
      }]
      const term = terminateCallEffects(args.call)
      return {
        call: args.call,
        effects: { ...term, outbound },
        spanEvents: [{
          name: "route_decision",
          attributes: { "route.action": "error", "route.reason": "missing_features" },
        }],
      } satisfies HandlerResult
    }

    // ── Admission: reject non-IP non-allow-listed destinations early ────
    // Catches the case where call-control returns a bogus host (e.g.
    // `kindlab` from a misconfigured fixture). Without this, the host
    // would flow to `dgram.send`, libuv's `getaddrinfo` would block for
    // ~5 s on EAI_AGAIN. The proxy's `BufferedUdpEndpoint` quarantines
    // that blocking; admission is the cheap-and-clear early filter.
    {
      const verdict = classifyAdmission(
        routing.destination.host,
        config.workerAllowedTargetSuffixes,
      )
      if (verdict === "reject") {
        yield* Effect.logWarning(
          `[admission] reject host=${routing.destination.host} reason=non-ip-non-suffixed callRef=${args.call.callRef}`,
        )
        return buildAdmissionRejectResult(
          args.call,
          req,
          aLegContact,
          rinfo,
          routing.destination.host,
        )
      }
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

    // ── Service ext descriptor → Call.ext (ADR-0016) ───────────────────────
    //
    // Write the adapter's `serviceExt` descriptor into the replicated
    // `Call.ext`, activating each service by ext-presence. For PEM, also derive
    // its slice from `strategy === "promote-pem-to-200"` so the existing
    // scenarios activate the service unchanged (PEM stays entangled with the
    // `relayFirst18xTo180` feature until that migrates). The seed is the
    // pre-promotion call-ext (Encoded == decoded for these boolean fields).
    {
      const serviceExt: Record<string, unknown> = { ...(routing.serviceExt ?? {}) }
      if (strategy === "promote-pem-to-200") {
        serviceExt["promote-pem"] = { promoted: false, windowOpen: false }
      } else if (strategy !== undefined) {
        // drop-sdp / keep-sdp / fake-prack — seed the relayFirst18x service.
        serviceExt["relayFirst18x"] = { strategy, firstRelayed: false }
      }
      if (Object.keys(serviceExt).length > 0) {
        updated = { ...updated, ext: { ...updated.ext, ...serviceExt } }
      }
    }

    // ── Limiter acquisition ────────────────────────────────────────────────
    // Typed channels (see CallLimiter.LimiterDecision / LimiterBackendError):
    //   - success channel: `Allowed` or `Rejected` (both normal outcomes)
    //   - error channel:   `RedisError` (ioredis surfaced an error within
    //                      its 100 ms commandTimeout) or `LimiterTimeout`
    //                      (outer Effect-level 150 ms safety net fired).
    // Both error arms map to a fail-open admission tagged
    // `incrementSucceeded: false`. The cleanup paths (force-purge,
    // rule-path decrement) MUST skip the matching DECR for those entries
    // — otherwise the counter drifts negative (cause (2b) in the plan).
    type LimiterAdmission =
      | { readonly _tag: "Admitted"; readonly currentWindow: number; readonly incrementSucceeded: boolean }
      | { readonly _tag: "RejectedByLimiter" }
    const limiterEntries: Array<{ limiterId: string; limit: number; originWindow: number; incrementSucceeded: boolean }> = []
    if (routing.call_limiter) {
      for (const entry of routing.call_limiter) {
        const admission = yield* limiter.checkAndIncrement(entry.id, entry.limit).pipe(
          Effect.map((d): LimiterAdmission =>
            d._tag === "Allowed"
              ? { _tag: "Admitted", currentWindow: d.currentWindow, incrementSucceeded: true }
              : { _tag: "RejectedByLimiter" },
          ),
          Effect.catchTags({
            RedisError: (e) =>
              Effect.logWarning(`limiter ${entry.id} unavailable: ${e.reason}`).pipe(
                Effect.as<LimiterAdmission>({ _tag: "Admitted", currentWindow: 0, incrementSucceeded: false }),
              ),
            LimiterTimeout: (e) =>
              Effect.logWarning(`limiter ${entry.id} timed out (${e.budgetMs}ms)`).pipe(
                Effect.as<LimiterAdmission>({ _tag: "Admitted", currentWindow: 0, incrementSucceeded: false }),
              ),
          }),
        )
        if (admission._tag === "RejectedByLimiter") {
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
              // Same admission gate as the main route — applied to the
              // failover destination separately.
              const failoverVerdict = classifyAdmission(
                failureResp.destination.host,
                config.workerAllowedTargetSuffixes,
              )
              if (failoverVerdict === "reject") {
                yield* Effect.logWarning(
                  `[admission] reject host=${failureResp.destination.host} reason=non-ip-non-suffixed callRef=${args.call.callRef} path=failover`,
                )
                // Eager DECR — failover-admission-reject won't pin the
                // successful prior INCRs to a persisted call.
                yield* eagerDecrement()
                return buildAdmissionRejectResult(
                  args.call,
                  req,
                  aLegContact,
                  rinfo,
                  failureResp.destination.host,
                )
              }
              // Failover: skip this limiter and try a different route.
              // aLegInvite is already populated at call creation (SipRouter) —
              // we just thread the callback context through.
              // Carry prior successful INCRs onto the failover call so
              // they DECR on terminate (the iff invariant: any INCR
              // recorded is matched by exactly one DECR).
              const failoverCall: Call = {
                ...args.call,
                callbackContext: failureResp.callback_context ?? routing.callback_context,
                limiterEntries,
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
                effects: { ...bLegResult.effects, outbound: bLegResult.outbound },
              } satisfies HandlerResult
            }
          }

          // No failover available — 486 Busy Here.
          // Attach prior successful INCRs as limiterEntries on the
          // rejected call so `terminateCallEffects` emits a
          // decrement-limiter for each. The current entry (the one that
          // returned `Rejected`) is NOT included — its INCR never landed.
          const rejectResp = generateResponse(req, 486, "Busy Here", {
            toTag: newTag(),
            contact: aLegContact,
          })
          const rejected = addCdrEvent({ ...args.call, limiterEntries }, {
            type: "reject",
            timestamp: nowMs,
            legId: "a",
            statusCode: 486,
            reason: "limiter",
          })
          const rejectOutbound: OutboundSipEffect[] = [{
            type: "send-sip",
            message: rejectResp,
            destination: { host: rinfo.address, port: rinfo.port },
            label: "reject 486 (limiter)",
            legId: "a",
          }]
          const rejectEffects = terminateCallEffects(rejected)
          return {
            call: rejected,
            effects: { ...rejectEffects, outbound: rejectOutbound },
          } satisfies HandlerResult
        }
        // Track the successful INCR for the eager-DECR safety net BEFORE
        // pushing onto `limiterEntries` — the call state may never be
        // durably stamped if the post-loop body fails/defects (Path 3 in
        // the cascade-fix plan). `successfulIncrements` is the canonical
        // record for that rollback.
        if (admission.incrementSucceeded) {
          successfulIncrements.push({
            limiterId: entry.id,
            originWindow: admission.currentWindow,
          })
        }
        limiterEntries.push({
          limiterId: entry.id,
          limit: entry.limit,
          originWindow: admission.currentWindow,
          incrementSucceeded: admission.incrementSucceeded,
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
      effects: { ...bLegResult.effects, outbound: bLegResult.outbound },
      spanEvents: [{
        name: "route_decision",
        attributes: {
          "route.action": "route",
          "route.destination": `${destination.host}:${destination.port}`,
        },
      }],
    } satisfies HandlerResult
  }).pipe(
    // Path 3 — any non-success exit (Cause-level failure, defect, fiber
    // interrupt) after a successful INCR would leave Redis incremented
    // but the call state never durably stamped with `limiterEntries`.
    // Eager-DECR every successful INCR before the failure propagates.
    // `Effect.onExit` does not swallow the cause — it just runs the
    // finalizer and then re-emits the same exit. `successfulIncrements`
    // is the canonical record (only entries with
    // `incrementSucceeded === true`); fail-open admissions are never
    // pushed there and so are never DECR'd.
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? eagerDecrement() : Effect.void,
    ),
  )
}
