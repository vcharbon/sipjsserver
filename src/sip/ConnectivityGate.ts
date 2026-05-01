/**
 * ConnectivityGate — fiber-local Reference consulted by `SignalingNetwork`'s
 * simulated UDP fabric (and the test-only `FakeHttpFabric`) before delivering
 * a packet/request. Drives the failover-harness "kill / partition / reconnect"
 * primitives by deciding whether a given (src, dst) pair is currently
 * deliverable.
 *
 * Slice 1.3 of the failover-harness plan
 * (docs/plan/management-of-k8s-reliability-compiled-dijkstra.md).
 *
 * Design choices:
 *   - `ServiceMap.Reference` (not a Tag) so the default value — "always
 *     allow" — is in scope for every consumer without explicit wiring.
 *     Production never overrides it; tests that need network-isolation
 *     primitives provide a richer implementation backed by
 *     `WorkerConnectivity` (tests/support/WorkerConnectivity.ts).
 *   - Predicate signature is synchronous (`canDeliver`) so the simulated
 *     fabric can call it inside non-Effect deliver paths without forcing
 *     refactors. The richer test-only API exposes mutations (`disconnect`,
 *     `partition`, etc.) on a separate Tag.
 *   - The send/receive split mirrors the plan: the fabric is responsible
 *     for invoking the gate at the right moments (before forking a transit,
 *     and again at deliver time). The gate itself is stateless w.r.t. that
 *     split — it just reports `canDeliver(src, dst)` and the fabric decides
 *     when to consult.
 */

import { ServiceMap } from "effect"

export interface ConnectivityAddress {
  readonly ip: string
  readonly port: number
}

export interface ConnectivityGateApi {
  /**
   * Is a packet from `src` to `dst` currently deliverable on the simulated
   * fabric? Returning `false` causes the fabric to drop the packet (with a
   * logged event) instead of routing it. Default implementation returns
   * `true` for every pair.
   *
   * Either endpoint may be unbound to any worker — in that case the gate is
   * expected to allow delivery (treat unbound endpoints as external sources/
   * sinks, not subject to connectivity rules).
   */
  readonly canDeliver: (
    src: ConnectivityAddress,
    dst: ConnectivityAddress,
  ) => boolean
}

const allowAll: ConnectivityGateApi = {
  canDeliver: () => true,
}

/**
 * Fiber-local connectivity-gate Reference. Default value: always-allow.
 *
 * Consumers (SignalingNetwork.simulated, FakeHttpFabric) read it via the
 * fiber's `getRef` accessor at delivery time, so any test that overrides
 * the Reference (typically via `WorkerConnectivityLayer`) sees its
 * mutations propagate immediately.
 */
export const ConnectivityGate: ServiceMap.Reference<ConnectivityGateApi> =
  ServiceMap.Reference<ConnectivityGateApi>(
    "@sipjsserver/sip/ConnectivityGate",
    { defaultValue: () => allowAll },
  )
