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

import { Effect, Layer } from "effect"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { CallLimiter } from "../../src/call/CallLimiter.js"
import { CallStateCache } from "../../src/call/CallStateCache.js"
import { CdrWriter } from "../../src/cdr/CdrWriter.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { OverloadController } from "../../src/b2bua/OverloadController.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { TracingService } from "../../src/tracing/TracingService.js"
import { UdpTransport } from "../../src/sip/UdpTransport.js"
import { B2buaCoreLayer } from "../../src/b2bua/B2buaCore.js"
import { MockCallControlLayer } from "../fullcall/framework/MockCallControlLayer.js"

/**
 * Default simulated-network transit delay — picked high enough to expose
 * races across forked delivery fibers but low enough that TestClock
 * advances stay cheap. Tests that need a different delay override via
 * `transitDelayMs`; the renderer reads the same value back off
 * `SignalingNetwork.transitDelayMs` (M3).
 */
export const DEFAULT_TRANSIT_DELAY_MS = 15

/**
 * No-op TracingService layer: keeps the API shape but short-circuits
 * every span method. Kept here (not in `src/`) because nothing in
 * production needs a null tracer.
 */
export const NoOpTracingLayer = Layer.succeed(TracingService, {
  decideSampling: () => false,
  withRootSpan: <A, E, R>(opts: {
    readonly name: string
    readonly sampled: boolean
    readonly attributes: Record<string, unknown>
    readonly effect: Effect.Effect<A, E, R>
  }): Effect.Effect<
    { readonly result: A; readonly traceId: string; readonly spanId: string },
    E,
    R
  > => Effect.map(opts.effect, (result) => ({ result, traceId: "", spanId: "" })),
  withProcessingSpan: <A, E, R>(opts: {
    readonly call: any
    readonly name: string
    readonly attributes: Record<string, unknown>
    readonly effect: Effect.Effect<A, E, R>
  }): Effect.Effect<A, E, R> => opts.effect,
  emitSendSpan: () => Effect.void,
  emitTombstone: () => Effect.void,
  withErrorSpan: <A, E, R>(
    _name: string,
    _attributes: Record<string, unknown>,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> => effect,
  emitSpanEvents: () => Effect.void,
  scrubMessage: (raw: string) => raw,
})

/** No-op CdrWriter layer — discards every CDR write. */
export const NoOpCdrLayer = Layer.succeed(CdrWriter, {
  write: (_call: any) => Effect.void,
})

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
  const AppConfigLayer = Layer.succeed(AppConfig, opts.config)
  const NetworkLayer = SignalingNetwork.simulated({
    transitDelayMs: opts.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS,
  })
  const MetricsLayer = MetricsRegistry.layer

  // Leaves with no cross-dependencies — merged once; all consumers that
  // need any of these pull from this single bundle. MockCallControlLayer
  // depends on AppConfig (B.7 translate step); provideMerge wires that
  // dep while still re-exposing AppConfig outward.
  const Leaves = Layer.mergeAll(
    NetworkLayer,
    MetricsLayer,
    CallStateCache.memoryLayer,
    MockCallControlLayer,
    NoOpTracingLayer,
    NoOpCdrLayer
  ).pipe(Layer.provideMerge(AppConfigLayer))

  // Mid-level services — each depends on some subset of the leaves.
  // `provideMerge(Leaves)` both satisfies those deps and exposes the
  // leaves outward, so the final stack surfaces AppConfig, Network, etc.
  const MidServices = Layer.mergeAll(
    UdpTransport.layer,
    OverloadController.layer,
    CallLimiter.memoryLayer
  ).pipe(Layer.provideMerge(Leaves))

  // B2buaCoreLayer (SipRouter, TransactionLayer, CallState, TimerService,
  // SipParser) consumes every mid/leaf service and republishes them.
  return B2buaCoreLayer.pipe(Layer.provideMerge(MidServices))
}
