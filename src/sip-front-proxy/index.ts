/**
 * SIP Front Proxy — package surface.
 *
 * PR2 lands `ProxyCore`, `RoutingStrategy`, `CancelBranchLru`, and the
 * `ForwardAll` strategy. PR3a adds `WorkerRegistry` (interface + static
 * + simulated impls) and `HmacKeyProvider` (interface + static impl).
 * `LoadBalancer` strategy / draining / observability arrive in PR3b+.
 * See `docs/todos/SIP-Front-Proxy.md`.
 *
 * Dependency policy (enforced by ESLint `no-restricted-imports`, scoped to
 * `src/sip-front-proxy/**` in `eslint.config.js`):
 *   - Allowed: `effect`, `src/sip/**` (parser/generators/SignalingNetwork).
 *   - Forbidden: `src/{b2bua,call,decision,redis,cdr,cluster,http,observability}/**`.
 */

export const PROXY_VERSION = "0.3.0-pr3a"

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
  DEFAULT_TTL_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
} from "./CancelBranchLru.js"
export {
  ForwardAllStrategyLive,
  ForwardAllConfig,
  type ForwardAllConfigData,
} from "./strategies/ForwardAll.js"
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
} from "./security/HmacKeyProvider.js"
