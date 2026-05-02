/**
 * proxyB2bFakeStack — the SUT layer for the `proxy+b2b` matrix arm of
 * the fake-clock e2e harness. Wires a real `ProxyCore` in front of one
 * real `B2buaCoreLayer` worker, both bound on the same
 * `SignalingNetwork.simulated`. Reuses `b2buaWorkerStackLayer` and
 * `proxyStackLayer` from `networkLeaves.ts` — same building blocks as
 * `fakeStackLayer` and `proxyFakeStack`, just composed differently so a
 * single packet can flow alice→proxy→worker→bob (and back) without ever
 * leaving the shared in-memory fabric.
 *
 * ## Topology
 *
 *   alice ──UDP──► proxy(127.0.0.1:15060) ──UDP──► worker(127.0.0.1:15061) ──UDP──► bob
 *
 * - `INGRESS_ADDR` is the address scenarios send their initial INVITE
 *   to. It's the proxy's listen port, but it matches the port
 *   `fakeStackLayer` exposes by default (15060), so scenarios that
 *   hardcode `sip:…@127.0.0.1:15060` work unchanged on both SUTs.
 * - `WORKER_ADDR` is where the B2BUA worker listens. It's deliberately
 *   different from the proxy address; the worker's `sipLocalPort`
 *   matches.
 *
 * ## What's NOT here yet (Slice B)
 *
 * In Slice A the worker still sends its B-leg INVITEs directly to Bob,
 * exactly like `fakeStackLayer`. Slice B introduces
 * `AppConfig.b2bOutboundProxy` and the matching worker logic so the
 * B-leg also traverses the proxy — at which point a Bob-initiated BYE
 * also routes back through the proxy via the cookie-decode path.
 */

import { Effect, Layer, ServiceMap } from "effect"
import { TestClock } from "effect/testing"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { SipRouter, type HandlerRegistry } from "../../src/sip/SipRouter.js"
import {
  HealthProbe,
  healthProbeOptionsKeepaliveLayer,
  type SocketAddr,
  workerRegistryControlSimulatedAdapterLayer,
  WorkerId,
} from "../../src/sip-front-proxy/index.js"
import { PeerFabric } from "../../src/cache/PeerFabric.js"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import { b2buaWorkerStackLayer, proxyStackLayer } from "./networkLeaves.js"
import { CdrWriter, makeCdrRecordsBuffer } from "../../src/cdr/CdrWriter.js"
import { PumpableClockLayer } from "./PumpableClock.js"

/** Default simulated transit delay — same as `fakeStack`'s. */
export const DEFAULT_TRANSIT_DELAY_MS = 15

/**
 * Pinned address scenarios send their initial INVITE to. Matches the
 * b2bonly default so basicCall and friends don't have to know which
 * SUT they're running against.
 */
export const INGRESS_ADDR: SocketAddr = { host: "127.0.0.1", port: 15060 }

/**
 * Pinned worker bind. `sipLocalPort` in the worker's `AppConfigData`
 * matches; UDP packets the proxy forwards land here.
 */
export const WORKER_ADDR: SocketAddr = { host: "10.0.0.1", port: 15061 }

/** Stable WorkerId for the single registered worker. */
export const WORKER_ID = WorkerId("test-worker-1")

export interface ProxyB2bFakeStackOpts {
  readonly config: AppConfigData
  readonly transitDelayMs?: number
}

/**
 * Build the `proxy+b2b` SUT layer.
 *
 * Returned layer exposes every service from both the proxy stack and
 * the worker stack — `ProxyCore`, `SipRouter`, `CallState`,
 * `SignalingNetwork`, etc. — all sharing one `SignalingNetwork`. The
 * worker is registered with the proxy's `WorkerRegistry` at construction
 * time; the proxy's `LoadBalancerStrategyLive` selects it via HRW for
 * any inbound dialog (with one worker, the only possible outcome).
 */
export function proxyB2bFakeStackLayer(opts: ProxyB2bFakeStackOpts) {
  // Force the worker's sipLocalPort to match WORKER_ADDR so legStackIdentity
  // stamps the right Via/Contact addresses; ingress is the proxy's port.
  // Set `b2bOutboundProxy` so B-leg dialog-creating outbound traffic
  // also traverses the proxy (Bob's responses + in-dialog requests come
  // back through the proxy via the stickiness cookie — symmetric with
  // the A-leg path).
  const workerConfig: AppConfigData = {
    ...opts.config,
    sipLocalIp: WORKER_ADDR.host,
    sipLocalPort: WORKER_ADDR.port,
    b2bOutboundProxy: { host: INGRESS_ADDR.host, port: INGRESS_ADDR.port },
  }

  const NetworkLayer = SignalingNetwork.simulated({
    transitDelayMs: opts.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS,
  })

  const WorkerStack = b2buaWorkerStackLayer({ config: workerConfig })
  const ProxyStack = proxyStackLayer({
    proxyAddr: INGRESS_ADDR,
    workers: [{ id: WORKER_ID, address: WORKER_ADDR, health: "alive" }],
  })

  return Layer.mergeAll(WorkerStack, ProxyStack).pipe(
    Layer.provideMerge(NetworkLayer),
    Layer.provideMerge(PumpableClockLayer),
  )
}

// ---------------------------------------------------------------------------
// sipproxyHA — 2-B2BUA SUT with subnet addressing and HealthProbe wired
// ---------------------------------------------------------------------------
//
// Topology — proxy is the central hub for every leg. With
// `b2bOutboundProxy` set on each B2BUA, B-leg INVITEs and Bob-initiated
// in-dialog requests also traverse the proxy, exercising the stickiness-
// cookie decode path symmetrically with the A-leg.
//
//                     ┌─────────────────────────┐
//   alice-1 ─UDP─▶    │     proxy 10.10.0.1     │   ◀─UDP─ bob-1
//   10.30.0.1:5060    │           :15060        │          10.40.0.1:5060
//                     └────┬────────────────┬───┘
//                          │ UDP            │ UDP
//                          ▼                ▼
//                    b2b-1 10.20.0.1   b2b-2 10.20.0.2
//                       :5060             :5060
//
// Subnet conventions (encoded in the second octet for at-a-glance trace
// readability):
//   - 10.10.0.x — proxy (single instance)
//   - 10.20.0.x — B2BUA workers
//   - 10.30.0.x — UAC side (alices)
//   - 10.40.0.x — UAS side (bobs)
//
// Each worker keeps its **own in-memory `PartitionedRelayStorage`** (no shared
// cache — HA design uses per-call dual-Redis backup, not replicated
// shared state). Per-worker stacks are otherwise identical except for
// `sipLocalIp` / `sipLocalPort`. The "primary" worker (worker-1) exposes
// its services outward for the harness's `setup()` to bootstrap a single
// `SipRouter` start. The "secondary" worker (worker-2) is materialized
// inside a hidden scope (`Layer.scopedDiscard`) and self-starts its own
// SipRouter — its services do not collide with the primary's outward-
// exposed service map.
//
// Workers are admitted to the registry as `unknown`; `HealthProbe`
// (`optionsKeepalive`) flips them to `alive` after the first 200 OK to
// the proxy's OPTIONS keepalive (MS-1 production behavior). Scenarios
// pause ~5s before sending traffic so the probe has time to settle.

/** Proxy bind for the sipproxyHA SUT. */
export const HA_PROXY_ADDR: SocketAddr = { host: "10.10.0.1", port: 15060 }

/** Probe's outbound UDP source — distinct from proxy ingress. */
const HA_PROBE_BIND = { ip: "10.10.0.1", port: 25060 }

/** B2BUA worker host helper: `haWorkerIp(1) === "10.20.0.1"`. */
export const haWorkerIp = (n: number): string => `10.20.0.${n}`
/** Alice (UAC) host helper: `haAliceIp(1) === "10.30.0.1"`. */
export const haAliceIp = (n: number): string => `10.30.0.${n}`
/** Bob (UAS) host helper: `haBobIp(1) === "10.40.0.1"`. */
export const haBobIp = (n: number): string => `10.40.0.${n}`

/** Stable WorkerIds for the two registered workers. */
export const HA_WORKER_1 = WorkerId("b2b-1")
export const HA_WORKER_2 = WorkerId("b2b-2")
export const HA_WORKER_IDS = [HA_WORKER_1, HA_WORKER_2] as const

/** Address the proxy advertises in Record-Route on the new SUT. */
export const HA_WORKER_ADDR = (n: number): SocketAddr => ({
  host: haWorkerIp(n),
  port: 5060,
})

export interface SipproxyHAFakeStackOpts {
  readonly config: AppConfigData
  readonly transitDelayMs?: number
  /**
   * `HandlerRegistry` each worker's `SipRouter.start` runs with.
   * Passed in (rather than imported) to keep the SUT layer free of
   * the handler-registry construction logic, which lives in the
   * harness layer (`tests/fullcall/framework`).
   */
  readonly handlers: HandlerRegistry
}

/** Build a per-worker `AppConfigData` from the test base config. */
const haWorkerConfig = (
  base: AppConfigData,
  addr: SocketAddr,
  ordinalLabel: string
): AppConfigData => ({
  ...base,
  sipLocalIp: addr.host,
  sipLocalPort: addr.port,
  b2bOutboundProxy: { host: HA_PROXY_ADDR.host, port: HA_PROXY_ADDR.port },
  // Slice 5: name the worker with the same string the proxy uses in
  // the stickiness cookie (`w_pri`/`w_bak`). CallState reads this for
  // its `partitionOf` decision so cookies and storage paths align.
  workerOrdinalLabel: ordinalLabel,
})

/**
 * Build a single B2BUA instance as a layer that **provides nothing
 * outward** but keeps its `UdpTransport` binding + forked
 * `SipRouter` ingress fiber alive for the surrounding (SUT) scope.
 *
 * Why the `Layer.fresh` + `Layer.buildWithScope` + `Effect.forkIn`
 * dance: composing two `b2buaWorkerStackLayer` instances at the
 * outer level via `Layer.merge` would collide on every service tag
 * (each provides `SipRouter`, `CallState`, `UdpTransport`, ...). The
 * obvious workaround — wrapping the inner layer in
 * `Effect.provide(stack)` inside a `Layer.effectDiscard` — releases
 * the inner layer's UdpTransport binding the moment the wrapped
 * effect returns (after `forkScoped`), so the probe's OPTIONS
 * packets to that worker become undeliverable for the rest of the
 * test. Binding the worker's layer resources to the *outer* scope
 * via `buildWithScope` (and forking the router fiber into that same
 * scope) is the only shape that keeps the binding alive without the
 * service-tag collisions.
 */
const b2buaInstance = (
  config: AppConfigData,
  handlers: HandlerRegistry,
  storageLayer?: Layer.Layer<
    import("../../src/cache/PartitionedRelayStorage.js").PartitionedRelayStorage
  >,
  peerCacheLayer?: Layer.Layer<
    import("../../src/cache/PeerCachePort.js").PeerCachePort
  >,
  cdrLayer?: Layer.Layer<CdrWriter>
): Layer.Layer<never, never, SignalingNetwork> => {
  // `Layer.fresh` gives this instance a distinct memo identity so a
  // second composition with the same `config` materialises fresh
  // resources rather than aliasing the first. When a peer-cache layer
  // is supplied, merge it INSIDE the freshness boundary so each
  // worker pulls its own `self`-pinned port (`cachePortLayerOf` is
  // per-worker). The `cdrLayer` parameter lets the SUT pass a
  // `CdrWriter.sharedTestLayer(buffer)` so all workers' CDRs land in
  // a single buffer the harness can read.
  const baseStack = b2buaWorkerStackLayer({
    config,
    ...(storageLayer !== undefined ? { storageLayer } : {}),
    ...(cdrLayer !== undefined ? { cdrLayer } : {}),
  })
  const stack = Layer.fresh(
    peerCacheLayer === undefined
      ? baseStack
      : Layer.provideMerge(baseStack, peerCacheLayer)
  )
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const services = yield* Layer.buildWithScope(stack, scope)
      const router = ServiceMap.get(services, SipRouter)
      yield* Effect.forkIn(router.start(handlers), scope)
    })
  )
}

/**
 * Build the `sipproxyHA` SUT layer: real `ProxyCore` + two real
 * B2BUA workers + `HealthProbe`, all on a shared
 * `SignalingNetwork.simulated`.
 *
 * Both workers are wired symmetrically via `b2buaInstance` — neither
 * exposes services outward (their `SipRouter`/`CallState`/etc. live
 * inside the SUT layer's scope but are not visible to test code).
 * Test code communicates with workers exclusively over UDP through
 * the shared `SignalingNetwork`. `HealthProbe.start` is invoked from
 * inside the SUT layer (also via `Layer.effectDiscard`) so the
 * harness's `setup()` for sipproxyHA has nothing to do — every
 * fiber bootstraps from the layer.
 */
export function sipproxyHAFakeStackLayer(opts: SipproxyHAFakeStackOpts) {
  const transitDelayMs = opts.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS

  const w1Addr = HA_WORKER_ADDR(1)
  const w2Addr = HA_WORKER_ADDR(2)

  const NetworkLayer = SignalingNetwork.simulated({ transitDelayMs })

  // Slice 5: build a simulated peer fabric BEFORE materialising the
  // workers so each worker's `PartitionedRelayStorage` is pinned to
  // its peer slot in the fabric. The fabric also exposes the
  // `PeerCachePort` impl that Phase D's dual-write fan-out will use.
  const w1Ord = WorkerOrdinal(HA_WORKER_1 as unknown as string)
  const w2Ord = WorkerOrdinal(HA_WORKER_2 as unknown as string)
  const fabricBuilt = PeerFabric.simulatedBuilt([w1Ord, w2Ord])

  // Shared CDR buffer: both workers write into the same in-memory
  // array so the harness can verify cross-worker behaviour (e.g. that
  // a BYE handled on the backup after primary takeover still produces
  // exactly one CDR). The same `sharedCdrLayer` is provided into each
  // worker AND merged at the outer scope so `yield* CdrWriter` in the
  // harness reads the aggregated records.
  const cdrBuffer = makeCdrRecordsBuffer()
  const sharedCdrLayer = CdrWriter.sharedTestLayer(cdrBuffer)

  // Both workers — symmetric. Services hidden, resources scoped to
  // the SUT layer. Each worker's storage points at its fabric peer
  // slot so writes/reads are observable through `snapshotPeer` and
  // `PeerCachePort` round-trips between them. The per-worker peer
  // cache port is pinned to its `self` ordinal so partition checks
  // applied to outbound RPCs land on the right (self, peer) pair.
  const Workers = Layer.mergeAll(
    b2buaInstance(
      haWorkerConfig(opts.config, w1Addr, w1Ord),
      opts.handlers,
      fabricBuilt.fabric.storageLayerOf(w1Ord),
      fabricBuilt.fabric.cachePortLayerOf(w1Ord),
      sharedCdrLayer,
    ),
    b2buaInstance(
      haWorkerConfig(opts.config, w2Addr, w2Ord),
      opts.handlers,
      fabricBuilt.fabric.storageLayerOf(w2Ord),
      fabricBuilt.fabric.cachePortLayerOf(w2Ord),
      sharedCdrLayer,
    ),
  )

  // Proxy stack: both workers admitted as `unknown` per MS-1. The
  // HealthProbe transitions them to `alive` after the first 200 OK to
  // OPTIONS — scenarios `s.pause(5000)` to let that settle.
  const ProxyStack = proxyStackLayer({
    proxyAddr: HA_PROXY_ADDR,
    workers: [
      { id: HA_WORKER_1, address: w1Addr, health: "unknown" },
      { id: HA_WORKER_2, address: w2Addr, health: "unknown" },
    ],
  })

  // HealthProbe + control adapter on top of the proxy's simulated
  // registry. `provideMerge` re-exposes ProxyStack's services outward
  // alongside the probe.
  const ControlAdapter = workerRegistryControlSimulatedAdapterLayer.pipe(
    Layer.provideMerge(ProxyStack)
  )
  const Probe = healthProbeOptionsKeepaliveLayer({
    bindHost: HA_PROBE_BIND.ip,
    bindPort: HA_PROBE_BIND.port,
  }).pipe(Layer.provideMerge(ControlAdapter))

  // Auto-start the probe at layer-materialization time. Its tick
  // loop is forked into the layer's scope (see HealthProbe.ts), so
  // it runs for the full test lifetime without the harness having to
  // yield the service.
  const ProbeAutoStart = Layer.effectDiscard(
    Effect.gen(function* () {
      const probe = yield* HealthProbe
      yield* probe.start
    }),
  ).pipe(Layer.provideMerge(Probe))

  // Slice 5: re-expose the fabric services outward so scenarios can
  // pull `PeerFabricControl` (kill / partition / snapshot) without
  // needing to thread it through `setup()`. The shared CDR layer is
  // merged outward too so the harness's `yield* CdrWriter` returns
  // the aggregated records from both workers.
  return Layer.mergeAll(Workers, ProbeAutoStart, fabricBuilt.layer, sharedCdrLayer).pipe(
    Layer.provideMerge(NetworkLayer),
    Layer.provideMerge(PumpableClockLayer),
  )
}

/**
 * Pump the simulated fabric: yield once, advance virtual time enough for
 * one transit, yield again, advance again. Three transits cover the
 * worst case for proxy+b2b (alice→proxy + proxy→worker + worker→bob in
 * the same scheduler step).
 */
export const pumpFor = (transitDelayMs: number, cycles = 1) =>
  Effect.gen(function* () {
    for (let i = 0; i < cycles; i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${transitDelayMs + 1} millis`)
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${transitDelayMs + 1} millis`)
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${transitDelayMs + 1} millis`)
      yield* Effect.yieldNow
    }
  })
