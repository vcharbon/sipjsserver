/**
 * Consumer-API gate for `@vcharbon/sipjs/sip-front-proxy`.
 *
 * Exercises the load-bearing public symbols (ProxyCore, registry layers,
 * routing strategies, security primitives) for compilation. Does not
 * boot a UDP listener — that's covered by the live test-harness suites.
 */

import { describe, expect, it } from "vitest"
import { Layer } from "effect"

import {
  ProxyCore,
  ProxyBindConfig,
  Registrar,
  RegisterStrategy,
  CoreToExtRoutingStrategy,
  RegistrarProxyConfig,
  RoutingStrategy,
  CancelBranchLru,
  ForwardAllStrategyLive,
  ForwardAllConfig,
  LoadBalancerStrategyLive,
  LoadBalancerConfig,
  rendezvousSelect,
  WorkerRegistry,
  WorkerId,
  workerRegistryFromString,
  workerRegistrySimulatedLayer,
  HmacKeyProvider,
  hmacKeyProviderStaticLayer,
  HealthProbe,
  healthProbeManualLayer,
  ProxyMetrics,
  ProxyTracing,
  ProxyLogger,
  MetricsServer,
  PROXY_VERSION,
} from "@vcharbon/sipjs/sip-front-proxy"
import type {
  ProxyCoreApi,
  RegistrarApi,
  Binding,
  RegisterStrategyApi,
  CoreToExtRoutingStrategyApi,
  RegistrarProxyConfigData,
  SocketAddr,
  RouteParams,
  WorkerRegistryApi,
  WorkerEntry,
  WorkerHealth,
  HmacKeyProviderApi,
  HealthProbeApi,
  ProxyMetricsApi,
} from "@vcharbon/sipjs/sip-front-proxy"

describe("@vcharbon/sipjs/sip-front-proxy public surface", () => {
  it("re-exports ProxyCore + version", () => {
    expect(ProxyCore).toBeDefined()
    expect(typeof PROXY_VERSION).toBe("string")
    expect(PROXY_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("exposes routing strategies and registry layer factories", () => {
    expect(ForwardAllStrategyLive).toBeDefined()
    expect(LoadBalancerStrategyLive).toBeDefined()
    expect(typeof rendezvousSelect).toBe("function")
    expect(typeof workerRegistryFromString).toBe("function")
    expect(typeof workerRegistrySimulatedLayer).toBe("function")
  })

  it("exposes registrar + routing + LRU primitives", () => {
    expect(Registrar).toBeDefined()
    expect(RegisterStrategy).toBeDefined()
    expect(CoreToExtRoutingStrategy).toBeDefined()
    expect(RoutingStrategy).toBeDefined()
    expect(CancelBranchLru).toBeDefined()
    expect(RegistrarProxyConfig).toBeDefined()
    expect(ProxyBindConfig).toBeDefined()
  })

  it("exposes security + health + observability + metrics-server", () => {
    expect(HmacKeyProvider).toBeDefined()
    expect(typeof hmacKeyProviderStaticLayer).toBe("function")
    expect(HealthProbe).toBeDefined()
    expect(healthProbeManualLayer).toBeDefined()
    expect(ProxyMetrics).toBeDefined()
    expect(ProxyTracing).toBeDefined()
    expect(ProxyLogger).toBeDefined()
    expect(MetricsServer).toBeDefined()
  })

  it("forward-all + load-balancer config types are reachable", () => {
    // Confirm the config tags are defined (they're Effect Service tags)
    expect(ForwardAllConfig).toBeDefined()
    expect(LoadBalancerConfig).toBeDefined()
    expect(WorkerRegistry).toBeDefined()
    expect(WorkerId).toBeDefined()
  })

  it("static-registry layer accepts a CSV-style worker list", () => {
    const layer = workerRegistryFromString("w1=10.0.1.1:5060,w2=10.0.1.2:5060")
    expect(layer).toBeDefined()
    // Confirm the layer carries the expected pipe API
    expect(typeof (layer as { pipe?: unknown }).pipe).toBe("function")
  })

  // The type-only import set above guards against silently dropping any
  // of these names from the public types. If a Slice 5 refactor renames
  // ProxyCoreApi → ProxyApi, the next compile fails here.
  it("type-only re-exports remain reachable", () => {
    const _shapes: Array<unknown> = [
      undefined as ProxyCoreApi | undefined,
      undefined as RegistrarApi | undefined,
      undefined as Binding | undefined,
      undefined as RegisterStrategyApi | undefined,
      undefined as CoreToExtRoutingStrategyApi | undefined,
      undefined as RegistrarProxyConfigData | undefined,
      undefined as SocketAddr | undefined,
      undefined as RouteParams | undefined,
      undefined as WorkerRegistryApi | undefined,
      undefined as WorkerEntry | undefined,
      undefined as WorkerHealth | undefined,
      undefined as HmacKeyProviderApi | undefined,
      undefined as HealthProbeApi | undefined,
      undefined as ProxyMetricsApi | undefined,
      undefined as Layer.Layer<unknown> | undefined,
    ]
    expect(_shapes.length).toBe(15)
  })
})
