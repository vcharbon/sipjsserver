/**
 * b2buaEmbeddedLayer — one-call factory for embedding the full B2BUA in
 * a consumer's app with their own `CallDecisionEngine`.
 *
 * Defaults to in-memory cache + limiter + CDR, noop OTel (no exporter
 * wired), `DrainingState.test` (no SIGTERM hook). The consumer supplies
 * the `callDecision` Layer and (optionally) overrides any subsystem.
 *
 * Production wiring (Redis-backed cache, OTLP exporter, K8s replication,
 * graceful drain) is out of scope here; consumers wanting it should
 * compose `B2buaCoreLayer` directly using the layer factories in this
 * package. For the standalone server mode see `src/main.ts`.
 */

import { Layer } from "effect"
import { B2buaCoreLayer } from "./B2buaCore.js"
import { OverloadController } from "./OverloadController.js"
import { DrainingState } from "./DrainingState.js"
import { AppConfig, type AppConfigData } from "../config/AppConfig.js"
import { CallLimiter } from "../call/CallLimiter.js"
import { PartitionedRelayStorage } from "../cache/PartitionedRelayStorage.js"
import { BufferedTerminateWriter } from "../cache/BufferedTerminateWriter.js"
import { CdrWriter } from "../cdr/CdrWriter.js"
import { TracingService } from "../tracing/TracingService.js"
import { TracerHealthSignal } from "../observability/tracer-health.js"
import { UdpTransport } from "../sip/UdpTransport.js"
import { SignalingNetwork } from "../sip/SignalingNetwork.js"
import { LoadSampler } from "../observability/LoadSampler.js"
import { MetricsRegistry } from "../observability/MetricsRegistry.js"
import { CallDecisionEngine } from "../decision/CallDecisionEngine.js"
import { WorkerReadiness } from "../cache/WorkerReadiness.js"
import { SipRouter } from "../sip/SipRouter.js"
import { TransactionLayer } from "../sip/TransactionLayer.js"
import { CallState } from "../call/CallState.js"
import { TimerService } from "../call/TimerService.js"
import { SipParser } from "../sip/Parser.js"
import { StackIdentity } from "./stack-identity.js"

/**
 * Sensible defaults for an embedded B2BUA. Everything Redis-related is
 * inert (in-memory cache; the URLs are placeholders that the in-memory
 * layers ignore). Override fields via `b2buaEmbeddedLayer({ config: {...} })`.
 */
export const defaultEmbeddedAppConfig: AppConfigData = {
  sipLocalIp: "0.0.0.0",
  sipLocalPort: 5060,
  sipUdpStack: "js",
  workerServiceName: "embedded-b2bua",
  redisUrl: "redis://unused",
  limiterRedisUrl: "redis://unused",
  redisKeyPrefix: "embedded",
  limiterWindowSeconds: 300,
  limiterActiveWindows: 3,
  limiterTtlSeconds: 1200,
  noAnswerTimeoutSec: 30,
  keepaliveIntervalSec: 900,
  keepaliveTimeoutSec: 10,
  callMaxDurationSec: 7200,
  cdrFilePath: "/tmp/embedded-cdr.jsonl",
  httpStatusPort: 0,
  callControlUrl: "http://unused",
  callControlNewCallTimeoutMs: 5000,
  callControlFailureTimeoutMs: 5000,
  callControlReferTimeoutMs: 5000,
  eventHandlerTimeoutMs: 10_000,
  timerHandlerTimeoutMs: 5_000,
  maxMessagesPerCall: 100,
  redisFlushIdleMs: 2000,
  traceSampleRate: 0,
  otelTracesUrl: "http://unused",
  clusterWorkers: 0,
  workerIndex: -1,
  callContextTtlSec: 1800,
  callCleanupDelaySec: 32,
  udpQueueMax: 1024,
  udpQueueTier1ThresholdPct: 70,
  workerQueueEmergencyMax: 500,
  workerQueueInDialogMax: 400,
  workerQueueNewCallMax: 100,
  workerInDialogFullKillAfterMs: 60_000,
  cpsBucketSize: 1000,
  cpsBucketRate: 500,
  overloadLoopLagSoftMs: 50,
  overloadLoopLagHardMs: 200,
  overloadRoutingNewCallSoftMs: 200,
  overloadRoutingNewCallHardMs: 1000,
  overloadPanicEluThreshold: 0.75,
  retryAfterBaseSec: 5,
  retryAfterJitterSec: 5,
  emergencyListenerEnabled: false,
  emergencyListenerHost: "127.0.0.1",
  emergencyListenerPort: 5070,
  referSubscriptionExpirySec: 60,
  referReinviteAnswerSec: 32,
  referOverallSafetySec: 120,
  scrubHeaders: [],
  workerAllowedTargetSuffixes: ["*"],
  proxyIngressConcurrency: 1,
  bufferedSendPerPeerQueueMax: 32,
  bufferedSendIdleTtlMs: 5_000,
  bufferedSendMaxPeers: 10_000,
  bufferedSendSweepIntervalMs: 1_000,
  cdrBufferQueueMax: 0,
  storageBufferQueueMax: 0,
  storageBufferDrainers: 4,
  storageDropFallbackMs: 1000,
  limiterDecrementTimeoutMs: 1000,
  eventDispatchConcurrency: 1024,
  perCallQueueCap: 200_000,
  perCallQueueDepth: 64,
  otelMaxAttributeValueLength: 32_768,
  traceTombstoneEnabled: false,
  replicationBootstrapTimeoutMs: 30_000,
}

export interface B2buaEmbeddedOptions {
  /**
   * The consumer's call-control backend. Implements `newCall`,
   * `callFailure`, `callRefer`. HTTP-backed, in-process, anything goes —
   * the b2bua only sees the canonical `CallDecisionEngine` Tag.
   */
  readonly callDecision: Layer.Layer<CallDecisionEngine, never, never>

  /**
   * Override fields from `defaultEmbeddedAppConfig`. Anything not set
   * keeps the default. SIP listen port lives on `sipLocalPort`.
   */
  readonly config?: Partial<AppConfigData>

  /** Override the cache layer. Default: `PartitionedRelayStorage.memoryLayer`. */
  readonly cache?: Layer.Layer<PartitionedRelayStorage, never, never>

  /** Override the call-limiter layer. Default: `CallLimiter.memoryLayer` (needs AppConfig). */
  readonly callLimiter?: Layer.Layer<CallLimiter, never, AppConfig>

  /** Override the CDR writer. Default: `CdrWriter.testLayer` (in-memory). */
  readonly cdr?: Layer.Layer<CdrWriter, never, never>

  /**
   * Override the tracing service. Default: `TracingService.layer` with
   * `traceSampleRate: 0` (no spans recorded — effectively noop). Provide
   * your own NodeSdk-backed layer to enable OTLP export.
   */
  readonly tracing?: Layer.Layer<TracingService, never, AppConfig>
}

/**
 * Public type alias for the layer returned by {@link b2buaEmbeddedLayer}.
 *
 * Consumers can name this in their own type annotations without relying
 * on the inferred `ReturnType<typeof b2buaEmbeddedLayer>`. The Out
 * channel exposes everything `B2buaCoreLayer` exports plus the
 * test-flavored `DrainingState` and `WorkerReadiness` defaults wired in
 * by this factory; the In channel is `never` (fully self-contained).
 */
export type B2buaLayer = Layer.Layer<
  | SipRouter
  | TransactionLayer
  | CallState
  | TimerService
  | SipParser
  | StackIdentity,
  never,
  never
>

/**
 * Build a runnable B2BUA layer that the consumer can compose with their
 * own SIP loop. After providing this layer, the consumer can `yield*
 * SipRouter` and call `router.start(handlers)` (handlers exported from
 * `@vcharbon/sipjs/b2bua`).
 *
 * The returned layer's `Out` is everything `B2buaCoreLayer` exports
 * (`SipRouter`, `TransactionLayer`, `CallState`, `TimerService`,
 * `SipParser`).
 */
export const b2buaEmbeddedLayer = (opts: B2buaEmbeddedOptions): B2buaLayer => {
  const cfg: AppConfigData = { ...defaultEmbeddedAppConfig, ...(opts.config ?? {}) }
  const AppConfigL = Layer.succeed(AppConfig, cfg)
  const MetricsL = MetricsRegistry.layer

  const CacheL = opts.cache ?? PartitionedRelayStorage.memoryLayer
  const LimiterL = (opts.callLimiter ?? CallLimiter.memoryLayer).pipe(
    Layer.provide(AppConfigL),
  )
  const CdrL = opts.cdr ?? CdrWriter.testLayer
  // Slice 5.3 — TracingService consults the kill-switch on every
  // span. Embedded callers don't run a BSP supervisor, so wire the
  // always-healthy noop signal so the per-request hot path stays a
  // single boolean check that always returns false.
  const TracingL = (opts.tracing ?? TracingService.layer).pipe(
    Layer.provide(AppConfigL),
    Layer.provide(TracerHealthSignal.noop),
  )

  const OverloadL = OverloadController.layer.pipe(
    Layer.provide(AppConfigL),
    Layer.provide(MetricsL),
    Layer.provide(LoadSampler.liveLayer),
  )

  const UdpL = UdpTransport.layer.pipe(
    Layer.provide(AppConfigL),
    Layer.provide(MetricsL),
    Layer.provide(SignalingNetwork.real),
  )

  // Issue 8 — expose `StackIdentity` to consumers of the embedded
  // layer so they can read advertisedHost/Port for their own templating.
  // `provideMerge` keeps it in the Out channel; `Layer.provide(AppConfigL)`
  // wired further down satisfies StackIdentity.Default's only dep.
  const StackIdentityL = StackIdentity.Default

  // Phase 4 — embedded callers get a passthrough `BufferedTerminateWriter`
  // (config sentinel `storageBufferQueueMax: 0` defaults to direct).
  const BufferedTerminateL = BufferedTerminateWriter.layer.pipe(
    Layer.provide(CacheL),
    Layer.provide(AppConfigL),
    Layer.provide(MetricsL),
  )

  return B2buaCoreLayer.pipe(
    Layer.provideMerge(StackIdentityL),
    Layer.provide(AppConfigL),
    Layer.provide(UdpL),
    Layer.provide(OverloadL),
    Layer.provide(CacheL),
    Layer.provide(BufferedTerminateL),
    Layer.provide(LimiterL),
    Layer.provide(opts.callDecision),
    Layer.provide(TracingL),
    Layer.provide(CdrL),
    Layer.provide(DrainingState.test),
    Layer.provide(WorkerReadiness.test(true)),
    // Slice 4: TransactionLayer / TimerService / CallState now publish
    // metrics back to the registry (event queue depth, drop counters,
    // active timers, terminating-call buckets). Provide MetricsL here
    // so the embedded layer keeps the same `Out` shape (no requirement
    // bubbles up to the caller).
    Layer.provide(MetricsL),
  )
}
