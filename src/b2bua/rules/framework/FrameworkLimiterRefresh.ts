/**
 * Framework-level handler for the `limiter_refresh` timer.
 *
 * This is intentionally NOT a RuleDefinition. Per AdvancedCallModel.md
 * §"Limitations and Not Yet Implemented", limiter refresh is a framework
 * concern: it touches an async service (Redis-backed CallLimiter) and
 * window-migration internals that rules should not know about.
 *
 * `RuleExecutor.executeRules` intercepts `event.type === "timer" &&
 * timerType === "limiter_refresh"` at the very top, before building the
 * rule list, and dispatches to this function. Neither the rule chain nor
 * the default handler ever sees the event.
 *
 * Behaviour: refresh each limiter window, schedule the next tick,
 * swallow Redis errors via `Effect.catchTag("RedisError", ...)`.
 */

import { Effect } from "effect"
import type { ResolvedContext, HandlerResult } from "../../../sip/SipRouter.js"
import { emptyEffects } from "../../../sip/SipRouter.js"
import type { TimerEntry } from "../../../call/CallModel.js"

export const handleLimiterRefresh = (
  ctx: ResolvedContext,
): Effect.Effect<HandlerResult, never, never> =>
  Effect.gen(function* () {
    const { call, callRef, config, nowMs } = ctx

    // No-op if the call is already shutting down — refresh has no value
    // and we don't want to schedule another tick.
    if (call.state === "terminated" || call.state === "terminating") {
      return { call, effects: emptyEffects }
    }

    // Migrate limiter counts from origin windows to the current window
    // for each entry. RedisError is logged and the existing originWindow
    // is kept (no migration this tick) — we never fail the call on a
    // transient Redis problem.
    const refreshedEntries = [...call.limiterEntries]
    for (let i = 0; i < refreshedEntries.length; i++) {
      const entry = refreshedEntries[i]!
      const newWindow = yield* ctx.limiter.refresh(entry.limiterId, entry.originWindow).pipe(
        Effect.catchTag("RedisError", (e) =>
          Effect.logError(`Failed to refresh limiter ${entry.limiterId}: ${e.reason}`).pipe(
            Effect.as(entry.originWindow),
          ),
        ),
      )
      refreshedEntries[i] = { ...entry, originWindow: newWindow }
    }
    const updated = { ...call, limiterEntries: refreshedEntries }

    // Schedule the next refresh tick. Same id as confirm-dialog uses for
    // the first tick, so re-scheduling overwrites the same fiber slot.
    const nextTimer: TimerEntry = {
      id: `limiter-refresh-${callRef}`,
      type: "limiter_refresh",
      fireAt: nowMs + config.limiterWindowSeconds * 1000,
    }

    return {
      call: updated,
      effects: { ...emptyEffects, critical: [{ type: "schedule-timer", timer: nextTimer }] },
    }
  })
