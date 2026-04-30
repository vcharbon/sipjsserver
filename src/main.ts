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
import { AppConfig, type AppConfigData } from "./config/AppConfig.js"
import { CallState } from "./call/CallState.js"
import { PartitionedRelayStorage } from "./cache/PartitionedRelayStorage.js"
import { WorkerOrdinal } from "./cache/PeerCachePort.js"
import { PeerEndpointResolver } from "./cache/PeerEndpointResolver.js"
import { PeerEnumerator } from "./cache/PeerEnumerator.js"
import { WorkerReadiness } from "./cache/WorkerReadiness.js"
import { CallLimiter } from "./call/CallLimiter.js"
import { AtomicWriter } from "./replication/AtomicWriter.js"
import { EpochCounter } from "./replication/EpochCounter.js"
import { PropagateStream } from "./replication/PropagateStream.js"
import { ReadyGate, ReplogClient } from "./replication/ReadyGate.js"
import { ReplLog } from "./replication/ReplLog.js"
import { ReplMetrics } from "./replication/ReplMetrics.js"
import { ReplPuller } from "./replication/ReplPuller.js"
import { WriteNotifier } from "./replication/WriteNotifier.js"
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

const CallLimiterLayer = CallLimiter.redisLayer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(RedisLayer)
)

// Hoisted at the top of the layer graph so a single memoized hub is
// shared by AtomicWriter (publisher, transitively via
// PartitionedRelayStorage.redisLayer) and ReplLog (subscriber). See
// DATA-REPLICATION-LAYER-REFACTOR-SURPRISES.md P1#1.
const WriteNotifierLayer = WriteNotifier.layer

// Hoisted (Phase 0b): both `PartitionedRelayStorage.redisLayer` (for
// SIP-driven local writes) AND `ReplPuller.redisLayer` (for applying
// inbound replication entries) need an AtomicWriter. Composing once at
// the outer level is functionally equivalent to having two distinct
// instances (each is just a wrapper over the same RedisClient +
// WriteNotifier), but it's cleaner and matches the pattern WriteNotifier
// already uses.
const AtomicWriterLayer = AtomicWriter.redisLayer.pipe(
  Layer.provide(RedisLayer),
  Layer.provide(WriteNotifierLayer)
)

const CallStateCacheLayer = PartitionedRelayStorage.redisLayer.pipe(
  Layer.provide(RedisLayer),
  Layer.provide(AtomicWriterLayer),
  Layer.provide(WriteNotifierLayer)
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

// DrainingState is NOT provided inline here — it is hoisted to the
// outer `standaloneMain` composition so HttpLayer can also see the
// same instance for the `/ready` route gating.
const SipLayer = B2buaCoreLayer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(UdpLayer),
  Layer.provide(OverloadControllerLayer),
  Layer.provide(CallStateCacheLayer),
  Layer.provide(CallLimiterLayer),
  Layer.provide(CallControlLayer),
  Layer.provide(TracingLayer),
  Layer.provide(CdrLayer),
)

// ---------------------------------------------------------------------------
// HTTP + cluster layers
// ---------------------------------------------------------------------------

const CallStateLayer = CallState.layer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(CallStateCacheLayer)
)

// Replication services for the server side of `/replog`. EpochCounter
// runs the boot-time `INCR epoch:{owner}` for this worker; ReplLog
// composes the long-poll stream from PropagateStream + storage +
// WriteNotifier + EpochCounter. The route handler itself is registered
// inside StatusServerLayer (alongside `/metrics` and call-control).
const EpochCounterLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const ordinal =
      config.workerOrdinalLabel !== undefined
        ? config.workerOrdinalLabel
        : config.workerIndex >= 0
          ? String(config.workerIndex)
          : "self"
    return EpochCounter.redisLayer(ordinal)
  })
).pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(RedisLayer),
  Layer.orDie
)

const PropagateStreamLayer = PropagateStream.redisLayer.pipe(
  Layer.provide(RedisLayer),
  Layer.provide(AppConfigLayer)
)

const ReplLogLayer = ReplLog.layer.pipe(
  Layer.provide(PropagateStreamLayer),
  Layer.provide(CallStateCacheLayer),
  Layer.provide(WriteNotifierLayer),
  Layer.provide(EpochCounterLayer)
)

const ReplMetricsLayer = ReplMetrics.layer.pipe(
  Layer.provide(EpochCounterLayer),
  Layer.provide(WriteNotifierLayer)
)

// WorkerReadiness + DrainingState are kept as requirements (not
// provided here) so HttpLayer's `/ready` handler reads from the
// SAME refs as ReadyGate (which flips ready after boot drain) and
// the SIGTERM accelerant (which flips draining on shutdown). Both
// layers are satisfied by the outer `standaloneMain` composition.
const HttpLayer = StatusServerLayer.pipe(
  Layer.provide(CallStateLayer),
  Layer.provide(AppConfigLayer),
  Layer.provide(MetricsRegistryLayer),
  Layer.provide(ReplLogLayer),
  Layer.provide(ReplMetricsLayer)
)

// ---------------------------------------------------------------------------
// Replication consumer (pull) side — Phase 0b
// ---------------------------------------------------------------------------
//
// The SIP-driven write side (ReplLog server, AtomicWriter, propagate)
// runs unconditionally. The pull side — boot-time ReadyGate + steady
// per-peer ReplPuller fibers — only makes sense when (a) the worker
// runs in K8s with peers reachable via the headless StatefulSet DNS,
// and (b) the worker has a stable ordinal label for stamping the
// `caller` query param. Both conditions reduce to: K8S_NAMESPACE +
// workerOrdinalLabel are set.
//
// Single-node / dev / non-K8s deployments leave K8S_NAMESPACE unset:
// the boot path skips the gate, no fibers are forked, no peers are
// dialed. The /replog server still answers (just to nobody).

const ReplPullerLayer = ReplPuller.redisLayer.pipe(
  Layer.provide(RedisLayer),
  Layer.provide(AtomicWriterLayer)
)

/**
 * Resolve the worker's ordinal — same precedence as `EpochCounterLayer`
 * uses. Lifted to a top-level helper so `standaloneMain` can use it for
 * the `caller` query param without re-deriving the rules.
 */
const resolveOrdinal = (config: AppConfigData): string =>
  config.workerOrdinalLabel !== undefined
    ? config.workerOrdinalLabel
    : config.workerIndex >= 0
      ? String(config.workerIndex)
      : "self"

// ---------------------------------------------------------------------------
// Replication boot + steady-state — Phase 0b
// ---------------------------------------------------------------------------

/**
 * Boot the replication pull side for a worker that has K8S_NAMESPACE
 * set. Builds the per-deployment layer stack:
 *   - PeerEnumerator (headless StatefulSet DNS poll)
 *   - PeerEndpointResolver (ordinal → URL)
 *   - ReplPuller (Redis-backed bookkeeping)
 *   - ReplogClient (HTTP, via FetchHttpClient)
 *   - ReadyGate (boot handshake)
 *
 * Runs `ReadyGate.run` inline (subject to its 30s ceiling per spec
 * §8.3); whether peers were synced or unreconciled, control returns
 * after the gate completes. Then forks one steady-state pull fiber per
 * peer that auto-reconnects on transport errors with exponential
 * backoff.
 *
 * The whole effect needs `RedisClient` + `AtomicWriter` from the outer
 * scope (so the puller's apply path uses the same RedisClient/sidecar
 * the writer publishes to) — both are already lifted to the outer
 * composition.
 */
const runReplicationConsumer = (
  self: string,
  namespace: string,
  serviceName: string,
  adminPort: number
) => {
  // Build layer leaves first — each is a single memoized instance so
  // the gate, the puller, and the steady-state fibers all see the
  // SAME PeerEnumerator (DNS poll) / ReplPuller (replpos bookkeeping)
  // / ReplogClient (HTTP transport).
  const PeerEnumeratorLayer = PeerEnumerator.headlessStatefulSet({
    serviceName,
    namespace,
    portName: "admin",
    self: WorkerOrdinal(self),
  })
  const PeerEndpointResolverLayer = PeerEndpointResolver.headlessStatefulSet(
    {
      serviceName,
      namespace,
      relayPort: adminPort,
    }
  )
  const ReplogClientLayer = ReplogClient.fetchHttpLayer({ self }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(PeerEndpointResolverLayer)
  )
  // Bundle the leaves so they're memoized as one composite layer —
  // services exported by ALL of them are visible to consumers.
  // WorkerReadiness is NOT provided here: it's hoisted to the outer
  // `standaloneMain` composition so HttpLayer's `/ready` handler and
  // ReadyGate's `markReady` flip share the same MutableRef.
  const PullSideLeaves = Layer.mergeAll(
    PeerEnumeratorLayer,
    ReplPullerLayer,
    ReplogClientLayer,
  )
  // ReadyGate sits on top, satisfied by the leaves; the merge ensures
  // BOTH ReadyGate AND the leaves are exported from ReplicationLayer.
  const ReplicationLayer = ReadyGate.layer().pipe(
    Layer.provideMerge(PullSideLeaves)
  )

  return Effect.gen(function* () {
    yield* Effect.logInfo(
      `replication: starting boot handshake (namespace=${namespace}, service=${serviceName}, self=${self})`
    )

    // Run the ReadyGate. The gate is a finite-time effect (max 30s per
    // spec §8.3); regardless of outcome it flips WorkerReadiness ready
    // and returns the {synced, unreconciled} summary.
    const gate = yield* ReadyGate
    const result = yield* gate.run

    yield* Effect.logInfo(
      `replication: ReadyGate finished — synced=${result.synced.length} unreconciled=${result.unreconciled.length} durationMs=${result.durationMs}`
    )

    // Steady-state: one auto-reconnecting fiber per peer. We do an
    // initial enumerator read here; the production
    // PeerEnumerator.headlessStatefulSet keeps refreshing in the
    // background and would let us re-fork on membership change, but
    // for Phase 0b we settle for "fork once per peer at ready".
    // Phase 1+ can layer in a watcher loop if peer churn becomes a
    // tight enough constraint.
    const enumerator = yield* PeerEnumerator
    const peers = yield* enumerator.currentPeers
    const puller = yield* ReplPuller
    const client = yield* ReplogClient

    for (const peer of peers) {
      // WorkerOrdinal is a branded string; downstream APIs (ReplPuller,
      // ReplogClient) take plain `string`. The brand is structural-only,
      // so the assignment is safe — the cast just satisfies the
      // structural-vs-nominal mismatch.
      const peerStr: string = peer
      const pullLoop = Effect.gen(function* () {
        const pos = yield* puller.readPos(peerStr)
        const upstream = client.streamFromPeer(peerStr, pos.lastSeq)
        // applyStream returns when the upstream ends — either because
        // /replog hit its max-open ceiling (default 25s) or because
        // the connection was closed mid-poll. Either way we want to
        // reconnect after a short pause; transport-level errors are
        // already absorbed by ReplogClient.fetchHttpLayer (logged,
        // converted to empty-stream).
        //
        // Wrapping the apply in `Effect.timeout(35s)` is the safety net
        // for the case where the underlying TCP connection goes silent
        // mid-stream (peer pod restarted, network partition, …): without
        // a hard ceiling the fiber waits indefinitely on the streamed
        // response body and the loop never reconnects. 35s gives the
        // server-side max-open (25s) plus a 10s slack so a healthy
        // long-poll still completes naturally.
        yield* puller.applyStream(peerStr, upstream).pipe(
          Effect.catchTags({
            ReplPullerError: (e) =>
              Effect.logWarning(
                `replication: applyStream(${peerStr}) ReplPullerError: ${e.reason}`
              ),
            AtomicWriterError: (e) =>
              Effect.logWarning(
                `replication: applyStream(${peerStr}) AtomicWriterError: ${e.reason}`
              ),
          }),
          Effect.timeout("35 seconds"),
          Effect.catchTag("TimeoutError", () =>
            Effect.logWarning(
              `replication: applyStream(${peerStr}) timed out — reconnecting`
            )
          )
        )
        // Pause between reconnects: 250ms gives the heartbeat / max-open
        // cycle a beat to settle on the server side without hammering.
        // The /replog max-open ceiling is 25s (spec §7.2), so a tight
        // reconnect immediately after natural close is fine.
        yield* Effect.sleep("250 millis")
      })
      // `forkDetach`: the loop must outlive the body of
      // `runReplicationConsumer` (which returns once the boot
      // handshake is done and all fibers are forked). `forkChild`
      // would tie the loop's lifetime to this enclosing effect,
      // causing it to be interrupted as soon as the for-loop body
      // returns — that's the bug we hit on first deployment.
      yield* Effect.forkDetach(
        Effect.forever(pullLoop).pipe(
          Effect.tap(() =>
            Effect.logInfo(
              `replication: peer ${peerStr} pull loop exited unexpectedly`
            )
          )
        )
      )
    }

    if (peers.length === 0) {
      yield* Effect.logInfo(
        "replication: no peers enumerated (single-replica StatefulSet?), no steady-state pull fibers forked"
      )
    } else {
      yield* Effect.logInfo(
        `replication: forked ${peers.length} steady-state pull fibers (peers=${peers.join(",")})`
      )
    }

    // Keep the consumer fiber alive forever — the per-peer pull loops
    // were forked with `forkDetach` and are independent daemons, but
    // returning here would tear down the surrounding `Effect.provide`
    // scope (and with it the HttpClient and PeerEnumerator background
    // fibers the daemons rely on). Blocking here keeps the
    // ReplicationLayer alive for the lifetime of the worker process.
    return yield* Effect.never
  }).pipe(Effect.provide(ReplicationLayer))
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

  // Replication consumer: ReadyGate boot handshake + per-peer steady
  // pull fibers. Skipped when K8S_NAMESPACE is unset (single-node /
  // dev / non-K8s). The HTTP server above already serves /replog so
  // peers can pull *from* this worker even when this worker isn't
  // pulling from anyone.
  if (config.k8sNamespace !== undefined && config.k8sNamespace.length > 0) {
    const self = resolveOrdinal(config)
    yield* Effect.forkDetach(
      runReplicationConsumer(
        self,
        config.k8sNamespace,
        config.workerServiceName,
        config.httpStatusPort
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
    const readiness = yield* WorkerReadiness
    yield* readiness.markReady(true)
  }

  // Run SipRouter — blocks forever consuming TransactionEvent stream
  return yield* router.start(handlers)
}).pipe(
  Effect.provide(
    Layer.mergeAll(SipLayer, AppConfigLayer).pipe(
      // Hoisted shared singletons consumed by SipLayer (DrainingState),
      // HttpLayer (both, for `/ready`) and the replication consumer
      // fiber (WorkerReadiness, for ReadyGate.markReady). `provideMerge`
      // both satisfies SipLayer's DrainingState requirement AND keeps
      // the singletons exported so HttpLayer / runReplicationConsumer
      // see the SAME instances. `Layer.mergeAll` would not satisfy
      // intra-list deps.
      Layer.provideMerge(
        Layer.mergeAll(WorkerReadinessLayer, DrainingStateLayer)
      ),
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
