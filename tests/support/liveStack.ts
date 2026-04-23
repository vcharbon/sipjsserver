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

import { Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { HttpReferenceAdapterLayer } from "../../src/decision/adapters/http-reference/HttpReferenceAdapter.js"
import { CallLimiter } from "../../src/call/CallLimiter.js"
import { CallStateCache } from "../../src/call/CallStateCache.js"
import { CdrWriter } from "../../src/cdr/CdrWriter.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { OverloadController } from "../../src/b2bua/OverloadController.js"
import { RedisClient } from "../../src/redis/RedisClient.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { TracingService } from "../../src/tracing/TracingService.js"
import { UdpTransport } from "../../src/sip/UdpTransport.js"
import { B2buaCoreLayer } from "../../src/b2bua/B2buaCore.js"

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
  const NetworkLayer = SignalingNetwork.real

  const RedisLayer = RedisClient.layer.pipe(Layer.provide(AppConfigLayer))

  const CallStateCacheLayer = CallStateCache.redisLayer.pipe(Layer.provide(RedisLayer))
  const CallLimiterLayer = CallLimiter.redisLayer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(RedisLayer)
  )

  const UdpLayer = UdpTransport.layer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(MetricsLayer),
    Layer.provide(NetworkLayer)
  )

  const OverloadLayer = OverloadController.layer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(MetricsLayer)
  )

  const CallControlLayer = HttpReferenceAdapterLayer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(OverloadLayer)
  )

  const TracingLayer = TracingService.layer.pipe(Layer.provide(AppConfigLayer))
  const CdrLayer = CdrWriter.layer.pipe(Layer.provide(AppConfigLayer))

  return B2buaCoreLayer.pipe(
    Layer.provideMerge(UdpLayer),
    Layer.provideMerge(OverloadLayer),
    Layer.provideMerge(CallStateCacheLayer),
    Layer.provideMerge(CallLimiterLayer),
    Layer.provideMerge(CallControlLayer),
    Layer.provideMerge(TracingLayer),
    Layer.provideMerge(CdrLayer),
    Layer.provideMerge(MetricsLayer),
    Layer.provideMerge(NetworkLayer),
    Layer.provideMerge(RedisLayer),
    Layer.provideMerge(AppConfigLayer)
  )
}
