/**
 * PartitionedRelayStorage — local-side storage for the cross-pod relay.
 *
 * Slice 3 of the HA-resilience plan. Calls live under
 * `{role}:{owner}:call:{callRef}`; indexes are flat (D7 / D10 / D15 / D16):
 *
 *   {role}:{owner}:call:{callRef}     → opaque JSON state, with TTL
 *   idx:{indexKey}                    → callRef, with TTL  (flat, NOT partitioned)
 *
 * `role ∈ {"pri","bak"}` and `owner` is the worker ordinal that the
 * stickiness cookie names as the natural primary for the call. A
 * single sidecar can hold many partitions side by side without
 * collision (e.g. a pod that is primary for some calls and backup
 * for several other primaries).
 *
 * Indexes are FLAT (not partitioned) — the index value is the
 * callRef, and Slice 4's `deriveCallRef` encodes the primary ordinal
 * in the callRef itself (Option C). So a worker holding a callRef
 * can derive `(role, primary)` deterministically and build the
 * partition path on the fly. Single index hop, single call read, no
 * proxy headers needed on the receive path.
 *
 * This service is intentionally separate from `CallStateCache` — that
 * service still owns the legacy `call:{callRef}` flat keyspace used by
 * the B2BUA's local writes. Slice 4 will migrate those writes onto
 * this partitioned storage; until then both keyspaces coexist on the
 * same Redis without conflict (`call:foo` vs `pri:A:call:foo` are
 * disjoint prefixes).
 *
 * Two implementations:
 *   - `redisLayer` (production) — backed by RedisClient
 *   - `memoryLayer` (tests) — MutableHashMap + Effect Clock for
 *     deterministic TTL under TestClock
 */

import {
  Data,
  Effect,
  Layer,
  MutableHashMap,
  ServiceMap,
  Stream,
} from "effect"
import type { PropagateDirection } from "./PartitionRef.js"
// Lazy import — only consumed inside Layer.suspend / function bodies
// so the module cycle (PartitionedRelayStorageKvBacked imports types
// and the class statics from this file) is resolved before either
// initializer fires.
import {
  kvBackedMemoryLayer,
  kvBackedRedisLayer,
  makeKvBackedMemoryApi,
} from "./PartitionedRelayStorageKvBacked.js"
import type { AppConfig } from "../config/AppConfig.js"
import type { RedisClient } from "../redis/RedisClient.js"
import type { KvBackendApi } from "../storage/KvBackend.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PartitionRole = "pri" | "bak"

/** One scanned entry returned to the relay's GET /scan handler. */
export interface ScanEntry {
  readonly callRef: string
  /** Raw body bytes (msgpack-encoded post-migration); decode via `CallCodec.decodeBodyAuto`. */
  readonly body: Buffer
  readonly ttlSec: number
}

/**
 * Slice 2 — per-write replication options. Pass `peer` only for calls
 * the LB has assigned a backup to; absent peer = no replication side
 * effect on this write.
 *
 * `direction` is the slice-2.4 propagate-direction tag (defaults to
 * `"forward"` — the role==="pri" case where this worker is primary
 * writing to a backup peer). Pass `"reverse"` from the role==="bak"
 * write path so the receiver routes the apply to `pri:{self}:` rather
 * than `bak:{caller}:`.
 */
export interface PartitionedRelayWriteOptions {
  readonly peer?: string | undefined
  readonly propagateSetTtlSec?: number | undefined
  readonly direction?: PropagateDirection | undefined
}

/**
 * Fault used internally by `redisLayer` when a SCAN/GET pair would
 * surface a key that disappeared mid-scan. We return the survivors
 * and skip the missing one — ttl reads can return 0/-2 in Redis.
 */
export class StorageError extends Data.TaggedError("PartitionedRelayStorageError")<{
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface PartitionedRelayStorageApi {
  /**
   * Read the call's body bytes from the (role, owner) partition.
   * Returns `null` if missing or expired (sweep-on-touch in
   * memoryLayer; Redis natively expires keys). The body is opaque
   * to PRS — callers decode via `CallCodec.decodeBodyAuto`.
   */
  readonly getCall: (
    role: PartitionRole,
    owner: string,
    callRef: string
  ) => Effect.Effect<Buffer | null, StorageError>

  /**
   * Read a flat index entry. Returns the stored callRef value, or
   * `null` if missing/expired. Index keys are unpartitioned per
   * Slice 4 design (callRef itself encodes the primary, so the
   * partition is derivable downstream).
   */
  readonly getIndex: (
    indexKey: string
  ) => Effect.Effect<string | null, StorageError>

  /**
   * Full create/overwrite. Writes the call's body bytes + every index
   * entry atomically (Slice 1 — Lua / mutex). When `opts.peer` is
   * provided, also bumps `propagate_seq:{peer}` and ZADDs the callRef
   * into `propagate:{peer}` with sliding TTL (Slice 2). Pass
   * `peer=undefined` (or empty string) for calls without an
   * LB-assigned backup — those skip the propagate side effect entirely.
   *
   * `body` is opaque bytes — typically `stampEncodedBody(encodeCall(...),
   * writtenAtMs)` (a 9-byte writtenAtMs prefix + msgpack Call). PRS
   * does NOT inspect or modify it; the wire-level `latency_ms` is
   * derived by stripping the prefix on the puller side.
   */
  readonly putCall: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    body: Buffer,
    indexes: ReadonlyArray<string>,
    ttlSec: number,
    /**
     * Per-call content version forwarded into the body's :gen sidecar.
     * Defaults to 0 when callers don't have a value (tests, recovery
     * paths). Production hot path (CallState.flushToRedis) passes
     * `bumped._topology.gen ?? 0`.
     */
    callGen?: number,
    opts?: PartitionedRelayWriteOptions
  ) => Effect.Effect<void, StorageError>

  /**
   * Keepalive — refresh TTL on the call key + every named index. No
   * value rewrite. No-op for missing keys (matches Redis EXPIRE
   * semantics + the memory layer's `expire*` ops). When `opts.peer` is
   * provided the refresh is also a propagate event (so the backup
   * keeps its TTL parity).
   */
  readonly refreshCall: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>,
    ttlSec: number,
    opts?: PartitionedRelayWriteOptions
  ) => Effect.Effect<void, StorageError>

  /**
   * Termination — delete the call key + every named index. When
   * `opts.peer` is provided, also bumps the propagate set so the
   * backup observes the deletion.
   */
  readonly deleteCall: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>,
    opts?: PartitionedRelayWriteOptions
  ) => Effect.Effect<void, StorageError>

  /**
   * Stream every call entry currently stored in the (role, owner)
   * partition. Implementation walks `SCAN MATCH {role}:{owner}:call:*`
   * with `Effect.yieldNow` between batches so concurrent local writes
   * are not starved (the sole reason for using a stream + batched
   * yields rather than `redis.scanKeys` which does not yield —
   * RedisClient.ts:152-168).
   */
  readonly scanCalls: (
    role: PartitionRole,
    owner: string,
    opts?: { readonly batch?: number }
  ) => Stream.Stream<ScanEntry, StorageError>
}

export class PartitionedRelayStorage extends ServiceMap.Service<
  PartitionedRelayStorage,
  PartitionedRelayStorageApi
>()("@sipjsserver/cache/PartitionedRelayStorage") {
  /** Default SCAN batch size (Redis COUNT hint). */
  static readonly DEFAULT_SCAN_BATCH = 50

  /** Build a partitioned storage key for a call. */
  static readonly callKey = (
    role: PartitionRole,
    owner: string,
    callRef: string
  ): string => `${role}:${owner}:call:${callRef}`

  /**
   * Build a FLAT storage key for an index entry. Indexes are not
   * partitioned — the value carries the callRef which itself encodes
   * the primary ordinal (Option C, Slice 4). A worker reading this
   * index gets the callRef, derives the primary, and builds the
   * partition path on the fly.
   */
  static readonly indexKey = (indexKey: string): string => `idx:${indexKey}`

  /** Match pattern for partition-wide scan of call keys. */
  static readonly scanPattern = (
    role: PartitionRole,
    owner: string
  ): string => `${role}:${owner}:call:*`

  // --------------------------------------------------------------------------
  // Layers
  // --------------------------------------------------------------------------

  /**
   * Production: backed by `kvBackedRedisLayer` (KvBackend + ChannelIndex
   * over RedisClient). Caller passes the worker's identity (`self`)
   * and incarnation `gen` — typically resolved from `AppConfig` and
   * `EpochCounter.fromKubernetesDownwardAPI`.
   *
   * The `redisLayer` constant is no longer a no-arg `Layer.Layer<…>`;
   * it's a function returning the layer. Boot wiring (`main.ts`)
   * supplies the config explicitly.
   */
  static readonly redisLayer = (config: {
    readonly self: string
    readonly gen: number
  }): Layer.Layer<PartitionedRelayStorage, never, RedisClient | AppConfig> =>
    kvBackedRedisLayer(config)

  /**
   * Tests: in-memory MutableHashMap. As of Slice 7c, the default
   * memory layer is backed by the new `kvBackedMemoryLayer`
   * (KvBackend + ChannelIndex), parity-verified against the legacy
   * AtomicWriter path in `tests/cache/prs-rewire.test.ts`.
   *
   * Defaults: `self="self"`, `gen=1`. Tests that need a different
   * worker identity should construct a layer via
   * `kvBackedMemoryLayer({ self, gen })` directly, or use
   * `makeMemoryApiFor(self)`.
   *
   * The legacy AtomicWriter-backed layer is preserved as
   * `legacyMemoryLayer` for the duration of the cutover so any
   * regression that surfaces post-swap can be diagnosed by binary
   * bisection.
   */
  // `Layer.suspend` defers `kvBackedMemoryLayer(...)` past this class's
  // static-initializer phase, dodging the module-cycle TDZ where
  // `PartitionedRelayStorage` is still being defined when the cyclic
  // module's `Layer.sync(PartitionedRelayStorage, ...)` would capture
  // the tag.
  static readonly memoryLayer: Layer.Layer<PartitionedRelayStorage> =
    Layer.suspend(() => kvBackedMemoryLayer({ self: "self", gen: 1 }))

  /**
   * Build a fresh in-memory `PartitionedRelayStorageApi` instance plus a
   * handle to the underlying store. Used by `PeerFabric.simulated` to
   * materialise N independent peer "sidecars".
   *
   * Defaults to `self="self"`, `gen=1`. Multi-worker callers
   * (PeerFabric) should use `makeMemoryApiFor(self)` so each peer's
   * storage is correctly identified for the per-`(self, peer)`
   * ChannelIndex bindings.
   */
  static readonly makeMemoryApi = (): MemoryApiHandle =>
    kvBackedMemoryApiHandle("self", 1)

  /**
   * Variant of `makeMemoryApi` that accepts the worker's ordinal so
   * the per-peer ChannelIndex bindings carry the correct `self`
   * identity. Used by `PeerFabric.simulated` to construct one
   * storage per worker.
   */
  static readonly makeMemoryApiFor = (
    self: string,
    gen: number = 1
  ): MemoryApiHandle => kvBackedMemoryApiHandle(self, gen)
}

// ---------------------------------------------------------------------------
// KV-backed `MemoryApiHandle` adapter
// ---------------------------------------------------------------------------

/**
 * Adapt `makeKvBackedMemoryApi`'s return shape (whose store carries
 * `MemoryStoreEntry` from `KvBackend`) to this module's
 * `MemoryApiHandle` shape (`MemoryEntry`). The two entry types are
 * structurally identical (`{ value: string | Buffer; expiresAtMs: number }`),
 * so the cast at the boundary is safe; the alternative would be a
 * runtime copy of every entry on every call, which is wasteful for
 * a test-only path.
 */
const kvBackedMemoryApiHandle = (self: string, gen: number): MemoryApiHandle => {
  const built = makeKvBackedMemoryApi({ self, gen })
  return {
    api: built.api,
    store: built.store as unknown as MutableHashMap.MutableHashMap<string, MemoryEntry>,
    kv: built.kv,
  }
}

// ---------------------------------------------------------------------------
// Memory-API factory (shared between memoryLayer and PeerFabric.simulated)
// ---------------------------------------------------------------------------

interface MemoryEntry {
  /** `string` for counters / index entries; `Buffer` for msgpack-encoded bodies. */
  readonly value: string | Buffer
  readonly expiresAtMs: number
}

/**
 * Materialised in-memory storage handle. The `api` is the public
 * service surface; `store` is exposed for snapshot inspection by
 * `PeerFabric.simulated`'s test control API. Slice 7c also exposes
 * the underlying `KvBackend` so test harnesses can construct
 * cross-peer `ChannelIndex` bindings needed by the new
 * `runPullerFiber` path (a peer's outgoing-to-self channel lives
 * inside this KvBackend instance, separate from the `store`).
 */
export interface MemoryApiHandle {
  readonly api: PartitionedRelayStorageApi
  readonly store: MutableHashMap.MutableHashMap<string, MemoryEntry>
  readonly kv: KvBackendApi
}


