/**
 * PartitionedRelayStorage — local-side storage for the cross-pod relay.
 *
 * Slice 3 of the HA-resilience plan. Owns the `{role}:{owner}:`
 * key namespace on each pod's sidecar Redis (D7 / D10 / D15 / D16):
 *
 *   {role}:{owner}:call:{callRef}     → opaque JSON state, with TTL
 *   {role}:{owner}:idx:{indexKey}     → callRef, with TTL
 *
 * `role ∈ {"pri","bak"}` and `owner` is the worker ordinal that the
 * stickiness cookie names as the natural primary for the call. A
 * single sidecar can hold many partitions side by side without
 * collision (e.g. a pod that is primary for some calls and backup
 * for several other primaries).
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
   * Full create/overwrite. Writes the call's state JSON + every
   * index entry with the supplied TTL. Sequential, not atomic — F10
   * (mid-flush crash) is an accepted small loss class.
   */
  readonly putCall: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    json: string,
    indexes: ReadonlyArray<string>,
    ttlSec: number
  ) => Effect.Effect<void, StorageError>

  /**
   * Keepalive — refresh TTL on the call key + every named index. No
   * value rewrite. No-op for missing keys (matches Redis EXPIRE
   * semantics + the memory layer's `expire*` ops).
   */
  readonly refreshCall: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>,
    ttlSec: number
  ) => Effect.Effect<void, StorageError>

  /** Termination — delete the call key + every named index. */
  readonly deleteCall: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>
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

  /** Build a partitioned storage key for an index entry. */
  static readonly indexKey = (
    role: PartitionRole,
    owner: string,
    indexKey: string
  ): string => `${role}:${owner}:idx:${indexKey}`

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

      const wrapErr = (err: RedisError): StorageError =>
        new StorageError({ reason: err.reason })

      const putCall = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        json: string,
        indexes: ReadonlyArray<string>,
        ttlSec: number
      ): Effect.Effect<void, StorageError> =>
        Effect.gen(function* () {
          yield* redis.setex(
            PartitionedRelayStorage.callKey(role, owner, callRef),
            ttlSec,
            json
          ).pipe(Effect.mapError(wrapErr))
          for (const idx of indexes) {
            yield* redis.setex(
              PartitionedRelayStorage.indexKey(role, owner, idx),
              ttlSec,
              callRef
            ).pipe(Effect.mapError(wrapErr))
          }
        })

      const refreshCall = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        indexes: ReadonlyArray<string>,
        ttlSec: number
      ): Effect.Effect<void, StorageError> =>
        Effect.gen(function* () {
          yield* redis.expire(
            PartitionedRelayStorage.callKey(role, owner, callRef),
            ttlSec
          ).pipe(Effect.mapError(wrapErr))
          for (const idx of indexes) {
            yield* redis.expire(
              PartitionedRelayStorage.indexKey(role, owner, idx),
              ttlSec
            ).pipe(Effect.mapError(wrapErr))
          }
        })

      const deleteCall = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        indexes: ReadonlyArray<string>
      ): Effect.Effect<void, StorageError> =>
        Effect.gen(function* () {
          const keys: Array<string> = [
            PartitionedRelayStorage.callKey(role, owner, callRef),
          ]
          for (const idx of indexes) {
            keys.push(PartitionedRelayStorage.indexKey(role, owner, idx))
          }
          yield* redis.del(...keys).pipe(Effect.mapError(wrapErr))
        })

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
        putCall,
        refreshCall,
        deleteCall,
        scanCalls,
      }
    })
  )

  /**
   * Tests: in-memory MutableHashMap + Effect Clock. TTL is enforced
   * on access (sweep-on-touch), matching `CallStateCache.memoryLayer`.
   */
  static readonly memoryLayer = Layer.effect(
    PartitionedRelayStorage,
    Effect.gen(function* () {
      interface Entry {
        readonly value: string
        readonly expiresAtMs: number
      }
      const store = MutableHashMap.empty<string, Entry>()

      const sweep = (key: string, nowMs: number): Option.Option<Entry> => {
        const opt = MutableHashMap.get(store, key)
        if (Option.isNone(opt)) return Option.none()
        if (opt.value.expiresAtMs <= nowMs) {
          MutableHashMap.remove(store, key)
          return Option.none()
        }
        return opt
      }

      const put = (
        key: string,
        value: string,
        ttlSec: number,
        nowMs: number
      ): void => {
        MutableHashMap.set(store, key, {
          value,
          expiresAtMs: nowMs + ttlSec * 1000,
        })
      }

      const expireExisting = (
        key: string,
        ttlSec: number,
        nowMs: number
      ): void => {
        const opt = sweep(key, nowMs)
        if (Option.isSome(opt)) {
          MutableHashMap.set(store, key, {
            value: opt.value.value,
            expiresAtMs: nowMs + ttlSec * 1000,
          })
        }
      }

      const putCall = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        json: string,
        indexes: ReadonlyArray<string>,
        ttlSec: number
      ): Effect.Effect<void, StorageError> =>
        Effect.gen(function* () {
          const ms = yield* Clock.currentTimeMillis
          yield* Effect.sync(() => {
            put(PartitionedRelayStorage.callKey(role, owner, callRef), json, ttlSec, ms)
            for (const idx of indexes) {
              put(
                PartitionedRelayStorage.indexKey(role, owner, idx),
                callRef,
                ttlSec,
                ms
              )
            }
          })
        })

      const refreshCall = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        indexes: ReadonlyArray<string>,
        ttlSec: number
      ): Effect.Effect<void, StorageError> =>
        Effect.gen(function* () {
          const ms = yield* Clock.currentTimeMillis
          yield* Effect.sync(() => {
            expireExisting(
              PartitionedRelayStorage.callKey(role, owner, callRef),
              ttlSec,
              ms
            )
            for (const idx of indexes) {
              expireExisting(
                PartitionedRelayStorage.indexKey(role, owner, idx),
                ttlSec,
                ms
              )
            }
          })
        })

      const deleteCall = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        indexes: ReadonlyArray<string>
      ): Effect.Effect<void, StorageError> =>
        Effect.sync(() => {
          MutableHashMap.remove(
            store,
            PartitionedRelayStorage.callKey(role, owner, callRef)
          )
          for (const idx of indexes) {
            MutableHashMap.remove(
              store,
              PartitionedRelayStorage.indexKey(role, owner, idx)
            )
          }
        })

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
        putCall,
        refreshCall,
        deleteCall,
        scanCalls,
      }
    })
  )
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

