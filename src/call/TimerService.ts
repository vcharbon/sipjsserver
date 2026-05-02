/**
 * TimerService — manages runtime fibers for serializable timer intents.
 *
 * Each scheduled timer spawns an Effect fiber that sleeps until fireAt,
 * then invokes a callback. Timer intents (TimerEntry) are serializable;
 * runtime fibers are ephemeral and never persisted.
 */

import { Clock, Duration, Effect, Fiber, Layer, MutableHashMap, Option, ServiceMap } from "effect"
import type { TimerEntry, TimerType } from "./CallModel.js"

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

      // Map timerId → { fiber, callRef }
      const fibersMap = MutableHashMap.empty<string, { fiber: Fiber.Fiber<void>; callRef: string }>()

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

        const timerEffect = Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(delayMs))
          yield* handler(callRef, entry.type, entry.legId)
        }).pipe(
          // The handler may invoke cancel-all-timers (begin-termination does),
          // which interrupts this fiber from the inside. Use `onExit` so the
          // fibersMap entry is removed regardless of whether the handler
          // completes normally, fails, or is self-interrupted.
          Effect.onExit(() => Effect.sync(() => MutableHashMap.remove(fibersMap, entry.id))),
          Effect.catchCause(logTimerFailure(entry.id, entry.type, callRef)),
        )

        const fiber = yield* Effect.forkIn(timerEffect, layerScope)
        MutableHashMap.set(fibersMap, entry.id, { fiber, callRef })

        return entry.id
      })

      const cancel = Effect.fnUntraced(function* (timerId: string) {
        const entry = Option.getOrUndefined(MutableHashMap.get(fibersMap, timerId))
        if (entry !== undefined) {
          yield* Fiber.interrupt(entry.fiber)
          MutableHashMap.remove(fibersMap, timerId)
        }
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

      return { schedule, cancel, cancelAll, restoreFromEntries, activeCount, activeCountSync }
    })
  )
}
