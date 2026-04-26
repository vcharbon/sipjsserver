/**
 * FakeStackLayer — the in-process, in-memory B2BUA stack used by
 * fake-clock tests. Every service is either a real implementation driven
 * by `Clock.currentTimeMillis` (so TestClock can virtualise it) or a
 * pure-in-memory stand-in.
 *
 * Composition, bottom-up:
 *   - `AppConfig`, `MetricsRegistry`                     — plain values
 *   - `SignalingNetwork.simulated`                        — bidirectional,
 *       routing-by-(ip,port) fake UDP fabric
 *   - `UdpTransport` bound on that fabric
 *   - `CallStateCache.memoryLayer`, `CallLimiter.memoryLayer`
 *   - `MockCallControlLayer`, `NoOpTracingLayer`, `NoOpCdrLayer`
 *   - `OverloadController`
 *   - `B2buaCoreLayer` (`SipRouter`, `TransactionLayer`, `CallState`,
 *     `TimerService`, `SipParser`)
 *
 * ## Sharing rule
 *
 * Every leaf (AppConfig, SignalingNetwork, MetricsRegistry, ...) is
 * defined **exactly once** inside this function, and every consumer
 * that needs it gets it from the same `Leaves` bundle. The previous
 * iteration of this module used `Layer.provide(leaf)` on each
 * intermediate layer AND `Layer.provideMerge(leaf)` at the outer chain
 * — that produced two distinct `SignalingNetwork` instances (one inside
 * `UdpLayer`, one at the top), so `UdpTransport` bound on a different
 * fabric than the one agents bound on and every test hung. The shape
 * below keeps each leaf singular by wiring it through `provideMerge`
 * exactly once.
 *
 * The result exposes every service outwards, so a test can yield
 * `SignalingNetwork` / `CallState` / `SipRouter` under the same
 * `Effect.provide(fakeStackLayer(...))` and observe the exact instance
 * the router sees. This is the durable replacement for the old pattern
 * in `simulated-backend.ts` that built a second `CallState` for
 * post-scenario stats — which worked only because both instances shared
 * Redis, and breaks silently under `memoryLayer`.
 *
 * Sibling to `liveStack.ts` (real Redis, real UDP); the two must never
 * be mixed in a single test — that's the point of the fake/live split.
 */

import { Layer } from "effect"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { b2buaWorkerStackLayer, NoOpCdrLayer, NoOpTracingLayer } from "./networkLeaves.js"

/**
 * Default simulated-network transit delay — picked high enough to expose
 * races across forked delivery fibers but low enough that TestClock
 * advances stay cheap. Tests that need a different delay override via
 * `transitDelayMs`; the renderer reads the same value back off
 * `SignalingNetwork.transitDelayMs` (M3).
 */
export const DEFAULT_TRANSIT_DELAY_MS = 15

// Re-export for callers that imported these directly from fakeStack.ts.
export { NoOpCdrLayer, NoOpTracingLayer }

/**
 * Build the full fake stack for a given `AppConfigData`.
 *
 * Returned layer exposes every service built by the stack — agents and
 * B2BUA share exactly one `SignalingNetwork`, one `CallStateCache`, one
 * `CallState`, etc. Any test that yields those services under
 * `Effect.provide(fakeStackLayer(...))` sees the router's instance.
 */
export function fakeStackLayer(opts: {
  readonly config: AppConfigData
  readonly transitDelayMs?: number
}) {
  const NetworkLayer = SignalingNetwork.simulated({
    transitDelayMs: opts.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS,
  })
  return b2buaWorkerStackLayer({ config: opts.config }).pipe(
    Layer.provideMerge(NetworkLayer),
  )
}
