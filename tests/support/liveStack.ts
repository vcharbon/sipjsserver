/**
 * LiveStackLayer — the in-process, real-infrastructure B2BUA stack used
 * by live-clock tests that drive a real UDP socket, real Redis, and a
 * real HTTP call-control server.
 *
 * This is the direct sibling of `fakeStack.ts`:
 *   - `SignalingNetwork.real`             (replaces the simulated fabric)
 *   - `CallStateCache.redisLayer`         (replaces `memoryLayer`)
 *   - `CallLimiter.redisLayer`            (replaces `memoryLayer`)
 *   - `HttpReferenceAdapterLayer`         (real HTTP, replaces Mock)
 *   - `TracingService.layer`              (real OTel, replaces NoOp)
 *   - `CdrWriter.layer`                   (real file writer, replaces NoOp)
 *
 * Not used by the existing `createLiveRunner` path — that helper drives
 * an *external* B2BUA process over real UDP and does not instantiate a
 * service layer at all. `liveStackLayer` is the in-process live-clock
 * harness for tests that want real Redis + real-UDP behaviour inside
 * the same `Effect.provide` scope as the test. Kept here so the
 * fake/live split has a symmetrical pair (spec requirement); the first
 * consumer will be a live-tier scenario runner added in B.4/B.5.
 */

import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { HttpReferenceAdapterLayer } from "../../src/decision/adapters/http-reference/HttpReferenceAdapter.js"
import { CallLimiter } from "../../src/call/CallLimiter.js"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"
import { EpochCounter } from "../../src/replication/EpochCounter.js"
import { CdrWriter } from "../../src/cdr/CdrWriter.js"
import { BufferedTerminateWriter } from "../../src/cache/BufferedTerminateWriter.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { LoadSampler } from "../../src/observability/LoadSampler.js"
import { OverloadController } from "../../src/b2bua/OverloadController.js"
import { RedisClient } from "../../src/redis/RedisClient.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { TracingService } from "../../src/tracing/TracingService.js"
import { TracerHealthSignal } from "../../src/observability/tracer-health.js"
import { UdpTransport } from "../../src/sip/UdpTransport.js"
import { B2buaCoreLayer } from "../../src/b2bua/B2buaCore.js"
import { DrainingState } from "../../src/b2bua/DrainingState.js"
import { WorkerReadiness } from "../../src/cache/WorkerReadiness.js"

/**
 * Build the full live stack for a given `AppConfigData`. Every backing
 * service is its production implementation — there is deliberately no
 * knob to swap any one of them out. If a test needs to mix (e.g. real
 * Redis + mock call-control) it is in the wrong harness and should
 * either use `fakeStack.ts` or run against an external B2BUA.
 */
export function liveStackLayer(opts: {
  readonly config: AppConfigData
}) {
  const AppConfigLayer = Layer.succeed(AppConfig, opts.config)
  const MetricsLayer = MetricsRegistry.layer
  // `realTracing` (not `real`): the live harness renders hop-by-hop
  // reports via `drainTrace()`. Production layers MUST use `real`
  // (recording disabled) — `realTracing` retains every Buffer payload
  // forever, which leaks under sustained load.
  const NetworkLayer = SignalingNetwork.realTracing()

  const RedisLayer = RedisClient.layer.pipe(Layer.provide(AppConfigLayer))

  // EpochCounter — Slice 7c new model: gen derived from Date.now()
  // for live tests. (Production uses fromKubernetesDownwardAPI.)
  const EpochCounterLayer = EpochCounter.fromWallClock("live-test-self")

  const CallStateCacheLayer = Layer.unwrap(
    Effect.gen(function* () {
      const epoch = yield* EpochCounter
      return PartitionedRelayStorage.redisLayer({
        self: "live-test-self",
        gen: epoch.gen,
      })
    })
  ).pipe(Layer.provide(RedisLayer), Layer.provide(EpochCounterLayer))
  const CallLimiterLayer = CallLimiter.redisLayer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(RedisLayer),
    Layer.provide(MetricsLayer)
  )

  const UdpLayer = UdpTransport.layer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(MetricsLayer),
    Layer.provide(NetworkLayer)
  )

  const OverloadLayer = OverloadController.layer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(MetricsLayer),
    Layer.provide(LoadSampler.liveLayer)
  )

  const CallControlLayer = HttpReferenceAdapterLayer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(OverloadLayer)
  )

  const TracingLayer = TracingService.layer.pipe(
    Layer.provide(AppConfigLayer),
    // Slice 5.3 — live stack doesn't run a BSP supervisor, so wire
    // the always-healthy noop signal so the per-request hot path in
    // TracingService is never gated.
    Layer.provide(TracerHealthSignal.noop),
  )
  const CdrLayer = CdrWriter.layer.pipe(Layer.provide(AppConfigLayer))
  // Phase 4 — live stack uses the test config defaults (storageBufferQueueMax: 0)
  // so this resolves to a passthrough.
  const BufferedTerminateL = BufferedTerminateWriter.layer.pipe(
    Layer.provide(CallStateCacheLayer),
    Layer.provide(AppConfigLayer),
    Layer.provide(MetricsLayer),
  )

  return B2buaCoreLayer.pipe(
    Layer.provideMerge(UdpLayer),
    Layer.provideMerge(OverloadLayer),
    Layer.provideMerge(CallStateCacheLayer),
    Layer.provideMerge(BufferedTerminateL),
    Layer.provideMerge(CallLimiterLayer),
    Layer.provideMerge(CallControlLayer),
    Layer.provideMerge(TracingLayer),
    Layer.provideMerge(CdrLayer),
    Layer.provideMerge(MetricsLayer),
    Layer.provideMerge(NetworkLayer),
    Layer.provideMerge(RedisLayer),
    Layer.provideMerge(AppConfigLayer),
    // Live stack runs against real sockets but tests still drive
    // markDraining explicitly — skip the SIGTERM hook.
    Layer.provideMerge(DrainingState.test),
    // Live tests don't run ReadyGate; default to ready=true so the
    // OPTIONS keepalive path answers 200. See networkLeaves.ts for
    // the same rationale on the fake stack.
    Layer.provideMerge(WorkerReadiness.test(true)),
  )
}
