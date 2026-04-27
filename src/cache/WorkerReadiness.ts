/**
 * WorkerReadiness — D9 (reclaim-gating via K8s readiness) of the
 * HA-resilience plan. Single source of truth for whether this worker
 * answers the kubelet `/ready` probe with 200 (ready, accepting
 * traffic) or 503 (not-ready, currently reclaiming).
 *
 * Distinct from `DrainingState` (`src/b2bua/DrainingState.ts`):
 *   - `DrainingState` flips on SIGTERM (shutdown path); it controls
 *     whether the worker accepts NEW calls.
 *   - `WorkerReadiness` flips during startup-time reclaim (boot path);
 *     it controls whether K8s sends the worker any traffic at all.
 *
 * Both eventually feed into a single kubelet probe in production
 * (typically `currentReady && !isDraining`), but they're orthogonal
 * lifecycle concerns and live in separate services so neither has to
 * know about the other.
 *
 * Default state is **not-ready** at construction (D9): the worker
 * stays out of the K8s Service until `ReclaimRunner` flips it ready.
 * Production wiring is not part of slice 6 — it lands with slice 9
 * (StatefulSet manifest + `/ready` route in `StatusServer`).
 */

import { Effect, Layer, MutableRef, ServiceMap } from "effect"

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface WorkerReadinessApi {
  /** Read the current ready flag. Non-suspending; a single ref read. */
  readonly currentReady: Effect.Effect<boolean>
  /**
   * Flip the ready flag. Idempotent. ReclaimRunner sets `false` at
   * startup and `true` on completion or `maxDuration` timeout.
   */
  readonly markReady: (ready: boolean) => Effect.Effect<void>
}

export class WorkerReadiness extends ServiceMap.Service<
  WorkerReadiness,
  WorkerReadinessApi
>()("@sipjsserver/cache/WorkerReadiness") {
  /**
   * Production layer. Initial state `false` per D9 — the worker stays
   * not-ready until ReclaimRunner explicitly marks it ready.
   *
   * `MutableRef` (not `Ref`) so the API exposes synchronous-feeling
   * `Effect.sync` reads on the hot path — same trick as `DrainingState`.
   */
  static readonly Default: Layer.Layer<WorkerReadiness> = Layer.sync(
    WorkerReadiness,
    () => makeApi(false)
  )

  /**
   * Test layer with a configurable initial state. Defaults to `false`
   * to mirror production, but tests that want to skip the
   * not-ready-while-reclaiming gate (e.g. a happy-path call test)
   * can pass `true`.
   */
  static readonly test = (initialReady = false): Layer.Layer<WorkerReadiness> =>
    Layer.sync(WorkerReadiness, () => makeApi(initialReady))
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const makeApi = (initial: boolean): WorkerReadinessApi => {
  const ref = MutableRef.make<boolean>(initial)
  return {
    currentReady: Effect.sync(() => MutableRef.get(ref)),
    markReady: (ready: boolean) =>
      Effect.sync(() => {
        MutableRef.set(ref, ready)
      }),
  }
}
