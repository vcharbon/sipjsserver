/**
 * SIP Front Proxy — package surface.
 *
 * PR2 lands `ProxyCore`, `RoutingStrategy`, `CancelBranchLru`, and the
 * `ForwardAll` strategy. PR3a adds `WorkerRegistry` (interface + static
 * + simulated impls) and `HmacKeyProvider` (interface + static impl).
 * PR3b adds the rendezvous-hash `LoadBalancer` strategy, the canonical
 * `proxyFakeStack` test fixture, and re-keys `CancelBranchLru` on
 * `(Call-ID, CSeq number)` (RFC 3261 §9.1) so CANCEL correlation works
 * across worker re-balances. PR4 wires `HealthProbe`
 * (optionsKeepalive + manual), `WorkerRegistryControl`, the D5
 * draining model in `LoadBalancerStrategy.decodeStickiness`
 * (drain-grace fallback + ACK/CANCEL exemption), and the worker-side
 * `DrainingState` + OPTIONS handler. PR5 lands the production
 * `WorkerRegistry.kubernetesStatefulSet` impl backed by a K8s pod
 * watch (with deletion-timestamp accelerant + most-restrictive health
 * composition over probe-side flips), the `HmacKeyProvider.kubernetesSecret`
 * fs-watch impl for live key rotation, the K8s-mode wiring in
 * `bin/proxy.ts`, and Helm charts under `deploy/helm/`. See
 * `docs/todos/SIP-Front-Proxy.md` and
 * `docs/sip-front-proxy/resilience-model.md` (D-RES).
 *
 * Dependency policy (enforced by ESLint `no-restricted-imports`, scoped to
 * `src/sip-front-proxy/**` in `eslint.config.js`):
 *   - Allowed: `effect`, `src/sip/**` (parser/generators/SignalingNetwork).
 *   - Forbidden: `src/{b2bua,call,decision,redis,cdr,cluster,http,observability}/**`.
 */

export const PROXY_VERSION = "1.0.0-pr6"

export {
  ProxyCore,
  ProxyBindConfig,
  type ProxyBindConfigData,
  type ProxyCoreApi,
} from "./ProxyCore.js"
export {
  RoutingStrategy,
  type RoutingStrategyApi,
  type SocketAddr,
  type RouteParams,
  DecodeResult,
  NoTargetAvailable,
} from "./RoutingStrategy.js"
export {
  CancelBranchLru,
  type CancelBranchLruApi,
  callIdCseqKey,
  DEFAULT_TTL_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
} from "./CancelBranchLru.js"
export {
  ForwardAllStrategyLive,
  ForwardAllConfig,
  type ForwardAllConfigData,
} from "./strategies/ForwardAll.js"
export {
  LoadBalancerStrategyLive,
  LoadBalancerConfig,
  type LoadBalancerConfigData,
} from "./strategies/LoadBalancer.js"
export {
  rendezvousSelect,
  type RendezvousCandidate,
} from "./strategies/RendezvousHash.js"
export {
  WorkerRegistry,
  WorkerId,
  type WorkerRegistryApi,
  type WorkerEntry,
  type WorkerHealth,
  type RegistryEvent,
} from "./registry/WorkerRegistry.js"
export {
  fromEnv as workerRegistryFromEnv,
  fromString as workerRegistryFromString,
  StaticRegistryParseError,
  parseWorkerList,
} from "./registry/static.js"
export {
  simulatedLayer as workerRegistrySimulatedLayer,
  WorkerRegistrySimulatedControl,
  type WorkerRegistrySimulatedControlApi,
  type SimulatedLayerOpts as WorkerRegistrySimulatedLayerOpts,
} from "./registry/simulated.js"
export {
  HmacKeyProvider,
  type HmacKeyProviderApi,
  type HmacKey,
  type HmacSignResult,
  HmacKeyProviderConfigError,
  staticLayer as hmacKeyProviderStaticLayer,
  type StaticOpts as HmacKeyProviderStaticOpts,
  kubernetesSecretLayer as hmacKeyProviderKubernetesSecretLayer,
  type KubernetesSecretOpts as HmacKeyProviderKubernetesSecretOpts,
} from "./security/HmacKeyProvider.js"
export {
  kubernetesStatefulSetLayer as workerRegistryKubernetesStatefulSetLayer,
  kubernetesWatchClient as workerRegistryKubernetesWatchClient,
  mostRestrictiveHealth,
  type KubernetesStatefulSetOpts as WorkerRegistryKubernetesStatefulSetOpts,
  type WatchClient as WorkerRegistryKubernetesWatchClient,
} from "./registry/kubernetes.js"
export {
  HealthProbe,
  type HealthProbeApi,
  type OptionsKeepaliveOpts,
  manualLayer as healthProbeManualLayer,
  optionsKeepaliveLayer as healthProbeOptionsKeepaliveLayer,
} from "./health/HealthProbe.js"
export {
  WorkerRegistryControl,
  type WorkerRegistryControlApi,
  noopLayer as workerRegistryControlNoopLayer,
  simulatedAdapterLayer as workerRegistryControlSimulatedAdapterLayer,
} from "./health/WorkerRegistryControl.js"
export {
  ProxyMetrics,
  type ProxyMetricsApi,
  type MessageDirection,
  type MessageResult,
  type RoutingDecisionKind,
  type HmacFailureReason,
  type WorkerHealthLabel,
  type CancelLookupOutcome,
  snapshot as proxyMetricsSnapshot,
} from "./observability/Metrics.js"
export {
  ProxyTracing,
  type ProxyTracingApi,
  type RouteSpanAttributes,
} from "./observability/Tracing.js"
export {
  ProxyLogger,
  type ProxyLoggerApi,
  type RoutingDecisionLog,
  type RoutingErrorLog,
} from "./observability/Logger.js"
export {
  MetricsServer,
  type MetricsServerApi,
  type MetricsServerOpts,
  renderPrometheus,
} from "./observability/MetricsServer.js"
