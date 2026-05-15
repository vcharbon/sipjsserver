/**
 * InvariantEnforcer — post-processing guarantees applied to every HandlerResult.
 *
 * Ensures that invariants hold regardless of what rules return:
 * - Limiter slots are always decremented when a call terminates
 * - Timers are always cancelled when a call terminates
 * - CDR is always written when a call terminates
 * - Call removal is always scheduled when a call terminates
 *
 * This is the safety net: even if a rule has a bug and terminates a call
 * without proper cleanup effects, the enforcer adds them.
 */

import type { Call } from "../../../call/CallModel.js"
import type {
  HandlerResult,
  CriticalStateEffect,
  SoftBoundedEffect,
  BufferedObservabilityEffect,
} from "../../../sip/SipRouter.js"

/**
 * Enforce invariants on a HandlerResult.
 * Called after ActionExecutor produces a result, before returning to SipRouter.
 *
 * @param before - Call state before rule execution
 * @param result - HandlerResult from ActionExecutor
 * @returns HandlerResult with invariant-guaranteed effects
 */
export function enforceInvariants(before: Call, result: HandlerResult): HandlerResult {
  const after = result.call

  // Only apply termination invariants when transitioning to terminated
  if (after.state !== "terminated" || before.state === "terminated") {
    return result
  }

  const critical: CriticalStateEffect[] = [...result.effects.critical]
  const soft: SoftBoundedEffect[] = [...result.effects.soft]
  const buffered: BufferedObservabilityEffect[] = [...result.effects.buffered]

  // 1. TIMER GUARANTEE: ensure cancel-all-timers is present
  if (!critical.some((e) => e.type === "cancel-all-timers")) {
    // Insert at the beginning — timers should be cancelled before other cleanup
    critical.unshift({ type: "cancel-all-timers" })
  }

  // 2. LIMITER GUARANTEE: ensure all limiter entries are decremented
  const existingDecrements = new Set(soft.map((e) => e.limiterId))
  for (const entry of after.limiterEntries) {
    if (!existingDecrements.has(entry.limiterId)) {
      soft.push({ type: "decrement-limiter", limiterId: entry.limiterId, window: entry.originWindow })
    }
  }

  // 3. CDR GUARANTEE: ensure CDR is written
  if (!buffered.some((e) => e.type === "write-cdr")) {
    buffered.push({ type: "write-cdr" })
  }

  // 4. REMOVAL GUARANTEE: ensure remove-call is present (and last among critical)
  const removalIdx = critical.findIndex((e) => e.type === "remove-call")
  if (removalIdx === -1) {
    critical.push({ type: "remove-call" })
  } else if (removalIdx !== critical.length - 1) {
    const [removal] = critical.splice(removalIdx, 1)
    critical.push(removal!)
  }

  return {
    ...result,
    effects: { ...result.effects, critical, soft, buffered },
  }
}
