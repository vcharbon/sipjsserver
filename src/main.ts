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
import { Effect, Fiber, Layer, LogLevel, References } from "effect"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { SipRouter } from "./sip/SipRouter.js"
import { AppConfig, resolveSipUdpStack, type AppConfigData } from "./config/AppConfig.js"
import { CallState } from "./call/CallState.js"
import { PartitionedRelayStorage } from "./cache/PartitionedRelayStorage.js"
import { BufferedTerminateWriter } from "./cache/BufferedTerminateWriter.js"
import { PeerCacheClientLayer } from "./cache/PeerCacheClient.js"
import { WorkerOrdinal } from "./cache/PeerCachePort.js"
import { PeerEndpointResolver } from "./cache/PeerEndpointResolver.js"
import { PeerEnumerator } from "./cache/PeerEnumerator.js"
import { WorkerReadiness } from "./cache/WorkerReadiness.js"
import { CallLimiter } from "./call/CallLimiter.js"
import { EpochCounter } from "./replication/EpochCounter.js"
import { ReplLogServer } from "./replication/ReplLogServer.js"
import { runPullerFiber } from "./replication/PullerFiber.js"
import { makePullerOpenStream } from "./replication/PullerHttpTransport.js"
import { makeReplicationSupervisor } from "./replication/ReplicationSupervisor.js"
import { makeReadinessController } from "./replication/ReadinessController.js"
import { makeReplicationApply } from "./replication/EchoApply.js"
import {
  makeBootstrapMetricsState,
  runPeerScanBootstrap,
} from "./replication/PeerScanBootstrap.js"
import { KvBackend } from "./storage/KvBackend.js"
import { CdrWriter } from "./cdr/CdrWriter.js"
import { BufferedCdrLayer } from "./cdr/BufferedCdrLayer.js"
import { RedisClient } from "./redis/RedisClient.js"
import { LimiterRedisClient } from "./redis/LimiterRedisClient.js"
import { UdpTransport } from "./sip/UdpTransport.js"
import { SignalingNetwork } from "./sip/SignalingNetwork.js"
import { NativeSignalingNetwork } from "./sip/NativeSignalingNetwork.js"
import { StatusServerLayer } from "./http/StatusServer.js"
import { HttpReferenceAdapterLayer } from "./decision/adapters/http-reference/HttpReferenceAdapter.js"
import { TracingService } from "./tracing/TracingService.js"
import { TracerHealthSignal, runTracerHealthSupervisor } from "./observability/tracer-health.js"
import { MeasuredBatchSpanProcessor, MeasuredSpanExporter } from "./observability/bsp-measured.js"
import { CircuitBreakerSpanExporter } from "./observability/otel-circuit-breaker.js"
import { installOtelDiagBridge } from "./observability/otel-diag.js"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { handlers, B2buaCoreLayer } from "./b2bua/B2buaCore.js"
import { DrainingState } from "./b2bua/DrainingState.js"
import { OverloadController } from "./b2bua/OverloadController.js"
import { LoadSampler } from "./observability/LoadSampler.js"
import { MetricsRegistry } from "./observability/MetricsRegistry.js"
import { runRedisCallKeyCountScanner } from "./observability/RedisCallKeyCountScanner.js"

// ---------------------------------------------------------------------------
// Environment-specific layers
// ---------------------------------------------------------------------------

const AppConfigLayer = AppConfig.layer
const MetricsRegistryLayer = MetricsRegistry.layer

// Hoisted so the SAME MutableRef instance backs both:
//   - the K8s `/ready` HTTP handler (StatusServer / HttpLayer)
//   - the boot-time ReadyGate that flips it true after replication drain
//   - the SIGTERM-driven mode flip on DrainingState
// Memoization is by Layer identity, so a single Layer reference lifted
// here and shared across SipLayer / HttpLayer / ReplicationLayer
// guarantees one instance per process.
const WorkerReadinessLayer = WorkerReadiness.Default
const DrainingStateLayer = DrainingState.Default

const RedisLayer = RedisClient.layer.pipe(
  Layer.provide(AppConfigLayer)
)

// Limiter binds to a SEPARATE Redis (cluster-shared, not per-pod sidecar) so
// concurrent-call counts are global across the fleet. See
// docs/replication/call-cache-backup.md for the sidecar-vs-shared rationale.
const LimiterRedisLayer = LimiterRedisClient.layer.pipe(
  Layer.provide(AppConfigLayer)
)

const CallLimiterLayer = CallLimiter.redisLayer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(LimiterRedisLayer),
  Layer.provide(MetricsRegistryLayer)
)

/**
 * Resolve the worker's ordinal — same precedence as `EpochCounterLayer`.
 * Lifted to top-level so layer constructors below can use it without
 * reaching into `AppConfig` separately.
 */
const resolveOrdinal = (config: AppConfigData): string =>
  config.workerOrdinalLabel !== undefined
    ? config.workerOrdinalLabel
    : config.workerIndex >= 0
      ? String(config.workerIndex)
      : "self"

// EpochCounter — Slice 6 redesign. `RESTART_COUNT` env var (set by
// the Helm init-container) into the high bits of `gen`; falls back
// to wall-clock-only when absent. No Redis dependency.
const EpochCounterLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    return EpochCounter.fromKubernetesDownwardAPI(resolveOrdinal(config))
  })
).pipe(Layer.provide(AppConfigLayer))

// PartitionedRelayStorage — Slice 7c redesign. Routes through
// KvBackend + ChannelIndex; takes `self` and `gen` from EpochCounter
// at boot.
const CallStateCacheLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const epoch = yield* EpochCounter
    return PartitionedRelayStorage.redisLayer({
      self: resolveOrdinal(config),
      gen: epoch.gen,
    })
  })
).pipe(
  Layer.provide(RedisLayer),
  Layer.provide(AppConfigLayer),
  Layer.provide(EpochCounterLayer)
)

// Production wraps the file-backed CdrWriter with BufferedCdrLayer so a
// slow disk cannot stall call termination. Fake-clock tests opt out via
// `cdrBufferQueueMax: 0` (BufferedCdrLayer falls through to the inner).
const CdrLayer = BufferedCdrLayer.pipe(
  Layer.provide(CdrWriter.layer.pipe(Layer.provide(AppConfigLayer))),
  Layer.provide(AppConfigLayer),
  Layer.provide(MetricsRegistryLayer),
)

const OverloadControllerLayer = OverloadController.layer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(MetricsRegistryLayer),
  Layer.provide(LoadSampler.liveLayer)
)

const CallControlLayer = HttpReferenceAdapterLayer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(OverloadControllerLayer),
  Layer.provide(MetricsRegistryLayer)
)

// Slice 5.3 — live kill switch. Production uses the live flag (toggled
// by `runTracerHealthSupervisor` further down); embedded/test paths
// keep `TracerHealthSignal.noop` so the per-request hot path in
// TracingService is identical when there is no BSP to monitor.
const TracerHealthLayer = TracerHealthSignal.live

const TracingLayer = TracingService.layer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(TracerHealthLayer),
)

// Slice 5.1/5.2/5.3 — BSP overload protection.
//
//   * Override BSP defaults (`maxQueueSize: 2048 → 1024`,
//     `maxExportBatchSize: 512 → 256`, `scheduledDelayMillis: 5_000
//     → 1_000`, `exportTimeoutMillis: 30_000 → 2_000`). With the
//     collector unreachable this caps in-flight retained span objects
//     at ≈ maxQueueSize + maxExportBatchSize ≈ 1.3 K and pinned HTTP
//     connections at ≤ 2 s × concurrent batches.
//   * Wrap exporter + processor in their measured variants so
//     `b2bua_otel_bsp_*` metrics report depth / drops without poking
//     at the upstream BSP's private fields.
//   * `installOtelDiagBridge` routes the SDK `diag` channel through
//     the Effect logger AND increments the drop counter when BSP
//     surfaces a "Dropping span" warning.
//   * `runTracerHealthSupervisor` (forked further down in
//     `standaloneMain`) toggles the kill switch when BSP queue depth
//     exceeds 80 % of capacity for ≥ 3 s.
const BSP_MAX_QUEUE_SIZE = 1024
const BSP_MAX_EXPORT_BATCH_SIZE = 256
const BSP_SCHEDULED_DELAY_MS = 1_000
const BSP_EXPORT_TIMEOUT_MS = 2_000

const measuredBsp = (config: AppConfigData): MeasuredBatchSpanProcessor => {
  // Front the OTLP HTTP exporter with a circuit breaker so a dead
  // collector produces at most two HTTP attempts (initial + one
  // probe after a 30 s cooldown) before the worker stops touching
  // the network. Without this, BSP scheduledDelayMillis = 1 s causes
  // a permanent 1 Hz ECONNREFUSED loop that burns ~25 % CPU per
  // worker post-test (observed in run post-fix-validation-6).
  const exporter = new MeasuredSpanExporter(
    new CircuitBreakerSpanExporter(
      new OTLPTraceExporter({ url: config.otelTracesUrl, timeoutMillis: BSP_EXPORT_TIMEOUT_MS }),
    ),
  )
  const inner = new BatchSpanProcessor(exporter, {
    maxQueueSize: BSP_MAX_QUEUE_SIZE,
    maxExportBatchSize: BSP_MAX_EXPORT_BATCH_SIZE,
    scheduledDelayMillis: BSP_SCHEDULED_DELAY_MS,
    exportTimeoutMillis: BSP_EXPORT_TIMEOUT_MS,
  })
  const wrapped = new MeasuredBatchSpanProcessor(inner, exporter, BSP_MAX_QUEUE_SIZE)
  installOtelDiagBridge(wrapped)
  return wrapped
}

// Lifted to module scope so the supervisor (built later) and the
// metrics registration can reach back to the same instance the
// NodeSdk layer constructed.
let bspSingleton: MeasuredBatchSpanProcessor | undefined

const OtelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const bsp = measuredBsp(config)
    bspSingleton = bsp
    return NodeSdk.layer(() => ({
      resource: { serviceName: "sip-b2bua", serviceVersion: "0.1.0" },
      spanProcessor: bsp,
      tracerConfig: {
        spanLimits: { attributeValueLengthLimit: config.otelMaxAttributeValueLength }
      }
    }))
  })
).pipe(Layer.provide(AppConfigLayer))

// SignalingNetwork variant selected by `resolveSipUdpStack()` (honours
// `SIP_UDP_STACK` first, then `SIP_UDP_STACK_BY_ORDINAL` for K8s endurance
// A/B). Resolved at module-eval time so the Layer composition stays
// static — AppConfig is provided to children of UdpLayer but isn't
// available at layer-construction time.
const resolvedSipUdpStack = resolveSipUdpStack()
console.log(
  `[startup] sipUdpStack=${resolvedSipUdpStack} ` +
  `(SIP_UDP_STACK=${process.env["SIP_UDP_STACK"] ?? ""} ` +
  `SIP_UDP_STACK_BY_ORDINAL=${process.env["SIP_UDP_STACK_BY_ORDINAL"] ?? ""} ` +
  `POD_NAME=${process.env["POD_NAME"] ?? ""})`,
)
const SignalingNetworkLayer: Layer.Layer<SignalingNetwork> =
  resolvedSipUdpStack === "native"
    ? NativeSignalingNetwork.layer
    : SignalingNetwork.real

const UdpLayer = UdpTransport.layer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(MetricsRegistryLayer),
  Layer.provide(SignalingNetworkLayer)
)

// ---------------------------------------------------------------------------
// Composed B2BUA layer (core + environment deps)
// ---------------------------------------------------------------------------

// Phase 4: terminate-path Redis I/O is buffered behind
// `BufferedTerminateWriter`. Callsites in CallState use this for
// `submitTerminateDelete` / `submitTerminatePut`; admission and
// hot-dialog flushes still hit `PartitionedRelayStorage` directly.
const BufferedTerminateLayer = BufferedTerminateWriter.layer.pipe(
  Layer.provide(CallStateCacheLayer),
  Layer.provide(AppConfigLayer),
  Layer.provide(MetricsRegistryLayer),
)

// DrainingState is NOT provided inline here — it is hoisted to the
// outer `standaloneMain` composition so HttpLayer can also see the
// same instance for the `/ready` route gating.
const SipLayer = B2buaCoreLayer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(UdpLayer),
  Layer.provide(OverloadControllerLayer),
  Layer.provide(CallStateCacheLayer),
  Layer.provide(BufferedTerminateLayer),
  Layer.provide(CallLimiterLayer),
  Layer.provide(CallControlLayer),
  Layer.provide(TracingLayer),
  Layer.provide(CdrLayer),
  // Slice 4: TransactionLayer / TimerService / CallState now publish
  // metrics back to the registry. Provide the same singleton layer
  // already used by UdpLayer / OverloadControllerLayer above so the
  // /metrics + /debug/memory endpoints see one consistent registry.
  Layer.provide(MetricsRegistryLayer),
)

// ---------------------------------------------------------------------------
// HTTP + cluster layers
// ---------------------------------------------------------------------------

const CallStateLayer = CallState.layer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(CallStateCacheLayer),
  Layer.provide(BufferedTerminateLayer),
  Layer.provide(CdrLayer),
  Layer.provide(CallLimiterLayer),
  Layer.provide(MetricsRegistryLayer),
)

// ReplLogServer — Slice 4 long-lived /replog endpoint. Pulls from the
// same KvBackend the SIP path writes through (CallStateCacheLayer's
// internal KvBackend); the route handler is registered inside
// StatusServerLayer.
//
// Slice 7c: ReplLogServer.layer requires KvBackend explicitly (no
// transitive provision). Build a dedicated KvBackendLayer that the
// /replog server reads from. This is the SAME Redis instance the
// CallStateCacheLayer uses, so both write+read ops see one keyspace.
const KvBackendLayer = KvBackend.redisLayer.pipe(
  Layer.provide(RedisLayer),
  Layer.provide(AppConfigLayer)
)

const ReplLogServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const epoch = yield* EpochCounter
    return ReplLogServer.layer({
      self: resolveOrdinal(config),
      gen: epoch.gen,
    })
  })
).pipe(
  Layer.provide(KvBackendLayer),
  Layer.provide(CallStateCacheLayer),
  Layer.provide(AppConfigLayer),
  Layer.provide(EpochCounterLayer)
)

// WorkerReadiness + DrainingState are kept as requirements (not
// provided here) so HttpLayer's `/ready` handler reads from the
// SAME refs as ReadinessController (which flips ready after boot
// converges) and the SIGTERM accelerant (which flips draining on
// shutdown). Both layers are satisfied by the outer `standaloneMain`
// composition.
const HttpLayer = StatusServerLayer.pipe(
  Layer.provide(CallStateLayer),
  Layer.provide(AppConfigLayer),
  Layer.provide(MetricsRegistryLayer),
  Layer.provide(ReplLogServerLayer),
  Layer.provide(CallStateCacheLayer)
)

// ---------------------------------------------------------------------------
// Replication consumer (pull) side — Slice 7c new model
// ---------------------------------------------------------------------------
//
// The SIP-driven write side runs unconditionally (PRS writes go
// through ChannelIndex → KvBackend; ReplLogServer serves /replog).
// The pull side — ReplicationSupervisor + per-peer PullerFiber +
// ReadinessController — only makes sense when (a) the worker runs
// in K8s with peers reachable via the headless StatefulSet DNS, and
// (b) the worker has a stable ordinal label.
//
// Single-node / dev / non-K8s deployments leave K8S_NAMESPACE unset:
// no fibers are forked, no peers dialed. The /replog server still
// answers (to nobody).

/**
 * Boot the replication pull side. Builds:
 *   - PeerEnumerator (headless StatefulSet DNS poll)
 *   - ReplicationSupervisor (per-peer PullerFiber lifecycle)
 *   - ReadinessController (T_min/T_max + everCaughtUp aggregation)
 *
 * The supervisor is forked detached. The readiness controller's
 * `markReady` writes to the hoisted WorkerReadiness MutableRef so
 * the K8s `/ready` HTTP route flips at the right moment.
 *
 * `afterGate` runs once readiness flips true — typically the
 * SIP-router's owned-call rehydration path.
 */
const runReplicationConsumer = (
  self: string,
  gen: number,
  namespace: string,
  serviceName: string,
  _adminPort: number,
  afterGate: Effect.Effect<void>
) => {
  const PeerEnumeratorLayer = PeerEnumerator.headlessStatefulSet({
    serviceName,
    namespace,
    portName: "admin",
    self: WorkerOrdinal(self),
  })
  const PeerEndpointResolverLayer = PeerEndpointResolver.headlessStatefulSet({
    serviceName,
    namespace,
    relayPort: _adminPort,
  })
  // PeerCachePort is the HTTP-backed cross-pod cache I/O port still
  // used by the SIP path (decode_forward_backup, etc.). The
  // replication redesign does NOT consume it — peer reads happen via
  // the /replog stream — but the SIP layer keeps using it for
  // direct cross-pod calls (e.g. proxy-driven backup writes).
  const PeerCachePortLayer = PeerCacheClientLayer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(PeerEndpointResolverLayer)
  )

  return Effect.gen(function* () {
    yield* Effect.logInfo(
      `replication: starting (namespace=${namespace}, service=${serviceName}, self=${self}, gen=${gen})`
    )

    const enumerator = yield* PeerEnumerator
    const kv = yield* KvBackend
    const readiness = yield* WorkerReadiness
    const appConfig = yield* AppConfig
    const metricsRegistry = yield* MetricsRegistry
    // FetchHttpClient-backed client used by every per-peer puller's
    // openStream below. Resolved once here so the puller fork closure
    // can capture it.
    const httpClient = yield* HttpClient.HttpClient
    const resolver = yield* PeerEndpointResolver

    // Build supervisor with a per-peer puller-fork closure. Each
    // PullerFiber opens a long-lived NDJSON fetch against the peer's
    // /replog endpoint via HttpClientResponse.stream — the response
    // body is consumed as a Uint8Array stream, line-buffered into
    // PullFrames by PullerFiber's `consumeStream`. The server side
    // (ReplLogServer) bounds work via `chunk_size`: the underlying
    // Lua `CHANNEL_PULL_BATCH_LUA` enforces `LIMIT 0 chunk_size` per
    // ZRANGEBYSCORE call AND emits one Noop per drained batch, so
    // even a long-stale puller reconnect cannot lock the source's
    // Redis past one chunk's worth of work (~ms range at 1000).
    const supervisor = makeReplicationSupervisor({
      enumerator,
      watchIntervalMs: 2_000,
      forkPullerFiber: (peer, viewRef) => {
        const sourceId = peer as unknown as string
        // Apply path is local-only — no mirror echo to the outgoing
        // channel. See src/replication/EchoApply.ts header for the
        // update/delete crossing bug the echo created.
        const replicationApply = makeReplicationApply({
          self,
          source: sourceId,
          localKv: kv,
          bodyTtlSec: 600,
        })
        const openStream = makePullerOpenStream({
          self,
          source: sourceId,
          client: httpClient,
          resolver,
        })
        return Effect.forkDetach(
          runPullerFiber({
            peer: sourceId,
            viewRef,
            openStream,
            applyFrame: (frame) => replicationApply(frame).pipe(Effect.orDie),
            chunkSize: 1000,
            initialBackoffMs: 250,
          })
        ).pipe(Effect.map((f) => f as unknown as Fiber.Fiber<void>))
      },
      onFork: (peer) =>
        Effect.logInfo(`replication: forked PullerFiber for peer ${peer}`),
    })

    // ReadinessController — observes supervisor state, flips
    // WorkerReadiness once T_min has elapsed and every alive peer
    // is `everCaughtUp`. T_max ceiling fires Ready=true even with
    // un-caught peers (logged WARN).
    let workerReadyInMs: number | undefined
    let workerReadyReason: "all_caught_up" | "t_max_timeout" | undefined
    metricsRegistry.workerReadiness = {
      readyInMs: () => workerReadyInMs,
      readyReason: () => workerReadyReason,
    }
    const controller = makeReadinessController({
      observeState: supervisor.observe,
      markReady: (ready) => readiness.markReady(ready),
      recordReady: (elapsedMs, reason) =>
        Effect.sync(() => {
          workerReadyInMs = elapsedMs
          workerReadyReason = reason
        }),
    })

    // Peer-scan-bootstrap (echo-removal slice §3). Snapshot the peer
    // set, scan each peer's `bak:{self}:*` partition over `/bootstrap`,
    // replay into local `pri:{self}:*`, and plant per-peer watermarks
    // so the supervisor's first puller-fork resumes at the recorded
    // head — not `(0,0)`. Runs before `supervisor.run` so readiness
    // does not flip on a worker that has not yet imported quiet calls.
    const peersAtBoot = yield* enumerator.currentPeers
    if (peersAtBoot.length > 0) {
      yield* Effect.logInfo(
        `replication: bootstrap starting against ${peersAtBoot.length} peer(s) (timeoutMs=${appConfig.replicationBootstrapTimeoutMs})`
      )
      const { hooks, registry } = makeBootstrapMetricsState()
      metricsRegistry.replicationBootstrap = registry
      const results = yield* runPeerScanBootstrap({
        self,
        peers: peersAtBoot,
        kv,
        httpClient,
        resolver,
        seedWatermark: supervisor.seedWatermark,
        overallTimeoutMs: appConfig.replicationBootstrapTimeoutMs,
        perPeerRetryDelayMs: 1_000,
        metrics: hooks,
      })
      for (const r of results) {
        yield* Effect.logInfo(
          `replication: bootstrap result peer=${r.peer} outcome=${r.outcome} imported=${r.entriesImported} durationMs=${r.durationMs}${r.error !== null ? ` error=${r.error}` : ""}`
        )
      }
    } else {
      yield* Effect.logInfo("replication: bootstrap skipped (no peers at boot)")
    }

    yield* Effect.forkDetach(supervisor.run)
    yield* Effect.forkDetach(controller.run)

    // Post-gate hook (timer rehydration etc.). Run regardless of
    // readiness — recovery should not block on rehydration.
    yield* afterGate

    // Block on `Effect.never` so the parent fiber stays alive; the
    // supervisor + controller forks own the work.
    return yield* Effect.never
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        PeerEnumeratorLayer,
        PeerEndpointResolverLayer,
        PeerCachePortLayer,
        KvBackendLayer,
        FetchHttpClient.layer
      ).pipe(Layer.provide(AppConfigLayer))
    )
  )
}

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

  // Periodic SCAN of `pri:{self}:call:*` / `bak:*:call:*` so /metrics
  // can surface nominal vs per-primary backup key counts without
  // adding work to the SIP hot path.
  yield* Effect.forkDetach(
    Effect.scoped(
      Effect.gen(function* () {
        const redis = yield* RedisClient
        const metrics = yield* MetricsRegistry
        yield* runRedisCallKeyCountScanner({
          redis,
          self: resolveOrdinal(config),
          registry: metrics,
        })
        return yield* Effect.never
      }),
    ).pipe(Effect.provide(RedisLayer)),
  )

  // Slice 5 — wire the BSP-decorator metrics into the registry and
  // start the kill-switch supervisor. Both are no-ops when OtelLayer
  // hasn't constructed a BSP yet (e.g. unit tests that swap OtelLayer
  // for a stub) — `bspSingleton` stays undefined.
  if (bspSingleton !== undefined) {
    const bsp = bspSingleton
    const metrics = yield* MetricsRegistry
    const signal = yield* TracerHealthSignal
    metrics.otelPipeline = {
      bspQueueDepth: () => bsp.queueDepth(),
      bspQueueCapacity: bsp.maxQueueSize,
      bspDroppedTotal: () => bsp.droppedTotal(),
      tracerDisabledTotal: () => signal.disabledTotal(),
    }
    yield* Effect.forkDetach(
      runTracerHealthSupervisor({
        queueDepth: () => bsp.queueDepth(),
        maxQueueSize: bsp.maxQueueSize,
      }),
    )
  }

  // Replication consumer: ReadyGate boot handshake + per-peer steady
  // pull fibers. Skipped when K8S_NAMESPACE is unset (single-node /
  // dev / non-K8s). The HTTP server above already serves /replog so
  // peers can pull *from* this worker even when this worker isn't
  // pulling from anyone.
  // Boot-time timer rehydration: walk owned calls back into memory and
  // respawn their persisted timer fibers (OPTIONS keepalive,
  // limiter-refresh, no-answer, …) so they survive a worker restart.
  // Errors are logged and swallowed — a recovery failure should not
  // hold the worker not-ready forever.
  const rehydrate = router.rehydrateOwnedCalls(handlers).pipe(
    Effect.catchTag("RedisError", (e) =>
      Effect.logError(`rehydrateOwnedCalls failed: ${e.reason}`)
    )
  )

  if (config.k8sNamespace !== undefined && config.k8sNamespace.length > 0) {
    const self = resolveOrdinal(config)
    const epoch = yield* EpochCounter
    yield* Effect.forkDetach(
      runReplicationConsumer(
        self,
        epoch.gen,
        config.k8sNamespace,
        config.workerServiceName,
        config.httpStatusPort,
        rehydrate
      )
    )
  } else {
    yield* Effect.logInfo(
      "replication: K8S_NAMESPACE unset — skipping ReadyGate / ReplPuller boot (single-node mode)"
    )
    // Without a ReadyGate to flip readiness, the K8s `/ready` route
    // would stay 503 forever. In single-node / dev / non-K8s mode
    // there's nothing to drain, so mark ready immediately. The
    // `/ready` route still gates correctly on `DrainingState` for
    // graceful shutdown.
    yield* rehydrate
    const readiness = yield* WorkerReadiness
    yield* readiness.markReady(true)
  }

  // Run SipRouter — blocks forever consuming TransactionEvent stream
  return yield* router.start(handlers)
}).pipe(
  Effect.provide(
    Layer.mergeAll(SipLayer, AppConfigLayer, EpochCounterLayer).pipe(
      // Hoisted shared singletons consumed by SipLayer (DrainingState),
      // HttpLayer (both, for `/ready`) and the replication consumer
      // fiber (WorkerReadiness, for the ReadinessController.markReady
      // flip). `provideMerge` both satisfies SipLayer's DrainingState
      // requirement AND keeps the singletons exported so HttpLayer /
      // runReplicationConsumer see the SAME instances.
      Layer.provideMerge(
        Layer.mergeAll(WorkerReadinessLayer, DrainingStateLayer)
      ),
      // Slice 5.3 — TracerHealthSignal + MetricsRegistry are shared
      // singletons too: SipLayer's TracingService consults the signal
      // on every span, and the supervisor / metrics-publish block in
      // `standaloneMain` reads back the same instances.
      Layer.provideMerge(TracerHealthLayer),
      Layer.provideMerge(MetricsRegistryLayer),
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
