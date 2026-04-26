/**
 * pumpAll — generic auto-pump for fake-stack tests.
 *
 * Replaces the hand-tuned `makePump` (tests/support/topologies.ts) and
 * `settle()` (tests/fullcall/framework/simulated-backend.ts) drains. Drives
 * virtual time forward exactly to the next pending deadline, fires it,
 * yields the scheduler a few times, repeats. Stops on:
 *
 *   - `maxSleepsFired` cap (safety net for self-rearming periodic timers),
 *   - the configured `within` virtual-time budget, or
 *   - quiescence: no pending sleeps AND no in-flight transit on the
 *     simulated network.
 *
 * After clean quiescence, ALWAYS does a 20ms real-clock probe via
 * `TestClock.withLive` and re-checks. If the probe surfaces new work, the
 * report flags `realProbeWasUseful: true` — that's the signal a test is
 * secretly depending on Redis / disk / external blocking I/O. Loop
 * re-enters; only return when even the probe yields nothing.
 *
 * Returns a `PumpReport` rather than throwing — caller decides whether to
 * assert. Per the plan, the simulated-backend `settle()` will surface
 * `realProbeWasUseful` and `periodicSuspects` into the scenario report
 * (Phase 2); `topologies.ts` callers ignore the report.
 *
 * Dependencies: `PumpableClock` (introspection) + `SignalingNetwork`
 * (in-flight count). `Clock.Clock` is provided alongside `PumpableClock`
 * by `PumpableClockLayer`, so production code under test sees the same
 * clock the pump drives.
 */

import { Effect } from "effect"
import * as Duration from "effect/Duration"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { PumpableClock } from "./PumpableClock.js"

const YIELDS_PER_ROUND = 5

const yieldRound = Effect.gen(function* () {
  for (let i = 0; i < YIELDS_PER_ROUND; i++) {
    yield* Effect.yieldNow
  }
})

export interface PumpReport {
  /** Total virtual ms advanced during this call. */
  readonly virtualAdvancedMs: number
  /** Number of latches opened during this call. */
  readonly sleepsFired: number
  /** Per-duration fire counts during this call (keyed by sleep arg in ms). */
  readonly firedHistogram: ReadonlyArray<{ readonly durationMillis: number; readonly count: number }>
  /** Deadlines still pending at return time, ascending. */
  readonly remainingDeadlines: ReadonlyArray<number>
  /** True when `within` was the reason we stopped before reaching quiescence. */
  readonly hitBudget: boolean
  /** True when `maxSleepsFired` was the reason we stopped. */
  readonly hitCap: boolean
  /** True when the post-quiescence 20ms real-clock probe surfaced new work. */
  readonly realProbeWasUseful: boolean
  /**
   * Sleep durations that fired more than `periodicWarnThreshold` times during
   * this call. Self-rearming heartbeats / keepalives produce many sleeps with
   * the same duration; one-shot work produces unique durations — this is the
   * signal the harness uses to flag incidental periodic-timer driving.
   */
  readonly periodicSuspects: ReadonlyArray<{ readonly durationMillis: number; readonly count: number }>
}

export interface PumpOptions {
  /** Max virtual-time advance per call. Default: 1 second. */
  readonly within?: Duration.DurationInput
  /** Hard cap on sleeps fired in one pumpAll call. Default: 10000. */
  readonly maxSleepsFired?: number
  /** Per-deadline fire count above which the deadline is flagged periodic. Default: 3. */
  readonly periodicWarnThreshold?: number
  /**
   * Always-on real-clock probe duration. Set to undefined to disable, but
   * default (20ms) is the recommended setting per the plan — it surfaces
   * tests that secretly depend on external I/O.
   */
  readonly realProbe?: Duration.DurationInput | undefined
}

const DEFAULTS: Required<Omit<PumpOptions, "realProbe">> & {
  readonly realProbe: Duration.DurationInput
} = {
  within: "1 second",
  maxSleepsFired: 10000,
  periodicWarnThreshold: 3,
  realProbe: "20 millis",
}

export const pumpAll = (
  opts: PumpOptions = {},
): Effect.Effect<PumpReport, never, PumpableClock | SignalingNetwork> =>
  Effect.gen(function* () {
    const within = Duration.toMillis(
      Duration.fromInputUnsafe(opts.within ?? DEFAULTS.within),
    )
    const maxSleepsFired = opts.maxSleepsFired ?? DEFAULTS.maxSleepsFired
    const periodicWarnThreshold =
      opts.periodicWarnThreshold ?? DEFAULTS.periodicWarnThreshold
    const realProbe = "realProbe" in opts ? opts.realProbe : DEFAULTS.realProbe

    const clock = yield* PumpableClock
    const net = yield* SignalingNetwork

    const startTime = clock.currentTimeMillisUnsafe()
    const startFired = clock.sleepsFiredCount()
    // Snapshot per-duration fire counts at start so we can compute the delta.
    const histStart = new Map<number, number>()
    for (const e of clock.firedHistogram()) histStart.set(e.durationMillis, e.count)

    let hitBudget = false
    let hitCap = false
    let realProbeWasUseful = false

    const budgetDeadline = startTime + within

    const drainOnce = (): Effect.Effect<"clean" | "cap" | "budget"> =>
      Effect.gen(function* () {
        while (true) {
          yield* yieldRound
          if (clock.sleepsFiredCount() - startFired >= maxSleepsFired) {
            return "cap" as const
          }
          const pending = clock.pendingSleeps()
          const inFlight = net.inFlight()
          if (pending.length === 0 && inFlight === 0) {
            return "clean" as const
          }
          // If transit is in flight but no sleeps are pending, the transit
          // fiber must be between sleep-fired and deliver-running. Another
          // yield round will catch it; loop without advancing time.
          if (pending.length === 0) continue
          const next = pending[0]!
          if (next > budgetDeadline) {
            return "budget" as const
          }
          const now = clock.currentTimeMillisUnsafe()
          const delta = next - now + 1
          yield* clock.adjust(`${delta} millis`)
        }
      })

    while (true) {
      const result = yield* drainOnce()
      if (result === "cap") {
        hitCap = true
        break
      }
      if (result === "budget") {
        hitBudget = true
        break
      }
      // result === "clean": run the real-clock probe.
      if (realProbe === undefined) break
      const pendingBefore = clock.pendingSleeps().length
      const inFlightBefore = net.inFlight()
      yield* clock.withLive(Effect.sleep(realProbe))
      yield* yieldRound
      const pendingAfter = clock.pendingSleeps().length
      const inFlightAfter = net.inFlight()
      if (pendingAfter > pendingBefore || inFlightAfter > inFlightBefore) {
        realProbeWasUseful = true
        // Re-enter drain loop — new work appeared.
        continue
      }
      break
    }

    const endTime = clock.currentTimeMillisUnsafe()
    const endFired = clock.sleepsFiredCount()
    const virtualAdvancedMs = endTime - startTime
    const sleepsFired = endFired - startFired

    // Compute per-duration delta histogram for this pump call.
    const firedHistogram: Array<{ durationMillis: number; count: number }> = []
    for (const e of clock.firedHistogram()) {
      const before = histStart.get(e.durationMillis) ?? 0
      const delta = e.count - before
      if (delta > 0) firedHistogram.push({ durationMillis: e.durationMillis, count: delta })
    }
    firedHistogram.sort((a, b) => a.durationMillis - b.durationMillis)

    const periodicSuspects = firedHistogram.filter(
      (e) => e.count > periodicWarnThreshold,
    )

    return {
      virtualAdvancedMs,
      sleepsFired,
      firedHistogram,
      remainingDeadlines: clock.pendingSleeps(),
      hitBudget,
      hitCap,
      realProbeWasUseful,
      periodicSuspects,
    }
  })
