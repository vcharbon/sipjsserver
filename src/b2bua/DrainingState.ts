/**
 * DrainingState — two-tier graceful drain protocol (ADR-0008).
 *
 * The worker walks `serving → draining-new → draining-quiet → exit` after
 * SIGTERM. Each transition has a distinct effect on how the proxy treats
 * the worker:
 *
 *   - `serving`: OPTIONS → 200 OK with normal `X-Overload`. Normal routing.
 *   - `draining-new`: OPTIONS → 200 OK but with `X-Overload: elu=1.0;
 *     reason=draining; ...`. The proxy's `WorkerLoadObserver` puts the
 *     worker in the `above_critical` ELU band, which excludes it from
 *     `selectForNewDialog`. In-dialog routing is unchanged so live calls
 *     keep flowing through this worker for the `drainGraceMs=5s` window
 *     while replication keeps the peer's `bak:` partition current.
 *   - `draining-quiet`: OPTIONS get no reply at all. The proxy's
 *     `HealthProbe` flips the worker to `dead` after `unhealthyAfterMisses`
 *     consecutive timeouts; in-dialog falls back via `selectForNewDialog`
 *     to the peer worker (which serves the calls out of `bak:`).
 *
 * Production layer installs a SIGTERM handler that forks an orchestrator
 * fiber walking `draining-new → sleep(DRAIN_TIER1_MS) → draining-quiet →
 * sleep(DRAIN_TIER2_MS) → process.exit(0)`. The orchestrator is detached
 * (`Effect.forkDetach`) so it survives Layer teardown — the whole point
 * is that it outlives the application and ends the process itself.
 *
 * Test layer exposes the same surface with NO SIGTERM hook and NO
 * orchestrator; tests drive `markDrainingNew` / `markDrainingQuiet` /
 * `markServing` directly.
 *
 * The proxy-side counterpart (`HealthProbe` + `WorkerLoadObserver`) lives
 * in `src/sip-front-proxy/`. The two NEVER cross-import: the proxy reads
 * the worker's state out of OPTIONS replies over UDP. See ADR-0008 for
 * the full protocol + invariants.
 */

import { Deferred, Effect, Layer, MutableRef, ServiceMap } from "effect"

// ---------------------------------------------------------------------------
// Timing constants (ADR-0008 invariants)
// ---------------------------------------------------------------------------

/**
 * Tier 1 duration: how long the worker stays in `draining-new` before
 * silencing OPTIONS. Sized to 3 × proxy OPTIONS interval (1 s) so the
 * proxy is guaranteed to observe the new band at least once before the
 * worker disappears from the LB-visible candidate set. Lower this only if
 * `optionsIntervalMs` is also lowered.
 */
export const DRAIN_TIER1_MS = 3_000

/**
 * Tier 2 duration: how long the worker stays in `draining-quiet` before
 * exiting. Sized to cover the proxy's `unhealthyAfterMisses ×
 * optionsIntervalMs` detection window plus a ~1-2 s replication-settle
 * margin. Lowering it risks in-dialog requests arriving at an
 * already-exited worker after the proxy's last LB tick.
 */
export const DRAIN_TIER2_MS = 5_000

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DrainingMode = "serving" | "draining-new" | "draining-quiet"

export interface DrainingStateApi {
  /** Read the current mode. Strictly non-suspending: a single `MutableRef.get`. */
  readonly mode: Effect.Effect<DrainingMode>
  /** Flip the mode to `'draining-new'` (tier 1). Idempotent. */
  readonly markDrainingNew: Effect.Effect<void>
  /** Flip the mode to `'draining-quiet'` (tier 2). Idempotent. */
  readonly markDrainingQuiet: Effect.Effect<void>
  /**
   * Flip the mode to `'serving'`. Idempotent. Production never calls this —
   * exposed so unit tests can flip back without rebuilding the layer.
   */
  readonly markServing: Effect.Effect<void>
}

export class DrainingState extends ServiceMap.Service<DrainingState, DrainingStateApi>()(
  "@sipjsserver/b2bua/DrainingState"
) {
  /**
   * Production layer. Installs a SIGTERM handler that releases a Deferred;
   * a detached orchestrator fiber awaits the Deferred, walks the modes,
   * and calls `process.exit(0)` when done. The fiber is detached so it
   * outlives Layer teardown — the orchestrator is what *ends* the process.
   */
  static readonly Default: Layer.Layer<DrainingState> = Layer.effect(
    DrainingState,
    Effect.gen(function* () {
      const ref = MutableRef.make<DrainingMode>("serving")
      const trigger = yield* Deferred.make<void>()
      const parentServices = yield* Effect.services<never>()

      yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* Deferred.await(trigger)
          MutableRef.set(ref, "draining-new")
          yield* Effect.logInfo(
            `drain: tier 1 (draining-new) — proxy excludes from new-INVITE selection; ` +
              `holding ${DRAIN_TIER1_MS}ms for OPTIONS round-trip`
          )
          yield* Effect.sleep(`${DRAIN_TIER1_MS} millis`)
          MutableRef.set(ref, "draining-quiet")
          yield* Effect.logInfo(
            `drain: tier 2 (draining-quiet) — OPTIONS silenced; holding ${DRAIN_TIER2_MS}ms ` +
              `for HealthProbe unhealthy detection + replication settle`
          )
          yield* Effect.sleep(`${DRAIN_TIER2_MS} millis`)
          yield* Effect.logInfo(`drain: exit`)
          return yield* Effect.sync(() => process.exit(0) as never)
        })
      )

      const onSigterm = (): void => {
        Effect.runForkWith(parentServices)(Deferred.succeed(trigger, undefined))
      }
      process.on("SIGTERM", onSigterm)

      return {
        mode: Effect.sync(() => MutableRef.get(ref)),
        markDrainingNew: Effect.sync(() => {
          MutableRef.set(ref, "draining-new")
        }),
        markDrainingQuiet: Effect.sync(() => {
          MutableRef.set(ref, "draining-quiet")
        }),
        markServing: Effect.sync(() => {
          MutableRef.set(ref, "serving")
        }),
      } satisfies DrainingStateApi
    })
  )

  /**
   * Test layer: same surface, NO SIGTERM hook, NO orchestrator. Tests
   * walk the modes explicitly via `markDrainingNew` / `markDrainingQuiet` /
   * `markServing`.
   */
  static readonly test: Layer.Layer<DrainingState> = Layer.effect(
    DrainingState,
    Effect.sync(() => {
      const ref = MutableRef.make<DrainingMode>("serving")
      return {
        mode: Effect.sync(() => MutableRef.get(ref)),
        markDrainingNew: Effect.sync(() => {
          MutableRef.set(ref, "draining-new")
        }),
        markDrainingQuiet: Effect.sync(() => {
          MutableRef.set(ref, "draining-quiet")
        }),
        markServing: Effect.sync(() => {
          MutableRef.set(ref, "serving")
        }),
      } satisfies DrainingStateApi
    })
  )
}
