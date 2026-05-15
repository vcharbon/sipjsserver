/**
 * ReadinessController — drives the worker-level state machine for
 * the replication redesign (Slice 6).
 *
 * Reads `SupervisorState` from `ReplicationSupervisor.observe` and
 * decides the worker state per the rules in
 * [docs/plan/grill-me-on-the-spicy-lark.md](../../docs/plan/grill-me-on-the-spicy-lark.md) §D5.1, §D6:
 *
 *   - Tick interval: 100 ms.
 *   - `T_min = 3 s` floor: stay `Booting` / `Bootstrapping` until at
 *     least this much wall (test-clock) time has elapsed since boot.
 *     Prevents flapping `Ready=true` when no peers exist yet.
 *   - `T_max = 60 s` ceiling: become `Ready` regardless, with a WARN
 *     log naming any peer that has not yet reached `everCaughtUp`.
 *   - Otherwise: become `Ready` once every alive peer has
 *     `everCaughtUp === true`.
 *   - Once `Ready`, stays `Ready` until `Draining`. No `Degraded`,
 *     no `CatchingUp`. Replication issues post-Ready are
 *     observability-only.
 *
 * Worker state values reflect §D5.1's enum:
 *   `Booting | Bootstrapping | Ready | Draining | Terminated`.
 *
 * Side effect: when state transitions to `Ready`, the controller
 * invokes the supplied `markReady(true)` (typically wired to
 * `WorkerReadiness.markReady`). On `Draining`, calls `markReady(false)`.
 *
 * The controller is a pure-by-contract observer of the supervisor;
 * it does not interrupt fibers, fork pullers, or write to local
 * storage. Tests can drive it by feeding a synthetic `observeState`
 * Effect.
 */

import { Clock, Effect, MutableRef } from "effect"
import type { SupervisorState } from "./ReplicationSupervisor.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WorkerState =
  | "Booting"
  | "Bootstrapping"
  | "Ready"
  | "Draining"
  | "Terminated"

export interface ReadinessControllerApi {
  /** Synchronous read of the current worker state. */
  readonly observe: Effect.Effect<WorkerState>
  /** Hook the SIGTERM path calls; flips state to `Draining`. */
  readonly drain: Effect.Effect<void>
}

export interface ReadinessControllerConfig {
  /** Pulled each tick. Typically `supervisor.observe`. */
  readonly observeState: Effect.Effect<SupervisorState>
  /**
   * Invoked on transition Booting/Bootstrapping → Ready (with `true`)
   * and Ready → Draining (with `false`). Idempotent in the
   * implementation, but the controller fires it only on transition.
   */
  readonly markReady: (ready: boolean) => Effect.Effect<void>
  /**
   * Invoked exactly once on the Booting/Bootstrapping → Ready
   * transition with the wall-clock elapsed since boot and the
   * disambiguating reason. Wired by `main.ts` to populate
   * `MetricsRegistry.workerReadiness` so the Prometheus scrape can
   * surface "how long it took to load context on last reboot" — the
   * single number that exposes regressions in cold-boot time. Optional
   * for tests that don't care about the metric.
   */
  readonly recordReady?: (
    elapsedMs: number,
    reason: "all_caught_up" | "t_max_timeout",
  ) => Effect.Effect<void>
  /** Tick interval. Defaults to 100ms. */
  readonly tickIntervalMs?: number
  /** Min wait before flipping Ready. Defaults to 3000ms. */
  readonly tMinMs?: number
  /** Max wait before flipping Ready (with WARN). Defaults to 60000ms. */
  readonly tMaxMs?: number
}

export const DEFAULT_TICK_INTERVAL_MS = 100
export const DEFAULT_T_MIN_MS = 3_000
export const DEFAULT_T_MAX_MS = 60_000

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a ReadinessController. Returns the API + a `run` Effect the
 * caller forks. The run effect ticks forever (`Effect.forever`) until
 * interrupted.
 *
 * Call shape:
 *
 *   const ctrl = makeReadinessController(config)
 *   const fiber = yield* Effect.forkChild(ctrl.run)
 *   ...
 *   yield* ctrl.drain         // on SIGTERM
 *   yield* Fiber.interrupt(fiber)
 */
export const makeReadinessController = (
  config: ReadinessControllerConfig
): {
  readonly run: Effect.Effect<never>
  readonly observe: Effect.Effect<WorkerState>
  readonly drain: Effect.Effect<void>
} => {
  const tickMs = config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
  const tMinMs = config.tMinMs ?? DEFAULT_T_MIN_MS
  const tMaxMs = config.tMaxMs ?? DEFAULT_T_MAX_MS

  const stateRef = MutableRef.make<WorkerState>("Booting")
  // Clamps the once-Ready-stays-Ready invariant: once we set Ready,
  // we can only transition forward to Draining/Terminated.
  let everReady = false

  const drain: Effect.Effect<void> = Effect.gen(function* () {
    const cur = MutableRef.get(stateRef)
    if (cur === "Draining" || cur === "Terminated") return
    MutableRef.set(stateRef, "Draining")
    yield* config.markReady(false)
  })

  const observe: Effect.Effect<WorkerState> = Effect.sync(() =>
    MutableRef.get(stateRef)
  )

  const run: Effect.Effect<never> = Effect.gen(function* () {
    const bootMs = yield* Clock.currentTimeMillis
    return yield* Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(`${tickMs} millis`)
        const cur = MutableRef.get(stateRef)

        // Once Ready or Draining/Terminated, the controller stops
        // computing state — those states are terminal modulo SIGTERM
        // (which calls `drain` directly).
        if (cur !== "Booting" && cur !== "Bootstrapping") return

        const now = yield* Clock.currentTimeMillis
        const elapsed = now - bootMs

        const sup = yield* config.observeState
        const alive = sup.alivePeers
        const totalAlive = alive.size

        // First peer seen → Bootstrapping.
        if (cur === "Booting" && totalAlive > 0) {
          MutableRef.set(stateRef, "Bootstrapping")
        }

        if (elapsed < tMinMs) return

        // T_min satisfied. Compute readiness.
        const allCaughtUp = (() => {
          for (const peer of alive) {
            const view = sup.perPeer.get(peer)
            if (view === undefined) return false
            if (!view.everCaughtUp) return false
          }
          return true
        })()

        if (allCaughtUp) {
          if (everReady) return
          everReady = true
          MutableRef.set(stateRef, "Ready")
          yield* Effect.logInfo(
            `ReadinessController: Ready in ${elapsed}ms (reason=all_caught_up, peers=${totalAlive})`
          )
          if (config.recordReady !== undefined) {
            yield* config.recordReady(elapsed, "all_caught_up")
          }
          yield* config.markReady(true)
          return
        }

        if (elapsed >= tMaxMs) {
          // T_max ceiling — flip Ready with a WARN naming the
          // not-yet-caught peers. This is the "switched to active by
          // timeout, not by positive evidence" path the operator must
          // see loud in logs and dashboards.
          if (everReady) return
          const stalled: Array<string> = []
          for (const peer of alive) {
            const view = sup.perPeer.get(peer)
            if (view === undefined || !view.everCaughtUp) {
              stalled.push(String(peer))
            }
          }
          yield* Effect.logWarning(
            `ReadinessController: T_max=${tMaxMs}ms ceiling reached; flipping Ready with un-caught peers: [${stalled.join(", ")}] (reason=t_max_timeout, elapsed=${elapsed}ms)`
          )
          everReady = true
          MutableRef.set(stateRef, "Ready")
          if (config.recordReady !== undefined) {
            yield* config.recordReady(elapsed, "t_max_timeout")
          }
          yield* config.markReady(true)
        }
      })
    )
  })

  return { run, observe, drain }
}
