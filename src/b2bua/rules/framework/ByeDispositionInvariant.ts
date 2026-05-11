/**
 * ByeDispositionInvariant — catches rules that consume a BYE-resolution event
 * without saying "leg terminated".
 *
 * The rule contract (docs/leg-termination-model.md): when a rule fires on
 *   (a) a final response (>=200) to a BYE for a leg in `bye_sent`, or
 *   (b) a `terminating_timeout` timer for any leg in `bye_sent`,
 * the rule MUST emit `terminate-leg` so the leg leaves `bye_sent`.
 *
 * If a rule absorbs that event without acting, the leg stays `bye_sent`,
 * `isFullyResolved` returns false, the call never reaches `terminated`,
 * cleanup never fires, the orphan sweep is the only path that recovers it,
 * and CDR / Redis tombstone are bypassed.
 *
 * This module is the framework safety net:
 *   - Force-set terminal disposition (bye_confirmed for responses,
 *     bye_timeout for timer)
 *   - Increment a process-wide counter
 *   - Caller logs a structured WARN with rule id + leg
 *
 * Returns `{ call, violations }`. Caller (`RuleExecutor`) emits the WARN
 * via `Effect.logWarning` from its generator and feeds the corrected call
 * into the existing `terminating → terminated` promotion.
 */

import type { Call, ByeDisposition } from "../../../call/CallModel.js"
import { setByeDisposition } from "../../../call/CallModel.js"
import type { CallEvent } from "../../../sip/SipRouter.js"

let invariantViolationCount = 0

/** Process-wide counter exposed for /status endpoint and tests. */
export const getByeDispositionInvariantViolationCount = (): number => invariantViolationCount

/** Reset for tests that need a clean baseline. */
export const resetByeDispositionInvariantViolationCount = (): void => {
  invariantViolationCount = 0
}

export interface ByeDispositionViolation {
  readonly legId: string
  readonly previous: ByeDisposition
  readonly forced: ByeDisposition
}

/**
 * Detect rules that left a `bye_sent` leg untouched after a BYE-resolution
 * event and force-correct the disposition. Returns the corrected call and
 * a list of violations the caller should log.
 */
export function enforceByeDispositionInvariant(
  callBefore: Call,
  event: CallEvent,
  callAfter: Call,
): { readonly call: Call; readonly violations: ReadonlyArray<ByeDispositionViolation> } {
  const trigger = classifyByeResolutionEvent(event)
  if (trigger === null) return { call: callAfter, violations: [] }

  // Identify legs that were in bye_sent before the rule fired and are
  // affected by this event.
  const candidateLegIds: string[] = []
  if (trigger.kind === "response") {
    // A response only resolves the leg it arrived on; SipRouter sets
    // event.legId via Via stamping. Fall back to checking every bye_sent
    // leg so we never miss a violation if the event lacks a legId.
    const target = trigger.legId
    for (const leg of [callBefore.aLeg, ...callBefore.bLegs]) {
      if (leg.byeDisposition !== "bye_sent") continue
      if (target !== undefined && target !== leg.legId) continue
      candidateLegIds.push(leg.legId)
    }
  } else {
    // terminating_timeout — fires for every bye_sent leg on the call.
    for (const leg of [callBefore.aLeg, ...callBefore.bLegs]) {
      if (leg.byeDisposition === "bye_sent") candidateLegIds.push(leg.legId)
    }
  }
  if (candidateLegIds.length === 0) return { call: callAfter, violations: [] }

  let updated = callAfter
  const violations: ByeDispositionViolation[] = []
  for (const legId of candidateLegIds) {
    const after = findLeg(updated, legId)
    if (after === undefined) continue
    if (after.byeDisposition !== "bye_sent") continue
    updated = setByeDisposition(updated, legId, trigger.forced)
    violations.push({ legId, previous: "bye_sent", forced: trigger.forced })
    invariantViolationCount++
  }

  return { call: updated, violations }
}

type Trigger =
  | { readonly kind: "response"; readonly legId: string | undefined; readonly forced: "bye_confirmed" }
  | { readonly kind: "timer"; readonly forced: "bye_timeout" }

function classifyByeResolutionEvent(event: CallEvent): Trigger | null {
  if (event.type === "sip" && event.message.type === "response") {
    const cseq = event.message.getHeader("cseq")
    const status = event.message.status
    if (cseq.method === "BYE" && status >= 200) {
      // Via params stamped by outbound BYE generators carry `lg`; if
      // missing we fall back to scanning all bye_sent legs.
      const viaParams = event.message.getHeader("via")[0]?.params
      const lg = typeof viaParams?.lg === "string" ? decodeURIComponent(viaParams.lg) : undefined
      return { kind: "response", legId: lg, forced: "bye_confirmed" }
    }
    return null
  }
  if (event.type === "timer" && event.timerType === "terminating_timeout") {
    return { kind: "timer", forced: "bye_timeout" }
  }
  return null
}

function findLeg(call: Call, legId: string) {
  if (call.aLeg.legId === legId) return call.aLeg
  return call.bLegs.find((l) => l.legId === legId)
}
