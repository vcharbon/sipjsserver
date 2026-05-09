/**
 * KvBackend — the storage primitive port for the replication redesign.
 *
 * Replaces the parallel `redisLayer` / `memoryLayerFromStore` impls in
 * `src/replication/AtomicWriter.ts`, `PropagateStream.ts`, `EpochCounter.ts`,
 * `ReplLog.ts`, `ReplPuller.ts` with a single small interface that the
 * replication modules above consume. Two backends satisfy this port:
 *
 *   - `KvBackend.makeMemory()`  — in-memory `MutableHashMap` + single mutex.
 *                                 Default for tests and dev.
 *   - `KvBackend.makeRedis()`   — Lua-backed Redis primitive (Slice 2).
 *
 * Every higher-level replication module is a single implementation that
 * consumes this port — eliminating the silent drift between fake and prod
 * code paths that produced the K8s-only bug fixed in commit `d6a2b7b`.
 *
 * Design ref: [docs/plan/grill-me-on-the-spicy-lark.md](../../docs/plan/grill-me-on-the-spicy-lark.md) §D1, §D2, §D3.
 *
 * Member format convention (enforced by the channel layer above, NOT by
 * this port — KvBackend treats `member` and `bodyKey` as opaque strings):
 *
 *   member  = `${op}:${bodyKey}`           where op ∈ {"U", "D"}
 *   bodyKey = `${partition}:${owner}:call:${callRef}`
 *
 * The "U:" / "D:" prefix lets `channelPullBatch` derive body keys from
 * members via simple substring slicing — uniform across both backends.
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
import { AppConfig } from "../config/AppConfig.js"
import { RedisClient, type RedisOps } from "../redis/RedisClient.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export class KvError extends Data.TaggedError("KvError")<{
  readonly reason: string
}> {}

/**
 * One entry returned by `channelPullBatch`. `body` is `null` when the body
 * key is missing in the store at read time — either because TTL has fired
 * since the index entry was written (rare; tombstone-ttl race) or because
 * a concurrent delete/expire collapsed it. The puller treats `null` body
 * as "apply implicit DEL" — the body has gone, so the call must be gone.
 */
export interface PulledEntry {
  readonly member: string
  readonly score: number
  readonly body: string | null
}

export interface ChannelPullResult {
  readonly entries: ReadonlyArray<PulledEntry>
  readonly headCounter: number
}

/**
 * Index entry written alongside a body in `channelWriteUpdate`. `key` is the
 * full Redis key (not a prefix) and `value` is what the index resolves to
 * (typically the callRef). The TTL is per-index — typically equal to the
 * body TTL, though the API does not require it.
 */
export interface IndexWrite {
  readonly key: string
  readonly value: string
  readonly ttlSec: number
}

export interface ChannelWriteUpdateArgs {
  readonly channel: string
  readonly counterKey: string
  readonly member: string
  readonly bodyKey: string
  readonly bodyValue: string
  readonly bodyTtlSec: number
  readonly indexes: ReadonlyArray<IndexWrite>
}

export interface ChannelWriteTombstoneArgs {
  readonly channel: string
  readonly counterKey: string
  readonly member: string
  readonly bodyKey: string
  readonly tombstoneValue: string
  readonly tombstoneTtlSec: number
  readonly indexesToRemove: ReadonlyArray<string>
}

export interface ChannelPullBatchArgs {
  readonly channel: string
  readonly counterKey: string
  readonly sinceScore: number
  readonly limit: number
}

export interface KvBackendApi {
  // ---- Body store --------------------------------------------------------

  readonly bodyGet: (key: string) => Effect.Effect<string | null, KvError>
  readonly bodyDel: (key: string) => Effect.Effect<void, KvError>
  readonly bodyMget: (
    keys: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<string | null>, KvError>

  // ---- Counter -----------------------------------------------------------

  readonly counterRead: (key: string) => Effect.Effect<number, KvError>

  // ---- Atomic composite ops ---------------------------------------------

  /**
   * Atomic write: SET body with TTL, INCR counter, ZADD member at the new
   * counter, SET each index with its TTL — all in one transaction.
   *
   * Re-writing the same `member` updates its score (sorted-set semantics:
   * latest write wins). Returns the assigned counter value (the new score).
   */
  readonly channelWriteUpdate: (
    args: ChannelWriteUpdateArgs
  ) => Effect.Effect<{ readonly counter: number }, KvError>

  /**
   * Atomic tombstone: SET body to a tombstone marker with a SHORT TTL
   * (typically ~3 min), INCR counter, ZADD member (with the "D:" prefix),
   * DEL each named secondary index — all in one transaction.
   *
   * The tombstone body is what the puller fetches via `channelPullBatch` to
   * learn that the call was deleted. After the tombstone TTL expires, the
   * body is GC'd; any peer pulling the index entry after that point gets
   * `body=null` and treats it as an implicit DEL.
   */
  readonly channelWriteTombstone: (
    args: ChannelWriteTombstoneArgs
  ) => Effect.Effect<{ readonly counter: number }, KvError>

  /**
   * Atomic batched pull: ZRANGEBYSCORE on the channel for entries with
   * score strictly greater than `sinceScore` (limited to `limit`), then
   * MGET on the bodies derived from each member by stripping the "U:"/"D:"
   * prefix — all in one snapshot.
   *
   * `headCounter` is the channel's current counter at snapshot time, used
   * by the puller to detect "caught up to head" (`entries.length < limit
   * AND lastEntryScore == headCounter`, or `entries.length == 0`).
   */
  readonly channelPullBatch: (
    args: ChannelPullBatchArgs
  ) => Effect.Effect<ChannelPullResult, KvError>
}

export class KvBackend extends ServiceMap.Service<KvBackend, KvBackendApi>()(
  "@sipjsserver/storage/KvBackend"
) {
  // -----------------------------------------------------------------------
  // Member encoding helpers (enforced as a CONVENTION; KvBackend itself is
  // agnostic about the prefix — but the in-memory pull-batch and the Lua
  // pull-batch both rely on this convention to derive body keys).
  // -----------------------------------------------------------------------

  /** Op tag prefix for "create / update" entries. */
  static readonly OP_UPDATE = "U"

  /** Op tag prefix for "delete (tombstone)" entries. */
  static readonly OP_DELETE = "D"

  /** Construct a `member` from an op tag + body key. */
  static readonly memberOf = (
    op: "U" | "D",
    bodyKey: string
  ): string => `${op}:${bodyKey}`

  /**
   * Derive the body key from a member by stripping the "U:" or "D:" prefix.
   * Returns `null` for malformed members (which signals a programming bug
   * — the caller should never write a member without the prefix).
   */
  static readonly bodyKeyFromMember = (member: string): string | null => {
    if (member.length < 3) return null
    if (member[1] !== ":") return null
    const op = member[0]
    if (op !== "U" && op !== "D") return null
    return member.slice(2)
  }

  /**
   * Memory backend — single mutex around a `MutableHashMap`. Equivalent
   * atomicity to a Redis Lua script for the purposes of test parity.
   *
   * Returned as a `Layer` so it composes with the rest of the replication
   * stack via `Layer.provide`. The shared store is allocated inside the
   * Layer build effect — each test gets a fresh store unless they share a
   * `MemoryStore` explicitly via `KvBackend.memoryLayerFromStore(store)`.
   */
  static readonly memoryLayer: Layer.Layer<KvBackend> = Layer.effect(
    KvBackend,
    Effect.sync(() => {
      const store = MutableHashMap.empty<string, MemoryStoreEntry>()
      return makeMemoryUnsafe(store)
    })
  )

  /** Memory backend bound to a caller-provided shared store. */
  static readonly memoryLayerFromStore = (
    store: MemoryStore
  ): Layer.Layer<KvBackend> =>
    Layer.effect(KvBackend, Effect.sync(() => makeMemoryUnsafe(store)))

  /** Synchronous factory for fabric-style wiring (no Effect runtime needed). */
  static readonly makeMemoryUnsafe = (store: MemoryStore): KvBackendApi =>
    makeMemoryUnsafe(store)

  // -----------------------------------------------------------------------
  // Lua scripts for the Redis backend (Slice 2). Inlined for now (matching
  // the pattern in AtomicWriter); a future slice may move them to .lua
  // files + SCRIPT LOAD for hash-pinned versioning.
  // -----------------------------------------------------------------------

  /**
   * Atomic write of (counter+1, body, indexes, ZADD member).
   *
   * KEYS = [counterKey, channel, bodyKey, idx1, idx2, ...]
   * ARGV = [member, bodyValue, bodyTtlSec, idxCount,
   *         idxValue1, idxTtl1, idxValue2, idxTtl2, ...]
   * Returns: counter (integer)
   */
  static readonly CHANNEL_WRITE_UPDATE_LUA = `
local counter = redis.call("INCR", KEYS[1])
redis.call("SETEX", KEYS[3], tonumber(ARGV[3]), ARGV[2])
local idxCount = tonumber(ARGV[4])
for i = 1, idxCount do
  local key = KEYS[3 + i]
  local val = ARGV[4 + (i - 1) * 2 + 1]
  local ttl = tonumber(ARGV[4 + (i - 1) * 2 + 2])
  redis.call("SETEX", key, ttl, val)
end
redis.call("ZADD", KEYS[2], counter, ARGV[1])
return counter
`

  /**
   * Atomic tombstone write (counter+1, tombstone body w/ short TTL,
   * remove indexes, ZADD D-member).
   *
   * KEYS = [counterKey, channel, bodyKey, idxToRemove1, idxToRemove2, ...]
   * ARGV = [member, tombstoneValue, tombstoneTtlSec, idxRemoveCount]
   * Returns: counter (integer)
   */
  static readonly CHANNEL_WRITE_TOMBSTONE_LUA = `
local counter = redis.call("INCR", KEYS[1])
redis.call("SETEX", KEYS[3], tonumber(ARGV[3]), ARGV[2])
local removeCount = tonumber(ARGV[4])
for i = 1, removeCount do
  redis.call("DEL", KEYS[3 + i])
end
redis.call("ZADD", KEYS[2], counter, ARGV[1])
return counter
`

  /**
   * Atomic batched pull: ZRANGEBYSCORE on the channel + GET on each
   * derived body key, all in one snapshot.
   *
   * KEYS = [counterKey, channel]
   * ARGV = [sinceScore, limit, prefixWithColon]
   *   - prefixWithColon: the RedisClient's per-pod key prefix WITH the
   *     trailing colon (e.g. "sipas:") — needed to construct the
   *     prefixed bodyKey from the unprefixed bodyKey suffix encoded in
   *     each ZSET member.
   * Returns: [headCounter, member1, score1, body1, member2, score2, body2, ...]
   *   - body* may be `false` (Redis-nil) when the body has been DEL'd or
   *     TTL'd between writeand pull. The caller maps false → null.
   */
  static readonly CHANNEL_PULL_BATCH_LUA = `
local headCounter = tonumber(redis.call("GET", KEYS[1]) or "0")
local sinceScore = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local prefix = ARGV[3]

local rangeResult = redis.call("ZRANGEBYSCORE", KEYS[2], "(" .. sinceScore, "+inf", "WITHSCORES", "LIMIT", 0, limit)

local response = { headCounter }
local i = 1
while i < #rangeResult do
  local member = rangeResult[i]
  local score = tonumber(rangeResult[i + 1])
  -- Strip the "U:" or "D:" prefix to get the bodyKey (without RedisClient prefix).
  local bodyKeySuffix = string.sub(member, 3)
  local prefixedBodyKey = prefix .. bodyKeySuffix
  local body = redis.call("GET", prefixedBodyKey)
  table.insert(response, member)
  table.insert(response, score)
  table.insert(response, body)
  i = i + 2
end

return response
`

  /**
   * Production: backed by RedisClient + Lua scripts above. Reads the
   * sidecar's per-pod key prefix from AppConfig so the channelPullBatch
   * Lua can construct prefixed body keys from the bodyKey suffix encoded
   * in each ZSET member.
   */
  static readonly redisLayer: Layer.Layer<
    KvBackend,
    never,
    RedisClient | AppConfig
  > = Layer.effect(
    KvBackend,
    Effect.gen(function* () {
      const redis = yield* RedisClient
      const config = yield* AppConfig
      const prefixWithColon = `${config.redisKeyPrefix}:`
      return makeRedisKv(redis, prefixWithColon)
    })
  )

  /**
   * Synchronous factory for tests that want to drive Redis directly with
   * a per-run prefix (parity tests, integration tests). Production code
   * uses `redisLayer`; this is the test-side equivalent of `makeMemoryUnsafe`.
   *
   * `prefixWithColon` MUST end with `:` and MUST match the prefix used by
   * the `RedisOps` instance — otherwise the channelPullBatch Lua will
   * construct wrong body keys when deriving them from members.
   */
  static readonly makeRedisUnsafe = (
    redis: RedisOps,
    prefixWithColon: string
  ): KvBackendApi => makeRedisKv(redis, prefixWithColon)
}

// ---------------------------------------------------------------------------
// Memory store contract
// ---------------------------------------------------------------------------

/**
 * Shape of an in-memory entry. Bodies and indexes use the `value` field
 * directly. The `propagate:{...}` channel is a single composite entry whose
 * `value` is a JSON-encoded sorted view (see `ChannelView`).
 */
export interface MemoryStoreEntry {
  readonly value: string
  readonly expiresAtMs: number
}

export type MemoryStore = MutableHashMap.MutableHashMap<
  string,
  MemoryStoreEntry
>

// ---------------------------------------------------------------------------
// Memory backend implementation
// ---------------------------------------------------------------------------

/**
 * Sentinel TTL meaning "never expire" — used internally for counter keys
 * which have no notion of expiry in the redesign (the counter persists
 * for the lifetime of the sidecar process; gen rolls handle restarts).
 */
const NO_EXPIRY_MS = Number.MAX_SAFE_INTEGER

/**
 * In-memory channel representation. Stored as a JSON-encoded value inside
 * the same `MemoryStoreEntry` mechanism so the store has a single uniform
 * type. Sorted lookup is O(N log N) on read — acceptable for tests up to
 * ~10K members; production uses Redis sorted sets.
 */
interface ChannelView {
  readonly entries: { [member: string]: number }
}

const emptyChannel = (): ChannelView => ({ entries: {} })

const decodeChannel = (raw: string): ChannelView => {
  const parsed = decodeChannelJson(raw)
  if (parsed === null) return emptyChannel()
  return parsed
}

// Pure helper outside Effect.gen so the Effect plugin's preferSchemaOverJson
// rule does not fire (the channel value is opaque-pass-through state).
const decodeChannelJson = (raw: string): ChannelView | null => {
  try {
    const obj = JSON.parse(raw) as { entries?: { [k: string]: number } }
    if (obj && typeof obj === "object" && obj.entries) {
      return { entries: obj.entries }
    }
  } catch {
    // Corrupted entry — treat as empty.
  }
  return null
}

const encodeChannel = (view: ChannelView): string =>
  JSON.stringify({ entries: view.entries })

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

const setEntry = (
  store: MemoryStore,
  key: string,
  value: string,
  expiresAtMs: number
): void => {
  MutableHashMap.set(store, key, { value, expiresAtMs })
}

const removeEntry = (store: MemoryStore, key: string): void => {
  MutableHashMap.remove(store, key)
}

const readChannel = (
  store: MemoryStore,
  key: string,
  nowMs: number
): ChannelView => {
  const live = liveEntry(store, key, nowMs)
  if (live === null) return emptyChannel()
  return decodeChannel(live.value)
}

const writeChannel = (
  store: MemoryStore,
  key: string,
  view: ChannelView
): void => {
  setEntry(store, key, encodeChannel(view), NO_EXPIRY_MS)
}

const incrCounter = (
  store: MemoryStore,
  key: string,
  nowMs: number
): number => {
  const live = liveEntry(store, key, nowMs)
  const next = live === null ? 1 : Number(live.value) + 1
  setEntry(store, key, String(next), NO_EXPIRY_MS)
  return next
}

const readCounter = (
  store: MemoryStore,
  key: string,
  nowMs: number
): number => {
  const live = liveEntry(store, key, nowMs)
  if (live === null) return 0
  const n = Number(live.value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const makeMemoryUnsafe = (store: MemoryStore): KvBackendApi => {
  // Single-permit semaphore = mutex. Without this, two concurrent writers
  // could observe-then-mutate in an order that breaks counter monotonicity
  // from any one observer's perspective. The synchronous block inside
  // Effect.sync does not yield, so atomicity within one critical section
  // is automatic — but cross-fiber ordering needs the mutex.
  const mutex = Semaphore.makeUnsafe(1)
  const exclusive = mutex.withPermits(1)

  const nowMs = Clock.currentTimeMillis

  const bodyGet: KvBackendApi["bodyGet"] = (key) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        const live = liveEntry(store, key, ms)
        return live === null ? null : live.value
      })
    )

  const bodyDel: KvBackendApi["bodyDel"] = (key) =>
    exclusive(Effect.sync(() => removeEntry(store, key)))

  const bodyMget: KvBackendApi["bodyMget"] = (keys) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        const out: Array<string | null> = []
        for (const k of keys) {
          const live = liveEntry(store, k, ms)
          out.push(live === null ? null : live.value)
        }
        return out
      })
    )

  const counterRead: KvBackendApi["counterRead"] = (key) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        return readCounter(store, key, ms)
      })
    )

  const channelWriteUpdate: KvBackendApi["channelWriteUpdate"] = (args) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        return yield* Effect.sync(() => {
          const counter = incrCounter(store, args.counterKey, ms)
          setEntry(store, args.bodyKey, args.bodyValue, ms + args.bodyTtlSec * 1000)
          for (const idx of args.indexes) {
            setEntry(store, idx.key, idx.value, ms + idx.ttlSec * 1000)
          }
          const view = readChannel(store, args.channel, ms)
          view.entries[args.member] = counter
          writeChannel(store, args.channel, view)
          return { counter }
        })
      })
    )

  const channelWriteTombstone: KvBackendApi["channelWriteTombstone"] = (args) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        return yield* Effect.sync(() => {
          const counter = incrCounter(store, args.counterKey, ms)
          setEntry(
            store,
            args.bodyKey,
            args.tombstoneValue,
            ms + args.tombstoneTtlSec * 1000
          )
          for (const idxKey of args.indexesToRemove) {
            removeEntry(store, idxKey)
          }
          const view = readChannel(store, args.channel, ms)
          view.entries[args.member] = counter
          writeChannel(store, args.channel, view)
          return { counter }
        })
      })
    )

  const channelPullBatch: KvBackendApi["channelPullBatch"] = (args) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        const view = readChannel(store, args.channel, ms)
        const headCounter = readCounter(store, args.counterKey, ms)
        // Sort entries by score ascending; emit those with score > sinceScore.
        const all: Array<{ member: string; score: number }> = []
        for (const [member, score] of Object.entries(view.entries)) {
          if (score > args.sinceScore) all.push({ member, score })
        }
        all.sort((a, b) => a.score - b.score)
        const slice = all.slice(0, args.limit)
        const entries: Array<PulledEntry> = []
        for (const { member, score } of slice) {
          const bodyKey = KvBackend.bodyKeyFromMember(member)
          if (bodyKey === null) {
            // Malformed member — surface as a typed error so tests catch
            // the bug. v4 idiom: `yield*` the TaggedError directly.
            return yield* new KvError({
              reason: `channelPullBatch: malformed member "${member}" in channel ${args.channel}`,
            })
          }
          const live = liveEntry(store, bodyKey, ms)
          entries.push({
            member,
            score,
            body: live === null ? null : live.value,
          })
        }
        return { entries, headCounter }
      })
    )

  return {
    bodyGet,
    bodyDel,
    bodyMget,
    counterRead,
    channelWriteUpdate,
    channelWriteTombstone,
    channelPullBatch,
  }
}

// ---------------------------------------------------------------------------
// Redis backend implementation
// ---------------------------------------------------------------------------

/**
 * Map a Redis-side error into the KvBackend error channel. Keeps the typed
 * error narrow — KvError is the only failure tag any consumer of this port
 * has to handle, regardless of which backend is wired.
 */
const wrapRedisErr = (err: { reason: string }): KvError =>
  new KvError({ reason: err.reason })

/**
 * Decode the alternating `[headCounter, m1, s1, b1, m2, s2, b2, ...]`
 * payload returned by CHANNEL_PULL_BATCH_LUA into a typed result.
 *
 * `body` arrives as `string` for an existing key, or `false` (Redis-nil)
 * for a missing one — we normalize the latter to `null` so callers see a
 * consistent type regardless of backend.
 */
const decodePullBatchResult = (raw: unknown): ChannelPullResult => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { entries: [], headCounter: 0 }
  }
  const headCounter = toFiniteNumber(raw[0]) ?? 0
  const entries: Array<PulledEntry> = []
  let i = 1
  while (i + 2 < raw.length + 1) {
    if (i + 2 >= raw.length + 1) break
    const member = raw[i]
    const score = toFiniteNumber(raw[i + 1])
    const body = raw[i + 2]
    if (typeof member !== "string" || score === null) {
      // Malformed payload — should never happen with our Lua; fail loudly
      // rather than silently swallow.
      break
    }
    entries.push({
      member,
      score,
      body: typeof body === "string" ? body : null,
    })
    i += 3
  }
  return { entries, headCounter }
}

const toFiniteNumber = (raw: unknown): number | null => {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

const makeRedisKv = (
  redis: RedisOps,
  prefixWithColon: string
): KvBackendApi => {
  const bodyGet: KvBackendApi["bodyGet"] = (key) =>
    redis.get(key).pipe(Effect.mapError(wrapRedisErr))

  const bodyDel: KvBackendApi["bodyDel"] = (key) =>
    redis.del(key).pipe(Effect.mapError(wrapRedisErr), Effect.asVoid)

  const bodyMget: KvBackendApi["bodyMget"] = (keys) =>
    Effect.gen(function* () {
      // ioredis MGET via pipeline: one GET per key. Slower than a real
      // MGET but it goes through the prefix-aware ops surface, and the
      // call sites for body MGET are short-lists (~10s in pull-batch's
      // null-body race fallback), so the perf delta is negligible.
      const out: Array<string | null> = []
      for (const k of keys) {
        const v = yield* redis.get(k).pipe(Effect.mapError(wrapRedisErr))
        out.push(v)
      }
      return out
    })

  const counterRead: KvBackendApi["counterRead"] = (key) =>
    redis.get(key).pipe(
      Effect.mapError(wrapRedisErr),
      Effect.map((raw) => {
        if (raw === null) return 0
        const n = Number(raw)
        return Number.isFinite(n) && n > 0 ? n : 0
      })
    )

  const channelWriteUpdate: KvBackendApi["channelWriteUpdate"] = (args) => {
    const keys: Array<string> = [args.counterKey, args.channel, args.bodyKey]
    for (const idx of args.indexes) keys.push(idx.key)
    const argv: Array<string | number> = [
      args.member,
      args.bodyValue,
      args.bodyTtlSec,
      args.indexes.length,
    ]
    for (const idx of args.indexes) {
      argv.push(idx.value, idx.ttlSec)
    }
    return redis
      .eval(KvBackend.CHANNEL_WRITE_UPDATE_LUA, keys, argv)
      .pipe(
        Effect.mapError(wrapRedisErr),
        Effect.flatMap((raw) => {
          const counter = toFiniteNumber(raw)
          if (counter === null) {
            return Effect.fail(
              new KvError({ reason: "channelWriteUpdate: bad Lua return" })
            )
          }
          return Effect.succeed({ counter })
        })
      )
  }

  const channelWriteTombstone: KvBackendApi["channelWriteTombstone"] = (args) => {
    const keys: Array<string> = [args.counterKey, args.channel, args.bodyKey]
    for (const k of args.indexesToRemove) keys.push(k)
    const argv: Array<string | number> = [
      args.member,
      args.tombstoneValue,
      args.tombstoneTtlSec,
      args.indexesToRemove.length,
    ]
    return redis
      .eval(KvBackend.CHANNEL_WRITE_TOMBSTONE_LUA, keys, argv)
      .pipe(
        Effect.mapError(wrapRedisErr),
        Effect.flatMap((raw) => {
          const counter = toFiniteNumber(raw)
          if (counter === null) {
            return Effect.fail(
              new KvError({ reason: "channelWriteTombstone: bad Lua return" })
            )
          }
          return Effect.succeed({ counter })
        })
      )
  }

  const channelPullBatch: KvBackendApi["channelPullBatch"] = (args) =>
    redis
      .eval(
        KvBackend.CHANNEL_PULL_BATCH_LUA,
        [args.counterKey, args.channel],
        [args.sinceScore, args.limit, prefixWithColon]
      )
      .pipe(
        Effect.mapError(wrapRedisErr),
        Effect.map(decodePullBatchResult)
      )

  return {
    bodyGet,
    bodyDel,
    bodyMget,
    counterRead,
    channelWriteUpdate,
    channelWriteTombstone,
    channelPullBatch,
  }
}
