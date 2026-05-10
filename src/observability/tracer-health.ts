/**
 * Tracer kill-switch (Slice 5.3 of
 * docs/plan/endurance-stuck-terminating-and-overload-hardening.md).
 *
 * Under sustained OTel collector unavailability the BSP's bounded
 * queue eventually saturates. Continuing to allocate `SpanImpl` /
 * `OtelSpan` / `BaseContext` per request piles in-flight context
 * onto the heap faster than the BSP can shed it. The kill switch
 * raises a flag when BSP queue depth crosses 80 % of capacity for
 * ≥ 3 consecutive samples and lowers it once depth dips below 50 %.
 *
 * `TracingService` consults the flag — when raised, the per-request
 * span APIs (`withRootSpan`, `withProcessingSpan`, `emitSendSpan`)
 * fall through to the underlying effect without allocating spans.
 * `withErrorSpan` keeps tracing on (errors are rare and worth the
 * diagnostics).
 *
 * Counters survive a flap so operators see how many times the switch
 * has tripped within a deployment lifetime.
 */

import { Effect, Layer, MutableRef, ServiceMap } from "effect"

export type TracerDisabledReason = "bsp_saturated"

export interface TracerHealthSignalApi {
  /** Synchronous readback for the per-request hot path. */
  readonly isSaturated: () => boolean
  /** Per-reason transition counter — surfaced as `b2bua_otel_tracer_disabled_total`. */
  readonly disabledTotal: () => Record<TracerDisabledReason, number>
  /**
   * Raise / lower the saturation flag for `reason`. Idempotent: a
   * second `raise` for the same reason does NOT bump the transition
   * counter. The supervisor in `runTracerHealthSupervisor` is the
   * sole legitimate caller in production; tests poke this directly.
   */
  readonly setSaturated: (reason: TracerDisabledReason, value: boolean) => Effect.Effect<void>
}

export class TracerHealthSignal extends ServiceMap.Service<
  TracerHealthSignal,
  TracerHealthSignalApi
>()("@sipjsserver/TracerHealthSignal") {
  /** Always-healthy default — the right choice for tests + dev. */
  static readonly noop: Layer.Layer<TracerHealthSignal> = Layer.sync(
    TracerHealthSignal,
    () => ({
      isSaturated: () => false,
      disabledTotal: () => ({ bsp_saturated: 0 }),
      setSaturated: () => Effect.void,
    }),
  )

  /**
   * Live signal backed by mutable state. The supervisor toggles via
   * `setSaturated`; callers read via `isSaturated`. Counters increment
   * only on a true 0→1 / 1→0 transition.
   */
  static readonly live: Layer.Layer<TracerHealthSignal> = Layer.sync(
    TracerHealthSignal,
    () => {
      const flags: Record<TracerDisabledReason, MutableRef.MutableRef<boolean>> = {
        bsp_saturated: MutableRef.make(false),
      }
      const counters: Record<TracerDisabledReason, number> = {
        bsp_saturated: 0,
      }
      const anyRaised = (): boolean => MutableRef.get(flags.bsp_saturated)

      const setSaturated = (reason: TracerDisabledReason, value: boolean) =>
        Effect.gen(function* () {
          const ref = flags[reason]
          const prev = MutableRef.get(ref)
          if (prev === value) return
          MutableRef.set(ref, value)
          if (value) {
            counters[reason]++
            yield* Effect.logWarning(
              `[otel] tracer kill-switch raised (reason=${reason})`,
            )
          } else {
            yield* Effect.logInfo(
              `[otel] tracer kill-switch lowered (reason=${reason})`,
            )
          }
        })

      return {
        isSaturated: anyRaised,
        disabledTotal: () => ({ ...counters }),
        setSaturated,
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Supervisor — periodic poll of BSP queue depth → toggle the flag
// ---------------------------------------------------------------------------

/**
 * Run an indefinite poll loop that watches the supplied BSP-depth
 * function and raises / lowers the saturation flag with hysteresis:
 *
 *   - Raise when depth ≥ 80 % of `maxQueueSize` for `raiseSamples`
 *     consecutive samples (default: 3 at 1 Hz → ≥ 3 s sustained).
 *   - Lower when depth ≤ 50 % of `maxQueueSize` for `lowerSamples`
 *     consecutive samples (default: 3 at 1 Hz → ≥ 3 s sustained).
 *
 * The hysteresis avoids flapping when depth oscillates around either
 * threshold during steady-state load.
 */
export const runTracerHealthSupervisor = (opts: {
  readonly queueDepth: () => number
  readonly maxQueueSize: number
  readonly pollIntervalMs?: number
  readonly raiseSamples?: number
  readonly lowerSamples?: number
}): Effect.Effect<never, never, TracerHealthSignal> =>
  Effect.gen(function* () {
    const signal = yield* TracerHealthSignal
    const pollMs = opts.pollIntervalMs ?? 1000
    const raiseSamples = opts.raiseSamples ?? 3
    const lowerSamples = opts.lowerSamples ?? 3
    const raiseAt = Math.floor(opts.maxQueueSize * 0.8)
    const lowerAt = Math.floor(opts.maxQueueSize * 0.5)
    let aboveRaiseStreak = 0
    let belowLowerStreak = 0

    while (true) {
      yield* Effect.sleep(`${pollMs} millis`)
      const depth = opts.queueDepth()
      if (depth >= raiseAt) {
        aboveRaiseStreak++
        belowLowerStreak = 0
        if (aboveRaiseStreak >= raiseSamples && !signal.isSaturated()) {
          yield* signal.setSaturated("bsp_saturated", true)
        }
      } else if (depth <= lowerAt) {
        belowLowerStreak++
        aboveRaiseStreak = 0
        if (belowLowerStreak >= lowerSamples && signal.isSaturated()) {
          yield* signal.setSaturated("bsp_saturated", false)
        }
      } else {
        aboveRaiseStreak = 0
        belowLowerStreak = 0
      }
    }
  }) as Effect.Effect<never, never, TracerHealthSignal>
