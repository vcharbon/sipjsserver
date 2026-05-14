/**
 * registrarFrontProxyHybridStack — register-proxy SUT layer for the
 * hybrid `register-fakeExt-realCore` harness.
 *
 * Runs `ProxyCore` in dual-endpoint registrar mode **inside the test
 * process**, with the two endpoints intentionally on DIFFERENT fabrics:
 *
 *   - `ext` endpoint binds on `SignalingNetwork` (provided externally
 *     as `SignalingNetwork.simulated`). alice/bob bind on the same
 *     fabric on synthetic `5.1.x.x` addresses — no kernel sockets.
 *   - `core` endpoint binds on `SignalingNetworkCore` (provided
 *     externally as `SignalingNetworkCore.realTracing`). Talks to the
 *     kind cluster over real UDP via the docker bridge gateway.
 *
 * Both fabrics record per-instance trace buffers; the hybrid runner
 * drains both and merges them into one timeline for the
 * HTML / global.txt report. The in-cluster LB → worker traffic stays
 * inside kind and is intentionally invisible — the proxy treats that
 * as a single opaque core peer at `coreDestination`.
 *
 * Production code (`bin/proxy.ts`) and the fake-clock fakestack do NOT
 * provide `SignalingNetworkCore`; ProxyCore then falls back to reusing
 * `SignalingNetwork` for both endpoints (the legacy single-fabric shape).
 */

import { Effect, Layer } from "effect"
import type { AppConfigData } from "../../config/AppConfig.js"
import {
  CancelBranchLru,
  CoreToExtRoutingStrategy,
  ForwardAllConfig,
  ForwardAllStrategyLive,
  ProxyBindConfig,
  ProxyCore,
  Registrar,
  RegisterStrategy,
  RegistrarProxyConfig,
  type SocketAddr,
  workerRegistryControlNoopLayer,
} from "../../sip-front-proxy/index.js"
import { fromString as staticRegistryFromString } from "../../sip-front-proxy/registry/static.js"

export interface RegistrarFrontProxyHybridStackOpts {
  readonly config: AppConfigData
  /** Bind / advertised address for the ext endpoint (alice / bob side). */
  readonly extBind: SocketAddr
  readonly extAdvertised: SocketAddr
  /** Bind / advertised address for the core endpoint (k8s-facing side). */
  readonly coreBind: SocketAddr
  readonly coreAdvertised: SocketAddr
  /** Where ext-INVITE forwards to when not resolved by registrar lookup. */
  readonly coreDestination: SocketAddr
}

/**
 * Build the in-process register-proxy SUT layer for the hybrid harness.
 * Returns a Layer providing `ProxyCore` and `SignalingNetwork` (real).
 *
 * The same `SignalingNetwork.real` instance is shared with the agent
 * transport (`live-backend`) so a single trace buffer captures every
 * UDP packet between alice/bob ↔ proxy and proxy ↔ kind-ingress —
 * that's what `drainTrace()` returns.
 */
export function registrarFrontProxyHybridStackLayer(
  opts: RegistrarFrontProxyHybridStackOpts,
) {
  // SignalingNetwork is intentionally NOT bundled here — the hybrid runner
  // provides one shared `SignalingNetwork.real` instance to both this
  // proxy layer and the live-backend agent transport, so a single trace
  // buffer captures every UDP hop on both ext and core sides.

  const BindCfgLayer = ProxyBindConfig.layer({
    bindHost: opts.extBind.host,
    bindPort: opts.extBind.port,
    advertisedHost: opts.extAdvertised.host,
    advertisedPort: opts.extAdvertised.port,
    queueMax: opts.config.udpQueueMax,
  })

  const RegistrarCfgLayer = RegistrarProxyConfig.layer({
    coreBind: opts.coreBind,
    coreAdvertisedHost: opts.coreAdvertised.host,
    coreAdvertisedPort: opts.coreAdvertised.port,
    coreDestination: opts.coreDestination,
  })

  // RoutingStrategy is required by ProxyCore but `handleRequestRegistrarMode`
  // never calls it for INVITEs that hit the registrar lookup path. Wire
  // ForwardAll → coreDestination so the legacy single-endpoint fallback
  // (if ever reached) still has a sane next hop.
  const RoutingLayer = ForwardAllStrategyLive.pipe(
    Layer.provide(ForwardAllConfig.layer(opts.coreDestination)),
  )

  // Single Registrar instance shared by the REGISTER strategy (writes)
  // and the core→ext lookup strategy (reads). See the corresponding
  // comment in registrarFrontProxyFakeStack.ts for why this can't rely
  // on Effect's per-Layer-value memoisation.
  const SharedRegistrar = Registrar.inMemoryLayer
  const StrategyLayers = Layer.mergeAll(
    RegisterStrategy.inMemoryRegistrarLayer,
    CoreToExtRoutingStrategy.registrarLookupLayer,
  ).pipe(Layer.provide(SharedRegistrar))

  const RegistryLayer = staticRegistryFromString("").pipe(Layer.orDie)

  const Leaves = Layer.mergeAll(
    BindCfgLayer,
    RegistrarCfgLayer,
    CancelBranchLru.Default,
    RoutingLayer,
    StrategyLayers,
    RegistryLayer,
    workerRegistryControlNoopLayer,
  )

  return ProxyCore.Default.pipe(Layer.provideMerge(Leaves))
}

/**
 * Convenience: bind the proxy and wait for it to be ready (ProxyCore's
 * scope acquires both ext and core endpoints during layer build).
 */
export const startProxy = Effect.gen(function* () {
  const proxy = yield* ProxyCore
  yield* Effect.logInfo(
    `[hybrid-proxy] ext=${proxy.localAddress.ip}:${proxy.localAddress.port} ` +
      `core=${proxy.coreLocalAddress?.ip ?? "-"}:${proxy.coreLocalAddress?.port ?? "-"}`,
  )
  return proxy
})
