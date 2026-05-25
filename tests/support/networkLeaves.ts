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
 *     `CallLimiter`, `MockCallControlLayer`, no-op
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
import { simulatedLayer as loadSamplerSimulatedLayer } from "../../src/observability/LoadSampler.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { OverloadController } from "../../src/b2bua/OverloadController.js"
import { TracingService } from "../../src/tracing/TracingService.js"
import { UdpTransport } from "../../src/sip/UdpTransport.js"
import { B2buaCoreLayer } from "../../src/b2bua/B2buaCore.js"
import { BufferedTerminateWriter } from "../../src/cache/BufferedTerminateWriter.js"
import { DrainingState } from "../../src/b2bua/DrainingState.js"
import { WorkerReadiness } from "../../src/cache/WorkerReadiness.js"
import { MockCallControlLayer } from "../fullcall/framework/MockCallControlLayer.js"
import {
  CancelBranchLru,
  CoreToExtRoutingStrategy,
  type HmacKey,
  hmacKeyProviderStaticLayer,
  LoadBalancerConfig,
  type LoadBalancerConfigData,
  LoadBalancerStrategyLive,
  ProxyBindConfig,
  type ProxyBindConfigData,
  ProxyCore,
  ProxySelfGate,
  RegisterStrategy,
  type SocketAddr,
  type WorkerEntry,
  WorkerLoadObserver,
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

/**
 * No-op CdrWriter — discards every CDR write. Kept exported for tests that
 * explicitly do not care about CDR observability; the fake-stack default is
 * `CdrWriter.testLayer` (in-memory recording) so the harness can assert that
 * every terminated call produced a CDR record.
 */
export const NoOpCdrLayer = Layer.succeed(CdrWriter, {
  write: (_call: any) => Effect.void,
  readAll: Effect.succeed([] as const),
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
 * `CallLimiter`, `MockCallControl`, `TracingService`,
 * `CdrWriter`, `MetricsRegistry`, `AppConfig`, `DrainingState`).
 *
 * The `MockCallControlLayer` wires `AppConfig` for the B.7 translate
 * step; we re-merge `AppConfig` outward so tests that yield `AppConfig`
 * see the same config the router sees (sharing rule — see fakeStack.ts
 * comment block on the same topic).
 */
export function b2buaWorkerStackLayer(opts: {
  readonly config: AppConfigData
  /**
   * Optional storage override. Defaults to a per-instance
   * `PartitionedRelayStorage.memoryLayer` (single-worker tests). Slice 5's
   * multi-peer SUTs pass `PeerFabric.simulated(...).storageLayerOf(self)`
   * so each worker shares state with the fabric's peer dispatcher.
   */
  readonly storageLayer?: Layer.Layer<PartitionedRelayStorage>
  /**
   * Optional CDR layer override. Defaults to `CdrWriter.testLayer` — a
   * per-instance in-memory recorder. Multi-worker SUTs pass
   * `CdrWriter.sharedTestLayer(buffer)` so every worker writes into a
   * single buffer the harness can read via `yield* CdrWriter`. Tests that
   * specifically want NoOp behaviour can pass `NoOpCdrLayer`.
   */
  readonly cdrLayer?: Layer.Layer<CdrWriter>
  /**
   * Optional CallLimiter layer override. Defaults to a per-instance
   * `CallLimiter.memoryLayer` (single-worker tests). Multi-worker SUTs
   * pass `CallLimiter.sharedMemoryLayer(map)` so every worker increments
   * the same `MutableHashMap` — mirrors the cluster-shared
   * `LimiterRedisClient` topology used in production. Without that, each
   * worker has its own independent counter and cluster-wide rejection
   * cannot be exercised in fake-clock tests.
   */
  readonly limiterLayer?: Layer.Layer<CallLimiter>
}) {
  const AppConfigLayer = Layer.succeed(AppConfig, opts.config)
  const MetricsLayer = MetricsRegistry.layer
  const StorageLayer = opts.storageLayer ?? PartitionedRelayStorage.memoryLayer
  const CdrLayer = opts.cdrLayer ?? CdrWriter.testLayer
  const LimiterLayer = opts.limiterLayer ?? CallLimiter.memoryLayer.pipe(Layer.provide(AppConfigLayer))

  const Leaves = Layer.mergeAll(
    MetricsLayer,
    StorageLayer,
    MockCallControlLayer,
    NoOpTracingLayer,
    CdrLayer,
    // Slice 2 of the overload rework — OverloadController now reads ELU
    // and GC fraction from LoadSampler to publish on X-Overload. Fake
    // stack provides the simulated layer so tests can inject values via
    // `LoadSamplerSimulatedControl`.
    loadSamplerSimulatedLayer(),
  ).pipe(Layer.provideMerge(AppConfigLayer))

  // Phase 4: BufferedTerminateWriter — fake-clock tests get the
  // passthrough variant via `storageBufferQueueMax: 0` in the test
  // config defaults.
  const BufferedTerminateLayer = BufferedTerminateWriter.layer.pipe(
    Layer.provide(Leaves),
  )

  const MidServices = Layer.mergeAll(
    UdpTransport.layer,
    OverloadController.layer,
    LimiterLayer,
    BufferedTerminateLayer,
  ).pipe(Layer.provideMerge(Leaves))

  // Tests don't run `ReadyGate`, so default to `ready=true` — otherwise
  // SipRouter's OPTIONS keepalive would 503 and any rule path that
  // consults readiness would block. Production wires
  // `WorkerReadiness.Default` (initial=false) and lets ReadyGate flip
  // it; the test variant skips that handshake.
  return B2buaCoreLayer.pipe(
    Layer.provideMerge(MidServices),
    Layer.provideMerge(DrainingState.test),
    Layer.provideMerge(WorkerReadiness.test(true)),
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
  /**
   * Slice 3 of the k8s-reliability rework: pass through to the
   * simulated registry's `autoStampFirstSeenAtMs` opt-in. When true,
   * any worker added (initial set or dynamic `add`) gets a
   * `firstSeenAtMs` stamped from the current Clock unless one was
   * supplied. Off by default so existing fixtures stay byte-identical.
   */
  readonly autoStampFirstSeenAtMs?: boolean
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
  const RegistryLayer = workerRegistrySimulatedLayer({
    initial: initialWorkers,
    autoStampFirstSeenAtMs: opts.autoStampFirstSeenAtMs === true,
  })
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

  // Slice 5: LoadBalancer now requires WorkerLoadObserver for the AIMD
  // bucket consume + CRITICAL filter. Fake stack defaults to a
  // permissive observer config so baseline distribution / e2e tests
  // don't get rate-limited by the aggressive operational defaults.
  // Tests that exercise the rejection paths pull `WorkerLoadObserver`
  // directly and call `applyPayload` to push workers into specific
  // bands.
  const FAKE_OBSERVER_CFG = {
    eluSoft: 0.6,
    eluHard: 0.8,
    eluCritical: 0.95,
    bandHysteresis: 0.02,
    aimdIncreaseStepCps: 5,
    aimdDecreaseFactor: 0.75,
    aimdCooldownTicks: 3,
    capInitialCps: 100000,
    capFloorCps: 1,
    capCeilingCps: 1000000,
    payloadStaleMs: 60000,
    optionsIntervalMs: 1000,
  } as const
  const StrategyLayer = LoadBalancerStrategyLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        RegistryLayer,
        HmacLayer,
        LbCfgLayer,
        WorkerLoadObserver.layer(FAKE_OBSERVER_CFG),
      ),
    ),
  )

  // Slice 6: ProxyCore now requires ProxySelfGate. Fake stack uses a
  // permissive bucket so baseline tests don't hit the proxy-self gate;
  // tests that exercise the gate directly drive their own LoadSampler.
  const SelfGateLayer = ProxySelfGate.layer({
    eluCritical: 0.95,
    cpsBucketSize: 1000000,
    cpsBucketRate: 1000000,
    eluSmoothingAlpha: 0.2,
    samplerIntervalMs: 100,
  }).pipe(Layer.provide(loadSamplerSimulatedLayer()))

  const Leaves = Layer.mergeAll(
    BindCfgLayer,
    LruLayer,
    StrategyLayer,
    RegistryLayer,
    HmacLayer,
    LbCfgLayer,
    SelfGateLayer,
    // Slice 2 of REGISTER + double-stack: ProxyCore now requires the
    // registrar-mode strategies. Proxy fixtures that don't exercise the
    // registrar path wire the noop variants — REGISTER returns 501, the
    // unused core-to-ext lookup is never called.
    RegisterStrategy.noopLayer,
    CoreToExtRoutingStrategy.noopLayer,
  )
  return ProxyCore.Default.pipe(Layer.provideMerge(Leaves))
}
