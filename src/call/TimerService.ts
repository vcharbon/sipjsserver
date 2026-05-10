/**
 * TimerService — manages runtime fibers for serializable timer intents.
 *
 * Each scheduled timer spawns an Effect fiber that sleeps until fireAt,
 * then invokes a callback. Timer intents (TimerEntry) are serializable;
 * runtime fibers are ephemeral and never persisted.
 */

import { Clock, Duration, Effect, Fiber, Layer, MutableHashMap, Option, ServiceMap } from "effect"
import type { TimerEntry, TimerType } from "./CallModel.js"
import { AppConfig } from "../config/AppConfig.js"
import { MetricsRegistry } from "../observability/MetricsRegistry.js"

// ---------------------------------------------------------------------------
// Timer callback type
// ---------------------------------------------------------------------------

/** Called when a timer fires. The handler should dispatch the appropriate action. */
export type TimerHandler = (callRef: string, timerType: TimerType, legId: string | undefined) => Effect.Effect<void>

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TimerService extends ServiceMap.Service<
  TimerService,
  {
    /** Schedule a new timer. Returns the timerId. */
    readonly schedule: (callRef: string, entry: TimerEntry, handler: TimerHandler) => Effect.Effect<string>
    /** Cancel a running timer by its id. No-op if already fired or not found. */
    readonly cancel: (timerId: string) => Effect.Effect<void>
    /** Cancel all timers for a given callRef. */
    readonly cancelAll: (callRef: string) => Effect.Effect<void>
    /** Restore timers from serialized entries (e.g., after Redis load). */
    readonly restoreFromEntries: (callRef: string, entries: ReadonlyArray<TimerEntry>, handler: TimerHandler) => Effect.Effect<void>
    /** Get the number of active timers (for diagnostics). */
    readonly activeCount: () => Effect.Effect<number>
    /** Synchronous variant of activeCount for metrics reporting. */
    readonly activeCountSync: () => number
  }
>()("@sipjsserver/TimerService") {
  static readonly layer = Layer.effect(
    TimerService,
    Effect.gen(function* () {
      // Capture the layer's scope so timer fibers can be forked INTO
      // it. With `forkDetach` (the previous default) a timer fiber
      // outlives the worker scope that built the layer — including the
      // `kill`/respawn cycle in test scenarios — and keeps firing
      // against the dead worker's stale `callsMap`. Forking against
      // the layer's scope ties every fiber's lifetime to the worker.
      const layerScope = yield* Effect.scope
      const registry = yield* MetricsRegistry
      const config = yield* AppConfig

      // Map timerId → { fiber, callRef }
      const fibersMap = MutableHashMap.empty<string, { fiber: Fiber.Fiber<void>; callRef: string }>()

      // Bumped whenever a timer body trips the per-handler safety
      // timeout. Surfaced via MetricsRegistry as
      // `b2bua_worker_timer_handler_timeouts_total`.
      let handlerTimeoutTotal = 0

      const logTimerFailure = (timerId: string, timerType: TimerType, callRef: string) =>
        (cause: import("effect").Cause.Cause<never>) =>
          Effect.logError(`Timer ${timerId} (${timerType}) for call ${callRef} failed`, cause)

      const schedule = Effect.fnUntraced(function* (
        callRef: string,
        entry: TimerEntry,
        handler: TimerHandler
      ) {
        const now = yield* Clock.currentTimeMillis
        const delayMs = Math.max(0, entry.fireAt - now)

        // Cancel any prior fiber registered under the same id — but
        // never interrupt ourselves. Recurring timers (keepalive,
        // limiter_refresh) reschedule under the same id from inside
        // their own fired handler; that path runs while the prior
        // entry is still in `fibersMap` (the `onExit` cleanup hasn't
        // run yet). Self-interruption would deadlock the schedule
        // call AND wipe the map entry we're about to install.
        const self = Fiber.getCurrent()
        const prior = Option.getOrUndefined(MutableHashMap.get(fibersMap, entry.id))
        if (prior !== undefined && prior.fiber !== self) {
          yield* Fiber.interrupt(prior.fiber)
        }

        // Capture the new entry's identity before forking so the
        // `onExit` removal is gated on "the map entry still points at
        // me". Otherwise a later reschedule under the same id would
        // overwrite the map entry, and our delayed `onExit` would
        // wipe out the new fiber's registration.
        let myFiber: Fiber.Fiber<void> | undefined
        // Per-handler safety timeout. A handler that exceeds the
        // configured budget is force-cancelled with a clear log line so
        // the hang is visible in metrics + logs instead of vanishing
        // into a sleeping fiber. `timeoutOrElse` keeps the body's
        // success type — the orElse branch logs, bumps the counter,
        // and returns void; the existing catchCause stays in charge
        // of plain handler failures.
        const timerEffect = Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(delayMs))
          yield* handler(callRef, entry.type, entry.legId).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(config.timerHandlerTimeoutMs),
              orElse: () =>
                Effect.gen(function* () {
                  handlerTimeoutTotal++
                  yield* Effect.logError(
                    `Timer handler ${entry.type} (id=${entry.id}) for call ${callRef}` +
                      `${entry.legId ? ` leg=${entry.legId}` : ""}` +
                      ` exceeded ${config.timerHandlerTimeoutMs}ms — handler did not return`,
                  )
                }),
            }),
          )
        }).pipe(
          Effect.onExit(() =>
            Effect.sync(() => {
              const cur = Option.getOrUndefined(MutableHashMap.get(fibersMap, entry.id))
              if (cur !== undefined && cur.fiber === myFiber) {
                MutableHashMap.remove(fibersMap, entry.id)
              }
            }),
          ),
          Effect.catchCause(logTimerFailure(entry.id, entry.type, callRef)),
        )

        const fiber = yield* Effect.forkIn(timerEffect, layerScope)
        myFiber = fiber
        MutableHashMap.set(fibersMap, entry.id, { fiber, callRef })

        return entry.id
      })

      const cancel = Effect.fnUntraced(function* (timerId: string) {
        const entry = Option.getOrUndefined(MutableHashMap.get(fibersMap, timerId))
        if (entry === undefined) return
        // Self-cancel protection: a timer's own handler may emit
        // `cancel-all-timers` (e.g. begin-termination), which iterates
        // every fiber for the callRef including this one. Calling
        // `Fiber.interrupt(self)` from within the same fiber is a
        // deadlock; just drop the map entry and let the body unwind
        // naturally. The `onExit` cleanup is gated on the map entry
        // still pointing at us, so it is a no-op after this remove.
        const self = Fiber.getCurrent()
        if (entry.fiber === self) {
          MutableHashMap.remove(fibersMap, timerId)
          return
        }
        yield* Fiber.interrupt(entry.fiber)
        MutableHashMap.remove(fibersMap, timerId)
      })

      const cancelAll = Effect.fnUntraced(function* (callRef: string) {
        const toCancel: string[] = []
        for (const [id, entry] of fibersMap) {
          if (entry.callRef === callRef) {
            toCancel.push(id)
          }
        }
        for (const id of toCancel) {
          yield* cancel(id)
        }
      })

      const restoreFromEntries = Effect.fnUntraced(function* (
        callRef: string,
        entries: ReadonlyArray<TimerEntry>,
        handler: TimerHandler
      ) {
        const nowMs = yield* Clock.currentTimeMillis
        for (const entry of entries) {
          // Skip timers that have already fired (fireAt in the past with no margin)
          if (entry.fireAt <= nowMs) {
            yield* Effect.logWarning(`Timer ${entry.id} (${entry.type}) already expired for call ${callRef} — firing immediately`)
          }
          yield* schedule(callRef, entry, handler)
        }
      })

      const activeCount = Effect.fnUntraced(function* () {
        return MutableHashMap.size(fibersMap)
      })

      const activeCountSync = (): number => MutableHashMap.size(fibersMap)

      // Surface the live count to the metrics registry so the
      // `b2bua_worker_active_timers` gauge reads the same number that
      // `activeCountSync` returns. See Slice 4 of
      // docs/plan/endurance-stuck-terminating-and-overload-hardening.md.
      registry.timers = {
        activeCount: activeCountSync,
        handlerTimeoutTotal: () => handlerTimeoutTotal,
      }

      return { schedule, cancel, cancelAll, restoreFromEntries, activeCount, activeCountSync }
    })
  )
}
