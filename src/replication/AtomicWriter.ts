/**
 * AtomicWriter — sole entry point for state-changing writes against a
 * worker's local Redis sidecar (or its in-memory test fake).
 *
 * Slice 2 widens the Slice 1 surface: when a backup peer is assigned to
 * a call, every put/refresh/delete also bumps `propagate_seq:{peer}`,
 * compacts the callRef into `propagate:{peer}`, and slides the set's
 * TTL. Calls without an LB-assigned backup go through the lighter
 * "no-peer" path — call body + indexes only, no replication side
 * effects. Spec: [docs/replication/call-cache-backup.md §5](../../docs/replication/call-cache-backup.md).
 *
 * Backup is OPTIONAL (per LB policy). Callers pass `peer=undefined`
 * when the call's `_topology.bak` is empty/absent, which selects the
 * Slice 1 atomic path. The Slice 2 path adds:
 *
 *   INCR  propagate_seq:{peer}            -- per-peer monotonic seq
 *   GET   epoch:{owner}                   -- bumped at boot by EpochCounter
 *   ZADD  propagate:{peer} seq callRef    -- compacts on existing member
 *   EXPIRE propagate:{peer} setTtl        -- sliding TTL on the whole set
 *   EXPIRE propagate_seq:{peer} setTtl    -- counter survives as long as the set
 *
 * Atomicity is unchanged: a single Lua EVAL runs to completion before
 * any other Redis command on the local sidecar. The memory layer mirrors
 * the contract via a single-permit Semaphore.
 *
 * Layer composition
 * -----------------
 * `AtomicWriter` is a separate service. The in-memory implementation
 * shares its store with `PartitionedRelayStorage.memoryLayer`. Tests
 * that want AtomicWriter exposed as a service can use
 * `AtomicWriter.memoryLayerFromStore(store)`.
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
import { WriteNotifier, type WriteNotifierApi } from "./WriteNotifier.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PartitionRole = "pri" | "bak"

/** Default sliding TTL on `propagate:{peer}` and `propagate_seq:{peer}`. */
export const DEFAULT_PROPAGATE_SET_TTL_SEC = 3600

/** Result of a peer-bearing write — undefined when no peer was assigned. */
export interface AtomicWriteResult {
  readonly seq: number
  readonly epoch: number
}

export class AtomicWriterError extends Data.TaggedError(
  "AtomicWriterError"
)<{
  readonly reason: string
}> {}

/**
 * Options shared by every write API. `peer` is undefined for calls
 * without an LB-assigned backup; `propagateSetTtlSec` defaults to
 * `DEFAULT_PROPAGATE_SET_TTL_SEC` when omitted.
 */
export interface PeerWriteOptions {
  readonly peer?: string | undefined
  readonly propagateSetTtlSec?: number | undefined
}

export interface AtomicWriterApi {
  readonly put: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    json: string,
    indexes: ReadonlyArray<string>,
    ttlSec: number,
    opts?: PeerWriteOptions
  ) => Effect.Effect<AtomicWriteResult | null, AtomicWriterError>

  readonly refresh: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>,
    ttlSec: number,
    opts?: PeerWriteOptions
  ) => Effect.Effect<AtomicWriteResult | null, AtomicWriterError>

  readonly delete: (
    role: PartitionRole,
    owner: string,
    callRef: string,
    indexes: ReadonlyArray<string>,
    opts?: PeerWriteOptions
  ) => Effect.Effect<AtomicWriteResult | null, AtomicWriterError>
}

// ---------------------------------------------------------------------------
// Memory store contract
// ---------------------------------------------------------------------------

/**
 * Shape of a memory-layer entry. Identical to PartitionedRelayStorage's
 * `MemoryEntry` but re-declared here to keep AtomicWriter independent of
 * cache/PartitionedRelayStorage at the type level. Both services touch
 * the same MutableHashMap instance at runtime.
 *
 * The single store keeps:
 *   - `pri:|bak:{owner}:call:{ref}` — call body, scalar
 *   - `idx:{indexKey}`              — flat index → callRef
 *   - `propagate:{peer}`            — composite entry whose `value` is a
 *     JSON map `{callRef → seq}` (Slice 2 representation of the
 *     Redis sorted set in memory).
 *   - `propagate_seq:{peer}`        — counter
 *   - `epoch:{owner}`               — counter (no TTL; effectively
 *     persistent inside the simulated sidecar)
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

  /** `propagate:{peer}` sorted set / composite key. */
  static readonly propagateSetKey = (peer: string): string =>
    `propagate:${peer}`

  /** `propagate_seq:{peer}` per-peer monotonic seq counter. */
  static readonly propagateSeqKey = (peer: string): string =>
    `propagate_seq:${peer}`

  /** `epoch:{owner}` worker incarnation counter. */
  static readonly epochKey = (owner: string): string => `epoch:${owner}`

  // ---------------- No-peer Lua scripts (Slice 1 unchanged) ----------------

  /** PUT (no peer). KEYS = [callKey, idx1, idx2, ...] ARGV = [ttlSec, json, callRef]. */
  static readonly PUT_LUA = `
local ttl = tonumber(ARGV[1])
redis.call("SETEX", KEYS[1], ttl, ARGV[2])
for i = 2, #KEYS do
  redis.call("SETEX", KEYS[i], ttl, ARGV[3])
end
return 1
`

  /** REFRESH (no peer). KEYS = [callKey, idx1, ...] ARGV = [ttlSec]. */
  static readonly REFRESH_LUA = `
local ttl = tonumber(ARGV[1])
for i = 1, #KEYS do
  redis.call("EXPIRE", KEYS[i], ttl)
end
return 1
`

  /** DELETE (no peer). KEYS = [callKey, idx1, ...] ARGV = []. */
  static readonly DELETE_LUA = `
for i = 1, #KEYS do
  redis.call("DEL", KEYS[i])
end
return 1
`

  // ---------------- Peer-bearing Lua scripts (Slice 2 new) -----------------

  /**
   * PUT (with peer). KEYS = [callKey, idx1..idxK, propSet, propSeq, epochKey]
   * ARGV = [ttlSec, json, callRef, propagateSetTtlSec]. Returns [seq, epoch].
   */
  static readonly PUT_WITH_PEER_LUA = `
local ttl = tonumber(ARGV[1])
local prop_ttl = tonumber(ARGV[4])
local idx_end = #KEYS - 3
local prop_set = KEYS[#KEYS - 2]
local prop_seq = KEYS[#KEYS - 1]
local epoch_k  = KEYS[#KEYS]

redis.call("SETEX", KEYS[1], ttl, ARGV[2])
for i = 2, idx_end do
  redis.call("SETEX", KEYS[i], ttl, ARGV[3])
end

local seq = redis.call("INCR", prop_seq)
redis.call("EXPIRE", prop_seq, prop_ttl)
local epoch = redis.call("GET", epoch_k)
if not epoch then
  redis.call("SET", epoch_k, "1")
  epoch = "1"
end
redis.call("ZADD", prop_set, seq, ARGV[3])
redis.call("EXPIRE", prop_set, prop_ttl)
return { seq, tonumber(epoch) }
`

  /**
   * REFRESH (with peer). KEYS = [callKey, idx1..idxK, propSet, propSeq, epochKey]
   * ARGV = [ttlSec, callRef, propagateSetTtlSec]. Returns [seq, epoch].
   */
  static readonly REFRESH_WITH_PEER_LUA = `
local ttl = tonumber(ARGV[1])
local prop_ttl = tonumber(ARGV[3])
local idx_end = #KEYS - 3
local prop_set = KEYS[#KEYS - 2]
local prop_seq = KEYS[#KEYS - 1]
local epoch_k  = KEYS[#KEYS]

for i = 1, idx_end do
  redis.call("EXPIRE", KEYS[i], ttl)
end

local seq = redis.call("INCR", prop_seq)
redis.call("EXPIRE", prop_seq, prop_ttl)
local epoch = redis.call("GET", epoch_k)
if not epoch then
  redis.call("SET", epoch_k, "1")
  epoch = "1"
end
redis.call("ZADD", prop_set, seq, ARGV[2])
redis.call("EXPIRE", prop_set, prop_ttl)
return { seq, tonumber(epoch) }
`

  /**
   * DELETE (with peer). KEYS = [callKey, idx1..idxK, propSet, propSeq, epochKey]
   * ARGV = [callRef, propagateSetTtlSec]. Returns [seq, epoch].
   *
   * Slice 2 implementation hard-deletes the call key (matching pre-Slice-1
   * semantics). Slice 5 will switch to the tombstone retention path
   * documented in spec §4.3.
   */
  static readonly DELETE_WITH_PEER_LUA = `
local prop_ttl = tonumber(ARGV[2])
local idx_end = #KEYS - 3
local prop_set = KEYS[#KEYS - 2]
local prop_seq = KEYS[#KEYS - 1]
local epoch_k  = KEYS[#KEYS]

for i = 1, idx_end do
  redis.call("DEL", KEYS[i])
end

local seq = redis.call("INCR", prop_seq)
redis.call("EXPIRE", prop_seq, prop_ttl)
local epoch = redis.call("GET", epoch_k)
if not epoch then
  redis.call("SET", epoch_k, "1")
  epoch = "1"
end
redis.call("ZADD", prop_set, seq, ARGV[1])
redis.call("EXPIRE", prop_set, prop_ttl)
return { seq, tonumber(epoch) }
`

  /** Production: backed by RedisClient and the Lua scripts above. */
  static readonly redisLayer = Layer.effect(
    AtomicWriter,
    Effect.gen(function* () {
      const redis = yield* RedisClient
      const notifier = yield* WriteNotifier

      const buildPeerKeys = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        indexes: ReadonlyArray<string>,
        peer: string
      ): Array<string> => {
        const keys: Array<string> = [AtomicWriter.callKey(role, owner, callRef)]
        for (const idx of indexes) keys.push(AtomicWriter.indexKey(idx))
        keys.push(AtomicWriter.propagateSetKey(peer))
        keys.push(AtomicWriter.propagateSeqKey(peer))
        keys.push(AtomicWriter.epochKey(owner))
        return keys
      }

      const buildBareKeys = (
        role: PartitionRole,
        owner: string,
        callRef: string,
        indexes: ReadonlyArray<string>
      ): Array<string> => {
        const keys: Array<string> = [AtomicWriter.callKey(role, owner, callRef)]
        for (const idx of indexes) keys.push(AtomicWriter.indexKey(idx))
        return keys
      }

      // Publish a notification when the Lua returned a non-null
      // {seq, epoch} (i.e. peer-bearing path). No-op for null results.
      const announce = (
        owner: string,
        peer: string,
        callRef: string,
        result: AtomicWriteResult | null
      ): Effect.Effect<AtomicWriteResult | null> => {
        if (result === null) return Effect.succeed(null)
        return notifier
          .publish({ owner, peer, callRef, seq: result.seq, epoch: result.epoch })
          .pipe(Effect.as(result))
      }

      const put: AtomicWriterApi["put"] = (
        role,
        owner,
        callRef,
        json,
        indexes,
        ttlSec,
        opts
      ) => {
        const peer = opts?.peer
        const setTtl = opts?.propagateSetTtlSec ?? DEFAULT_PROPAGATE_SET_TTL_SEC
        if (peer === undefined || peer.length === 0) {
          const keys = buildBareKeys(role, owner, callRef, indexes)
          return redis
            .eval(AtomicWriter.PUT_LUA, keys, [ttlSec, json, callRef])
            .pipe(Effect.mapError(wrapWriterErr), Effect.as(null))
        }
        const keys = buildPeerKeys(role, owner, callRef, indexes, peer)
        return redis
          .eval(AtomicWriter.PUT_WITH_PEER_LUA, keys, [
            ttlSec,
            json,
            callRef,
            setTtl,
          ])
          .pipe(
            Effect.mapError(wrapWriterErr),
            Effect.map(parseLuaPair),
            Effect.flatMap((r) => announce(owner, peer, callRef, r))
          )
      }

      const refresh: AtomicWriterApi["refresh"] = (
        role,
        owner,
        callRef,
        indexes,
        ttlSec,
        opts
      ) => {
        const peer = opts?.peer
        const setTtl = opts?.propagateSetTtlSec ?? DEFAULT_PROPAGATE_SET_TTL_SEC
        if (peer === undefined || peer.length === 0) {
          const keys = buildBareKeys(role, owner, callRef, indexes)
          return redis
            .eval(AtomicWriter.REFRESH_LUA, keys, [ttlSec])
            .pipe(Effect.mapError(wrapWriterErr), Effect.as(null))
        }
        const keys = buildPeerKeys(role, owner, callRef, indexes, peer)
        return redis
          .eval(AtomicWriter.REFRESH_WITH_PEER_LUA, keys, [
            ttlSec,
            callRef,
            setTtl,
          ])
          .pipe(
            Effect.mapError(wrapWriterErr),
            Effect.map(parseLuaPair),
            Effect.flatMap((r) => announce(owner, peer, callRef, r))
          )
      }

      const del: AtomicWriterApi["delete"] = (
        role,
        owner,
        callRef,
        indexes,
        opts
      ) => {
        const peer = opts?.peer
        const setTtl = opts?.propagateSetTtlSec ?? DEFAULT_PROPAGATE_SET_TTL_SEC
        if (peer === undefined || peer.length === 0) {
          const keys = buildBareKeys(role, owner, callRef, indexes)
          return redis
            .eval(AtomicWriter.DELETE_LUA, keys, [])
            .pipe(Effect.mapError(wrapWriterErr), Effect.as(null))
        }
        const keys = buildPeerKeys(role, owner, callRef, indexes, peer)
        return redis
          .eval(AtomicWriter.DELETE_WITH_PEER_LUA, keys, [callRef, setTtl])
          .pipe(
            Effect.mapError(wrapWriterErr),
            Effect.map(parseLuaPair),
            Effect.flatMap((r) => announce(owner, peer, callRef, r))
          )
      }

      return { put, refresh, delete: del }
    })
  )

  /**
   * Tests / fabric: build an AtomicWriter wired to a shared in-memory
   * store. Pulls a `WriteNotifier` from the layer scope; tests that
   * exercise ReplLog should compose `WriteNotifier.layer`, others can
   * use `WriteNotifier.noopLayer`.
   */
  static readonly memoryLayerFromStore = (
    store: MemoryStore
  ): Layer.Layer<AtomicWriter, never, WriteNotifier> =>
    Layer.effect(
      AtomicWriter,
      Effect.gen(function* () {
        const notifier = yield* WriteNotifier
        return makeMemoryUnsafe(store, notifier)
      })
    )

  /**
   * Synchronous factory used by `PartitionedRelayStorage.memoryLayer`
   * and by `PeerFabric.simulated` to embed an AtomicWriter that shares
   * a MutableHashMap with another service. Synchronous so callers that
   * build their state outside of an Effect.gen scope (e.g. PeerFabric's
   * per-peer state map) do not need an Effect runtime to wire up a
   * peer. The optional `notifier` is published to on every successful
   * peer-bearing write; pass undefined for tests that don't observe
   * notifications (the existing 800+ tests fall into this bucket).
   */
  static readonly makeMemoryUnsafe = (
    store: MemoryStore,
    notifier?: WriteNotifierApi
  ): AtomicWriterApi => makeMemoryUnsafe(store, notifier)
}

// ---------------------------------------------------------------------------
// Redis-side helpers
// ---------------------------------------------------------------------------

const wrapWriterErr = (err: { reason: string }): AtomicWriterError =>
  new AtomicWriterError({ reason: err.reason })

const parseLuaPair = (raw: unknown): AtomicWriteResult | null => {
  if (Array.isArray(raw) && raw.length === 2) {
    const [seq, epoch] = raw
    if (typeof seq === "number" && typeof epoch === "number") {
      return { seq, epoch }
    }
    const seqN = Number(seq)
    const epochN = Number(epoch)
    if (Number.isFinite(seqN) && Number.isFinite(epochN)) {
      return { seq: seqN, epoch: epochN }
    }
  }
  return null
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

/** Sweep-on-touch: returns the live entry or removes it if expired. */
const liveEntry = (
  store: MemoryStore,
  key: string,
  nowMs: number
): MemoryStoreEntry | null => {
  const opt = MutableHashMap.get(store, key)
  if (Option.isNone(opt)) return null
  if (opt.value.expiresAtMs <= nowMs) {
    MutableHashMap.remove(store, key)
    return null
  }
  return opt.value
}

/**
 * Ensure `epoch:{owner}` exists; if not, initialize to 1 (matching the
 * Lua `if not epoch then SET ... "1"` branch). Returns the value seen.
 */
const ensureEpoch = (store: MemoryStore, owner: string): number => {
  const opt = MutableHashMap.get(store, AtomicWriter.epochKey(owner))
  if (Option.isSome(opt)) {
    const n = Number(opt.value.value)
    if (Number.isFinite(n) && n > 0) return n
  }
  MutableHashMap.set(store, AtomicWriter.epochKey(owner), {
    value: "1",
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  })
  return 1
}

/**
 * Read+update `propagate_seq:{peer}` (INCR with sliding TTL). Re-creates
 * the counter if it had expired (matches Redis behaviour: an expired
 * counter is gone, and INCR on a missing key creates it at 1).
 */
const incrSeq = (
  store: MemoryStore,
  peer: string,
  setTtlSec: number,
  nowMs: number
): number => {
  const key = AtomicWriter.propagateSeqKey(peer)
  const live = liveEntry(store, key, nowMs)
  const next = live === null ? 1 : Number(live.value) + 1
  MutableHashMap.set(store, key, {
    value: String(next),
    expiresAtMs: nowMs + setTtlSec * 1000,
  })
  return next
}

interface PropagateSetView {
  readonly entries: Record<string, number>
}

const readPropagateSet = (
  store: MemoryStore,
  peer: string,
  nowMs: number
): PropagateSetView => {
  const key = AtomicWriter.propagateSetKey(peer)
  const live = liveEntry(store, key, nowMs)
  if (live === null) return { entries: {} }
  try {
    const parsed = JSON.parse(live.value) as { entries?: Record<string, number> }
    if (parsed && typeof parsed === "object" && parsed.entries) {
      return { entries: parsed.entries }
    }
  } catch {
    // Corrupted entry — treat as empty.
  }
  return { entries: {} }
}

const writePropagateSet = (
  store: MemoryStore,
  peer: string,
  view: PropagateSetView,
  setTtlSec: number,
  nowMs: number
): void => {
  MutableHashMap.set(store, AtomicWriter.propagateSetKey(peer), {
    value: JSON.stringify({ entries: view.entries }),
    expiresAtMs: nowMs + setTtlSec * 1000,
  })
}

/** Compact (ZADD-replaces-score): same callRef updates seq in place. */
const propagateZAdd = (
  store: MemoryStore,
  peer: string,
  callRef: string,
  seq: number,
  setTtlSec: number,
  nowMs: number
): void => {
  const view = readPropagateSet(store, peer, nowMs)
  view.entries[callRef] = seq
  writePropagateSet(store, peer, view, setTtlSec, nowMs)
}

const makeMemoryUnsafe = (
  store: MemoryStore,
  notifier?: WriteNotifierApi
): AtomicWriterApi => {
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

  const announce = (
    owner: string,
    peer: string,
    callRef: string,
    result: AtomicWriteResult | null
  ): Effect.Effect<AtomicWriteResult | null> => {
    if (result === null || notifier === undefined) {
      return Effect.succeed(result)
    }
    return notifier
      .publish({
        owner,
        peer,
        callRef,
        seq: result.seq,
        epoch: result.epoch,
      })
      .pipe(Effect.as(result))
  }

  const put: AtomicWriterApi["put"] = (
    role,
    owner,
    callRef,
    json,
    indexes,
    ttlSec,
    opts
  ) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        const peer = opts?.peer
        const setTtl =
          opts?.propagateSetTtlSec ?? DEFAULT_PROPAGATE_SET_TTL_SEC
        const result = yield* Effect.sync(() => {
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
          if (peer === undefined || peer.length === 0) return null
          const epoch = ensureEpoch(store, owner)
          const seq = incrSeq(store, peer, setTtl, ms)
          propagateZAdd(store, peer, callRef, seq, setTtl, ms)
          return { seq, epoch } satisfies AtomicWriteResult
        })
        if (peer !== undefined && peer.length > 0) {
          return yield* announce(owner, peer, callRef, result)
        }
        return result
      })
    )

  const refresh: AtomicWriterApi["refresh"] = (
    role,
    owner,
    callRef,
    indexes,
    ttlSec,
    opts
  ) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        const peer = opts?.peer
        const setTtl =
          opts?.propagateSetTtlSec ?? DEFAULT_PROPAGATE_SET_TTL_SEC
        const result = yield* Effect.sync(() => {
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
          if (peer === undefined || peer.length === 0) return null
          const epoch = ensureEpoch(store, owner)
          const seq = incrSeq(store, peer, setTtl, ms)
          propagateZAdd(store, peer, callRef, seq, setTtl, ms)
          return { seq, epoch } satisfies AtomicWriteResult
        })
        if (peer !== undefined && peer.length > 0) {
          return yield* announce(owner, peer, callRef, result)
        }
        return result
      })
    )

  const del: AtomicWriterApi["delete"] = (
    role,
    owner,
    callRef,
    indexes,
    opts
  ) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        const peer = opts?.peer
        const setTtl =
          opts?.propagateSetTtlSec ?? DEFAULT_PROPAGATE_SET_TTL_SEC
        const result = yield* Effect.sync(() => {
          removeEntry(store, AtomicWriter.callKey(role, owner, callRef))
          for (const idx of indexes) {
            removeEntry(store, AtomicWriter.indexKey(idx))
          }
          if (peer === undefined || peer.length === 0) return null
          const epoch = ensureEpoch(store, owner)
          const seq = incrSeq(store, peer, setTtl, ms)
          propagateZAdd(store, peer, callRef, seq, setTtl, ms)
          return { seq, epoch } satisfies AtomicWriteResult
        })
        if (peer !== undefined && peer.length > 0) {
          return yield* announce(owner, peer, callRef, result)
        }
        return result
      })
    )

  return { put, refresh, delete: del }
}
