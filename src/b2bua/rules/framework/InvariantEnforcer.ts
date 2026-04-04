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
import type { HandlerResult, SideEffect } from "../../../sip/SipRouter.js"

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

  // Build a mutable copy of effects to patch
  const effects: SideEffect[] = [...result.effects]

  // 1. TIMER GUARANTEE: ensure cancel-all-timers is present
  if (!effects.some((e) => e.type === "cancel-all-timers")) {
    // Insert at the beginning — timers should be cancelled before other cleanup
    effects.unshift({ type: "cancel-all-timers" })
  }

  // 2. LIMITER GUARANTEE: ensure all limiter entries are decremented
  const existingDecrements = new Set(
    effects
      .filter((e): e is Extract<SideEffect, { type: "decrement-limiter" }> => e.type === "decrement-limiter")
      .map((e) => e.limiterId)
  )
  for (const entry of after.limiterEntries) {
    if (!existingDecrements.has(entry.limiterId)) {
      effects.push({ type: "decrement-limiter", limiterId: entry.limiterId, window: entry.originWindow })
    }
  }

  // 3. CDR GUARANTEE: ensure CDR is written
  if (!effects.some((e) => e.type === "write-cdr")) {
    effects.push({ type: "write-cdr" })
  }

  // 4. REMOVAL GUARANTEE: ensure remove-call is present (and last)
  const hasRemoval = effects.some((e) => e.type === "remove-call")
  if (!hasRemoval) {
    effects.push({ type: "remove-call" })
  } else {
    // Ensure remove-call is the last effect
    const idx = effects.findIndex((e) => e.type === "remove-call")
    if (idx !== effects.length - 1) {
      effects.splice(idx, 1)
      effects.push({ type: "remove-call" })
    }
  }

  return { ...result, effects }
}
