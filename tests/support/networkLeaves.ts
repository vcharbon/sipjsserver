/**
 * networkLeaves — composable Layer builders shared by every fake-clock test
 * stack. The point is to let `fakeStack` (B2BUA only), `proxy-fakeStack`
 * (proxy + simulated-UAS workers), and `proxyB2bFakeStack` (proxy + real
 * B2BUA worker behind it) each compose the same building blocks against a
 * **single** `SignalingNetwork.simulated`, so packets sent by an agent at
 * `(ip,port)` actually reach the listener bound at that address.
 *
 * Two helpers, both requiring `SignalingNetwork` from upstream:
 *
 *   - `b2buaWorkerStackLayer({ config })` — full B2BUA services
 *     (`SipRouter`, `TransactionLayer`, `CallState`, `TimerService`,
 *     `SipParser`, plus `UdpTransport`, `OverloadController`,
 *     `CallLimiter`, `CallStateCache`, `MockCallControlLayer`, no-op
 *     tracing/CDR, `MetricsRegistry`, `AppConfig`, `DrainingState.test`).
 *   - `proxyStackLayer({ proxyAddr, workers, ... })` — full proxy
 *     services (`ProxyCore`, `LoadBalancerStrategyLive`,
 *     `WorkerRegistrySimulatedControl`, `HmacKeyProvider`,
 *     `LoadBalancerConfig`, `ProxyBindConfig`, `CancelBranchLru`).
 *
 * Each helper returns a Layer with `SignalingNetwork` *required* (not
 * provided) — callers compose it with whichever network builder they
 * want, including a single shared one when both stacks coexist.
 */

import { Effect, Layer } from "effect"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { CallLimiter } from "../../src/call/CallLimiter.js"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"
import { CdrWriter } from "../../src/cdr/CdrWriter.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { OverloadController } from "../../src/b2bua/OverloadController.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { TracingService } from "../../src/tracing/TracingService.js"
import { UdpTransport } from "../../src/sip/UdpTransport.js"
import { B2buaCoreLayer } from "../../src/b2bua/B2buaCore.js"
import { DrainingState } from "../../src/b2bua/DrainingState.js"
import { MockCallControlLayer } from "../fullcall/framework/MockCallControlLayer.js"
import {
  CancelBranchLru,
  type HmacKey,
  hmacKeyProviderStaticLayer,
  LoadBalancerConfig,
  type LoadBalancerConfigData,
  LoadBalancerStrategyLive,
  ProxyBindConfig,
  type ProxyBindConfigData,
  ProxyCore,
  type SocketAddr,
  type WorkerEntry,
  workerRegistrySimulatedLayer,
} from "../../src/sip-front-proxy/index.js"

/** No-op TracingService — keeps API shape but short-circuits every span. */
export const NoOpTracingLayer = Layer.succeed(TracingService, {
  decideSampling: () => false,
  withRootSpan: <A, E, R>(opts: {
    readonly name: string
    readonly sampled: boolean
    readonly attributes: Record<string, unknown>
    readonly effect: Effect.Effect<A, E, R>
  }): Effect.Effect<
    { readonly result: A; readonly traceId: string; readonly spanId: string },
    E,
    R
  > => Effect.map(opts.effect, (result) => ({ result, traceId: "", spanId: "" })),
  withProcessingSpan: <A, E, R>(opts: {
    readonly call: any
    readonly name: string
    readonly attributes: Record<string, unknown>
    readonly effect: Effect.Effect<A, E, R>
  }): Effect.Effect<A, E, R> => opts.effect,
  emitSendSpan: () => Effect.void,
  emitTombstone: () => Effect.void,
  withErrorSpan: <A, E, R>(
    _name: string,
    _attributes: Record<string, unknown>,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> => effect,
  emitSpanEvents: () => Effect.void,
  scrubMessage: (raw: string) => raw,
})

/** No-op CdrWriter — discards every CDR write. */
export const NoOpCdrLayer = Layer.succeed(CdrWriter, {
  write: (_call: any) => Effect.void,
})

/** Default test HMAC key — 32-byte 0xab pattern. Stable across tests. */
export const DEFAULT_HMAC_KEY: HmacKey = {
  id: "test-k1",
  bytes: new Uint8Array(32).fill(0xab),
}

/**
 * Build the full B2BUA worker stack (everything except the network).
 *
 * Output Layer requires `SignalingNetwork`; provides every service the
 * B2BUA needs (`SipRouter`, `CallState`, `TransactionLayer`,
 * `TimerService`, `SipParser`, `UdpTransport`, `OverloadController`,
 * `CallLimiter`, `CallStateCache`, `MockCallControl`, `TracingService`,
 * `CdrWriter`, `MetricsRegistry`, `AppConfig`, `DrainingState`).
 *
 * The `MockCallControlLayer` wires `AppConfig` for the B.7 translate
 * step; we re-merge `AppConfig` outward so tests that yield `AppConfig`
 * see the same config the router sees (sharing rule — see fakeStack.ts
 * comment block on the same topic).
 */
export function b2buaWorkerStackLayer(opts: {
  readonly config: AppConfigData
}) {
  const AppConfigLayer = Layer.succeed(AppConfig, opts.config)
  const MetricsLayer = MetricsRegistry.layer

  const Leaves = Layer.mergeAll(
    MetricsLayer,
    PartitionedRelayStorage.memoryLayer,
    MockCallControlLayer,
    NoOpTracingLayer,
    NoOpCdrLayer,
  ).pipe(Layer.provideMerge(AppConfigLayer))

  const MidServices = Layer.mergeAll(
    UdpTransport.layer,
    OverloadController.layer,
    CallLimiter.memoryLayer,
  ).pipe(Layer.provideMerge(Leaves))

  return B2buaCoreLayer.pipe(
    Layer.provideMerge(MidServices),
    Layer.provideMerge(DrainingState.test),
  )
}

export interface ProxyStackLayerOpts {
  readonly proxyAddr: SocketAddr
  readonly workers?: ReadonlyArray<WorkerEntry>
  readonly hmacKey?: HmacKey
  readonly hmacPreviousKey?: HmacKey
  readonly cancelLruTtlMs?: number
  readonly cancelLruSweepIntervalMs?: number
  readonly proxyQueueMax?: number
  readonly loadBalancer?: LoadBalancerConfigData
}

/**
 * Build the full proxy stack (everything except the network).
 *
 * Output Layer requires `SignalingNetwork`; provides `ProxyCore` plus
 * its dependencies (Strategy, Registry, Hmac, LbConfig, BindConfig,
 * CancelBranchLru) — re-exposed outward so tests can pull mutators
 * (e.g. `WorkerRegistrySimulatedControl`) from the runtime.
 */
export function proxyStackLayer(opts: ProxyStackLayerOpts) {
  const initialWorkers = opts.workers ?? []

  const bindCfg: ProxyBindConfigData = {
    bindHost: opts.proxyAddr.host,
    bindPort: opts.proxyAddr.port,
    advertisedHost: opts.proxyAddr.host,
    advertisedPort: opts.proxyAddr.port,
    queueMax: opts.proxyQueueMax ?? 1024,
  }
  const BindCfgLayer = ProxyBindConfig.layer(bindCfg)
  const RegistryLayer = workerRegistrySimulatedLayer({ initial: initialWorkers })
  const HmacLayer = hmacKeyProviderStaticLayer({
    current: opts.hmacKey ?? DEFAULT_HMAC_KEY,
    ...(opts.hmacPreviousKey !== undefined ? { previous: opts.hmacPreviousKey } : {}),
  }).pipe(Layer.orDie)
  const LbCfgLayer = LoadBalancerConfig.layer(opts.loadBalancer ?? {})
  const LruLayer = CancelBranchLru.layer({
    ...(opts.cancelLruTtlMs !== undefined ? { ttlMs: opts.cancelLruTtlMs } : {}),
    ...(opts.cancelLruSweepIntervalMs !== undefined
      ? { sweepIntervalMs: opts.cancelLruSweepIntervalMs }
      : {}),
  })

  const StrategyLayer = LoadBalancerStrategyLive.pipe(
    Layer.provide(Layer.mergeAll(RegistryLayer, HmacLayer, LbCfgLayer)),
  )

  const Leaves = Layer.mergeAll(
    BindCfgLayer,
    LruLayer,
    StrategyLayer,
    RegistryLayer,
    HmacLayer,
    LbCfgLayer,
  )
  return ProxyCore.Default.pipe(Layer.provideMerge(Leaves))
}
