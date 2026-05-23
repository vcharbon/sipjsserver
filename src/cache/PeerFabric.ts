/**
 * PeerFabric — multi-peer in-memory simulation for the cross-pod
 * cache layer (D12 of the HA-resilience plan).
 *
 * Slice 5. Models N "fake peers" sharing one in-process fabric:
 *
 *   - Each peer holds its own `PartitionedRelayStorageApi` instance
 *     backed by a `MutableHashMap` (the fake sidecar Redis).
 *   - The fabric exposes `storageLayerOf(ordinal)` so a worker stack
 *     can be wired against a specific peer's storage — equivalent to
 *     today's per-worker `PartitionedRelayStorage.memoryLayer` but
 *     with a stable handle the fabric can reach.
 *   - The fabric exposes `cachePortLayerOf(self)` providing a
 *     `PeerCachePort` impl that routes RPC writes/reads from `self`
 *     to the destination peer's store. This is the test-side analogue
 *     of `PeerCacheClient` — the dual-write fan-out (Slice 5 phase D)
 *     is agnostic to which it's running against.
 *   - `PeerFabricControl` is a separate test-only Service. Implements
 *     "fake SIGTERM", partition / heal, latency / error-rate
 *     injection, and snapshot inspection that drives `step.fabric.*`
 *     in scenarios.
 *
 * Failure model:
 *
 *   - Killed / dead peers: writes addressed to them fail with
 *     `connection_refused`; scan fails with the same.
 *   - Partition between (self, peer): outbound calls FROM the worker
 *     identified as `self` (resolved via the dispatching layer) to
 *     `peer` fail. The set is symmetric.
 *   - Latency: a fixed `Effect.sleep(ms)` is inserted before the
 *     dispatch — under TestClock the scheduler advances deterministically.
 *   - Error rate: per-peer Bernoulli-trial drop of writes/scans,
 *     surfaced as `http_error` / `stream_aborted` to mirror
 *     `PeerCacheClient`'s mapping.
 */

import {
  Effect,
  Layer,
  MutableRef,
  ServiceMap,
  Stream,
} from "effect"
import {
  PartitionedRelayStorage,
  type MemoryApiHandle,
  type ScanEntry,
} from "./PartitionedRelayStorage.js"
import {
  PeerCachePort,
  PeerScanError,
  PeerWriteError,
  type WorkerOrdinal,
} from "./PeerCachePort.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PeerHealth = "alive" | "draining" | "dead" | "rebooting"

/**
 * Per-peer state visible through `snapshotPeer`. Surfaces both the
 * health and a flat dump of the underlying store keys/values so tests
 * can assert exact partition contents (`pri:A:call:foo` etc.).
 */
export interface PeerSnapshot {
  readonly ordinal: WorkerOrdinal
  readonly health: PeerHealth
  readonly latencyMs: number
  readonly errorRate: number
  /** Every key currently in the peer's store with its raw value. */
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }>
}

/**
 * Fabric-wide test control surface. Kept as a separate Service so
 * production code can never accidentally pull it in.
 */
export interface PeerFabricControlApi {
  /** Hard kill: peer goes "dead". Future writes/scans fail. Sidecar store retained for inspection. */
  readonly killWorker: (peer: WorkerOrdinal) => Effect.Effect<void>
  /** Graceful: marks "draining"; production path can run the drain handler before exit. */
  readonly sigtermWorker: (peer: WorkerOrdinal) => Effect.Effect<void>
  /** Boot a fresh sidecar store (clears everything) and mark alive. Used by Slice 6's reclaim flow. */
  readonly rebootWorker: (peer: WorkerOrdinal) => Effect.Effect<void>
  /**
   * Soft restart: mark alive without clearing the sidecar store. Models
   * §11.1 of `docs/replication/call-cache-backup.md` (process restart
   * with sidecar persisting), as opposed to `rebootWorker` which models
   * §11.2 (full pod replace, sidecar wiped).
   */
  readonly softRebootWorker: (peer: WorkerOrdinal) => Effect.Effect<void>
  /** Symmetric partition between two peers. */
  readonly partition: (a: WorkerOrdinal, b: WorkerOrdinal) => Effect.Effect<void>
  readonly heal: (a: WorkerOrdinal, b: WorkerOrdinal) => Effect.Effect<void>
  /** Inject latency on every cross-peer op landing on `peer`. */
  readonly setLatency: (peer: WorkerOrdinal, ms: number) => Effect.Effect<void>
  /** Bernoulli drop rate (0..1) on every cross-peer op landing on `peer`. */
  readonly setErrorRate: (peer: WorkerOrdinal, rate: number) => Effect.Effect<void>
  /** Synchronous snapshot of the peer's store. */
  readonly snapshotPeer: (peer: WorkerOrdinal) => Effect.Effect<PeerSnapshot>
  /**
   * Add a new peer to the fabric mid-test. Allocates a fresh
   * `MemoryApiHandle` and marks it `alive`. After this returns, the
   * peer is visible via `fabric.peers`, `storageOf`, `storageLayerOf`,
   * and `PeerEnumerator.fromFabric`. No-op if the peer already exists.
   *
   * Slice 5 of the replication redesign: enables NS11 (peer-disappear-
   * watermark) and the d6a2b7b regression scenario where a peer arrives
   * after the worker first checked the enumerator.
   */
  readonly addPeer: (peer: WorkerOrdinal) => Effect.Effect<void>
  /**
   * Remove a peer from the fabric. After this returns, `fabric.peers`
   * no longer lists it and `PeerEnumerator.fromFabric` reports a
   * shrunk set on the next read. The peer's prior storage is
   * discarded; if it is later re-added it starts fresh. No-op if the
   * peer is not present.
   */
  readonly removePeer: (peer: WorkerOrdinal) => Effect.Effect<void>
}

export class PeerFabricControl extends ServiceMap.Service<
  PeerFabricControl,
  PeerFabricControlApi
>()("@sipjsserver/cache/PeerFabricControl") {}

// ---------------------------------------------------------------------------
// Internal peer-state record
// ---------------------------------------------------------------------------

interface PeerState {
  readonly ordinal: WorkerOrdinal
  handle: MemoryApiHandle
  health: PeerHealth
  latencyMs: number
  errorRate: number
}

interface FabricInner {
  readonly peers: Map<WorkerOrdinal, PeerState>
  readonly partitions: MutableRef.MutableRef<ReadonlySet<string>>
  readonly rng: () => number
}

// ---------------------------------------------------------------------------
// PeerFabric service (the cluster-wide dispatcher)
// ---------------------------------------------------------------------------

/**
 * The fabric handle exposed by `PeerFabric.simulated`. Used by tests
 * to obtain per-peer storage layers and per-worker `PeerCachePort`
 * layers when wiring multi-worker SUTs.
 */
export interface PeerFabricApi {
  readonly peers: ReadonlyArray<WorkerOrdinal>
  readonly storageOf: (ordinal: WorkerOrdinal) => MemoryApiHandle
  readonly storageLayerOf: (
    ordinal: WorkerOrdinal
  ) => Layer.Layer<PartitionedRelayStorage>
  readonly cachePortLayerOf: (
    self: WorkerOrdinal
  ) => Layer.Layer<PeerCachePort>
}

export class PeerFabric extends ServiceMap.Service<PeerFabric, PeerFabricApi>()(
  "@sipjsserver/cache/PeerFabric"
) {
  /**
   * Build a simulated multi-peer fabric for tests. The returned
   * layer carries BOTH `PeerFabric` and `PeerFabricControl` over the
   * same shared `FabricInner`.
   */
  static readonly simulated = (
    workers: ReadonlyArray<WorkerOrdinal>,
    opts?: { readonly rng?: () => number }
  ): Layer.Layer<PeerFabric | PeerFabricControl> => {
    const built = PeerFabric.simulatedBuilt(workers, opts)
    return built.layer
  }

  /**
   * Variant of `simulated` that exposes the unboxed fabric handle in
   * addition to the Layer. Tests building multi-worker SUTs use the
   * handle to wire `storageLayerOf(ordinal)` into each worker's stack
   * BEFORE the layer is run — the layer carries the same handle so
   * `yield* PeerFabric` later returns the same object.
   *
   * The return shape is `{ layer, fabric, control }` where `fabric` is
   * the `PeerFabricApi` and `control` is the `PeerFabricControlApi`.
   */
  static readonly simulatedBuilt = (
    workers: ReadonlyArray<WorkerOrdinal>,
    opts?: { readonly rng?: () => number }
  ): {
    readonly layer: Layer.Layer<PeerFabric | PeerFabricControl>
    readonly fabric: PeerFabricApi
    readonly control: PeerFabricControlApi
  } => {
    const inner = makeFabricInner(workers, opts?.rng ?? Math.random)
    const fabricApi = makeFabricApi(inner)
    const controlApi = makeControlApi(inner)
    const layer = Layer.succeedServices(
      ServiceMap.make(PeerFabric, fabricApi).pipe(
        ServiceMap.add(PeerFabricControl, controlApi)
      )
    )
    return { layer, fabric: fabricApi, control: controlApi }
  }
}

// ---------------------------------------------------------------------------
// Inner construction
// ---------------------------------------------------------------------------

const makeFabricInner = (
  workers: ReadonlyArray<WorkerOrdinal>,
  rng: () => number
): FabricInner => {
  const peers = new Map<WorkerOrdinal, PeerState>()
  for (const w of workers) {
    peers.set(w, {
      ordinal: w,
      handle: PartitionedRelayStorage.makeMemoryApiFor(w),
      health: "alive",
      latencyMs: 0,
      errorRate: 0,
    })
  }
  const partitions = MutableRef.make<ReadonlySet<string>>(new Set<string>())
  return { peers, partitions, rng }
}

const peerOrThrow = (
  inner: FabricInner,
  ordinal: WorkerOrdinal,
  who: string
): PeerState => {
  const p = inner.peers.get(ordinal)
  if (p === undefined) {
    throw new Error(`${who}: unknown peer ordinal "${ordinal}"`)
  }
  return p
}

const partitionKey = (a: WorkerOrdinal, b: WorkerOrdinal): string =>
  a < b ? `${a}|${b}` : `${b}|${a}`

const makeFabricApi = (inner: FabricInner): PeerFabricApi => {
  const storageOf = (ordinal: WorkerOrdinal): MemoryApiHandle =>
    peerOrThrow(inner, ordinal, "PeerFabric.storageOf").handle

  const storageLayerOf = (
    ordinal: WorkerOrdinal
  ): Layer.Layer<PartitionedRelayStorage> =>
    Layer.sync(
      PartitionedRelayStorage,
      () => peerOrThrow(inner, ordinal, "PeerFabric.storageLayerOf").handle.api
    )

  const cachePortLayerOf = (
    self: WorkerOrdinal
  ): Layer.Layer<PeerCachePort> =>
    Layer.sync(PeerCachePort, () => makeCachePort(inner, self))

  // `peers` is a getter so `addPeer` / `removePeer` mutations are
  // immediately visible to callers (most importantly
  // `PeerEnumerator.fromFabric`, which iterates this on every read).
  return {
    get peers() {
      return Array.from(inner.peers.keys()).sort() as ReadonlyArray<WorkerOrdinal>
    },
    storageOf,
    storageLayerOf,
    cachePortLayerOf,
  }
}

// ---------------------------------------------------------------------------
// PeerCachePort impl backed by the fabric
// ---------------------------------------------------------------------------

const makeCachePort = (
  inner: FabricInner,
  self: WorkerOrdinal
): PeerCachePort["Service"] => {
  const isPartitioned = (peer: WorkerOrdinal): boolean =>
    MutableRef.get(inner.partitions).has(partitionKey(self, peer))

  const dispatch = <A>(
    peer: WorkerOrdinal,
    op: (state: PeerState) => Effect.Effect<A, PeerWriteError>
  ): Effect.Effect<A, PeerWriteError> =>
    Effect.gen(function* () {
      const state = inner.peers.get(peer)
      if (state === undefined) {
        return yield* new PeerWriteError({
          peer,
          reason: "dns_failed",
          detail: `no peer "${peer}" in fabric`,
        })
      }
      if (isPartitioned(peer)) {
        return yield* new PeerWriteError({
          peer,
          reason: "fabric_partitioned",
        })
      }
      if (state.health === "dead" || state.health === "rebooting") {
        return yield* new PeerWriteError({
          peer,
          reason: "connection_refused",
        })
      }
      // draining → still accepts writes (Slice 7 will tighten this)
      if (state.latencyMs > 0) {
        yield* Effect.sleep(`${state.latencyMs} millis`)
      }
      if (state.errorRate > 0 && inner.rng() < state.errorRate) {
        return yield* new PeerWriteError({
          peer,
          reason: "http_error",
          detail: "fabric injected error",
        })
      }
      return yield* op(state)
    })

  const dispatchScan = (
    peer: WorkerOrdinal,
    op: (state: PeerState) => Stream.Stream<ScanEntry, PeerScanError>
  ): Stream.Stream<ScanEntry, PeerScanError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const state = inner.peers.get(peer)
        if (state === undefined) {
          return Stream.fail(
            new PeerScanError({
              peer,
              reason: "dns_failed",
              detail: `no peer "${peer}" in fabric`,
            })
          )
        }
        if (isPartitioned(peer)) {
          return Stream.fail(
            new PeerScanError({ peer, reason: "fabric_partitioned" })
          )
        }
        if (state.health === "dead" || state.health === "rebooting") {
          return Stream.fail(
            new PeerScanError({ peer, reason: "connection_refused" })
          )
        }
        if (state.latencyMs > 0) {
          yield* Effect.sleep(`${state.latencyMs} millis`)
        }
        if (state.errorRate > 0 && inner.rng() < state.errorRate) {
          return Stream.fail(
            new PeerScanError({
              peer,
              reason: "stream_aborted",
              detail: "fabric injected error",
            })
          )
        }
        return op(state)
      })
    )

  const wrapStorageWriteErr = (
    peer: WorkerOrdinal,
    eff: Effect.Effect<void, { readonly reason: string }>
  ): Effect.Effect<void, PeerWriteError> =>
    eff.pipe(
      Effect.mapError(
        (e) =>
          new PeerWriteError({
            peer,
            reason: "http_error",
            detail: e.reason,
          })
      )
    )

  const wrapStorageScanErr = (
    peer: WorkerOrdinal,
    s: Stream.Stream<ScanEntry, { readonly reason: string }>
  ): Stream.Stream<ScanEntry, PeerScanError> =>
    s.pipe(
      Stream.mapError(
        (e) =>
          new PeerScanError({
            peer,
            reason: "stream_aborted",
            detail: e.reason,
          })
      )
    )

  const putCall: PeerCachePort["Service"]["putCall"] = ({
    peer,
    role,
    owner,
    callRef,
    state,
    indexes,
    ttlSec,
    callGen,
  }) =>
    dispatch(peer, (st) =>
      wrapStorageWriteErr(
        peer,
        st.handle.api.putCall(role, owner, callRef, state, indexes, ttlSec, callGen ?? 0)
      )
    )

  const refreshCall: PeerCachePort["Service"]["refreshCall"] = ({
    peer,
    role,
    owner,
    callRef,
    indexes,
    ttlSec,
  }) =>
    dispatch(peer, (st) =>
      wrapStorageWriteErr(
        peer,
        st.handle.api.refreshCall(role, owner, callRef, indexes, ttlSec)
      )
    )

  const deleteCall: PeerCachePort["Service"]["deleteCall"] = ({
    peer,
    role,
    owner,
    callRef,
    indexes,
  }) =>
    dispatch(peer, (st) =>
      wrapStorageWriteErr(
        peer,
        st.handle.api.deleteCall(role, owner, callRef, indexes)
      )
    )

  const scan: PeerCachePort["Service"]["scan"] = ({ peer, role, owner }) =>
    dispatchScan(peer, (st) =>
      wrapStorageScanErr(peer, st.handle.api.scanCalls(role, owner))
    )

  return { putCall, refreshCall, deleteCall, scan }
}

// ---------------------------------------------------------------------------
// PeerFabricControl impl
// ---------------------------------------------------------------------------

const makeControlApi = (inner: FabricInner): PeerFabricControlApi => {
  const killWorker = (peer: WorkerOrdinal): Effect.Effect<void> =>
    Effect.sync(() => {
      peerOrThrow(inner, peer, "PeerFabricControl.killWorker").health = "dead"
    })

  const sigtermWorker = (peer: WorkerOrdinal): Effect.Effect<void> =>
    Effect.sync(() => {
      peerOrThrow(inner, peer, "PeerFabricControl.sigtermWorker").health =
        "draining"
    })

  const rebootWorker = (peer: WorkerOrdinal): Effect.Effect<void> =>
    Effect.sync(() => {
      const st = peerOrThrow(inner, peer, "PeerFabricControl.rebootWorker")
      // Fresh store mimics ephemeral sidecar Redis (no persistence).
      st.handle = PartitionedRelayStorage.makeMemoryApiFor(peer)
      st.health = "alive"
      st.latencyMs = 0
      st.errorRate = 0
    })

  const softRebootWorker = (peer: WorkerOrdinal): Effect.Effect<void> =>
    Effect.sync(() => {
      const st = peerOrThrow(inner, peer, "PeerFabricControl.softRebootWorker")
      // Storage retained across the restart — the previously-killed
      // process is coming back in front of the same sidecar Redis.
      st.health = "alive"
      st.latencyMs = 0
      st.errorRate = 0
    })

  const partition = (
    a: WorkerOrdinal,
    b: WorkerOrdinal
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      const next = new Set(MutableRef.get(inner.partitions))
      next.add(partitionKey(a, b))
      MutableRef.set(inner.partitions, next)
    })

  const heal = (a: WorkerOrdinal, b: WorkerOrdinal): Effect.Effect<void> =>
    Effect.sync(() => {
      const next = new Set(MutableRef.get(inner.partitions))
      next.delete(partitionKey(a, b))
      MutableRef.set(inner.partitions, next)
    })

  const setLatency = (
    peer: WorkerOrdinal,
    ms: number
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      peerOrThrow(inner, peer, "PeerFabricControl.setLatency").latencyMs = ms
    })

  const setErrorRate = (
    peer: WorkerOrdinal,
    rate: number
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      peerOrThrow(inner, peer, "PeerFabricControl.setErrorRate").errorRate =
        rate
    })

  const snapshotPeer = (peer: WorkerOrdinal): Effect.Effect<PeerSnapshot> =>
    Effect.sync(() => {
      const st = peerOrThrow(inner, peer, "PeerFabricControl.snapshotPeer")
      const entries: Array<{ readonly key: string; readonly value: string }> =
        []
      for (const [k, v] of st.handle.store) {
        // Body slots now hold Buffer (msgpack bytes); render as
        // hex-prefixed string for diagnostic-only snapshot output so
        // test assertions remain string-comparable.
        const valueStr = Buffer.isBuffer(v.value)
          ? `<msgpack:0x${v.value.toString("hex")}>`
          : v.value
        entries.push({ key: k, value: valueStr })
      }
      return {
        ordinal: st.ordinal,
        health: st.health,
        latencyMs: st.latencyMs,
        errorRate: st.errorRate,
        // Sort for deterministic test assertions; the underlying map
        // ordering is implementation-defined.
        entries: entries.sort((a, b) => (a.key < b.key ? -1 : 1)),
      }
    })

  const addPeer = (peer: WorkerOrdinal): Effect.Effect<void> =>
    Effect.sync(() => {
      if (inner.peers.has(peer)) return
      inner.peers.set(peer, {
        ordinal: peer,
        handle: PartitionedRelayStorage.makeMemoryApiFor(peer),
        health: "alive",
        latencyMs: 0,
        errorRate: 0,
      })
    })

  const removePeer = (peer: WorkerOrdinal): Effect.Effect<void> =>
    Effect.sync(() => {
      inner.peers.delete(peer)
      // Drop any partitions that name this peer — otherwise a re-added
      // peer would inherit a stale partition flag.
      const next = new Set(MutableRef.get(inner.partitions))
      for (const key of [...next]) {
        const [a, b] = key.split("|") as [WorkerOrdinal, WorkerOrdinal]
        if (a === peer || b === peer) next.delete(key)
      }
      MutableRef.set(inner.partitions, next)
    })

  return {
    killWorker,
    sigtermWorker,
    rebootWorker,
    softRebootWorker,
    partition,
    heal,
    setLatency,
    setErrorRate,
    snapshotPeer,
    addPeer,
    removePeer,
  }
}
