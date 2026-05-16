/**
 * SIP Front Proxy entry point.
 *
 * Modes (selected via `PROXY_REGISTRY_MODE`):
 *
 *   - `static` (default): wires `ForwardAllStrategy` against a single
 *     `PROXY_FORWARD_TARGET=host:port`. Useful for dev / smoke tests.
 *   - `kubernetes`: wires `LoadBalancerStrategy` against
 *     `WorkerRegistry.kubernetesStatefulSet` + `HmacKeyProvider.kubernetesSecret`
 *     + `HealthProbe.optionsKeepalive`. This is the production path.
 *
 * Configuration (env-driven, no `AppConfig` dep — see
 * `docs/todos/SIP-Front-Proxy.md` D9):
 *
 *   General:
 *     - PROXY_REGISTRY_MODE          static (default) | kubernetes
 *     - PROXY_BIND_HOST              default "0.0.0.0"
 *     - PROXY_BIND_PORT              default 5070
 *     - PROXY_ADVERTISED_HOST        default = bind host
 *     - PROXY_ADVERTISED_PORT        default = bind port
 *
 *   Static mode:
 *     - PROXY_FORWARD_TARGET         required: "host:port" — the single
 *                                    backend every dialog gets forwarded
 *                                    to. Without it the proxy refuses to
 *                                    start.
 *
 *   Kubernetes mode:
 *     - PROXY_K8S_NAMESPACE          required: namespace to watch.
 *     - PROXY_K8S_STATEFULSET_NAME   required: drives the default label
 *                                    selector `app.kubernetes.io/name=…`.
 *     - PROXY_K8S_POD_PORT           required: SIP UDP port the worker
 *                                    listens on inside each pod.
 *     - PROXY_K8S_LABEL_SELECTOR     optional override of the label
 *                                    selector.
 *     - PROXY_HMAC_KEY_PATH          required: file path of the HMAC
 *                                    Secret-mounted current key.
 *     - PROXY_HMAC_PREVIOUS_KEY_PATH optional second mounted file for
 *                                    operator-controlled rotation
 *                                    (NFR-8 overlap window).
 *     - PROXY_HEALTH_PROBE_BIND_HOST required: bind address for the
 *                                    OPTIONS keepalive probe.
 *     - PROXY_HEALTH_PROBE_BIND_PORT required: bind UDP port for the
 *                                    OPTIONS keepalive probe.
 *     - PROXY_HEALTH_PROBE_INTERVAL_MS  optional, default 2000.
 *     - PROXY_HEALTH_PROBE_TIMEOUT_MS   optional, default 1500.
 *     - PROXY_HEALTH_PROBE_THRESHOLD    optional, default 3.
 *
 * Manual smoke (static mode, two terminals):
 *   PROXY_FORWARD_TARGET=127.0.0.1:5061 npm run proxy:dev
 *   sipp -sn uas -p 5061 127.0.0.1
 *   sipp -sn uac -s alice 127.0.0.1:5070
 */

import { NodeRuntime } from "@effect/platform-node"
import { KubeConfig, Watch } from "@kubernetes/client-node"
import { Clock, Effect, Layer } from "effect"
import { LoadSampler } from "../src/observability/LoadSampler.js"
import { SignalingNetwork } from "../src/sip/SignalingNetwork.js"
import {
  CancelBranchLru,
  CoreToExtRoutingStrategy,
  ForwardAllConfig,
  ForwardAllStrategyLive,
  HealthProbe,
  healthProbeOptionsKeepaliveLayer,
  LoadBalancerConfig,
  LoadBalancerStrategyLive,
  ProxyBindConfig,
  ProxyCore,
  ProxySelfGate,
  PROXY_VERSION,
  Registrar,
  RegisterStrategy,
  type SocketAddr,
  workerRegistryControlNoopLayer,
  WorkerLoadObserver,
} from "../src/sip-front-proxy/index.js"
import {
  kubernetesStatefulSetLayer,
  kubernetesWatchClient,
} from "../src/sip-front-proxy/registry/kubernetes.js"
import { fromString as staticRegistryFromString } from "../src/sip-front-proxy/registry/static.js"
import { kubernetesSecretLayer } from "../src/sip-front-proxy/security/HmacKeyProvider.js"
import { MetricsServer } from "../src/sip-front-proxy/observability/MetricsServer.js"

const DEFAULT_BIND_HOST = "0.0.0.0"
const DEFAULT_BIND_PORT = 5070

const parsePort = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.length === 0) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : fallback
}

const requirePort = (raw: string | undefined, name: string): number => {
  if (raw === undefined || raw.length === 0) {
    throw new Error(`${name} is required (must be a port in 1..65535)`)
  }
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`${name} malformed: ${raw} (must be 1..65535)`)
  }
  return n
}

const requireString = (raw: string | undefined, name: string): string => {
  if (raw === undefined || raw.length === 0) {
    throw new Error(`${name} is required`)
  }
  return raw
}

const parseTarget = (raw: string | undefined): SocketAddr => {
  if (raw === undefined || raw.length === 0) {
    throw new Error("PROXY_FORWARD_TARGET is required (format: host:port)")
  }
  const colon = raw.lastIndexOf(":")
  if (colon === -1) {
    throw new Error(`PROXY_FORWARD_TARGET malformed: ${raw} (expected host:port)`)
  }
  const host = raw.slice(0, colon)
  const port = Number.parseInt(raw.slice(colon + 1), 10)
  if (host.length === 0 || !Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`PROXY_FORWARD_TARGET malformed: ${raw}`)
  }
  return { host, port }
}

const bindHost = process.env["PROXY_BIND_HOST"] ?? DEFAULT_BIND_HOST
const bindPort = parsePort(process.env["PROXY_BIND_PORT"], DEFAULT_BIND_PORT)
// PROXY_METRICS_PORT — TCP port for the /metrics endpoint (sip_*
// Prometheus exposition from MetricsServer). Default 9090.
const metricsPort = parsePort(process.env["PROXY_METRICS_PORT"], 9090)
const metricsServerLayer = MetricsServer.layer({ port: metricsPort })
const advertisedHost = process.env["PROXY_ADVERTISED_HOST"] ?? bindHost
const advertisedPort = parsePort(process.env["PROXY_ADVERTISED_PORT"], bindPort)
const ingressConcurrency = Number.parseInt(process.env["PROXY_INGRESS_CONCURRENCY"] ?? "16", 10)
const mode = (process.env["PROXY_REGISTRY_MODE"] ?? "static").toLowerCase()

// Register-strategy default for both static and kubernetes modes is `noop`
// (REGISTER → 501). The hybrid register-fakeExt-realCore harness flips
// `PROXY_REGISTER_MODE=in-memory` via Helm extraEnv so REGISTER is
// terminated by an in-process AOR store. INVITE routing (LoadBalancer in
// k8s mode, ForwardAll in static mode) is untouched.
const registerMode = (process.env["PROXY_REGISTER_MODE"] ?? "noop").toLowerCase()
const registrarLayers =
  registerMode === "in-memory"
    ? Layer.mergeAll(
        RegisterStrategy.inMemoryRegistrarLayer,
        CoreToExtRoutingStrategy.noopLayer,
      ).pipe(Layer.provide(Registrar.inMemoryLayer))
    : Layer.mergeAll(
        RegisterStrategy.noopLayer,
        CoreToExtRoutingStrategy.noopLayer,
      )

const baseBindLayer = Layer.mergeAll(
  SignalingNetwork.real,
  ProxyBindConfig.layer({
    bindHost,
    bindPort,
    advertisedHost,
    advertisedPort,
    reusePort: true,
    ingressConcurrency: Number.isFinite(ingressConcurrency) && ingressConcurrency > 0
      ? ingressConcurrency
      : 16,
  }),
  CancelBranchLru.Default,
  registrarLayers,
)

const buildStaticLayer = () => {
  const target = parseTarget(process.env["PROXY_FORWARD_TARGET"])
  const program = Effect.gen(function* () {
    const proxy = yield* ProxyCore
    // Force-instantiate MetricsServer so its bound HTTP server is live
    // before we sleep on Effect.never.
    yield* MetricsServer
    yield* Effect.logInfo(
      `sip-front-proxy ${PROXY_VERSION} mode=static bound=${proxy.localAddress.ip}:${proxy.localAddress.port} ` +
        `advertised=${proxy.advertisedAddress.ip}:${proxy.advertisedAddress.port} ` +
        `metrics=:${metricsPort} ` +
        `→ ${target.host}:${target.port}`
    )
    return yield* Effect.never
  })
  const layer = Layer.mergeAll(
    ProxyCore.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          baseBindLayer,
          ForwardAllStrategyLive.pipe(
            Layer.provide(ForwardAllConfig.layer(target))
          ),
          // ForwardAll doesn't use the registry for routing decisions, but
          // ProxyCore needs `WorkerRegistry.lookupByAddress` to classify
          // worker-sourced traffic as outbound. An empty static registry
          // makes every lookup return `Option.none` — equivalent to the
          // pre-loop-fix behaviour, since ForwardAll mode never has a
          // worker fronted by us.
          staticRegistryFromString(""),
          // Provide a no-op WorkerRegistryControl so any future code that
          // reaches for it in this mode doesn't crash.
          workerRegistryControlNoopLayer,
          // Slice 6 — proxy-self gate. Static (ForwardAll) mode rarely
          // sees overload, but ProxyCore requires the service.
          ProxySelfGate.layer().pipe(Layer.provide(LoadSampler.liveLayer)),
        )
      )
    ),
    metricsServerLayer,
  )
  return { program, layer }
}

const buildKubernetesLayer = () => {
  const namespace = requireString(process.env["PROXY_K8S_NAMESPACE"], "PROXY_K8S_NAMESPACE")
  const statefulSetName = requireString(
    process.env["PROXY_K8S_STATEFULSET_NAME"],
    "PROXY_K8S_STATEFULSET_NAME"
  )
  const podPort = requirePort(process.env["PROXY_K8S_POD_PORT"], "PROXY_K8S_POD_PORT")
  const labelSelector = process.env["PROXY_K8S_LABEL_SELECTOR"]
  const hmacKeyPath = requireString(
    process.env["PROXY_HMAC_KEY_PATH"],
    "PROXY_HMAC_KEY_PATH"
  )
  const hmacPreviousKeyPath = process.env["PROXY_HMAC_PREVIOUS_KEY_PATH"]
  const probeBindHost = requireString(
    process.env["PROXY_HEALTH_PROBE_BIND_HOST"],
    "PROXY_HEALTH_PROBE_BIND_HOST"
  )
  const probeBindPort = requirePort(
    process.env["PROXY_HEALTH_PROBE_BIND_PORT"],
    "PROXY_HEALTH_PROBE_BIND_PORT"
  )
  const probeIntervalMs = process.env["PROXY_HEALTH_PROBE_INTERVAL_MS"]
  const probeTimeoutMs = process.env["PROXY_HEALTH_PROBE_TIMEOUT_MS"]
  const probeThreshold = process.env["PROXY_HEALTH_PROBE_THRESHOLD"]

  // Build the K8s client at module scope (synchronous) — the SDK's
  // `loadFromCluster` reads the ServiceAccount-mounted token. Failing
  // here is the right behavior: a misconfigured RBAC binding shouldn't
  // be silently masked.
  const kubeConfig = new KubeConfig()
  kubeConfig.loadFromCluster()
  const watch = new Watch(kubeConfig)
  const watchClient = kubernetesWatchClient(watch)

  const program = Effect.gen(function* () {
    const proxy = yield* ProxyCore
    const probe = yield* HealthProbe
    yield* probe.start
    yield* MetricsServer
    yield* Effect.logInfo(
      `sip-front-proxy ${PROXY_VERSION} mode=kubernetes ns=${namespace} ` +
        `sts=${statefulSetName} bound=${proxy.localAddress.ip}:${proxy.localAddress.port} ` +
        `advertised=${proxy.advertisedAddress.ip}:${proxy.advertisedAddress.port} ` +
        `metrics=:${metricsPort}`
    )
    return yield* Effect.never
  })

  const registryLayer = kubernetesStatefulSetLayer(
    labelSelector !== undefined
      ? { namespace, statefulSetName, podPort, labelSelector }
      : { namespace, statefulSetName, podPort },
    watchClient
  )

  const hmacLayer = kubernetesSecretLayer(
    hmacPreviousKeyPath !== undefined
      ? { keyPath: hmacKeyPath, previousKeyPath: hmacPreviousKeyPath }
      : { keyPath: hmacKeyPath }
  )

  const probeLayer = healthProbeOptionsKeepaliveLayer({
    bindHost: probeBindHost,
    bindPort: probeBindPort,
    ...(probeIntervalMs !== undefined && {
      intervalMs: parsePort(probeIntervalMs, 1000),
    }),
    ...(probeTimeoutMs !== undefined && {
      timeoutMs: parsePort(probeTimeoutMs, 1500),
    }),
    ...(probeThreshold !== undefined && {
      threshold: Number.parseInt(probeThreshold, 10) || 2,
    }),
  })

  // Layer composition:
  //   - registryLayer  provides WorkerRegistry + WorkerRegistryControl
  //   - hmacLayer      provides HmacKeyProvider
  //   - probeLayer     needs SignalingNetwork, WorkerRegistry, WorkerRegistryControl
  //   - LB strategy    needs WorkerRegistry, HmacKeyProvider
  //   - ProxyCore      needs RoutingStrategy, SignalingNetwork, ProxyBindConfig, CancelBranchLru
  //
  // We build a single shared "infra" layer below ProxyCore + HealthProbe so
  // the registry and HMAC providers are instantiated exactly once and
  // shared across consumers.
  // Slice 4 — WorkerLoadObserver is shared between HealthProbe (which
  // feeds it from OPTIONS replies) and LoadBalancerStrategy (which
  // reads its bucket state — wired in slice 5).
  const loadObserverLayer = WorkerLoadObserver.layer()
  // Slice 6 — ProxySelfGate gates external new-dialog non-emergency
  // INVITEs on proxy ELU + CPS bucket. Needs LoadSampler.liveLayer.
  const selfGateLayer = ProxySelfGate.layer().pipe(
    Layer.provide(LoadSampler.liveLayer),
  )
  const infraLayer = Layer.mergeAll(
    baseBindLayer,
    registryLayer,
    hmacLayer,
    loadObserverLayer,
    selfGateLayer,
  )
  const lbStrategyLayer = LoadBalancerStrategyLive.pipe(
    Layer.provide(LoadBalancerConfig.layer({}))
  )
  // Auto-start a 1s sweep fiber for stale-payload handling. Runs for
  // the layer's scope lifetime.
  const loadObserverSweepLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const observer = yield* WorkerLoadObserver
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep("1 second")
            const now = yield* Clock.currentTimeMillis
            observer.sweepStale(now)
          }),
        ),
      )
    }),
  ).pipe(Layer.provide(loadObserverLayer))
  const layer = Layer.mergeAll(
    ProxyCore.Default.pipe(Layer.provide(lbStrategyLayer)),
    probeLayer,
    metricsServerLayer,
    loadObserverSweepLayer,
  ).pipe(Layer.provide(infraLayer))
  return { program, layer }
}

if (mode === "kubernetes") {
  const { program, layer } = buildKubernetesLayer()
  NodeRuntime.runMain(Effect.scoped(program).pipe(Effect.provide(layer)))
} else {
  const { program, layer } = buildStaticLayer()
  NodeRuntime.runMain(Effect.scoped(program).pipe(Effect.provide(layer)))
}
