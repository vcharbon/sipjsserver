/**
 * WorkerConnectivity — test-side service that drives the
 * `ConnectivityGate` Reference consulted by `SignalingNetwork.simulated`
 * and `FakeHttpFabric`. Slice 1.3 of the failover-harness plan
 * (docs/plan/management-of-k8s-reliability-compiled-dijkstra.md).
 *
 * Model:
 *   - Each known worker has an entry `{ address, outbound, inbound }`.
 *     `bind(workerId, address)` creates the entry with both flags `true`.
 *     The entry is removed when the registering scope closes (so a
 *     respawned worker can re-bind cleanly under the same workerId).
 *   - `disconnect(workerId)` flips both flags to `false`.
 *     `reconnect(workerId)` restores them to `true`. Partitions are
 *     orthogonal — `reconnect` does *not* clear them.
 *   - `partition({from, to, direction})` adds a directional rule. A
 *     packet from `from` to `to` (and/or vice versa) is dropped while the
 *     rule is active. `heal(a, b)` removes both directions of the rule
 *     between two workers.
 *   - The gate's `canDeliver(srcAddr, dstAddr)` resolves both addresses
 *     to workerIds (returning `true` immediately if either is unbound),
 *     then consults the flags + partitions. Symmetric layout: if the
 *     sender's `outbound` is false OR the recipient's `inbound` is false
 *     OR a partition rule matches src→dst, the packet is gated.
 *
 * Slice ownership: the `SimulatedK8sCluster` facade (slice 3.1) is the
 * eventual driver — it calls `bind` on `addWorker`, `disconnect` /
 * `partition` from the kill / partition primitives, and `reconnect` /
 * `heal` from respawn. Defining the service here lets both the UDP
 * fabric (`SignalingNetwork.simulated`) and the HTTP fabric
 * (`FakeHttpFabric`) consume the same predicate without leaking the
 * mutation API into production code.
 */

import {
  Effect,
  Layer,
  MutableHashMap,
  Scope,
  ServiceMap,
} from "effect"
import {
  ConnectivityGate,
  type ConnectivityAddress,
  type ConnectivityGateApi,
} from "../../sip/ConnectivityGate.js"

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type PartitionDirection = "from-to" | "to-from" | "both"

export interface WorkerConnectivityApi {
  /**
   * Register a worker at `address`. Returns an Effect that requires a
   * `Scope`; closing the scope removes the entry from the map (no
   * lingering "ghost worker" gating after the simulated worker's scope
   * closes). Re-binding the same `workerId` overrides the previous
   * address.
   */
  readonly bind: (
    workerId: string,
    address: ConnectivityAddress,
  ) => Effect.Effect<void, never, Scope.Scope>

  /**
   * Set both `outbound` and `inbound` flags to `false` for `workerId`.
   * No-op if the worker isn't bound. Mirrors slice 3.1 phase-1 of the
   * kill pipeline (network disconnect before registry-remove + scope
   * close).
   */
  readonly disconnect: (workerId: string) => Effect.Effect<void>

  /**
   * Restore both flags to `true`. Does **not** clear partitions —
   * use `heal` for that.
   */
  readonly reconnect: (workerId: string) => Effect.Effect<void>

  /**
   * Add a directional partition rule. `direction`:
   *   - `"from-to"`: drop packets from `from` to `to`.
   *   - `"to-from"`: drop packets from `to` to `from`.
   *   - `"both"`:    drop in both directions.
   * Multiple calls accumulate; healing is via `heal`.
   */
  readonly partition: (opts: {
    readonly from: string
    readonly to: string
    readonly direction: PartitionDirection
  }) => Effect.Effect<void>

  /** Remove every partition rule between `workerA` and `workerB`. */
  readonly heal: (workerA: string, workerB: string) => Effect.Effect<void>

  /** Reverse-lookup: address → workerId, or `undefined` if unbound. */
  readonly resolveAddress: (
    address: ConnectivityAddress,
  ) => Effect.Effect<string | undefined>

  /**
   * The same predicate the fabrics consume via the `ConnectivityGate`
   * Reference. Exposed on the API so test bodies can assert directly
   * without mocking the network.
   */
  readonly gate: ConnectivityGateApi
}

export class WorkerConnectivity extends ServiceMap.Service<
  WorkerConnectivity,
  WorkerConnectivityApi
>()("@sipjsserver/test-support/WorkerConnectivity") {}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface WorkerState {
  address: ConnectivityAddress
  outbound: boolean
  inbound: boolean
}

const addrKey = (a: ConnectivityAddress): string =>
  `${a.ip.toLowerCase()}:${a.port}`

const partitionKey = (from: string, to: string): string => `${from}->${to}`

const buildApi = (): WorkerConnectivityApi => {
  const workers = MutableHashMap.empty<string, WorkerState>()
  const addressIndex = MutableHashMap.empty<string, string>()
  // Set of "from->to" strings; both sides of a "both" partition write
  // two entries.
  const partitions = new Set<string>()

  const removeAddressIndex = (workerId: string): void => {
    // Linear scan is fine — failover tests have a handful of workers,
    // not thousands.
    for (const [k, v] of addressIndex) {
      if (v === workerId) MutableHashMap.remove(addressIndex, k)
    }
  }

  const bind: WorkerConnectivityApi["bind"] = (workerId, address) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        // Re-bind: clear any stale address index entries for this id
        // before installing the new one.
        removeAddressIndex(workerId)
        MutableHashMap.set(workers, workerId, {
          address,
          outbound: true,
          inbound: true,
        })
        MutableHashMap.set(addressIndex, addrKey(address), workerId)
      }),
      () =>
        Effect.sync(() => {
          MutableHashMap.remove(workers, workerId)
          removeAddressIndex(workerId)
        }),
    )

  const setFlags = (workerId: string, outbound: boolean, inbound: boolean) =>
    Effect.sync(() => {
      const current = MutableHashMap.get(workers, workerId)
      if (current._tag !== "Some") return
      MutableHashMap.set(workers, workerId, {
        ...current.value,
        outbound,
        inbound,
      })
    })

  const disconnect: WorkerConnectivityApi["disconnect"] = (workerId) =>
    setFlags(workerId, false, false)

  const reconnect: WorkerConnectivityApi["reconnect"] = (workerId) =>
    setFlags(workerId, true, true)

  const partition: WorkerConnectivityApi["partition"] = ({
    from,
    to,
    direction,
  }) =>
    Effect.sync(() => {
      if (direction === "from-to" || direction === "both") {
        partitions.add(partitionKey(from, to))
      }
      if (direction === "to-from" || direction === "both") {
        partitions.add(partitionKey(to, from))
      }
    })

  const heal: WorkerConnectivityApi["heal"] = (a, b) =>
    Effect.sync(() => {
      partitions.delete(partitionKey(a, b))
      partitions.delete(partitionKey(b, a))
    })

  const resolveAddress: WorkerConnectivityApi["resolveAddress"] = (address) =>
    Effect.sync(() => {
      const opt = MutableHashMap.get(addressIndex, addrKey(address))
      return opt._tag === "Some" ? opt.value : undefined
    })

  const lookup = (address: ConnectivityAddress): string | undefined => {
    const opt = MutableHashMap.get(addressIndex, addrKey(address))
    return opt._tag === "Some" ? opt.value : undefined
  }

  const gate: ConnectivityGateApi = {
    canDeliver: (src, dst) => {
      const srcId = lookup(src)
      const dstId = lookup(dst)

      // Sender-side check. An unbound src is treated as external
      // (proxy / agent / test client without a worker identity) and
      // allowed through this leg.
      if (srcId !== undefined) {
        const srcState = MutableHashMap.get(workers, srcId)
        if (srcState._tag === "Some" && !srcState.value.outbound) return false
      }

      // Receiver-side check. An unbound dst is similarly external —
      // tests targeting fake addresses outside the connectivity model
      // shouldn't be gated.
      if (dstId !== undefined) {
        const dstState = MutableHashMap.get(workers, dstId)
        if (dstState._tag === "Some" && !dstState.value.inbound) return false
      }

      // Partition rules require both sides bound — they're between
      // *named* workers.
      if (
        srcId !== undefined &&
        dstId !== undefined &&
        partitions.has(partitionKey(srcId, dstId))
      ) {
        return false
      }
      return true
    },
  }

  return {
    bind,
    disconnect,
    reconnect,
    partition,
    heal,
    resolveAddress,
    gate,
  }
}

/**
 * Provides `WorkerConnectivity` and overrides the `ConnectivityGate`
 * Reference value so the same closure-shared state powers both. Compose
 * this layer into any fake-stack that wants to drive disconnect /
 * partition primitives — typically inside the future
 * `SimulatedK8sCluster` (slice 3.1) or directly in a test that needs
 * one-off connectivity manipulation.
 */
export const WorkerConnectivityLayer: Layer.Layer<WorkerConnectivity> =
  Layer.unwrap(
    Effect.sync(() => {
      const api = buildApi()
      return Layer.mergeAll(
        Layer.succeed(WorkerConnectivity, api),
        Layer.succeed(ConnectivityGate, api.gate),
      )
    }),
  )
