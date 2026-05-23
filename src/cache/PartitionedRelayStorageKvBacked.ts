/**
 * PartitionedRelayStorage — KV-backed implementation.
 *
 * Slice 7b cutover work. This module provides an alternative
 * implementation of `PartitionedRelayStorageApi` whose internals route
 * through `KvBackend` (storage primitive) and `ChannelIndex` (per-peer
 * propagate channel) instead of the legacy `AtomicWriter` +
 * `propagate:{peer}` ZSET path.
 *
 * The SIP-facing surface is byte-for-byte identical to the existing
 * `PartitionedRelayStorage.memoryLayer` — every public method
 * (`getCall`, `getIndex`, `putCall`, `refreshCall`, `deleteCall`,
 * `scanCalls`) preserves its argument shape and observable semantics
 * so `CallState`, `PeerCacheClient`, and the rest of the SIP path
 * keep working without a single call-site change.
 *
 * Internals — write path:
 *   - When `opts.peer` is provided: route through
 *     `ChannelIndex(self → peer)`. Body and indexes go through the
 *     channel's atomic write; the propagate index gets the U-member.
 *     The body is stamped with `written_at_ms` so the puller's
 *     `latency_ms` is meaningful.
 *   - When `opts.peer` is absent: write the body directly through
 *     `KvBackend.bodySet` (an internal helper — KvBackendApi's public
 *     surface doesn't expose `bodySet` because the design wants
 *     replicated writes to always go through a channel). Indexes are
 *     written via the same direct path.
 *
 * Internals — delete path:
 *   - With peer: `ChannelIndex.tombstone` (writes a tombstone body
 *     with the configured TTL, removes named indexes, ZADDs D-member).
 *   - Without peer: direct `bodyDel` for body and indexes (no
 *     tombstone — there's no consumer to notify).
 *
 * Internals — read path:
 *   - `getCall` / `getIndex` go through `KvBackend.bodyGet`.
 *   - `scanCalls` walks the underlying memory store directly when the
 *     factory is given a `MemoryStore` reference; for Redis-backed
 *     deployments the existing `redisLayer` SCAN logic is reused
 *     (this module's memory variant lands first; the Redis variant
 *     is a follow-up).
 *
 * Reference: [docs/plan/grill-me-on-the-spicy-lark.md](../../docs/plan/grill-me-on-the-spicy-lark.md) §D2, §D5, §"Slice 7b deferral inventory".
 */

import {
  Clock,
  Effect,
  Layer,
  MutableHashMap,
  Option,
  Stream,
} from "effect"
import { AppConfig } from "../config/AppConfig.js"
import { ChannelIndex, type ChannelIndexApi, type Partition } from "../replication/ChannelIndex.js"
import { RedisClient, type RedisOps } from "../redis/RedisClient.js"
import {
  PartitionedRelayStorage,
  StorageError,
  type PartitionRole,
  type PartitionedRelayStorageApi,
  type PartitionedRelayWriteOptions,
  type ScanEntry,
} from "./PartitionedRelayStorage.js"
import {
  KvBackend,
  KvError,
  type KvBackendApi,
  type MemoryStore,
  type MemoryStoreEntry,
} from "../storage/KvBackend.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Construction config for the KV-backed PRS layer.
 *
 * `self` is this worker's ordinal. It is used:
 *   - To compute the partition body keys (the existing `bodyKey(role,
 *     owner, callRef)` derivation already uses the caller-supplied
 *     `owner`, so `self` is only needed to instantiate the per-peer
 *     `ChannelIndex` bindings).
 *   - To stamp the channel binding (`self → peer`) so the propagate
 *     index correctly identifies the writer.
 *
 * `gen` is the writer's incarnation gen, sourced from `EpochCounter`
 * at boot. Channel writes carry this gen so peers can resolve
 * `(gen, counter)` ordering correctly across restarts.
 *
 */
export interface KvBackedPrsConfig {
  readonly self: string
  readonly gen: number
}

// ---------------------------------------------------------------------------
// Channel-index registry — caches one ChannelIndex instance per peer
// ---------------------------------------------------------------------------

/**
 * Lazily build (and memoize) a `ChannelIndex` per peer the writer
 * targets. The cache is bounded by the cluster's peer-set size
 * (typically <10), so unbounded growth is not a concern.
 */
interface ChannelRegistry {
  forPeer(peer: string): ChannelIndexApi
}

const makeChannelRegistry = (
  kv: KvBackendApi,
  config: KvBackedPrsConfig
): ChannelRegistry => {
  const cache = new Map<string, ChannelIndexApi>()
  return {
    forPeer(peer) {
      const cached = cache.get(peer)
      if (cached !== undefined) return cached
      const ch = ChannelIndex.make(
        { self: config.self, peer, gen: config.gen },
        kv
      )
      cache.set(peer, ch)
      return ch
    },
  }
}

// ---------------------------------------------------------------------------
// Body-write helpers (no-peer path bypasses ChannelIndex)
// ---------------------------------------------------------------------------

/**
 * Set a body under the given key with TTL via the in-memory backend's
 * underlying store. Used by the no-peer write path; the public
 * `KvBackendApi` does not expose a generic `bodySet` because the
 * design wants every replicated write to flow through a channel.
 *
 * For Redis the same path uses `SETEX` against the prefixed key — the
 * Redis PRS layer (follow-up) wires this through `redis.setex`
 * directly to keep parity.
 */
const memoryBodySet = (
  store: MemoryStore,
  key: string,
  value: string | Buffer,
  ttlSec: number,
  nowMs: number
): void => {
  MutableHashMap.set(store, key, {
    value,
    expiresAtMs: nowMs + ttlSec * 1000,
  })
}

const memoryBodyExpire = (
  store: MemoryStore,
  key: string,
  ttlSec: number,
  nowMs: number
): void => {
  const opt = MutableHashMap.get(store, key)
  if (opt._tag !== "Some") return
  if (opt.value.expiresAtMs <= nowMs) {
    MutableHashMap.remove(store, key)
    return
  }
  // EXPIRE semantics: replace expiresAt with now + ttl.
  MutableHashMap.set(store, key, {
    value: opt.value.value,
    expiresAtMs: nowMs + ttlSec * 1000,
  })
}

// ---------------------------------------------------------------------------
// Memory factory
// ---------------------------------------------------------------------------

/**
 * Build a KV-backed `PartitionedRelayStorageApi` over an in-memory
 * MutableHashMap store. The store is the same shape used by
 * `KvBackend.makeMemoryUnsafe` — we share it between the KvBackend
 * (for body get/del + channel ops) and the direct-write path (for
 * no-peer writes + scanCalls iteration).
 */
export const makeKvBackedMemoryUnsafe = (
  store: MemoryStore,
  config: KvBackedPrsConfig
): PartitionedRelayStorageApi => {
  const kv = KvBackend.makeMemoryUnsafe(store)
  return makeKvBacked(kv, store, config)
}

/**
 * Build a KV-backed PRS over an arbitrary `KvBackendApi` instance.
 * For tests that want to share a `KvBackend` across multiple
 * components in the same worker.
 *
 * `directBodyOps` provides the no-peer body get/set/del path; the
 * caller is responsible for wiring this against the same physical
 * store the KvBackend instance reads from.
 */
export const makeKvBackedFromBackend = (
  kv: KvBackendApi,
  directBodyOps: {
    readonly bodySetBuffer: (
      key: string,
      value: Buffer,
      ttlSec: number
    ) => Effect.Effect<void, KvError>
    readonly bodySetString: (
      key: string,
      value: string,
      ttlSec: number
    ) => Effect.Effect<void, KvError>
    readonly bodyExpire: (
      key: string,
      ttlSec: number
    ) => Effect.Effect<void, KvError>
    readonly scanByPrefix: (
      prefix: string
    ) => Stream.Stream<{ readonly key: string; readonly value: Buffer; readonly ttlSec: number }, KvError>
  },
  config: KvBackedPrsConfig
): PartitionedRelayStorageApi => makeKvBackedExplicit(kv, directBodyOps, config)

// ---------------------------------------------------------------------------
// Internal factory
// ---------------------------------------------------------------------------

const makeKvBacked = (
  kv: KvBackendApi,
  store: MemoryStore,
  config: KvBackedPrsConfig
): PartitionedRelayStorageApi => {
  // Bind the direct-store ops via the shared MemoryStore. The KvBackend
  // and these helpers operate on the same MutableHashMap so a body
  // written here is visible to a ChannelIndex.pullBatch and vice versa.
  const directBodyOps = {
    bodySetBuffer: (
      key: string,
      value: Buffer,
      ttlSec: number
    ): Effect.Effect<void, KvError> =>
      Effect.gen(function* () {
        const ms = yield* Clock.currentTimeMillis
        yield* Effect.sync(() => memoryBodySet(store, key, value, ttlSec, ms))
      }),
    bodySetString: (
      key: string,
      value: string,
      ttlSec: number
    ): Effect.Effect<void, KvError> =>
      Effect.gen(function* () {
        const ms = yield* Clock.currentTimeMillis
        yield* Effect.sync(() => memoryBodySet(store, key, value, ttlSec, ms))
      }),
    bodyExpire: (
      key: string,
      ttlSec: number
    ): Effect.Effect<void, KvError> =>
      Effect.gen(function* () {
        const ms = yield* Clock.currentTimeMillis
        yield* Effect.sync(() => memoryBodyExpire(store, key, ttlSec, ms))
      }),
    scanByPrefix: (
      prefix: string
    ): Stream.Stream<
      { readonly key: string; readonly value: Buffer; readonly ttlSec: number },
      KvError
    > =>
      Stream.unwrap(
        Effect.gen(function* () {
          const ms = yield* Clock.currentTimeMillis
          const out: Array<{
            readonly key: string
            readonly value: Buffer
            readonly ttlSec: number
          }> = []
          for (const [k, entry] of store) {
            if (!k.startsWith(prefix)) continue
            if (entry.expiresAtMs <= ms) continue
            const ttlSec = Math.max(
              0,
              Math.ceil((entry.expiresAtMs - ms) / 1000)
            )
            const value = Buffer.isBuffer(entry.value)
              ? entry.value
              : Buffer.from(entry.value)
            out.push({ key: k, value, ttlSec })
          }
          return Stream.fromIterable(out)
        })
      ),
  }
  return makeKvBackedExplicit(kv, directBodyOps, config)
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
//
// Note on `written_at_ms`: the legacy JSON path spliced a wall-clock
// stamp into the encoded body inside PRS so the receiver could compute
// `latency_ms`. With msgpack the body is opaque bytes; Fix #2 moved the
// stamp out of the msgpack body entirely. CallState now calls
// `stampEncodedBody(encodeCall(call), writtenAtMs)` to prepend a 9-byte
// binary header (`[0x01][BE uint64]`) before storage. PRS still treats
// the body as opaque; receivers read the stamp via
// `readStampedWrittenAtMs` without decoding the body.
// Indexes are short strings (no stamping needed) and pass through as
// strings unchanged.

const makeKvBackedExplicit = (
  kv: KvBackendApi,
  ops: {
    readonly bodySetBuffer: (
      key: string,
      value: Buffer,
      ttlSec: number
    ) => Effect.Effect<void, KvError>
    readonly bodySetString: (
      key: string,
      value: string,
      ttlSec: number
    ) => Effect.Effect<void, KvError>
    readonly bodyExpire: (
      key: string,
      ttlSec: number
    ) => Effect.Effect<void, KvError>
    readonly scanByPrefix: (
      prefix: string
    ) => Stream.Stream<{ readonly key: string; readonly value: Buffer; readonly ttlSec: number }, KvError>
  },
  config: KvBackedPrsConfig
): PartitionedRelayStorageApi => {
  const channels = makeChannelRegistry(kv, config)

  const wrapKv = (e: KvError): StorageError =>
    new StorageError({ reason: e.reason })

  const partitionOf = (role: PartitionRole): Partition => role
  const callBodyKey = (
    role: PartitionRole,
    owner: string,
    callRef: string
  ): string => PartitionedRelayStorage.callKey(role, owner, callRef)
  const indexStorageKey = (indexKey: string): string =>
    PartitionedRelayStorage.indexKey(indexKey)

  const getCall: PartitionedRelayStorageApi["getCall"] = (
    role,
    owner,
    callRef
  ) =>
    kv
      .bodyGet(callBodyKey(role, owner, callRef))
      .pipe(Effect.mapError(wrapKv))

  // Index values are short callRef strings stored in the same KV slot
  // shape as bodies. `kv.bodyGet` returns Buffer (the binary path); we
  // decode back to UTF-8 here because callers expect a string callRef.
  const getIndex: PartitionedRelayStorageApi["getIndex"] = (indexKey) =>
    kv.bodyGet(indexStorageKey(indexKey)).pipe(
      Effect.mapError(wrapKv),
      Effect.map((buf) => (buf === null ? null : buf.toString("utf8"))),
    )

  const putCall: PartitionedRelayStorageApi["putCall"] = (
    role,
    owner,
    callRef,
    body,
    indexes,
    ttlSec,
    callGen,
    opts
  ) =>
    Effect.gen(function* () {
      const callGenValue = callGen ?? 0
      const peer = opts?.peer
      if (peer === undefined || peer.length === 0) {
        // No-peer path: direct body write + sidecar + per-index write.
        // No propagate side effect.
        yield* ops.bodySetBuffer(callBodyKey(role, owner, callRef), body, ttlSec)
        yield* ops.bodySetBuffer(
          KvBackend.bodyGenSidecarKey(callBodyKey(role, owner, callRef)),
          KvBackend.encodeCallGenSidecar(callGenValue),
          ttlSec,
        )
        for (const idx of indexes) {
          yield* ops.bodySetString(indexStorageKey(idx), callRef, ttlSec)
        }
        return
      }
      // Peer path: route through ChannelIndex(self → peer) at the
      // ORIGINATING bucket (entryGen = self.incarnationGen, exposed
      // via the ChannelIndex binding's `gen` per Story 7d). The
      // channel's `write` does body + indexes + counter + ZADD
      // atomically and bumps the outgoing channel. The body's
      // `_topology.gen` (set by CallState) carries the per-call
      // content version; the puller's apply path uses it as the
      // content gate.
      const channel = channels.forPeer(peer)
      yield* channel
        .write({
          entryGen: channel.gen,
          partition: partitionOf(role),
          callRef,
          bodyValue: body,
          bodyTtlSec: ttlSec,
          callGen: callGenValue,
          indexes: indexes.map((k) => ({
            key: indexStorageKey(k),
            value: callRef,
            ttlSec,
          })),
        })
        .pipe(Effect.asVoid)
    }).pipe(Effect.mapError(wrapKv))

  const refreshCall: PartitionedRelayStorageApi["refreshCall"] = (
    role,
    owner,
    callRef,
    indexes,
    ttlSec,
    opts
  ) =>
    Effect.gen(function* () {
      const peer = opts?.peer
      if (peer === undefined || peer.length === 0) {
        // No-peer refresh: extend TTL on body + sidecar + indexes.
        yield* ops.bodyExpire(callBodyKey(role, owner, callRef), ttlSec)
        yield* ops.bodyExpire(
          KvBackend.bodyGenSidecarKey(callBodyKey(role, owner, callRef)),
          ttlSec,
        )
        for (const idx of indexes) {
          yield* ops.bodyExpire(indexStorageKey(idx), ttlSec)
        }
        return
      }
      // Peer refresh: re-stamp the body via ChannelIndex.write so the
      // remote peer sees a fresh `(gen, counter)` for the same callRef.
      // The legacy AtomicWriter REFRESH_WITH_PEER_LUA used EXPIRE +
      // INCR seq + ZADD member; the new path is semantically
      // equivalent because (a) it bumps the counter, (b) the body's
      // TTL is reset to ttlSec by SETEX, (c) re-write of the same
      // member keeps the index entry compacted.
      //
      // Read the current body to preserve content. If the body has
      // already expired we silently drop the refresh (matching the
      // legacy "EXPIRE on missing is a no-op" semantics).
      const existing = yield* kv.bodyGet(
        callBodyKey(role, owner, callRef)
      )
      if (existing === null) return
      // The sidecar preserves the existing callGen on a refresh —
      // refresh is content-preserving, so the callGen does not advance.
      // A missing sidecar (e.g. pre-sidecar entry) falls back to 0.
      const existingSidecar = yield* kv.bodyGet(
        KvBackend.bodyGenSidecarKey(callBodyKey(role, owner, callRef))
      )
      const existingCallGen =
        KvBackend.decodeCallGenSidecar(existingSidecar) ?? 0
      const channel = channels.forPeer(peer)
      yield* channel
        .write({
          entryGen: channel.gen,
          partition: partitionOf(role),
          callRef,
          bodyValue: existing,
          bodyTtlSec: ttlSec,
          callGen: existingCallGen,
          indexes: indexes.map((k) => ({
            key: indexStorageKey(k),
            value: callRef,
            ttlSec,
          })),
        })
        .pipe(Effect.asVoid)
    }).pipe(Effect.mapError(wrapKv))

  const deleteCall: PartitionedRelayStorageApi["deleteCall"] = (
    role,
    owner,
    callRef,
    indexes,
    opts
  ) =>
    Effect.gen(function* () {
      const peer = opts?.peer
      if (peer === undefined || peer.length === 0) {
        // No-peer delete: hard-delete body + sidecar + indexes (no
        // consumer needs the deletion notification).
        yield* kv.bodyDel(callBodyKey(role, owner, callRef))
        yield* kv.bodyDel(
          KvBackend.bodyGenSidecarKey(callBodyKey(role, owner, callRef)),
        )
        for (const idx of indexes) {
          yield* kv.bodyDel(indexStorageKey(idx))
        }
        return
      }
      // Peer delete: hard-DEL body + indexes via the channel and emit
      // a D-member so the peer's puller observes the deletion. Body
      // slot is empty after this — no tombstone JSON ever lives in a
      // call body slot (see docs/plan/lets-plan-a-proper-crystalline-emerson.md).
      const channel = channels.forPeer(peer)
      yield* channel
        .tombstone({
          entryGen: channel.gen,
          partition: partitionOf(role),
          callRef,
          indexesToRemove: indexes.map(indexStorageKey),
        })
        .pipe(Effect.asVoid)
    }).pipe(Effect.mapError(wrapKv))

  const scanCalls: PartitionedRelayStorageApi["scanCalls"] = (role, owner) => {
    const prefix = `${role}:${owner}:call:`
    return ops.scanByPrefix(prefix).pipe(
      // The `${bodyKey}:gen` sidecar shares the same prefix; filter it
      // out so callers only see call body entries.
      Stream.filter((row) => !row.key.endsWith(":gen")),
      Stream.map((row): ScanEntry => ({
        callRef: row.key.slice(prefix.length),
        body: row.value,
        ttlSec: row.ttlSec,
      })),
      Stream.mapError(wrapKv)
    )
  }

  // Suppress unused-import warning for PartitionedRelayWriteOptions
  // (the shape is referenced via the API interface above; keeping
  // the import here makes the types fully discoverable from this
  // file).
  void ({} as PartitionedRelayWriteOptions)

  return {
    getCall,
    getIndex,
    putCall,
    refreshCall,
    deleteCall,
    scanCalls,
  }
}

// ---------------------------------------------------------------------------
// Public layer constructors
// ---------------------------------------------------------------------------

/**
 * In-memory KV-backed `PartitionedRelayStorage` layer. Allocates a
 * fresh `MemoryStore` on layer build. For tests that want to share
 * the store with another component (e.g. seed entries, snapshot via
 * `PeerFabric.simulated`), use `makeKvBackedMemoryUnsafe(store, ...)`
 * directly and wrap with `Layer.succeed`.
 */
export const kvBackedMemoryLayer = (
  config: KvBackedPrsConfig
): Layer.Layer<PartitionedRelayStorage> =>
  Layer.sync(PartitionedRelayStorage, () => {
    const store = MutableHashMap.empty<string, MemoryStoreEntry>()
    return makeKvBackedMemoryUnsafe(store, config)
  })

/**
 * Build a fresh KV-backed PRS API + the underlying store + the
 * KvBackend instance. Mirrors `PartitionedRelayStorage.makeMemoryApi`
 * for `PeerFabric.simulated` compatibility, plus exposes the
 * `KvBackend` so test harnesses can construct cross-peer
 * `ChannelIndex` bindings (used by the new puller path that reads
 * from a peer's outgoing channel).
 */
export const makeKvBackedMemoryApi = (
  config: KvBackedPrsConfig
): {
  readonly api: PartitionedRelayStorageApi
  readonly store: MemoryStore
  readonly kv: KvBackendApi
} => {
  const store = MutableHashMap.empty<string, MemoryStoreEntry>()
  const kv = KvBackend.makeMemoryUnsafe(store)
  const api = makeKvBacked(kv, store, config)
  return { api, store, kv }
}

// ---------------------------------------------------------------------------
// Redis variant (production cutover candidate)
// ---------------------------------------------------------------------------

/**
 * Wire `RedisOps` into the no-peer body path + the SCAN-based
 * scanCalls path. The redis-side body get/set/del all flow through
 * the prefix-aware `RedisClient` ops (same `pk()` glue as the
 * existing legacy layer).
 *
 * `scanByPrefix` reuses the same cursor-walking logic as
 * `PartitionedRelayStorage.redisLayer`'s scanCalls — directly via
 * `redis.raw.scan` with manual prefix glue, paginated, with a
 * runtime yield between batches.
 */
const makeRedisDirectOps = (
  redis: RedisOps,
  scanBatch: number
): {
  readonly bodySetBuffer: (
    key: string,
    value: Buffer,
    ttlSec: number
  ) => Effect.Effect<void, KvError>
  readonly bodySetString: (
    key: string,
    value: string,
    ttlSec: number
  ) => Effect.Effect<void, KvError>
  readonly bodyExpire: (
    key: string,
    ttlSec: number
  ) => Effect.Effect<void, KvError>
  readonly scanByPrefix: (
    prefix: string
  ) => Stream.Stream<{ readonly key: string; readonly value: Buffer; readonly ttlSec: number }, KvError>
} => {
  const wrapErr = (e: { reason: string }): KvError =>
    new KvError({ reason: e.reason })

  const bodySetBuffer = (key: string, value: Buffer, ttlSec: number) =>
    redis.setexBuffer(key, ttlSec, value).pipe(Effect.mapError(wrapErr))

  const bodySetString = (key: string, value: string, ttlSec: number) =>
    redis.setex(key, ttlSec, value).pipe(Effect.mapError(wrapErr))

  const bodyExpire = (key: string, ttlSec: number) =>
    redis.expire(key, ttlSec).pipe(Effect.mapError(wrapErr))

  const scanByPrefix = (prefix: string) =>
    Stream.paginate("0", (cursor) =>
      Effect.gen(function* () {
        const fullPattern = scanPatternWithGlobalPrefix(redis, `${prefix}*`)
        const [nextCursor, keys] = yield* Effect.tryPromise({
          try: () => redis.raw.scan(cursor, "MATCH", fullPattern, "COUNT", scanBatch),
          catch: (err) =>
            new KvError({
              reason: err instanceof Error ? err.message : String(err),
            }),
        })
        const localKeys = (keys as ReadonlyArray<string>).map(stripGlobalPrefix(redis))
        const entries = yield* fetchScanEntries(redis, localKeys)
        yield* Effect.yieldNow
        const next: Option.Option<string> =
          nextCursor === "0" ? Option.none() : Option.some(nextCursor as string)
        return [entries, next] as const
      })
    )

  return { bodySetBuffer, bodySetString, bodyExpire, scanByPrefix }
}

const scanPatternWithGlobalPrefix = (redis: RedisOps, pattern: string): string => {
  const prefix = (redis.raw as { options?: { keyPrefix?: string } }).options?.keyPrefix
  return prefix !== undefined && prefix.length > 0 ? `${prefix}${pattern}` : pattern
}

const stripGlobalPrefix =
  (redis: RedisOps) =>
  (key: string): string => {
    const prefix = (redis.raw as { options?: { keyPrefix?: string } }).options?.keyPrefix
    if (prefix !== undefined && prefix.length > 0 && key.startsWith(prefix)) {
      return key.slice(prefix.length)
    }
    return key
  }

const fetchScanEntries = (
  redis: RedisOps,
  localKeys: ReadonlyArray<string>
): Effect.Effect<
  ReadonlyArray<{ readonly key: string; readonly value: Buffer; readonly ttlSec: number }>,
  KvError
> =>
  Effect.tryPromise({
    try: async () => {
      if (localKeys.length === 0) return []
      const prefix =
        (redis.raw as { options?: { keyPrefix?: string } }).options?.keyPrefix ?? ""
      const fullKeys = localKeys.map((k) => `${prefix}${k}`)
      // mgetBuffer returns Buffer | null per key — required for msgpack
      // bodies (string-decoded path would mojibake binary bytes). ioredis
      // exposes this on the raw client; we cast through the same shape
      // pattern as the legacy mget call.
      const rawClient = redis.raw as unknown as {
        readonly mgetBuffer: (...keys: Array<string>) => Promise<Array<Buffer | null>>
        readonly pttl: (key: string) => Promise<number>
      }
      const values = await rawClient.mgetBuffer(...fullKeys)
      const ttls = await Promise.all(fullKeys.map((k) => rawClient.pttl(k)))
      const out: Array<{
        readonly key: string
        readonly value: Buffer
        readonly ttlSec: number
      }> = []
      for (let i = 0; i < localKeys.length; i++) {
        const v = values[i] ?? null
        const ttlMs = ttls[i] ?? -2
        if (v === null || ttlMs < 0) continue
        out.push({
          key: localKeys[i]!,
          value: v,
          ttlSec: Math.max(0, Math.ceil(ttlMs / 1000)),
        })
      }
      return out
    },
    catch: (err) =>
      new KvError({
        reason: err instanceof Error ? err.message : String(err),
      }),
  })

/**
 * Redis-backed KV PRS layer. Pulls `RedisClient` + `AppConfig` from
 * the layer scope; the AppConfig provides the `redisKeyPrefix` glue
 * the inner Lua scripts need (`KvBackend.redisLayer` already reads
 * this via the same path).
 *
 * `selfOrdinal` and `gen` are caller-supplied because they live in
 * the caller's boot context (resolved from `AppConfig.workerOrdinalLabel`
 * / `EpochCounter`) — passing them in keeps the layer free of those
 * additional dependencies and lets `main.ts` wire them once.
 */
export const kvBackedRedisLayer = (
  config: KvBackedPrsConfig
): Layer.Layer<PartitionedRelayStorage, never, RedisClient | AppConfig> =>
  Layer.effect(
    PartitionedRelayStorage,
    Effect.gen(function* () {
      const redis = yield* RedisClient
      const appConfig = yield* AppConfig
      const prefixWithColon = `${appConfig.redisKeyPrefix}:`
      const kv = KvBackend.makeRedisUnsafe(redis, prefixWithColon)
      const ops = makeRedisDirectOps(redis, PartitionedRelayStorage.DEFAULT_SCAN_BATCH)
      return makeKvBackedExplicit(kv, ops, config)
    })
  )
