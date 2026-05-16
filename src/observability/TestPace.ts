/**
 * TestPace — async-work registry for fake-clock quiescence detection.
 *
 * The fake-clock test harness (`tests/support/pumpAll.ts` +
 * `tests/support/PumpableClock.ts`) decides when virtual time is safe
 * to advance based on `pendingSleeps + simulated-network in-flight`.
 * Some async producers — `PerCallDispatcher`'s worker fibers parked on
 * `Queue.take` being the canonical example — are invisible to both of
 * those signals. Without a third channel, the test fiber races ahead
 * of the producer and asserts state that hasn't been written yet.
 *
 * `TestPace` is that third channel: producers call `beginWork()` when
 * they submit an async unit and `endWork()` when it finishes.
 * `PumpableClock.adjust` drains `pendingWork()` to zero between latch
 * fires (with a bounded yield budget so a stuck handler can't loop
 * forever).
 *
 * Production composition omits this layer (or uses the noop default
 * below) and pays nothing at runtime — the producer's
 * `Effect.serviceOption(TestPace)` returns `None` and the
 * begin/end calls become no-ops.
 *
 * Pattern recap: any code that needs the "ensure my async work is
 * visible to fake-clock quiescence" hook can take this dependency.
 * It is intentionally narrower than wrapping Clock itself — `TestPace`
 * stays orthogonal to Clock semantics.
 */

import { Layer, ServiceMap } from "effect"

export interface TestPaceShape {
  /** Mark the start of one async unit of work. */
  readonly beginWork: () => void
  /** Mark the end of one async unit of work. */
  readonly endWork: () => void
  /** Snapshot of currently-pending async work count. */
  readonly pendingWork: () => number
}

export class TestPace extends ServiceMap.Service<TestPace, TestPaceShape>()(
  "@sipjsserver/TestPace",
) {
  /**
   * No-op pace — production deployments use this (or simply omit the
   * service entirely; producers' `Effect.serviceOption` will return
   * `None`). Mostly here so test stacks that *don't* run under
   * `PumpableClock` (rare) still compose without a missing-service
   * error if some downstream code requires `TestPace` directly.
   */
  static readonly noopLayer: Layer.Layer<TestPace> = Layer.succeed(TestPace, {
    beginWork: () => {},
    endWork: () => {},
    pendingWork: () => 0,
  })
}
