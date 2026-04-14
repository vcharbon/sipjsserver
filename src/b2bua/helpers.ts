/**
 * Shared B2BUA helpers — canonical cleanup effects, b-leg creation for failover.
 */

import type { Call, Leg, TimerEntry } from "../call/CallModel.js"
import { addBLeg, addCdrEvent, randomInitialCSeq } from "../call/CallModel.js"
import type { SideEffect, OutboundEnvelope } from "../sip/SipRouter.js"
import type { SipRequest } from "../sip/types.js"
import type { AppConfigData } from "../config/AppConfig.js"
import { buildBLegInvite, extractNameAddrUri, newTag, stripTag } from "../sip/MessageFactory.js"
import { generateBLegCallId } from "../cluster/HashUtils.js"

// ---------------------------------------------------------------------------
// Canonical cleanup effects — used by ALL call termination paths
// ---------------------------------------------------------------------------

/**
 * Available SideEffect types (defined in SipRouter.ts, executed in this order by withCall):
 *   1. schedule-timer    — schedule a TimerEntry to fire later
 *   2. cancel-timer      — cancel a specific timer by ID (e.g. `no-answer-{callRef}-{legId}`)
 *   3. cancel-all-timers — cancel every timer for the call
 *   4. decrement-limiter — release a limiter slot (limiterId + window)
 *   5. write-cdr         — flush CDR events to the writer
 *   6. flush-redis       — persist call state changes to Redis
 *   7. remove-call       — delete the call from state (must be last)
 */

/**
 * Returns the FULL canonical list of side effects for immediate call termination.
 * Used by termination paths that skip the "terminating" state because no
 * outstanding BYE transactions need resolution:
 *   - Initial INVITE rejection (503/486)
 *   - Transaction timeout (far side already unresponsive 32s)
 *   - B-leg INVITE failure without failover (4xx/5xx/6xx, no BYE was sent)
 *
 * Paths that send outbound BYEs should use beginTerminationEffects() instead
 * and defer final cleanup to finalCleanupEffects() when all legs resolve.
 */
export function terminateCallEffects(call: Call): SideEffect[] {
  return [
    { type: "cancel-all-timers" },
    ...call.limiterEntries.map((e) => ({
      type: "decrement-limiter" as const,
      limiterId: e.limiterId,
      window: e.originWindow
    })),
    { type: "write-cdr" },
    { type: "remove-call" }
  ]
}

/**
 * Effects for entering the "terminating" state — BYE(s) have been sent,
 * waiting for far-side responses. Call stays in memory and Redis.
 *
 * Cancels all timers (except the terminating_timeout safety net, which
 * the caller schedules separately), writes CDR, and flushes to Redis
 * so the terminating state survives a crash.
 *
 * Does NOT remove the call or decrement limiters — those happen in
 * finalCleanupEffects() when all legs are resolved.
 *
 * @param callRef - needed to build the terminating_timeout timer ID
 * @param nowMs - current wall-clock time for timer fireAt
 */
export function beginTerminationEffects(callRef: string, nowMs: number): SideEffect[] {
  // 64s = 2× RFC 3261 Timer B/F (32s). Gives plenty of margin for the
  // far side to respond to our BYE before we force-clean.
  const TERMINATING_TIMEOUT_MS = 64_000
  const safetyTimer: TimerEntry = {
    id: `terminating-timeout-${callRef}`,
    type: "terminating_timeout",
    fireAt: nowMs + TERMINATING_TIMEOUT_MS,
  }
  return [
    { type: "cancel-all-timers" },
    { type: "write-cdr" },
    { type: "schedule-timer", timer: safetyTimer },
    { type: "flush-redis" },
  ]
}

/**
 * Effects for final call cleanup after all legs are resolved (all
 * byeDispositions are terminal). The call transitions from "terminating"
 * to "terminated" and is removed from memory and Redis.
 *
 * Also decrements limiters — deferred to this point so that a call in
 * "terminating" state still holds its limiter slot until fully cleaned up.
 */
export function finalCleanupEffects(call: Call): SideEffect[] {
  return [
    { type: "cancel-all-timers" },
    ...call.limiterEntries.map((e) => ({
      type: "decrement-limiter" as const,
      limiterId: e.limiterId,
      window: e.originWindow
    })),
    { type: "remove-call" },
  ]
}

// ---------------------------------------------------------------------------
// B-leg creation helper — used for initial routing and failover
// ---------------------------------------------------------------------------

export interface RouteParams {
  readonly destination: { readonly host: string; readonly port: number }
  readonly new_ruri?: string | undefined
  readonly update_headers?: Record<string, string | null> | undefined
  readonly no_answer_timeout_sec?: number | undefined
  readonly call_limiter?: ReadonlyArray<{ readonly id: string; readonly limit: number }> | undefined
  readonly callback_context?: string | undefined
}

/** Options for creating a new b-leg. */
export interface CreateBLegOptions {
  readonly call: Call
  /** Base INVITE to clone for the outbound b-leg INVITE. When undefined,
   *  the b-leg Leg entry is created but no INVITE is sent (used when
   *  the rule engine defers sending). */
  readonly baseInvite: SipRequest | undefined
  readonly route: RouteParams
  readonly config: AppConfigData
  readonly nowMs: number
}

/**
 * Create a new b-leg from routing parameters.
 * Returns the updated call, outbound INVITE envelope (if baseInvite provided),
 * and side effects (timer + flush).
 *
 * Single source of truth for b-leg creation — used by InitialInviteHandler
 * (first b-leg), limiter failover, and the rule engine's create-leg action.
 */
export function createBLegFromRoute(
  opts: CreateBLegOptions
): { call: Call; outbound: OutboundEnvelope[]; effects: SideEffect[] } {
  const { call, baseInvite, route, config, nowMs } = opts
  const legNumber = call.bLegs.length + 1
  const legId = `b-${legNumber}`
  const bLegFromTag = newTag()

  const bLegCallId = config.workerIndex >= 0
    ? generateBLegCallId(legNumber, config.workerIndex, config.clusterWorkers, config.sipLocalIp)
    : `${legNumber}-${call.aLeg.callId}`

  const initialCSeq = randomInitialCSeq()

  // RFC 3261 §12.2.1.1: track local/remote URIs for in-dialog header construction
  // B2BUA is UAC on b-leg: localUri = From URI (Alice's identity), remoteUri = To URI (callee)
  const requestUri = route.new_ruri ?? baseInvite?.uri
  const bLeg: Leg = {
    legId,
    callId: bLegCallId,
    fromTag: bLegFromTag,
    source: { address: config.sipLocalIp, port: config.sipLocalPort },
    state: "trying",
    disposition: "pending",
    dialogs: [],
    noAnswerTimeoutSec: route.no_answer_timeout_sec ?? config.noAnswerTimeoutSec,
    initialCSeq,
    localUri: extractNameAddrUri(stripTag(call.aLegFrom)),
    remoteUri: extractNameAddrUri(stripTag(call.aLegTo)),
    // RFC 3261 §9.1: CANCEL must copy Request-URI from original INVITE
    inviteRequestUri: requestUri,
  }

  const outbound: OutboundEnvelope[] = []

  if (baseInvite !== undefined) {
    // Merge policy-level header overrides (e.g. strip 100rel from Supported)
    // with route-level overrides. Route headers take precedence.
    const mergedHeaders: Record<string, string | null> | undefined =
      (call.policyUpdateHeaders || route.update_headers)
        ? { ...(call.policyUpdateHeaders as Record<string, string | null> ?? {}),
            ...(route.update_headers as Record<string, string | null> ?? {}) }
        : undefined

    const bLegInvite = buildBLegInvite(
      baseInvite,
      bLegCallId,
      bLegFromTag,
      route.new_ruri,
      mergedHeaders,
      initialCSeq
    )

    outbound.push({
      message: bLegInvite,
      destination: route.destination,
      label: `send ${legId} INVITE`,
      legId,
    })
  }

  let updated = addBLeg(call, bLeg)
  updated = addCdrEvent(updated, { type: "invite_sent", timestamp: nowMs, legId })

  if (route.callback_context !== undefined) {
    updated = { ...updated, callbackContext: route.callback_context }
  }

  const noAnswerTimeout = route.no_answer_timeout_sec ?? config.noAnswerTimeoutSec
  const noAnswerTimer: TimerEntry = {
    id: `no-answer-${call.callRef}-${legId}`,
    type: "no_answer",
    fireAt: nowMs + noAnswerTimeout * 1000,
    legId
  }
  updated = { ...updated, timers: [...updated.timers, noAnswerTimer] }

  const effects: SideEffect[] = [
    { type: "schedule-timer", timer: noAnswerTimer },
    { type: "flush-redis" }
  ]

  return { call: updated, outbound, effects }
}
