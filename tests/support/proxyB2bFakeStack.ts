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
import { b2buaWorkerStackLayer, proxyStackLayer } from "./networkLeaves.js"
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
// Each worker keeps its **own in-memory `CallStateCache`** (no shared
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
}

/** Build a per-worker `AppConfigData` from the test base config. */
const haWorkerConfig = (
  base: AppConfigData,
  addr: SocketAddr
): AppConfigData => ({
  ...base,
  sipLocalIp: addr.host,
  sipLocalPort: addr.port,
  b2bOutboundProxy: { host: HA_PROXY_ADDR.host, port: HA_PROXY_ADDR.port },
})

/**
 * Build the `sipproxyHA` SUT layer: real `ProxyCore` + real B2BUA
 * primary worker (worker-1) + `HealthProbe`, all on a shared
 * `SignalingNetwork.simulated`. The **secondary worker (worker-2) is
 * NOT in this layer** — it is bootstrapped from the harness's
 * `setup()` via `Effect.forkScoped(haSecondaryWorkerEffect(...))` so
 * its UdpTransport binding stays alive for the test's full scope.
 *
 * (Putting it inside a `Layer.effectDiscard` with
 * `Effect.provide(b2buaWorkerStackLayer)` releases the inner layer's
 * UdpTransport binding the moment the wrapped effect completes — the
 * probe's OPTIONS packets to worker-2 then become undeliverable for
 * the rest of the test.)
 */
export function sipproxyHAFakeStackLayer(opts: SipproxyHAFakeStackOpts) {
  const transitDelayMs = opts.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS

  const w1Addr = HA_WORKER_ADDR(1)
  const w2Addr = HA_WORKER_ADDR(2)

  const NetworkLayer = SignalingNetwork.simulated({ transitDelayMs })

  // Primary worker: services exposed outward — harness `setup()` yields
  // `SipRouter` and forks `router.start(handlers)`, matching the
  // existing 1-worker SUT pattern.
  const PrimaryWorker = b2buaWorkerStackLayer({
    config: haWorkerConfig(opts.config, w1Addr),
  })

  // Secondary worker: explicitly bind the worker's layer resources to
  // the SUT's outer scope using `Layer.buildWithScope`, then fork the
  // SipRouter ingress fiber `Effect.forkIn` that same scope. This is
  // the only Effect-v4 shape that keeps a *second* b2buaWorkerStackLayer
  // alive without service-tag collisions:
  //
  //   - `Layer.fresh` gives the inner stack a distinct memo identity
  //     (so it materializes fresh resources rather than aliasing the
  //     primary worker's instance).
  //   - `Layer.buildWithScope(layer, outerScope)` ties UdpTransport's
  //     binding lifetime to the outer scope (= SUT layer scope). The
  //     `Effect.provide(layer)` shape would have tied them to the
  //     wrapped-effect's sub-scope, which closes the moment forkScoped
  //     returns.
  //   - `Effect.forkIn(eff, outerScope)` keeps the SipRouter ingress
  //     fiber alive for the same outer scope.
  //
  // Outcome: worker-2's UDP binding at 10.20.0.2:5060 stays bound for
  // the entire test, the OPTIONS handler responds, and the proxy's
  // HealthProbe transitions worker-2 from `unknown` to `alive`.
  const SecondaryStack = Layer.fresh(
    b2buaWorkerStackLayer({ config: haWorkerConfig(opts.config, w2Addr) })
  )
  const SecondaryWorker = Layer.effectDiscard(
    Effect.gen(function* () {
      const outerScope = yield* Effect.scope
      const services = yield* Layer.buildWithScope(SecondaryStack, outerScope)
      const router = ServiceMap.get(services, SipRouter)
      yield* Effect.forkIn(router.start(secondaryHandlersGetter()), outerScope)
    })
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

  return Layer.mergeAll(PrimaryWorker, SecondaryWorker, Probe).pipe(
    Layer.provideMerge(NetworkLayer),
    Layer.provideMerge(PumpableClockLayer),
  )
}

// Lazy handler injection — keep handlers out of the layer factory to
// avoid a tests/support → tests/fullcall import cycle. The harness
// calls `setSipproxyHASecondaryHandlers(buildTestHandlers())` before
// providing the SUT layer.
let secondarySipproxyHAHandlers: HandlerRegistry | undefined
const secondaryHandlersGetter = (): HandlerRegistry => {
  if (secondarySipproxyHAHandlers === undefined) {
    throw new Error(
      "sipproxyHA secondary worker: handlers not registered. Call " +
      "setSipproxyHASecondaryHandlers(buildTestHandlers()) before " +
      "providing the SUT layer."
    )
  }
  return secondarySipproxyHAHandlers
}

/** Inject the `HandlerRegistry` the secondary worker's `SipRouter` runs with. */
export const setSipproxyHASecondaryHandlers = (handlers: HandlerRegistry) => {
  secondarySipproxyHAHandlers = handlers
}


// Re-export so callers can yield it from the runtime context.
export { HealthProbe }

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
