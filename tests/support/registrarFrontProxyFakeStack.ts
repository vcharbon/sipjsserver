/**
 * registrarFrontProxyFakeStack — SUT layer for slice 3 of the
 * REGISTER + double-stack proxy work.
 *
 * Wires a single `ProxyCore` running in registrar mode (dual ext/core
 * endpoints, in-memory `Registrar`, `inMemoryRegistrar` REGISTER strategy,
 * `registrarLookup` core→ext strategy) on top of one
 * `SignalingNetwork.simulated` fabric. The ext / core "fabric boundary"
 * is encoded in IP subnets (matching `sipproxyHA`'s convention):
 *
 *   - 10.30.0.x — `ext` endpoints (Alice, Bob, …)
 *   - 10.40.0.x — `core` endpoints (the K8s app server)
 *
 * The proxy listens at `EXT_INGRESS` on the ext side and at
 * `CORE_INGRESS` on the core side. Scenarios pick whichever side they're
 * binding agents on via `s.agent("alice", { ip: ALICE_IP, network: "ext" })`
 * etc.; the simulated-backend reads `agentConfig.network` and threads it
 * through the trace renderer so the HTML report paints two lanes.
 *
 * No B2BUA, no K8s LB strategy, no `WorkerRegistry` — registrar mode is
 * orthogonal to those. The test fixture provides:
 *
 *   - `Registrar.inMemoryLayer` (the live binding store)
 *   - `RegisterStrategy.inMemoryRegistrarLayer`
 *   - `CoreToExtRoutingStrategy.registrarLookupLayer`
 *   - `RegistrarProxyConfig.layer({ coreBind, coreDestination })`
 *   - `RoutingStrategy = ForwardAllStrategyLive` pointed at the K8s
 *     app-server destination — this is the "ext INVITE → core" path's
 *     fallback selectForNewDialog (which `handleRequestRegistrarMode`
 *     never actually consults; we wire it for layer-completeness only).
 *   - empty `WorkerRegistry` (no workers in registrar mode).
 *   - `CancelBranchLru.Default` (still used for INVITE↔CANCEL matching).
 *   - `Hmac` keys aren't relevant — only the LB strategy reads HMAC.
 */

import { Layer } from "effect"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import {
  CancelBranchLru,
  CoreToExtRoutingStrategy,
  ForwardAllConfig,
  ForwardAllStrategyLive,
  ProxyBindConfig,
  ProxyCore,
  ProxySelfGate,
  Registrar,
  RegisterStrategy,
  RegistrarProxyConfig,
  type SocketAddr,
  workerRegistryControlNoopLayer,
} from "../../src/sip-front-proxy/index.js"
import { simulatedLayer as loadSamplerSimulatedLayer } from "../../src/observability/LoadSampler.js"
import { fromString as staticRegistryFromString } from "../../src/sip-front-proxy/registry/static.js"
import { PumpableClockLayer } from "./PumpableClock.js"

/** Default simulated transit delay — same as the other SUTs. */
export const DEFAULT_TRANSIT_DELAY_MS = 15

/** ext-side ingress (where Alice / Bob send REGISTER and INVITE). */
export const EXT_INGRESS: SocketAddr = { host: "10.30.0.1", port: 15060 }

/** core-side ingress (where the K8s app server originates inbound calls). */
export const CORE_INGRESS: SocketAddr = { host: "10.40.0.1", port: 15060 }

/** The fixed core destination ext INVITEs always forward to. */
export const CORE_DESTINATION: SocketAddr = { host: "10.40.0.10", port: 5060 }

/** Helper: an ext-side agent IP (10.30.0.x). */
export const extIp = (n: number): string => `10.30.0.${n + 100}`
/** Helper: a core-side agent IP (10.40.0.x). */
export const coreIp = (n: number): string => `10.40.0.${n + 100}`

export interface RegistrarFrontProxyFakeStackOpts {
  readonly config: AppConfigData
  /**
   * Whether the proxy stamps Record-Route on dialog-creating requests.
   * `true` preserves existing register-proxy behaviour; `false` selects
   * the non-record-routing mode so in-dialog traffic bypasses the proxy.
   */
  readonly recordRoute: boolean
  readonly transitDelayMs?: number
  /**
   * Optional send-fault injector forwarded to `SignalingNetwork.simulated`.
   * Returning a string for a (src, dst) pair makes that send fail with
   * `SendError`, used by drop-handling regression tests (e.g. registrar
   * 503-on-EAI_AGAIN).
   */
  readonly sendFault?: (
    src: { readonly ip: string; readonly port: number },
    dst: { readonly ip: string; readonly port: number },
  ) => string | null
}

/**
 * Build the `registrarFrontProxy` SUT layer.
 *
 * `config` is taken for parity with the other SUT layer factories (so
 * scenarios can hand the same `testAppConfigDefaults({...})` they pass
 * to `b2bonly` / `proxy+b2b`). Most fields are unused — registrar mode
 * doesn't run a B2BUA — but a few (e.g. `udpQueueMax`) flow through
 * `ProxyBindConfig.queueMax` for consistent behaviour across SUTs.
 */
export function registrarFrontProxyFakeStackLayer(
  opts: RegistrarFrontProxyFakeStackOpts,
) {
  const transitDelayMs = opts.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS

  const NetworkLayer = SignalingNetwork.simulated({
    transitDelayMs,
    ...(opts.sendFault !== undefined ? { sendFault: opts.sendFault } : {}),
  })

  const BindCfgLayer = ProxyBindConfig.layer({
    bindHost: EXT_INGRESS.host,
    bindPort: EXT_INGRESS.port,
    advertisedHost: EXT_INGRESS.host,
    advertisedPort: EXT_INGRESS.port,
    queueMax: opts.config.udpQueueMax,
  })

  const RegistrarCfgLayer = RegistrarProxyConfig.layer({
    coreBind: CORE_INGRESS,
    coreAdvertisedHost: CORE_INGRESS.host,
    coreAdvertisedPort: CORE_INGRESS.port,
    coreDestination: CORE_DESTINATION,
    recordRoute: opts.recordRoute,
  })

  // RoutingStrategy is required by ProxyCore but `handleRequestRegistrarMode`
  // never calls it. ForwardAll-to-CORE_DESTINATION makes the layer
  // resolve and gives a sane fallback if a deployment ever reaches the
  // legacy single-endpoint code path with this layer wired.
  const RoutingLayer = ForwardAllStrategyLive.pipe(
    Layer.provide(ForwardAllConfig.layer(CORE_DESTINATION)),
  )

  // CRITICAL: register and lookup must share ONE Registrar instance so
  // bindings made by the REGISTER handler are visible to the
  // core→ext lookup. Provide `Registrar.inMemoryLayer` once and merge it
  // outward so both consumers (`RegisterStrategy.inMemoryRegistrarLayer`
  // and `CoreToExtRoutingStrategy.registrarLookupLayer`) read the same
  // map. (Layer composition normally memoises a layer, but doing
  // `Layer.provide(Registrar.inMemoryLayer)` separately on each strategy
  // would in fact build two — Effect's memoisation is per layer
  // *value*, and the value here is a fresh `Layer.effect` each time.)
  const SharedRegistrar = Registrar.inMemoryLayer
  const StrategyLayers = Layer.mergeAll(
    RegisterStrategy.inMemoryRegistrarLayer,
    CoreToExtRoutingStrategy.registrarLookupLayer,
  ).pipe(Layer.provide(SharedRegistrar))

  // Empty static worker registry + noop registry control — registrar
  // mode has no LB workers but ProxyCore.Default's surface still
  // requires those services. `staticRegistryFromString("")` returns a
  // layer with a typed parse error in its channel; an empty string
  // never fails to parse, so promote that to a defect for layer
  // composition (matches `bin/proxy.ts`'s static-mode wiring shape).
  const RegistryLayer = staticRegistryFromString("").pipe(Layer.orDie)
  const Leaves = Layer.mergeAll(
    BindCfgLayer,
    RegistrarCfgLayer,
    CancelBranchLru.Default,
    RoutingLayer,
    StrategyLayers,
    RegistryLayer,
    workerRegistryControlNoopLayer,
    // Slice 6 — proxy-self gate. Permissive config — registrar baseline
    // tests don't exercise the gate; tests that do build their own layer.
    ProxySelfGate.layer({
      eluCritical: 0.95,
      cpsBucketSize: 1000000,
      cpsBucketRate: 1000000,
      eluSmoothingAlpha: 0.2,
      samplerIntervalMs: 100,
    }).pipe(Layer.provide(loadSamplerSimulatedLayer())),
  )

  return ProxyCore.Default.pipe(
    Layer.provideMerge(Leaves),
    Layer.provideMerge(NetworkLayer),
    Layer.provideMerge(PumpableClockLayer),
  )
}
