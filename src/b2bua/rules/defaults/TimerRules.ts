/**
 * Timer rules — max-duration, keepalive, keepalive-timeout.
 *
 * These handle timer events for confirmed calls.
 * Limiter refresh is a framework concern, not a rule (see InvariantEnforcer).
 */

import { Effect, Schema } from "effect"
import type { RuleDefinition, RuleAction } from "../framework/RuleDefinition.js"
import { allPeeredLegs } from "../../../call/CallModel.js"

// ── max-duration (priority 936) ───────────────────────────────────────────

/** Terminate call when global duration timer fires. */
export const maxDurationRule: RuleDefinition<undefined, undefined> = {
  id: "max-duration",
  name: "Max Duration Timeout",
  alwaysActive: true,
  defaultPriority: 936,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: { kind: "timer", timerType: "global_duration" },

  init: () => undefined,

  handle: () =>
    Effect.succeed({
      actions: [
        { type: "add-cdr-event", eventType: "bye" as const, legId: "a" },
        { type: "begin-termination" },
      ],
      state: undefined,
    }),
}

// ── keepalive (priority 939) ──────────────────────────────────────────────

/**
 * Send OPTIONS keepalive to all peered legs, schedule timeout timers
 * and the next keepalive.
 *
 * Uses `send-request-to-leg` action — the ActionExecutor handles CSeq bump,
 * dialog lookup, and message construction for the generated OPTIONS request.
 */
export const keepaliveRule: RuleDefinition<undefined, undefined> = {
  id: "keepalive",
  name: "Keepalive Timer",
  alwaysActive: true,
  defaultPriority: 939,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "timer",
    timerType: "keepalive",
    callState: ["active", "terminating"],
  },

  init: () => undefined,

  handle: (ctx) => {
    const actions: RuleAction[] = []

    // Send OPTIONS to all peered legs and schedule timeout for each.
    // Skip a leg that already has a pending keepalive_timeout — the previous
    // OPTIONS is still in flight (Timer E retransmits it). Emitting a second
    // OPTIONS with a bumped CSeq while the first is unresolved would cause
    // two overlapping OPTIONS transactions to the same leg.
    const peered = allPeeredLegs(ctx.call)
    // Filter to entries that haven't fired yet (fireAt > now). Fired-but-not-
    // removed entries are a historical quirk of the timer list; ignore them.
    const pendingKeepaliveLegs = new Set(
      ctx.call.timers
        .filter((t) =>
          t.type === "keepalive_timeout" &&
          t.legId !== undefined &&
          t.fireAt > ctx.nowMs,
        )
        .map((t) => t.legId as string),
    )
    for (const legId of peered) {
      if (pendingKeepaliveLegs.has(legId)) continue
      actions.push({ type: "send-request-to-leg", legId, method: "OPTIONS" })
      actions.push({
        type: "schedule-timer",
        timerType: "keepalive_timeout",
        delaySec: ctx.config.keepaliveTimeoutSec,
        legId,
      })
    }

    // Schedule next keepalive
    actions.push({
      type: "schedule-timer",
      timerType: "keepalive",
      delaySec: ctx.config.keepaliveIntervalSec,
    })

    return Effect.succeed({ actions, state: undefined })
  },
}

// ── keepalive-timeout (priority 942) ──────────────────────────────────────

/** Terminate call when a keepalive timeout fires. */
export const keepaliveTimeoutRule: RuleDefinition<undefined, undefined> = {
  id: "keepalive-timeout",
  name: "Keepalive Timeout",
  alwaysActive: true,
  defaultPriority: 942,
  stateSchema: Schema.Undefined,
  paramsSchema: Schema.Undefined,

  match: {
    kind: "timer",
    timerType: "keepalive_timeout",
    callState: ["active", "terminating"],
  },

  init: () => undefined,

  handle: (ctx) => {
    // Mark the unresponsive leg as timed out so begin-termination
    // only sends BYE to the responsive peer (no point BYE-ing a dead leg).
    const timedOutLegId = ctx.event.type === "timer" ? ctx.event.legId : undefined
    const actions: RuleAction[] = []

    if (timedOutLegId !== undefined) {
      actions.push({ type: "terminate-leg", legId: timedOutLegId, byeDisposition: "bye_timeout" as const })
    }

    actions.push({ type: "add-cdr-event", eventType: "bye" as const, legId: timedOutLegId ?? "a", reason: "keepalive timeout" })
    actions.push({ type: "begin-termination" })

    return Effect.succeed({ actions, state: undefined })
  },
}
