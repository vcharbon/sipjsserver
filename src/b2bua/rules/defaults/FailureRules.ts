/**
 * Failure rules — route-failure, no-answer-failover.
 *
 * Handle b-leg failures (3xx-6xx responses) and no-answer timeouts.
 * Both support failover via the HTTP /call/failure API.
 */

import { Effect, Schema } from "effect"
import type { RuleDefinition, RuleAction } from "../framework/RuleDefinition.js"
import type { SipResponse } from "../../../sip/types.js"
import { getHeader } from "../../../sip/MessageFactory.js"

// ── Helper ────────────────────────────────────────────────────────────────

function cseqMethod(resp: SipResponse): string {
  const h = getHeader(resp.headers, "cseq") ?? ""
  return h.split(/\s+/)[1]?.toUpperCase() ?? "INVITE"
}

// ── route-failure (priority 906) ──────────────────────────────────────────

/**
 * Handle 3xx-6xx response from b-leg INVITE.
 * Calls /call/failure for potential failover, or terminates the call.
 *
 * NOTE: This rule requires async HTTP calls (callControl.callFailure) and
 * b-leg creation logic that isn't fully expressible as pure RuleActions yet.
 * For now, it passes through to the default handler. Once ActionExecutor
 * supports "create-leg-from-failover" or similar, this can be migrated.
 */
export const routeFailureRule: RuleDefinition<undefined, undefined> = {
  id: "route-failure",
  name: "B-Leg Route Failure",
  alwaysActive: true,
  defaultPriority: 906,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  // resolve-cancel-response (legDisposition=cancelling) and
  // absorb-stale-failure (legState=terminated) carve out by specificity.
  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: ["3xx", "4xx", "5xx", "6xx"],
    direction: "from-b",
  },

  init: () => undefined,

  handle: (ctx) =>
    Effect.gen(function* () {
      if (ctx.event.type !== "sip") return undefined
      const resp = ctx.event.message as SipResponse

      const actions: RuleAction[] = [
        { type: "add-cdr-event", eventType: "reject" as const, legId: ctx.sourceLeg.legId, statusCode: resp.status, reason: resp.reason },
        { type: "terminate-leg", legId: ctx.sourceLeg.legId },
      ]

      // Try /call/failure for potential failover
      if (ctx.call.callbackContext !== undefined) {
        const failureResp = yield* ctx.callControl.callFailure({
          call_id: ctx.call.aLeg.callId,
          callback_context: ctx.call.callbackContext,
          failure: {
            origin: "external" as const,
            sip_code: resp.status,
            sip_reason: resp.reason,
          },
        }).pipe(
          Effect.catchTag("CallControlError", (e) =>
            Effect.logError(`/call/failure failed: ${e.reason}`).pipe(
              Effect.as(undefined),
            ),
          ),
        )

        if (failureResp !== undefined && failureResp.action === "failover") {
          actions.push({
            type: "cancel-timer",
            timerId: `no-answer-${ctx.callRef}-${ctx.sourceLeg.legId}`,
          })
          const updateHeaders = failureResp.update_headers as Record<string, string | null> | undefined
          actions.push({
            type: "create-leg",
            destination: { host: failureResp.destination.host, port: failureResp.destination.port ?? 5060 },
            fromInvite: "snapshot",
            ...(updateHeaders !== undefined ? { updateHeaders } : {}),
            ...(failureResp.no_answer_timeout_sec !== undefined ? { noAnswerTimeoutSec: failureResp.no_answer_timeout_sec } : {}),
            ...(failureResp.new_ruri !== undefined ? { newRuri: failureResp.new_ruri } : {}),
            ...(failureResp.callback_context !== undefined ? { callbackContext: failureResp.callback_context } : {}),
          })
          return { actions, state: undefined }
        }
      }

      // No failover — relay error to a-leg and begin termination
      actions.push({ type: "relay-to-peer" })
      actions.push({ type: "begin-termination" })

      return { actions, state: undefined }
    }),
}

// ── no-answer-failover (priority 909) ─────────────────────────────────────

/**
 * Handle no-answer timeout on a b-leg. Destroys the timed-out leg,
 * calls /call/failure for potential failover, or terminates.
 */
export const noAnswerFailoverRule: RuleDefinition<undefined, undefined> = {
  id: "no-answer-failover",
  name: "No-Answer Failover",
  alwaysActive: true,
  defaultPriority: 909,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: { kind: "timer", timerType: "no_answer" },

  init: () => undefined,

  handle: (ctx) =>
    Effect.gen(function* () {
      if (ctx.event.type !== "timer") return undefined
      const legId = ctx.event.legId
      if (legId === undefined) return undefined

      const bLeg = ctx.call.bLegs.find((l) => l.legId === legId)
      if (bLeg === undefined || bLeg.state === "terminated") return undefined

      const actions: RuleAction[] = [
        { type: "add-cdr-event", eventType: "timeout" as const, legId, reason: "no_answer_timeout" },
        { type: "destroy-leg", legId },
      ]

      // Try /call/failure for potential failover
      if (ctx.call.callbackContext !== undefined) {
        const failureResp = yield* ctx.callControl.callFailure({
          call_id: ctx.call.aLeg.callId,
          callback_context: ctx.call.callbackContext,
          failure: { origin: "no_answer_timeout" as const },
        }).pipe(
          Effect.catchTag("CallControlError", (e) =>
            Effect.logError(`/call/failure failed: ${e.reason}`).pipe(
              Effect.as(undefined),
            ),
          ),
        )

        if (failureResp !== undefined && failureResp.action === "failover") {
          const updateHeaders = failureResp.update_headers as Record<string, string | null> | undefined
          actions.push({
            type: "create-leg",
            destination: { host: failureResp.destination.host, port: failureResp.destination.port ?? 5060 },
            fromInvite: "snapshot",
            ...(updateHeaders !== undefined ? { updateHeaders } : {}),
            ...(failureResp.no_answer_timeout_sec !== undefined ? { noAnswerTimeoutSec: failureResp.no_answer_timeout_sec } : {}),
            ...(failureResp.new_ruri !== undefined ? { newRuri: failureResp.new_ruri } : {}),
            ...(failureResp.callback_context !== undefined ? { callbackContext: failureResp.callback_context } : {}),
          })
          return { actions, state: undefined }
        }
      }

      // No failover — begin termination
      actions.push({ type: "begin-termination" })
      return { actions, state: undefined }
    }),
}

// ── absorb-stale-failure (priority 905) ──────────────────────────────────

/**
 * Absorb a late 3xx-6xx INVITE response arriving on an already-terminated
 * b-leg. Under strict specificity this wins over route-failure (extra
 * legState column) so the failover/CDR path isn't re-triggered by stale
 * retransmissions.
 *
 * Replaces the imperative `legState !== "terminated"` negation that lived
 * inside route-failure's legacy matches() body — same semantics, positively expressed.
 */
export const absorbStaleFailureRule: RuleDefinition<undefined, undefined> = {
  id: "absorb-stale-failure",
  name: "Absorb Stale Failure",
  alwaysActive: true,
  defaultPriority: 905,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "response",
    cseqMethod: "INVITE",
    statusClass: ["3xx", "4xx", "5xx", "6xx"],
    legState: "terminated",
    direction: "from-b",
  },

  init: () => undefined,

  handle: () =>
    Effect.succeed({ actions: [], state: undefined }),
}
