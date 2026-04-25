/**
 * Entry point — composes all layers and launches the SIP B2BUA.
 *
 * Single mode after PR6: standalone worker. The legacy `cluster.fork`
 * dispatcher (`src/cluster/`) has been retired in favor of the SIP
 * front proxy (`src/sip-front-proxy/`) running as a separate K8s
 * Deployment. Multi-process scaling is now done via K8s replicas plus
 * the proxy's rendezvous hashing across pods.
 *
 * Services:
 *   1. SIP B2BUA — UDP, TransactionLayer, SipRouter, handlers
 *   2. HTTP status + call control — HTTP
 */

import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, LogLevel, References } from "effect"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { SipRouter } from "./sip/SipRouter.js"
import { AppConfig } from "./config/AppConfig.js"
import { CallState } from "./call/CallState.js"
import { CallStateCache } from "./call/CallStateCache.js"
import { CallLimiter } from "./call/CallLimiter.js"
import { CdrWriter } from "./cdr/CdrWriter.js"
import { RedisClient } from "./redis/RedisClient.js"
import { UdpTransport } from "./sip/UdpTransport.js"
import { SignalingNetwork } from "./sip/SignalingNetwork.js"
import { StatusServerLayer } from "./http/StatusServer.js"
import { HttpReferenceAdapterLayer } from "./decision/adapters/http-reference/HttpReferenceAdapter.js"
import { TracingService } from "./tracing/TracingService.js"
import { FetchHttpClient } from "effect/unstable/http"
import { handlers, B2buaCoreLayer } from "./b2bua/B2buaCore.js"
import { DrainingState } from "./b2bua/DrainingState.js"
import { OverloadController } from "./b2bua/OverloadController.js"
import { MetricsRegistry } from "./observability/MetricsRegistry.js"

// ---------------------------------------------------------------------------
// Environment-specific layers
// ---------------------------------------------------------------------------

const AppConfigLayer = AppConfig.layer
const MetricsRegistryLayer = MetricsRegistry.layer

const RedisLayer = RedisClient.layer.pipe(
  Layer.provide(AppConfigLayer)
)

const CallLimiterLayer = CallLimiter.redisLayer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(RedisLayer)
)

const CallStateCacheLayer = CallStateCache.redisLayer.pipe(
  Layer.provide(RedisLayer)
)

const CdrLayer = CdrWriter.layer.pipe(
  Layer.provide(AppConfigLayer)
)

const OverloadControllerLayer = OverloadController.layer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(MetricsRegistryLayer)
)

const CallControlLayer = HttpReferenceAdapterLayer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(OverloadControllerLayer),
  Layer.provide(MetricsRegistryLayer)
)

const TracingLayer = TracingService.layer.pipe(
  Layer.provide(AppConfigLayer)
)

const OtelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    return NodeSdk.layer(() => ({
      resource: { serviceName: "sip-b2bua", serviceVersion: "0.1.0" },
      spanProcessor: new BatchSpanProcessor(
        new OTLPTraceExporter({ url: config.otelTracesUrl })
      ),
      tracerConfig: {
        spanLimits: { attributeValueLengthLimit: config.otelMaxAttributeValueLength }
      }
    }))
  })
).pipe(Layer.provide(AppConfigLayer))

const UdpLayer = UdpTransport.layer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(MetricsRegistryLayer),
  Layer.provide(SignalingNetwork.real)
)

// ---------------------------------------------------------------------------
// Composed B2BUA layer (core + environment deps)
// ---------------------------------------------------------------------------

const SipLayer = B2buaCoreLayer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(UdpLayer),
  Layer.provide(OverloadControllerLayer),
  Layer.provide(CallStateCacheLayer),
  Layer.provide(CallLimiterLayer),
  Layer.provide(CallControlLayer),
  Layer.provide(TracingLayer),
  Layer.provide(CdrLayer),
  Layer.provide(DrainingState.Default),
)

// ---------------------------------------------------------------------------
// HTTP + cluster layers
// ---------------------------------------------------------------------------

const CallStateLayer = CallState.layer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(CallStateCacheLayer)
)

const HttpLayer = StatusServerLayer.pipe(
  Layer.provide(CallStateLayer),
  Layer.provide(AppConfigLayer),
  Layer.provide(MetricsRegistryLayer)
)

// ---------------------------------------------------------------------------
// Standalone program (the only mode after the PR6 cluster retirement)
// ---------------------------------------------------------------------------

const standaloneMain = Effect.gen(function* () {
  const config = yield* AppConfig
  yield* Effect.logInfo(
    `SIP B2BUA starting (standalone) — UDP :${config.sipLocalPort}, HTTP :${config.httpStatusPort}`
  )

  const router = yield* SipRouter

  // Run HTTP server in a detached background fiber
  yield* Effect.forkDetach(Layer.launch(HttpLayer))

  // Run SipRouter — blocks forever consuming TransactionEvent stream
  return yield* router.start(handlers)
}).pipe(
  Effect.provide(
    Layer.mergeAll(SipLayer, AppConfigLayer).pipe(
      Layer.provideMerge(OtelLayer)
    )
  )
)

// ---------------------------------------------------------------------------
// Main — single mode after PR6.
// ---------------------------------------------------------------------------

const main = standaloneMain

// ---------------------------------------------------------------------------
// Log level from env
// ---------------------------------------------------------------------------

const validLogLevels = new Set(["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"])

const logLevelFromEnv = (): LogLevel.LogLevel => {
  const raw = process.env.EFFECT_LOG_LEVEL ?? "Info"
  // Capitalise first letter to match Effect's expected casing
  const normalised = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
  return validLogLevels.has(normalised) ? (normalised as LogLevel.LogLevel) : "Info"
}

NodeRuntime.runMain(
  main.pipe(Effect.provideService(References.MinimumLogLevel, logLevelFromEnv()))
)
