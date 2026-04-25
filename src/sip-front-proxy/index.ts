/**
 * SIP Front Proxy — package surface.
 *
 * PR2 lands `ProxyCore`, `RoutingStrategy`, `CancelBranchLru`, and the
 * `ForwardAll` strategy. PR3a adds `WorkerRegistry` (interface + static
 * + simulated impls) and `HmacKeyProvider` (interface + static impl).
 * PR3b adds the rendezvous-hash `LoadBalancer` strategy, the canonical
 * `proxyFakeStack` test fixture, and re-keys `CancelBranchLru` on
 * `(Call-ID, CSeq number)` (RFC 3261 §9.1) so CANCEL correlation works
 * across worker re-balances. Draining + observability arrive in PR4+.
 * See `docs/todos/SIP-Front-Proxy.md`.
 *
 * Dependency policy (enforced by ESLint `no-restricted-imports`, scoped to
 * `src/sip-front-proxy/**` in `eslint.config.js`):
 *   - Allowed: `effect`, `src/sip/**` (parser/generators/SignalingNetwork).
 *   - Forbidden: `src/{b2bua,call,decision,redis,cdr,cluster,http,observability}/**`.
 */

export const PROXY_VERSION = "0.4.0-pr3b"

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
} from "./security/HmacKeyProvider.js"
