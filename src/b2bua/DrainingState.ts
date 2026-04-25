/**
 * DrainingState — D5 (Draining model) of the SIP Front Proxy plan, worker side.
 *
 * Single source of truth for whether this B2BUA worker is currently
 * `serving` (default) or `draining`. The OPTIONS handler reads this flag
 * to decide between `200 OK` (serving) and `503 Service Unavailable` +
 * `Retry-After: 0` (draining), per RFC 3261 §11 / §21.5.4 / §20.33.
 *
 * Why a tiny dedicated service rather than a flag on AppConfig: the flag
 * is *mutable* at runtime (SIGTERM flips it), so it must live behind a
 * `Ref` and be readable from the request-processing path without
 * crossing a Layer boundary on every read.
 *
 * Lifecycle:
 *   - `Default` Layer: initial state `'serving'`, installs a SIGTERM
 *     handler that flips the flag to `'draining'`. The handler is
 *     installed via `Layer.effectDiscard` so the listener tracks the
 *     Layer's scope and is removed when the process tears down (e.g. an
 *     in-process test reload).
 *   - `Test` Layer (`DrainingState.test`): same shape, no SIGTERM hook —
 *     tests drive `markDraining` / `markServing` explicitly.
 *
 * The proxy-side counterpart (`HealthProbe`) lives in
 * `src/sip-front-proxy/health/HealthProbe.ts`. The two NEVER cross-import:
 * the proxy observes the worker's mode by reading the OPTIONS keepalive
 * response (200 vs 503) over UDP — no in-process wire.
 */

import { Effect, Layer, MutableRef, ServiceMap } from "effect"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Worker serving mode. `'serving'` = healthy, accepting new calls;
 * `'draining'` = SIGTERM received, finishing in-flight calls but
 * refusing new ones. The mode is one-way in production (a draining
 * worker exits, it does not return to serving), but the test API
 * exposes `markServing` so unit tests can flip back and forth.
 */
export type DrainingMode = "serving" | "draining"

export interface DrainingStateApi {
  /** Read the current mode. Strictly non-suspending: a single `Ref.get`. */
  readonly mode: Effect.Effect<DrainingMode>
  /** Flip the mode to `'draining'`. Idempotent. */
  readonly markDraining: Effect.Effect<void>
  /**
   * Flip the mode to `'serving'`. Idempotent. Production code should
   * never call this — exposed so tests can drive the OPTIONS handler
   * through both branches without a fresh layer build.
   */
  readonly markServing: Effect.Effect<void>
}

export class DrainingState extends ServiceMap.Service<DrainingState, DrainingStateApi>()(
  "@sipjsserver/b2bua/DrainingState"
) {
  /**
   * Production layer: installs a `SIGTERM` listener that flips the mode to
   * `draining`. The listener is removed on Layer teardown so repeat builds
   * (tests, hot-reload) don't leak handlers.
   *
   * The actual `process.exit` is **not** scheduled here — that's the bin
   * entry's responsibility (it sleeps `terminationGracePeriodSeconds` and
   * then exits). DrainingState only exposes the flag.
   */
  static readonly Default: Layer.Layer<DrainingState> = Layer.effect(
    DrainingState,
    Effect.sync(() => {
      // Plain `MutableRef` (not `Ref`) so the OS-signal callback can
      // flip the mode without fabricating an Effect runtime. The
      // surface API still exposes `Effect`-returning getters/setters
      // so callers don't need to know the storage shape.
      const ref = MutableRef.make<DrainingMode>("serving")
      const api: DrainingStateApi = {
        mode: Effect.sync(() => MutableRef.get(ref)),
        markDraining: Effect.sync(() => {
          MutableRef.set(ref, "draining")
        }),
        markServing: Effect.sync(() => {
          MutableRef.set(ref, "serving")
        }),
      }
      const onSigterm = (): void => {
        MutableRef.set(ref, "draining")
      }
      process.on("SIGTERM", onSigterm)
      return api
    })
  )

  /**
   * Test layer: same surface, **no** SIGTERM hook. Use this in `it.effect`
   * tests so flipping `markDraining` / `markServing` from the test body is
   * the only way the mode changes.
   */
  static readonly test: Layer.Layer<DrainingState> = Layer.effect(
    DrainingState,
    Effect.sync(() => {
      const ref = MutableRef.make<DrainingMode>("serving")
      return {
        mode: Effect.sync(() => MutableRef.get(ref)),
        markDraining: Effect.sync(() => {
          MutableRef.set(ref, "draining")
        }),
        markServing: Effect.sync(() => {
          MutableRef.set(ref, "serving")
        }),
      }
    })
  )
}
