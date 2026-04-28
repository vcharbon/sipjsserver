/**
 * AtomicWriter — sole entry point for state-changing writes against a
 * worker's local Redis sidecar (or its in-memory test fake).
 *
 * Slice 1 deliverable. The contract is documented in
 * [docs/replication/call-cache-backup.md §5](../../docs/replication/call-cache-backup.md).
 *
 * What atomicity buys us
 * ----------------------
 * The previous `PartitionedRelayStorage.putCall` flushed the call body
 * and N index entries with a sequential SETEX loop. If the worker
 * crashed mid-flush, observers (peers pulling, the local recovery scan)
 * could see the call body without all of its indexes — accepted-loss
 * class F10 in the old design. Slice 1 closes F10 by funnelling every
 * write through one Lua script that runs to completion atomically on
 * the Redis instance (Redis runs scripts to completion before serving
 * any other command, RFC-equivalent for our purposes).
 *
 * Slice 1 scope
 * -------------
 * - call body + indexes only (NO `propagate:{peer}` set yet — Slice 2 widens the script).
 * - PUT, REFRESH and DELETE modes.
 * - In-memory layer mirrors the all-or-nothing contract via a single-permit
 *   Semaphore around the same MutableHashMap mutations the existing memory
 *   layer already uses.
 *
 * Layer composition
 * -----------------
 * `AtomicWriter` is a separate service. The in-memory implementation needs
 * to share its store with `PartitionedRelayStorage.memoryLayer` so both
 * services see the same state. We expose `AtomicWriter.makeMemory(store)`
 * as a non-Layer factory consumed internally by
 * `PartitionedRelayStorage.memoryLayer`. Tests that want AtomicWriter
 * exposed as a service can use `AtomicWriter.memoryLayerFromStore(store)`.
 */

import {
  Clock,
  Data,
  Effect,
  Layer,
  MutableHashMap,
  Option,
  Semaphore,
  ServiceMap,
} from "effect"
import { RedisClient } from "../redis/RedisClient.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PartitionRole = "pri" | "bak"

export class AtomicWriterError extends Data.TaggedError(
  "AtomicWriterError"
)<{
  readonly reason: string
}> {}

export interface AtomicWriterApi {
  readonly put: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    json: string,
    indexes: ReadonlyArray<string>,
    ttlSec: number
  ) => Effect.Effect<void, AtomicWriterError>

  readonly refresh: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>,
    ttlSec: number
  ) => Effect.Effect<void, AtomicWriterError>

  readonly delete: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>
  ) => Effect.Effect<void, AtomicWriterError>
}

// ---------------------------------------------------------------------------
// Memory store contract
// ---------------------------------------------------------------------------

/**
 * Shape of a memory-layer entry. Identical to PartitionedRelayStorage's
 * `MemoryEntry` but re-declared here to keep AtomicWriter independent of
 * cache/PartitionedRelayStorage at the type level. Both services touch
 * the same MutableHashMap instance at runtime.
 */
export interface MemoryStoreEntry {
  readonly value: string
  readonly expiresAtMs: number
}

export type MemoryStore = MutableHashMap.MutableHashMap<string, MemoryStoreEntry>

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AtomicWriter extends ServiceMap.Service<
  AtomicWriter,
  AtomicWriterApi
>()("@sipjsserver/replication/AtomicWriter") {
  /** Build a partitioned call-storage key (must match PartitionedRelayStorage.callKey). */
  static readonly callKey = (
    role: PartitionRole,
    owner: string,
    callRef: string
  ): string => `${role}:${owner}:call:${callRef}`

  /** Build a flat index storage key (must match PartitionedRelayStorage.indexKey). */
  static readonly indexKey = (indexKey: string): string => `idx:${indexKey}`

  /** Lua script for PUT mode. KEYS = [callKey, idx1, idx2, ...] ARGV = [ttlSec, json, callRef]. */
  static readonly PUT_LUA = `
local ttl = tonumber(ARGV[1])
redis.call("SETEX", KEYS[1], ttl, ARGV[2])
for i = 2, #KEYS do
  redis.call("SETEX", KEYS[i], ttl, ARGV[3])
end
return 1
`

  /** Lua script for REFRESH mode. KEYS = [callKey, idx1, ...] ARGV = [ttlSec]. */
  static readonly REFRESH_LUA = `
local ttl = tonumber(ARGV[1])
for i = 1, #KEYS do
  redis.call("EXPIRE", KEYS[i], ttl)
end
return 1
`

  /** Lua script for DELETE mode. KEYS = [callKey, idx1, ...] ARGV = []. */
  static readonly DELETE_LUA = `
for i = 1, #KEYS do
  redis.call("DEL", KEYS[i])
end
return 1
`

  /** Production: backed by RedisClient and the Lua scripts above. */
  static readonly redisLayer = Layer.effect(
    AtomicWriter,
    Effect.gen(function* () {
      const redis = yield* RedisClient
      const wrapErr = (err: { reason: string }) =>
        new AtomicWriterError({ reason: err.reason })

      const put = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        json: string,
        indexes: ReadonlyArray<string>,
        ttlSec: number
      ): Effect.Effect<void, AtomicWriterError> => {
        const keys: Array<string> = [AtomicWriter.callKey(role, owner, callRef)]
        for (const idx of indexes) keys.push(AtomicWriter.indexKey(idx))
        return redis
          .eval(AtomicWriter.PUT_LUA, keys, [ttlSec, json, callRef])
          .pipe(Effect.mapError(wrapErr), Effect.asVoid)
      }

      const refresh = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        indexes: ReadonlyArray<string>,
        ttlSec: number
      ): Effect.Effect<void, AtomicWriterError> => {
        const keys: Array<string> = [AtomicWriter.callKey(role, owner, callRef)]
        for (const idx of indexes) keys.push(AtomicWriter.indexKey(idx))
        return redis
          .eval(AtomicWriter.REFRESH_LUA, keys, [ttlSec])
          .pipe(Effect.mapError(wrapErr), Effect.asVoid)
      }

      const del = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        indexes: ReadonlyArray<string>
      ): Effect.Effect<void, AtomicWriterError> => {
        const keys: Array<string> = [AtomicWriter.callKey(role, owner, callRef)]
        for (const idx of indexes) keys.push(AtomicWriter.indexKey(idx))
        return redis
          .eval(AtomicWriter.DELETE_LUA, keys, [])
          .pipe(Effect.mapError(wrapErr), Effect.asVoid)
      }

      return { put, refresh, delete: del }
    })
  )

  /**
   * Tests / fabric: build an AtomicWriter wired to a shared in-memory store.
   * The store is the one PartitionedRelayStorage.memoryLayer writes through;
   * sharing it lets both services see one set of entries with the same
   * atomicity contract.
   */
  static readonly memoryLayerFromStore = (
    store: MemoryStore
  ): Layer.Layer<AtomicWriter> =>
    Layer.sync(AtomicWriter, () => makeMemoryUnsafe(store))

  /**
   * Synchronous factory used by `PartitionedRelayStorage.memoryLayer` and
   * by `PeerFabric.simulated` to embed an AtomicWriter that shares a
   * MutableHashMap with another service. Synchronous so callers that build
   * their state outside of an Effect.gen scope (e.g. PeerFabric's per-peer
   * state map) do not need an Effect runtime to wire up a peer.
   */
  static readonly makeMemoryUnsafe = (store: MemoryStore): AtomicWriterApi =>
    makeMemoryUnsafe(store)
}

// ---------------------------------------------------------------------------
// Memory backend
// ---------------------------------------------------------------------------

const putEntry = (
  store: MemoryStore,
  key: string,
  entry: MemoryStoreEntry
): void => {
  MutableHashMap.set(store, key, entry)
}

const extendIfPresent = (
  store: MemoryStore,
  key: string,
  newExpiresAtMs: number,
  nowMs: number
): void => {
  const opt = MutableHashMap.get(store, key)
  if (Option.isNone(opt)) return
  if (opt.value.expiresAtMs <= nowMs) {
    MutableHashMap.remove(store, key)
    return
  }
  MutableHashMap.set(store, key, {
    value: opt.value.value,
    expiresAtMs: newExpiresAtMs,
  })
}

const removeEntry = (store: MemoryStore, key: string): void => {
  MutableHashMap.remove(store, key)
}

const makeMemoryUnsafe = (store: MemoryStore): AtomicWriterApi => {
  // Single-permit semaphore = mutex. Without this, two fibers could
  // observe the clock then race into the synchronous write block in
  // an order TestClock cannot predict — atomicity from the observer's
  // view (no half-state) holds either way (the sync block doesn't
  // yield), but ordering across fibers is non-deterministic. The
  // mutex restores write-write ordering, which is what real Redis
  // single-threaded EVAL gives us in production.
  const mutex = Semaphore.makeUnsafe(1)
  const exclusive = mutex.withPermits(1)

  const nowMs = Clock.currentTimeMillis

  const put = (
    role: PartitionRole,
    owner: string,
    callRef: string,
    json: string,
    indexes: ReadonlyArray<string>,
    ttlSec: number
  ): Effect.Effect<void, AtomicWriterError> =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        yield* Effect.sync(() => {
          const expiresAtMs = ms + ttlSec * 1000
          putEntry(store, AtomicWriter.callKey(role, owner, callRef), {
            value: json,
            expiresAtMs,
          })
          for (const idx of indexes) {
            putEntry(store, AtomicWriter.indexKey(idx), {
              value: callRef,
              expiresAtMs,
            })
          }
        })
      })
    )

  const refresh = (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>,
    ttlSec: number
  ): Effect.Effect<void, AtomicWriterError> =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        yield* Effect.sync(() => {
          const newExpire = ms + ttlSec * 1000
          extendIfPresent(
            store,
            AtomicWriter.callKey(role, owner, callRef),
            newExpire,
            ms
          )
          for (const idx of indexes) {
            extendIfPresent(store, AtomicWriter.indexKey(idx), newExpire, ms)
          }
        })
      })
    )

  const del = (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>
  ): Effect.Effect<void, AtomicWriterError> =>
    exclusive(
      Effect.sync(() => {
        removeEntry(store, AtomicWriter.callKey(role, owner, callRef))
        for (const idx of indexes) {
          removeEntry(store, AtomicWriter.indexKey(idx))
        }
      })
    )

  return { put, refresh, delete: del }
}
