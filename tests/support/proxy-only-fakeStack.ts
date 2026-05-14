/**
 * proxy-only-fakeStack — fixture for the transit-only PR2 test suite.
 *
 * Wires `SignalingNetwork.simulated` + `ProxyCore` + `ForwardAllStrategy`
 * + `CancelBranchLru` over a single in-memory UDP fabric so a test can
 * spin up Alice / Proxy / Bob inside the same Effect runtime under
 * `it.effect` + TestClock. No real sockets, no Redis, no wall clock.
 *
 * Mirrors the shape of `tests/support/fakeStack.ts` (B2BUA fake stack):
 *
 *   const layer = proxyOnlyFakeStackLayer({
 *     proxyAddr: { host: "10.0.0.1", port: 5060 },
 *     forwardTarget: { host: "10.0.0.3", port: 5060 },
 *   })
 *
 *   it.effect("…", () => Effect.gen(function* () {
 *     const proxy = yield* ProxyCore
 *     const alice = yield* bindUac({ host: "10.0.0.2", port: 5060 })
 *     const bob   = yield* bindUas({ host: "10.0.0.3", port: 5060 })
 *     // …drive UDP packets directly via alice.send / bob.send / poll…
 *   }).pipe(Effect.provide(layer)))
 *
 * The fixture deliberately exposes `bindUac` / `bindUas` as raw
 * `UdpEndpoint` factories — the transit-only suite drives the proxy with
 * hand-built byte buffers and asserts on parsed/serialized message
 * shapes, not on a higher-level call-flow framework. PR3+ scenario tests
 * can layer one on top.
 */

import { Effect, Layer, type Scope } from "effect"
import {
  CancelBranchLru,
  CoreToExtRoutingStrategy,
  ForwardAllConfig,
  ForwardAllStrategyLive,
  workerRegistryControlNoopLayer,
  ProxyBindConfig,
  type ProxyBindConfigData,
  ProxyCore,
  RegisterStrategy,
  type SocketAddr,
} from "../../src/sip-front-proxy/index.js"
import { fromString as staticRegistryFromString } from "../../src/sip-front-proxy/registry/static.js"
import { SignalingNetwork, type UdpEndpoint } from "../../src/sip/SignalingNetwork.js"

/** Default simulated transit delay — same as the B2BUA fake stack. */
export const DEFAULT_TRANSIT_DELAY_MS = 5

export interface ProxyOnlyFakeStackOpts {
  /** ip:port the proxy binds (and advertises) on. */
  readonly proxyAddr: SocketAddr
  /** ip:port the proxy forwards every new dialog to. */
  readonly forwardTarget: SocketAddr
  /** Override transit delay (default: 5 ms virtual). */
  readonly transitDelayMs?: number
  /** Override CancelBranchLru TTL (default: 32 s). */
  readonly cancelLruTtlMs?: number
  /** Override CancelBranchLru sweep interval (default: 16 s). */
  readonly cancelLruSweepIntervalMs?: number
  /** Override proxy bind queueMax (default: 1024). */
  readonly proxyQueueMax?: number
  /** Override proxy ingress concurrency (default: 1 — sequential). */
  readonly ingressConcurrency?: number
}

/**
 * Build the fake-stack layer.
 *
 * Returned layer exposes every service the test might want — `SignalingNetwork`
 * (so a test can `bindUdp` more endpoints for Alice/Bob), `ProxyCore` (for
 * its `localAddress` / `endpoint`), `RoutingStrategy` and `CancelBranchLru`
 * (so tests can poke at strategy state / LRU size).
 */
export function proxyOnlyFakeStackLayer(opts: ProxyOnlyFakeStackOpts) {
  const NetworkLayer = SignalingNetwork.simulated({
    transitDelayMs: opts.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS,
  })
  const bindCfg: ProxyBindConfigData = {
    bindHost: opts.proxyAddr.host,
    bindPort: opts.proxyAddr.port,
    advertisedHost: opts.proxyAddr.host,
    advertisedPort: opts.proxyAddr.port,
    queueMax: opts.proxyQueueMax ?? 1024,
    ...(opts.ingressConcurrency !== undefined
      ? { ingressConcurrency: opts.ingressConcurrency }
      : {}),
  }
  const BindCfgLayer = ProxyBindConfig.layer(bindCfg)
  const ForwardCfgLayer = ForwardAllConfig.layer(opts.forwardTarget)
  const StrategyLayer = ForwardAllStrategyLive.pipe(Layer.provide(ForwardCfgLayer))
  const LruLayer = CancelBranchLru.layer({
    ...(opts.cancelLruTtlMs !== undefined ? { ttlMs: opts.cancelLruTtlMs } : {}),
    ...(opts.cancelLruSweepIntervalMs !== undefined
      ? { sweepIntervalMs: opts.cancelLruSweepIntervalMs }
      : {}),
  })

  // ProxyCore needs a `WorkerRegistry` to classify worker-sourced traffic
  // as outbound (the cookie-decode loop fix). ForwardAll mode has no
  // workers; an empty static registry makes `lookupByAddress` always
  // return `Option.none`, restoring the pre-fix behaviour for these
  // topology-only tests.
  const RegistryLayer = staticRegistryFromString("")

  // Compose: every leaf provided once, every consumer reads from the same
  // bundle (the "sharing rule" lifted from `tests/support/fakeStack.ts`).
  const Leaves = Layer.mergeAll(
    NetworkLayer,
    BindCfgLayer,
    LruLayer,
    StrategyLayer,
    RegistryLayer,
    workerRegistryControlNoopLayer,
    // Slice 2 of REGISTER + double-stack: noop variants — this fixture
    // never exercises the registrar path. REGISTER would surface as 501
    // and the unused `core`-to-`ext` lookup is never reached.
    RegisterStrategy.noopLayer,
    CoreToExtRoutingStrategy.noopLayer,
  )
  return ProxyCore.Default.pipe(Layer.provideMerge(Leaves))
}

/**
 * Bind an extra simulated UDP endpoint (Alice / Bob in the test). Returns
 * the raw `UdpEndpoint` so the test can `endpoint.send(buf, port, host)`
 * and `yield* endpoint.poll()` without a higher-level wrapper.
 *
 * Bound endpoints live in the test's effect scope, so they're released
 * when the test returns.
 */
export const bindUdpEndpoint = (
  addr: SocketAddr,
  queueMax = 64
): Effect.Effect<UdpEndpoint, never, SignalingNetwork | Scope.Scope> =>
  Effect.gen(function* () {
    const net = yield* SignalingNetwork
    return yield* net
      .bindUdp({ ip: addr.host, port: addr.port, queueMax })
      .pipe(Effect.orDie)
  })
