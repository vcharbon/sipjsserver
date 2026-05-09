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
  Clock,
  Data,
  Effect,
  Layer,
  MutableHashMap,
  Option,
  ServiceMap,
  Stream,
} from "effect"
import { RedisClient, RedisError } from "../redis/RedisClient.js"
import {
  AtomicWriter,
  type AtomicWriterError,
  type PropagateDirection,
} from "../replication/AtomicWriter.js"
// Lazy import — only consumed inside Layer.sync bodies so the
// module cycle (PartitionedRelayStorageKvBacked imports types and
// the class statics from this file) is resolved before either
// initializer fires.
import {
  kvBackedMemoryLayer,
  makeKvBackedMemoryApi,
} from "./PartitionedRelayStorageKvBacked.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PartitionRole = "pri" | "bak"

/** One scanned entry returned to the relay's GET /scan handler. */
export interface ScanEntry {
  readonly callRef: string
  readonly json: string
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
   * Read the call's JSON state from the (role, owner) partition.
   * Returns `null` if missing or expired (sweep-on-touch in
   * memoryLayer; Redis natively expires keys).
   */
  readonly getCall: (
    role: PartitionRole,
    owner: string,
    callRef: string
  ) => Effect.Effect<string | null, StorageError>

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
   * Full create/overwrite. Writes the call's state JSON + every index
   * entry atomically (Slice 1 — Lua / mutex). When `opts.peer` is
   * provided, also bumps `propagate_seq:{peer}` and ZADDs the callRef
   * into `propagate:{peer}` with sliding TTL (Slice 2). Pass
   * `peer=undefined` (or empty string) for calls without an
   * LB-assigned backup — those skip the propagate side effect entirely.
   */
  readonly putCall: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    json: string,
    indexes: ReadonlyArray<string>,
    ttlSec: number,
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
   * Production: backed by RedisClient. Issues `SETEX` / `EXPIRE` /
   * `DEL` directly. SCAN is cursor-walked one batch at a time, with a
   * `Stream.async` pull boundary that yields the runtime in between
   * iterations.
   */
  static readonly redisLayer = Layer.effect(
    PartitionedRelayStorage,
    Effect.gen(function* () {
      const redis = yield* RedisClient
      const writer = yield* AtomicWriter

      const wrapErr = (err: RedisError): StorageError =>
        new StorageError({ reason: err.reason })

      const wrapWriterErr = (err: AtomicWriterError): StorageError =>
        new StorageError({ reason: err.reason })

      const getCall = (
        role: PartitionRole,
        owner: string,
        callRef: string
      ): Effect.Effect<string | null, StorageError> =>
        redis
          .get(PartitionedRelayStorage.callKey(role, owner, callRef))
          .pipe(Effect.mapError(wrapErr))

      const getIndex = (
        indexKey: string
      ): Effect.Effect<string | null, StorageError> =>
        redis
          .get(PartitionedRelayStorage.indexKey(indexKey))
          .pipe(Effect.mapError(wrapErr))

      const putCall = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        json: string,
        indexes: ReadonlyArray<string>,
        ttlSec: number,
        opts?: PartitionedRelayWriteOptions
      ): Effect.Effect<void, StorageError> =>
        writer
          .put(role, owner, callRef, json, indexes, ttlSec, opts)
          .pipe(Effect.mapError(wrapWriterErr), Effect.asVoid)

      const refreshCall = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        indexes: ReadonlyArray<string>,
        ttlSec: number,
        opts?: PartitionedRelayWriteOptions
      ): Effect.Effect<void, StorageError> =>
        writer
          .refresh(role, owner, callRef, indexes, ttlSec, opts)
          .pipe(Effect.mapError(wrapWriterErr), Effect.asVoid)

      const deleteCall = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        indexes: ReadonlyArray<string>,
        opts?: PartitionedRelayWriteOptions
      ): Effect.Effect<void, StorageError> =>
        writer
          .delete(role, owner, callRef, indexes, opts)
          .pipe(Effect.mapError(wrapWriterErr), Effect.asVoid)

      const scanCalls = (
        role: PartitionRole,
        owner: string,
        opts?: { readonly batch?: number }
      ): Stream.Stream<ScanEntry, StorageError> => {
        const batch = opts?.batch ?? PartitionedRelayStorage.DEFAULT_SCAN_BATCH
        const pattern = PartitionedRelayStorage.scanPattern(role, owner)
        const callPrefix = `${role}:${owner}:call:`
        const callPrefixLen = callPrefix.length

        // Cursor-walk one batch per pull, yielding to the runtime
        // between iterations so concurrent local writes are not
        // starved while the scan is in progress.
        return Stream.paginate("0", (cursor) =>
          Effect.gen(function* () {
            // Use ioredis directly via redis.raw — RedisClient.scanKeys
            // accumulates ALL keys before returning, defeating the
            // pacing requirement. We need cursor-by-cursor control.
            const [nextCursor, keys] = yield* Effect.tryPromise({
              try: () =>
                redis.raw.scan(
                  cursor,
                  "MATCH",
                  // ioredis applies the `keyPrefix` option transparently;
                  // we pass the bare pattern. For the default RedisClient
                  // setup the prefix is glued globally per-connection via
                  // `pk()` — but raw.scan on this client does NOT apply
                  // pk(). We mirror the internal `pk` logic here.
                  scanPatternWithGlobalPrefix(redis, pattern),
                  "COUNT",
                  batch
                ),
              catch: (err) =>
                new StorageError({
                  reason: err instanceof Error ? err.message : String(err),
                }),
            })
            // Strip the global prefix so the user-facing keys come
            // back in our local namespace.
            const localKeys = keys.map(stripGlobalPrefix(redis))
            // GET each value + TTL in a single pipeline batch.
            const entries = yield* fetchEntries(redis, localKeys, callPrefixLen)
            // Yield the runtime so concurrent local Redis ops can
            // interleave (the whole point of D10's pacing).
            yield* Effect.yieldNow
            const next: Option.Option<string> =
              nextCursor === "0" ? Option.none() : Option.some(nextCursor)
            return [entries as ReadonlyArray<ScanEntry>, next] as const
          })
        )
      }

      return {
        getCall,
        getIndex,
        putCall,
        refreshCall,
        deleteCall,
        scanCalls,
      }
    })
  )
  // AtomicWriter requires a WriteNotifier (it publishes on every
  // successful peer-bearing write so ReplLog's long-poll handlers can
  // push entries to subscribers within milliseconds). We intentionally
  // do NOT embed `WriteNotifier.layer` here: ReplLog must subscribe to
  // the same hub instance the writer publishes to, and the only
  // reliable way to achieve that is to hoist `WriteNotifier.layer` to
  // the outermost composition so a single memoized instance is shared.
  //
  // Phase 0b additionally hoists `AtomicWriter.redisLayer` itself: the
  // production `ReplPuller.redisLayer` (consumer of /replog from peers)
  // also needs AtomicWriter to apply backup writes. Keeping a single
  // shared AtomicWriter is functionally fine (each is a thin wrapper
  // over the same RedisClient + WriteNotifier), but composing it once
  // at the top avoids two redundant service instances.
  // Therefore `redisLayer`'s external requirement is now:
  // `RedisClient | AtomicWriter | WriteNotifier`.

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
   * Pre-Slice-7c memoryLayer. Kept on the public surface temporarily
   * so a regression triage can swap layers at the test boundary
   * without code changes. Will be removed in the final cleanup once
   * the swap is fully validated.
   */
  static readonly legacyMemoryLayer = Layer.sync(
    PartitionedRelayStorage,
    () => makeMemoryApi().api
  )

  /**
   * Build a fresh in-memory `PartitionedRelayStorageApi` instance plus a
   * handle to the underlying store. Slice 5's `PeerFabric.simulated`
   * uses this to materialise N independent peer "sidecars" while still
   * sharing the exact memoryLayer semantics — every peer's storage is
   * the same object the rest of the codebase already exercises.
   *
   * As of Slice 7c, the default factory is the KV-backed implementation
   * with `self="self"`. Multi-worker callers (PeerFabric) should use
   * `makeMemoryApiFor(self)` so each peer's storage is correctly
   * identified for the per-`(self, peer)` ChannelIndex bindings.
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

  /**
   * Pre-Slice-7c factory. Kept temporarily for regression triage.
   */
  static readonly makeLegacyMemoryApi = (): MemoryApiHandle => makeMemoryApi()
}

// ---------------------------------------------------------------------------
// KV-backed `MemoryApiHandle` adapter
// ---------------------------------------------------------------------------

/**
 * Adapt `makeKvBackedMemoryApi`'s return shape (whose store carries
 * `MemoryStoreEntry` from `KvBackend`) to this module's
 * `MemoryApiHandle` shape (`MemoryEntry`). The two entry types are
 * structurally identical (`{ value: string; expiresAtMs: number }`),
 * so the cast at the boundary is safe; the alternative would be a
 * runtime copy of every entry on every call, which is wasteful for
 * a test-only path.
 */
const kvBackedMemoryApiHandle = (self: string, gen: number): MemoryApiHandle => {
  const built = makeKvBackedMemoryApi({ self, gen })
  return {
    api: built.api,
    store: built.store as unknown as MutableHashMap.MutableHashMap<string, MemoryEntry>,
  }
}

// ---------------------------------------------------------------------------
// Memory-API factory (shared between memoryLayer and PeerFabric.simulated)
// ---------------------------------------------------------------------------

interface MemoryEntry {
  readonly value: string
  readonly expiresAtMs: number
}

/**
 * Materialised in-memory storage handle. The `api` is the public
 * service surface; `store` is exposed for snapshot inspection by
 * `PeerFabric.simulated`'s test control API.
 */
export interface MemoryApiHandle {
  readonly api: PartitionedRelayStorageApi
  readonly store: MutableHashMap.MutableHashMap<string, MemoryEntry>
}

const makeMemoryApi = (): MemoryApiHandle => {
  const store = MutableHashMap.empty<string, MemoryEntry>()
  const writer = AtomicWriter.makeMemoryUnsafe(store)

  const wrapWriterErr = (err: AtomicWriterError): StorageError =>
    new StorageError({ reason: err.reason })

  const sweep = (key: string, nowMs: number): Option.Option<MemoryEntry> => {
    const opt = MutableHashMap.get(store, key)
    if (Option.isNone(opt)) return Option.none()
    if (opt.value.expiresAtMs <= nowMs) {
      MutableHashMap.remove(store, key)
      return Option.none()
    }
    return opt
  }

  const getCall = (
    role: PartitionRole,
    owner: string,
    callRef: string
  ): Effect.Effect<string | null, StorageError> =>
    Effect.gen(function* () {
      const ms = yield* Clock.currentTimeMillis
      return yield* Effect.sync(() => {
        const opt = sweep(
          PartitionedRelayStorage.callKey(role, owner, callRef),
          ms
        )
        return Option.isSome(opt) ? opt.value.value : null
      })
    })

  const getIndex = (
    indexKey: string
  ): Effect.Effect<string | null, StorageError> =>
    Effect.gen(function* () {
      const ms = yield* Clock.currentTimeMillis
      return yield* Effect.sync(() => {
        const opt = sweep(PartitionedRelayStorage.indexKey(indexKey), ms)
        return Option.isSome(opt) ? opt.value.value : null
      })
    })

  const putCall = (
    role: PartitionRole,
    owner: string,
    callRef: string,
    json: string,
    indexes: ReadonlyArray<string>,
    ttlSec: number,
    opts?: PartitionedRelayWriteOptions
  ): Effect.Effect<void, StorageError> =>
    writer
      .put(role, owner, callRef, json, indexes, ttlSec, opts)
      .pipe(Effect.mapError(wrapWriterErr), Effect.asVoid)

  const refreshCall = (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>,
    ttlSec: number,
    opts?: PartitionedRelayWriteOptions
  ): Effect.Effect<void, StorageError> =>
    writer
      .refresh(role, owner, callRef, indexes, ttlSec, opts)
      .pipe(Effect.mapError(wrapWriterErr), Effect.asVoid)

  const deleteCall = (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>,
    opts?: PartitionedRelayWriteOptions
  ): Effect.Effect<void, StorageError> =>
    writer
      .delete(role, owner, callRef, indexes, opts)
      .pipe(Effect.mapError(wrapWriterErr), Effect.asVoid)

  const scanCalls = (
    role: PartitionRole,
    owner: string
  ): Stream.Stream<ScanEntry, StorageError> => {
    const callPrefix = `${role}:${owner}:call:`
    return Stream.unwrap(
      Effect.gen(function* () {
        const ms = yield* Clock.currentTimeMillis
        const matches: Array<ScanEntry> = []
        for (const [key, entry] of store) {
          if (!key.startsWith(callPrefix)) continue
          if (entry.expiresAtMs <= ms) continue
          const callRef = key.slice(callPrefix.length)
          const ttlSec = Math.max(
            0,
            Math.ceil((entry.expiresAtMs - ms) / 1000)
          )
          matches.push({ callRef, json: entry.value, ttlSec })
        }
        return Stream.fromIterable(matches)
      })
    )
  }

  return {
    api: {
      getCall,
      getIndex,
      putCall,
      refreshCall,
      deleteCall,
      scanCalls,
    },
    store,
  }
}

// ---------------------------------------------------------------------------
// redis-layer scan helpers
// ---------------------------------------------------------------------------

// Helper: read the global key prefix from RedisClient's underlying ioredis
// `keyPrefix` option so we can prepend it ourselves when calling raw.scan.
// The wrapped operations (`get`/`setex`/etc.) all go through `pk()`; raw
// commands bypass that, so we mirror the prefix logic locally.
const scanPatternWithGlobalPrefix = (
  redis: { readonly raw: { options: { keyPrefix?: string | undefined } } },
  pattern: string
): string => {
  const prefix = redis.raw.options?.keyPrefix
  return prefix !== undefined && prefix.length > 0 ? `${prefix}${pattern}` : pattern
}

const stripGlobalPrefix =
  (redis: { readonly raw: { options: { keyPrefix?: string | undefined } } }) =>
  (key: string): string => {
    const prefix = redis.raw.options?.keyPrefix
    if (prefix !== undefined && prefix.length > 0 && key.startsWith(prefix)) {
      return key.slice(prefix.length)
    }
    return key
  }

const fetchEntries = (
  redis: {
    readonly raw: {
      readonly mget: (...keys: Array<string>) => Promise<Array<string | null>>
      readonly pttl: (key: string) => Promise<number>
      readonly options: { readonly keyPrefix?: string | undefined }
    }
  },
  localKeys: ReadonlyArray<string>,
  callPrefixLen: number
): Effect.Effect<Array<ScanEntry>, StorageError> =>
  Effect.tryPromise({
    try: async () => {
      if (localKeys.length === 0) return []
      const prefix = redis.raw.options?.keyPrefix ?? ""
      const fullKeys = localKeys.map((k) => `${prefix}${k}`)
      const values = await redis.raw.mget(...fullKeys)
      const ttls = await Promise.all(fullKeys.map((k) => redis.raw.pttl(k)))
      const out: Array<ScanEntry> = []
      for (let i = 0; i < localKeys.length; i++) {
        const v = values[i] ?? null
        const ttlMs = ttls[i] ?? -2
        if (v === null || ttlMs < 0) continue // disappeared mid-scan
        out.push({
          callRef: localKeys[i]!.slice(callPrefixLen),
          json: v,
          ttlSec: Math.max(0, Math.ceil(ttlMs / 1000)),
        })
      }
      return out
    },
    catch: (err) =>
      new StorageError({
        reason: err instanceof Error ? err.message : String(err),
      }),
  })

