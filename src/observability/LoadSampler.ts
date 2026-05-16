/**
 * LoadSampler — current-load reader service.
 *
 * Exposes two snapshot reads consumed by the per-worker overload
 * signal pipeline (slice 2: worker stamps `X-Overload` on OPTIONS
 * replies; slice 6: proxy gates external new-dialog INVITEs on its
 * own ELU). Both reads return a `0..1` ratio of the wall time since
 * the previous call.
 *
 *   elu()         — Event Loop Utilization (Node `perf_hooks`).
 *                   Includes major GC pauses ("loop is busy").
 *   gcFraction()  — Fraction of wall time spent in GC pauses
 *                   (PerformanceObserver "gc" entries).
 *
 * Smoothing (EWMA) is the consumer's responsibility, not the
 * sampler's — keeps the test fixture simple (inject a raw value, no
 * convergence wait).
 *
 * Two layer implementations:
 *   - `liveLayer` — perf_hooks-backed; production.
 *   - `simulatedLayer()` — ref-backed; provides BOTH `LoadSampler`
 *     and `LoadSamplerSimulatedControl` so a test can set values and
 *     have the same closure read them back.
 */

import { Effect, Layer, MutableRef, ServiceMap } from "effect"
import { PerformanceObserver, performance } from "node:perf_hooks"

const clamp01 = (v: number): number => {
  if (!Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

// ---------------------------------------------------------------------------
// Public read surface
// ---------------------------------------------------------------------------

export interface LoadSamplerApi {
  /** Event Loop Utilization since the previous `elu()` call (0..1). */
  readonly elu: () => number
  /** Fraction of wall time spent in GC pauses since the previous `gcFraction()` call (0..1). */
  readonly gcFraction: () => number
}

export class LoadSampler extends ServiceMap.Service<LoadSampler, LoadSamplerApi>()(
  "@sipjsserver/LoadSampler",
) {
  static readonly liveLayer: Layer.Layer<LoadSampler> = Layer.effect(
    LoadSampler,
    Effect.gen(function* () {
      // ELU baseline. `performance.eventLoopUtilization()` returns a
      // monotonic ELU object; passing two of them to the same call
      // yields the delta in between.
      let prevElu = performance.eventLoopUtilization()

      // GC pause accumulator, reset on every `gcFraction()` read.
      const gcState = {
        pauseMsSinceRead: 0,
        lastReadAtMs: Date.now(),
      }
      const gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          gcState.pauseMsSinceRead += entry.duration
        }
      })
      gcObserver.observe({ type: "gc", buffered: false })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => gcObserver.disconnect()),
      )

      const elu = (): number => {
        const curr = performance.eventLoopUtilization()
        const delta = performance.eventLoopUtilization(curr, prevElu)
        prevElu = curr
        return clamp01(delta.utilization)
      }

      const gcFraction = (): number => {
        const now = Date.now()
        const wallMs = now - gcState.lastReadAtMs
        const pauseMs = gcState.pauseMsSinceRead
        gcState.pauseMsSinceRead = 0
        gcState.lastReadAtMs = now
        if (wallMs <= 0) return 0
        return clamp01(pauseMs / wallMs)
      }

      return { elu, gcFraction }
    }),
  )
}

// ---------------------------------------------------------------------------
// Test-only control surface
// ---------------------------------------------------------------------------

export interface LoadSamplerSimulatedControlApi {
  /** Set the next `elu()` reading. Clamped to [0,1]. */
  readonly setElu: (v: number) => void
  /** Set the next `gcFraction()` reading. Clamped to [0,1]. */
  readonly setGcFraction: (v: number) => void
}

export class LoadSamplerSimulatedControl extends ServiceMap.Service<
  LoadSamplerSimulatedControl,
  LoadSamplerSimulatedControlApi
>()("@sipjsserver/LoadSamplerSimulatedControl") {}

/**
 * Simulated layer — single closure backs both the read surface and
 * the control surface, so a test that yields `LoadSamplerSimulatedControl`
 * and calls `setElu(0.85)` will see `0.85` from `LoadSampler.elu()`
 * on the same fiber.
 */
export const simulatedLayer = (): Layer.Layer<
  LoadSampler | LoadSamplerSimulatedControl
> =>
  Layer.effectServices(
    Effect.sync(() => {
      const eluRef = MutableRef.make(0)
      const gcRef = MutableRef.make(0)

      const sampler: LoadSamplerApi = {
        elu: () => MutableRef.get(eluRef),
        gcFraction: () => MutableRef.get(gcRef),
      }
      const control: LoadSamplerSimulatedControlApi = {
        setElu: (v) => MutableRef.set(eluRef, clamp01(v)),
        setGcFraction: (v) => MutableRef.set(gcRef, clamp01(v)),
      }

      return ServiceMap.empty().pipe(
        ServiceMap.add(LoadSampler, sampler),
        ServiceMap.add(LoadSamplerSimulatedControl, control),
      )
    }),
  )
