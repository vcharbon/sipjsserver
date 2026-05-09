/**
 * k8sFakeStack — slice 3.2 SUT layer for the fake-clock failover
 * harness, extended in slice 4b-ii with per-worker child scopes so
 * `cluster.respawn(...)` can tear down + rebuild a single worker.
 *
 * What the layer composes:
 *   - `SignalingNetwork.simulated` (UDP fabric, transitDelay-aware)
 *   - `WorkerConnectivity` (per-worker network gate; consumed by the
 *     simulated UDP fabric and by `FakeHttpFabric` via the shared
 *     `ConnectivityGate` Reference)
 *   - `PeerFabric` + `PeerFabricControl` (per-peer in-memory storage,
 *     killable / reboot-able for failover scenarios)
 *   - `proxyStackLayer` with `autoStampFirstSeenAtMs: true` so the LB
 *     fresh-pod-guard window fires deterministically under TestClock
 *   - N × b2bua workers — each in its own child scope, each running
 *     ReadyGate before SipRouter ingest forks
 *   - `HealthProbe` (OPTIONS keepalive — flips workers from `unknown`
 *     to `alive` after first 200 OK)
 *   - `SimulatedK8sCluster` façade with `kill` (phase-5 scope close)
 *     and `respawn` (rebuilds the worker against a fresh child scope)
 *
 * Topology mirrors the existing `sipproxyHA` SUT (subnet conventions
 * documented in [proxyB2bFakeStack.ts](./proxyB2bFakeStack.ts)) so the
 * proxy lives on `10.10.0.1`, workers on `10.20.0.{ordinal}`, and
 * external agents (alice / bob) on `10.30.0.x` / `10.40.0.x`.
 */

import { Effect, Layer, MutableRef, Scope, ServiceMap, Stream } from "effect"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { CallLimiter, type LimiterMemoryStore, makeLimiterMemoryStore } from "../../src/call/CallLimiter.js"
import { PeerFabric, type PeerFabricApi } from "../../src/cache/PeerFabric.js"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import { CallState } from "../../src/call/CallState.js"
import { TimerService } from "../../src/call/TimerService.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { SipRouter, type HandlerRegistry } from "../../src/sip/SipRouter.js"
import {
  HealthProbe,
  healthProbeOptionsKeepaliveLayer,
  type SocketAddr,
  workerRegistryControlSimulatedAdapterLayer,
  WorkerId,
  WorkerRegistrySimulatedControl,
  type LoadBalancerConfigData,
} from "../../src/sip-front-proxy/index.js"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import { makeReplicationApply } from "../../src/replication/EchoApply.js"
import {
  initialPeerView,
  PullerTransportError,
  runPullerFiber,
} from "../../src/replication/PullerFiber.js"
import { buildPullStream } from "../../src/replication/ReplLogServer.js"
import type { KvBackendApi } from "../../src/storage/KvBackend.js"
import { b2buaWorkerStackLayer, proxyStackLayer } from "./networkLeaves.js"
import { CdrWriter, makeCdrRecordsBuffer } from "../../src/cdr/CdrWriter.js"
import { PumpableClockLayer } from "./PumpableClock.js"
import { WorkerConnectivity, WorkerConnectivityLayer } from "../../src/test-harness/internal/WorkerConnectivity.js"
import {
  SimulatedK8sCluster,
  SimulatedK8sClusterLayer,
  type ClusterWorker,
  type WorkerLifecycle,
  type WorkerRuntimeHandle,
  makeClusterWorker,
} from "../../src/test-harness/internal/SimulatedK8sCluster.js"

// ---------------------------------------------------------------------------
// Topology constants (kept in sync with `proxyB2bFakeStack.HA_*` so traces
// stay readable across failover and HA scenarios).
// ---------------------------------------------------------------------------

export const K8S_PROXY_ADDR: SocketAddr = { host: "10.10.0.1", port: 15060 }
const K8S_PROBE_BIND = { ip: "10.10.0.1", port: 25060 }

/** B2BUA host helper: `k8sWorkerIp(1) === "10.20.0.1"`. */
export const k8sWorkerIp = (n: number): string => `10.20.0.${n}`

export const k8sWorkerAddr = (n: number): SocketAddr => ({
  host: k8sWorkerIp(n),
  port: 5060,
})

/** Stable WorkerId helper — keeps id strings predictable in trace dumps. */
export const k8sWorkerId = (n: number): WorkerId => WorkerId(`b2b-${n}`)

export const DEFAULT_TRANSIT_DELAY_MS = 15

/** Tunables for the per-pull-cycle latency. Public so tests can override. */
const REPL_PULL_RECONNECT_GAP_MS = 50

// ---------------------------------------------------------------------------
// Layer builder
// ---------------------------------------------------------------------------

export interface K8sFakeStackOpts {
  readonly config: AppConfigData
  readonly transitDelayMs?: number
  /**
   * Number of B2BUA workers to pre-allocate. Each gets its own
   * UdpTransport binding, storage, and peer-cache port. Defaults to 2
   * (the minimum needed for any failover scenario).
   */
  readonly workerCount?: number
  /**
   * `HandlerRegistry` each worker's `SipRouter.start` runs with. Like
   * `sipproxyHAFakeStackLayer`, the harness layer constructs this from
   * the call-control / rule plumbing and passes it in.
   */
  readonly handlers: HandlerRegistry
  /**
   * Optional LoadBalancer overrides (e.g. `freshPodGuardMs: 0` for tests
   * that want to demonstrate kill-driven failover without the
   * conntrack-stale guard window getting in the way). When omitted,
   * production defaults apply (20s guard, 5s drain grace).
   */
  readonly loadBalancer?: LoadBalancerConfigData
  /**
   * Optional shared `CallLimiter` backing store. Every worker's limiter
   * layer points at this single `MutableHashMap`, mirroring the
   * cluster-shared `LimiterRedisClient` topology used in production.
   * Tests that want to assert on counter contents construct one via
   * `makeLimiterMemoryStore()` and pass it in here. Default: a fresh
   * private store (sharing is still in place across workers, but the
   * test cannot peek).
   */
  readonly limiterStore?: LimiterMemoryStore
  /**
   * When true, no worker config receives `b2bOutboundProxy`. Mirrors the
   * k8s production-deployment shape that omitted `B2B_OUTBOUND_PROXY`
   * and tore down every long-hold call via `keepaliveTimeoutRule`.
   */
  readonly simulateMissingOutboundProxy?: boolean
}

/**
 * Per-worker config tweak — pin sipLocalIp/Port to the worker's bind
 * and route B-leg outbound through the proxy so Bob-initiated traffic
 * round-trips through the cookie-decode path.
 */
const perWorkerConfig = (
  base: AppConfigData,
  addr: SocketAddr,
  ordinalLabel: string,
  simulateMissingOutboundProxy: boolean = false,
): AppConfigData => ({
  ...base,
  sipLocalIp: addr.host,
  sipLocalPort: addr.port,
  ...(simulateMissingOutboundProxy
    ? {}
    : { b2bOutboundProxy: { host: K8S_PROXY_ADDR.host, port: K8S_PROXY_ADDR.port } }),
  workerOrdinalLabel: ordinalLabel,
})

/**
 * Compose the full failover SUT.
 *
 * The returned layer requires nothing externally and provides:
 *   - `ProxyCore` + load-balancer + simulated registry + control
 *     adapter + HealthProbe (auto-started)
 *   - `SignalingNetwork` (simulated)
 *   - `PeerFabric` + `PeerFabricControl`
 *   - `WorkerConnectivity` (gate-backing) + `ConnectivityGate` Ref
 *   - `SimulatedK8sCluster` (the test-side façade with respawn)
 *
 * Each worker's services live inside a per-worker child scope forked
 * from the SUT scope; the cluster service holds the handle map so
 * `kill` (phase-5 scope close) and `respawn` can rebuild a single
 * worker without touching the others.
 */
export function k8sFakeStackLayer(opts: K8sFakeStackOpts) {
  const transitDelayMs = opts.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS
  const workerCount = opts.workerCount ?? 2
  if (workerCount < 1) {
    throw new Error(`k8sFakeStackLayer: workerCount must be >= 1 (got ${workerCount})`)
  }

  const clusterWorkers: ReadonlyArray<ClusterWorker> = Array.from(
    { length: workerCount },
    (_, i) => makeClusterWorker(k8sWorkerId(i + 1), k8sWorkerAddr(i + 1))
  )

  const NetworkLayer = SignalingNetwork.simulated({ transitDelayMs })
  const ConnectivityLayer = WorkerConnectivityLayer
  const fabricBuilt = PeerFabric.simulatedBuilt(
    clusterWorkers.map((w) => w.ordinal)
  )

  // Proxy stack — workers admitted as `unknown` so HealthProbe can
  // promote them to `alive`. autoStampFirstSeenAtMs ON so the LB
  // fresh-pod guard window fires deterministically under TestClock.
  const ProxyStack = proxyStackLayer({
    proxyAddr: K8S_PROXY_ADDR,
    workers: clusterWorkers.map((w) => ({
      id: w.id,
      address: w.address,
      health: "unknown" as const,
    })),
    autoStampFirstSeenAtMs: true,
    ...(opts.loadBalancer !== undefined ? { loadBalancer: opts.loadBalancer } : {}),
  })

  const ControlAdapter = workerRegistryControlSimulatedAdapterLayer.pipe(
    Layer.provideMerge(ProxyStack)
  )
  const Probe = healthProbeOptionsKeepaliveLayer({
    bindHost: K8S_PROBE_BIND.ip,
    bindPort: K8S_PROBE_BIND.port,
  }).pipe(Layer.provideMerge(ControlAdapter))

  // Auto-start the probe at layer materialization. Mirrors
  // sipproxyHAFakeStackLayer's `ProbeAutoStart` pattern.
  const ProbeAutoStart = Layer.effectDiscard(
    Effect.gen(function* () {
      const probe = yield* HealthProbe
      yield* probe.start
    })
  ).pipe(Layer.provideMerge(Probe))

  // Shared CDR buffer for the whole cluster — every worker writes into
  // this single in-memory array so the harness can verify cross-worker
  // CDR behaviour (BYE-on-backup after primary takeover still produces
  // exactly one CDR, etc.).
  const cdrBuffer = makeCdrRecordsBuffer()
  const sharedCdrLayer = CdrWriter.sharedTestLayer(cdrBuffer)

  // Single shared `CallLimiter` backing store across the whole cluster.
  // Mirrors production where every worker points at one cluster-shared
  // Redis (`LimiterRedisClient`). The limiter only consults windowSec /
  // activeWindows / ttlSec from AppConfig — identical across workers —
  // so we can provide AppConfig once at SUT scope and the resulting
  // layer is `R = never` for every worker that consumes it.
  const limiterStore = opts.limiterStore ?? makeLimiterMemoryStore()
  const sharedLimiterLayer = CallLimiter.sharedMemoryLayer(limiterStore).pipe(
    Layer.provide(Layer.succeed(AppConfig, opts.config))
  )

  // The cluster + workers + replication all live in one effect so
  // the per-worker handles, peer logs, and lifecycle wiring share
  // one closure. This replaces the previous eager `Workers` layer
  // and the standalone `ReplicationLayer` from slice 3c.
  const ClusterAndWorkers = buildClusterWithWorkersLayer(
    clusterWorkers,
    fabricBuilt.fabric,
    opts.config,
    opts.handlers,
    sharedCdrLayer,
    sharedLimiterLayer,
    opts.simulateMissingOutboundProxy === true,
  )

  return Layer.mergeAll(
    ProbeAutoStart,
    fabricBuilt.layer,
    sharedCdrLayer,
    ClusterAndWorkers.pipe(
      Layer.provideMerge(ProbeAutoStart),
      Layer.provideMerge(fabricBuilt.layer),
    ),
  ).pipe(
    Layer.provideMerge(NetworkLayer),
    Layer.provideMerge(ConnectivityLayer),
    Layer.provideMerge(PumpableClockLayer),
  )
}

// ---------------------------------------------------------------------------
// Cluster + workers + replication — one effect, one shared closure
// ---------------------------------------------------------------------------

/**
 * Build the `SimulatedK8sCluster` service together with every B2BUA
 * worker stack and the per-worker ReplPuller pull loops. The single
 * `Layer.effect` keeps the per-worker handles, the peer-log map, and
 * the lifecycle wiring inside one closure so `cluster.respawn` can
 * reuse the same construction path the initial boot took.
 *
 * Requirements (passed in by `k8sFakeStackLayer`'s outer composition):
 *   - `SignalingNetwork` (each worker's UdpTransport binds via this)
 *   - `WorkerConnectivity` (worker addresses register here)
 *   - `WorkerRegistrySimulatedControl` (re-add on respawn)
 *   - `PeerFabricControl` (kill/reboot per-peer storage)
 *
 * `PeerFabric` is consumed via the closure-captured handle (passed as
 * `fabric`) rather than as a service requirement so we can call
 * `storageOf(...).store` after `rebootWorker` returned a new handle.
 */
function buildClusterWithWorkersLayer(
  clusterWorkers: ReadonlyArray<ClusterWorker>,
  fabric: PeerFabricApi,
  baseConfig: AppConfigData,
  handlers: HandlerRegistry,
  sharedCdrLayer: Layer.Layer<CdrWriter>,
  sharedLimiterLayer: Layer.Layer<CallLimiter>,
  simulateMissingOutboundProxy: boolean = false,
): Layer.Layer<
  SimulatedK8sCluster,
  never,
  | SignalingNetwork
  | WorkerConnectivity
  | WorkerRegistrySimulatedControl
  | import("../../src/cache/PeerFabric.js").PeerFabricControl
> {
  // Inner Layer.effect that prepares every closure-shared piece of
  // state and then yields the assembled SimulatedK8sCluster service.
  const built = Effect.gen(function* () {
    const sutScope = yield* Effect.scope
    const network = yield* SignalingNetwork
    const connectivity = yield* WorkerConnectivity
    const registry = yield* WorkerRegistrySimulatedControl

    // Per-peer KvBackend handle — used by pullers to construct
    // `ChannelIndex(self=peer, peer=caller)` bindings via
    // `buildPullStream`. The Map is mutable so `respawn` can swap a
    // peer's KvBackend when its backing store gets rebuilt by
    // `PeerFabricControl.rebootWorker`.
    const peerKvs = new Map<string, KvBackendApi>()
    const peerGens = new Map<string, number>()

    const refreshPeerKv = (ord: WorkerOrdinal) => {
      const handle = fabric.storageOf(ord)
      const ordStr = ord as unknown as string
      peerKvs.set(ordStr, handle.kv)
      // Slice 7c: PeerFabric.makeMemoryApiFor uses `gen=1` by default
      // (see PartitionedRelayStorage.makeMemoryApiFor). Tests that
      // need a fresh gen on respawn should override this map.
      peerGens.set(ordStr, 1)
    }

    for (const w of clusterWorkers) {
      refreshPeerKv(w.ordinal)
    }

    // Per-worker handles (mutated in place: scope + rebuild closure).
    const handles = new Map<string, WorkerRuntimeHandle>()

    const buildWorker = (w: ClusterWorker, scope: Scope.Closeable) =>
      Effect.gen(function* () {
        // Build the b2bua stack against `scope`. UdpTransport,
        // CallState, TimerService, etc. all release on close.
        const stack = Layer.fresh(
          Layer.provideMerge(
            b2buaWorkerStackLayer({
              config: perWorkerConfig(baseConfig, w.address, w.id as unknown as string, simulateMissingOutboundProxy),
              storageLayer: fabric.storageLayerOf(w.ordinal),
              cdrLayer: sharedCdrLayer,
              limiterLayer: sharedLimiterLayer,
            }),
            fabric.cachePortLayerOf(w.ordinal),
          )
        )
        const services = yield* Effect.provideService(
          Layer.buildWithScope(stack, scope),
          SignalingNetwork,
          network,
        )
        const router = ServiceMap.get(services, SipRouter)
        const callState = ServiceMap.get(services, CallState)
        const timers = ServiceMap.get(services, TimerService)

        // Slice 7c: per-worker pullers using the new model. One
        // PullerFiber per peer, reading from peer.kv via
        // ChannelIndex(self=peer, peer=us, gen=peer.gen). Apply is
        // cycle-safe `makeDirectApply` (no echo): the puller writes
        // received frames to the LOCAL KvBackend's body store
        // directly without bumping the local outgoing channel —
        // recovery for the OTHER side is already covered because
        // PRS-driven writes echo at write-time.
        const selfOrdStr = w.ordinal as unknown as string
        const localKv = fabric.storageOf(w.ordinal).kv

        for (const peer of clusterWorkers) {
          if (peer.ordinal === w.ordinal) continue
          const peerOrdStr = peer.ordinal as unknown as string
          const viewRef = MutableRef.make(initialPeerView(peerOrdStr))

          // Re-resolve peer.kv per-cycle so respawn (which swaps the
          // peer's KvBackend) picks up the fresh instance on the next
          // reconnect.
          const openStream = (
            args: { sinceGen: number; sinceCounter: number; chunkSize: number }
          ): Stream.Stream<Uint8Array, PullerTransportError> => {
            const peerKv = peerKvs.get(peerOrdStr)
            const peerGen = peerGens.get(peerOrdStr) ?? 1
            if (peerKv === undefined) {
              return Stream.fail(
                new PullerTransportError({ reason: `no peerKv for ${peerOrdStr}` })
              )
            }
            const peerOutgoingToSelf = ChannelIndex.make(
              { self: peerOrdStr, peer: selfOrdStr, gen: peerGen },
              peerKv
            )
            return buildPullStream({
              channel: peerOutgoingToSelf,
              serverGen: peerGen,
              initialSince: { gen: args.sinceGen, counter: args.sinceCounter },
              chunkSize: args.chunkSize,
              noopIntervalMs: REPL_PULL_RECONNECT_GAP_MS,
            })
          }

          // Replication-driven apply via the design's "echo everything"
          // path. ⚠️ The cycle-break per design §D3 (body-gen
          // comparison) is NOT IMPLEMENTED — see Story 7d in the
          // plan-of-record. Tests with concurrent bidirectional
          // pullers (e.g. `replication-gap-mini.test.ts`) WILL
          // currently time out under this configuration. Revert
          // intentional: keeping the architecturally clean shape so
          // the gap is visible at the right layer.
          const localOutgoingToPeer = ChannelIndex.make(
            { self: selfOrdStr, peer: peerOrdStr, gen: 1 },
            localKv
          )
          const apply = makeReplicationApply({
            outgoingChannel: localOutgoingToPeer,
            localKv,
            self: selfOrdStr,
            source: peerOrdStr,
            bodyTtlSec: 600,
          })
          const pullerEffect = runPullerFiber({
            peer: peerOrdStr,
            viewRef,
            openStream,
            applyFrame: (frame) => apply(frame).pipe(Effect.orDie),
            chunkSize: 1000,
            initialBackoffMs: REPL_PULL_RECONNECT_GAP_MS,
          })
          yield* Effect.forkIn(pullerEffect, scope)
        }

        // Slice 7c removes ReadyGate / ReclaimRunner. The new model
        // relies on `runPullerFiber` (above) to deliver any
        // outstanding frames since the peer's outgoing channel head;
        // since=0 cold-start delivers everything the peer holds.
        // Recovery for the LOCAL worker (after respawn) happens via
        // the same puller — it receives reverse-tagged frames from
        // peers and writes them to local pri:{self}:. The rehydrate
        // step below pulls those bodies back into CallState.
        //
        // For the inner-loop fake-stack tests, we don't need a
        // synchronous "wait until caught up" gate — the SIP path
        // can call into PRS immediately, and replication catches up
        // asynchronously. Tests that need stronger ordering use
        // `s.pause(...)` to advance TestClock past the puller's
        // reconnect interval.

        // Rehydrate owned calls + their persisted timer fibers from
        // the local `pri:{self}:` partition. On initial boot the
        // partition is empty so this is a no-op; on respawn (after
        // ReadyGate drained the peer's reverse-propagate stream into
        // `pri:{self}:`), this respawns OPTIONS keepalive /
        // limiter-refresh / no-answer timer fibers so the call keeps
        // ticking across the restart. Errors are logged and swallowed
        // — a recovery failure must not keep the worker stuck.
        yield* router.rehydrateOwnedCalls(handlers).pipe(
          Effect.catchTag("RedisError", (e) =>
            Effect.logError(
              `[${w.id as unknown as string}] rehydrateOwnedCalls failed: ${e.reason}`
            )
          )
        )

        // Bind connectivity AFTER the readiness drain so external
        // packets only land once the worker is ready to serve.
        yield* Effect.provideService(
          connectivity.bind(w.id as unknown as string, {
            ip: w.address.host,
            port: w.address.port,
          }),
          Scope.Scope,
          scope,
        )

        // Fork SipRouter ingest into the worker's scope.
        yield* Effect.forkIn(router.start(handlers), scope)

        return { callState, timers }
      })

    // Initial boot: open a child scope per worker and run buildWorker.
    for (const w of clusterWorkers) {
      const scope = yield* Scope.fork(sutScope, "sequential")
      const built = yield* buildWorker(w, scope)
      const idStr = w.id as unknown as string
      const handle: WorkerRuntimeHandle = {
        id: w.id,
        scope,
        // Respawn rebuilds the worker against a fresh scope and writes
        // the new per-worker `CallState`/`TimerService` instances back
        // into the handle so cluster-wide sweeps consult the live
        // services rather than the dead pre-respawn ones.
        rebuild: (newScope) =>
          Effect.gen(function* () {
            const rebuilt = yield* buildWorker(w, newScope)
            handle.callState = rebuilt.callState
            handle.timers = rebuilt.timers
          }),
        callState: built.callState,
        timers: built.timers,
      }
      handles.set(idStr, handle)
    }

    // Lifecycle wiring exposed to the cluster service.
    const lifecycle: WorkerLifecycle = {
      handles,
      sutScope,
      registryAdd: (id) => {
        const w = clusterWorkers.find(
          (cw) => (cw.id as unknown as string) === (id as unknown as string),
        )
        if (w === undefined) {
          throw new Error(`registryAdd: unknown worker "${id as unknown as string}"`)
        }
        return registry.add({
          id: w.id,
          address: w.address,
          health: "unknown",
        })
      },
      onRebootSideEffects: (id) =>
        Effect.gen(function* () {
          const w = clusterWorkers.find(
            (cw) => (cw.id as unknown as string) === (id as unknown as string),
          )
          if (w === undefined) {
            throw new Error(
              `onRebootSideEffects: unknown worker "${id as unknown as string}"`,
            )
          }
          // Slice 7c: refresh the per-peer KvBackend pointer so
          // other workers' PullerFibers reconnect against the fresh
          // storage handle on next cycle. The old KvBackend is
          // garbage-collected when its store and references go out
          // of scope (PeerFabric.rebootWorker swapped the handle).
          refreshPeerKv(w.ordinal)
          yield* Effect.void
        }),
    }

    return lifecycle
  })

  // Apply the assembled lifecycle to SimulatedK8sClusterLayer. The
  // outer .pipe(Layer.provide(...)) chain hooks up the same
  // requirements `built` advertises (registry, connectivity, fabric).
  return Layer.unwrap(
    built.pipe(
      Effect.map((lifecycle) =>
        SimulatedK8sClusterLayer({
          workers: clusterWorkers,
          lifecycle,
        }),
      ),
    ),
  )
}

/** Re-export for tests that want to enumerate the cluster ordinals. */
export const k8sWorkerOrdinal = (n: number) =>
  WorkerOrdinal(k8sWorkerId(n) as unknown as string)
