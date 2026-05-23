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
 *
 * `entryGen` is the bucket the entry was written under (per Story 7d):
 *   - `0`  — mirror entry written by a puller's apply path
 *   - `>0` — originating entry written by PRS, stamped with the writer's
 *           incarnation gen
 * `score` is the per-bucket counter (monotonic within the bucket).
 * `body_ttl_remaining_sec` is computed at pull time as `(expiresAtMs -
 *   nowMs) / 1000` (memory) or `PTTL` (Redis) so receivers can stamp
 *   their local copies with the source's intended remaining lifetime,
 *   not a fresh full TTL. `0` for already-expired bodies (treated as
 *   implicit DEL upstream).
 */
export interface PulledEntry {
  readonly member: string
  readonly entryGen: number
  readonly score: number
  /**
   * Raw body bytes, or `null` when the body slot has TTL'd / been DEL'd
   * between the channel write and the pull. msgpackr-encoded after the
   * codec migration (see `src/call/CallCodec.ts`); callers decode via
   * `decodeBodyAuto` for rolling-upgrade-safe parsing.
   */
  readonly body: Buffer | null
  readonly body_ttl_remaining_sec: number
  /**
   * Per-call content version read from the `${bodyKey}:gen` sidecar at
   * pull time. `null` when the sidecar key is missing (pre-sidecar
   * entries; sidecar TTL'd before pull). Callers fall back to body
   * decode or `0` when null.
   */
  readonly callGen: number | null
}

export interface ChannelPullResult {
  readonly entries: ReadonlyArray<PulledEntry>
  /**
   * Head tuple — the highest `(entryGen, counter)` across all buckets
   * of the channel at snapshot time. Used by the puller for the
   * caught-up signal in noop frames.
   */
  readonly head: { readonly gen: number; readonly counter: number }
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
  /**
   * The bucket this write goes into. PRS originating writes pass the
   * worker's incarnation gen; the puller's apply path passes `0`
   * (mirror sentinel — see Story 7d in
   * docs/plan/grill-me-on-the-spicy-lark.md). Storage internally
   * derives bucket-scoped channel + counter keys by appending
   * `:gen:{entryGen}` so multiple gens coexist on one channel.
   */
  readonly entryGen: number
  readonly member: string
  readonly bodyKey: string
  /** msgpack-encoded body bytes — passed opaquely to Redis (SETEX accepts binary). */
  readonly bodyValue: Buffer
  readonly bodyTtlSec: number
  /**
   * Per-call content version (`_topology.gen` at flush time). Written
   * atomically to the `${bodyKey}:gen` sidecar key alongside the body
   * so the peer's apply path can read it without decoding the body.
   * Dead-weight today (commit 4 wires the read side).
   */
  readonly callGen: number
  readonly indexes: ReadonlyArray<IndexWrite>
}

export interface ChannelWriteTombstoneArgs {
  readonly channel: string
  readonly counterKey: string
  /** Same semantics as `ChannelWriteUpdateArgs.entryGen`. */
  readonly entryGen: number
  readonly member: string
  readonly bodyKey: string
  readonly indexesToRemove: ReadonlyArray<string>
}

export interface ChannelPullBatchArgs {
  readonly channel: string
  readonly counterKey: string
  /**
   * Lex-ordered watermark. Storage walks per-`(channel, entryGen)`
   * buckets in ascending lex order; for the bucket where
   * `entryGen === since.gen` returns members with `score > since.counter`;
   * for buckets with `entryGen > since.gen` returns all members in
   * counter order; buckets with `entryGen < since.gen` are skipped.
   *
   * Cold pull = `{ gen: 0, counter: 0 }` returns everything (all
   * buckets, all members). Warm pull naturally skips mirror entries
   * because `(0, *) < (≥1, *)` lexicographically.
   */
  readonly since: { readonly gen: number; readonly counter: number }
  readonly limit: number
}

export interface KvBackendApi {
  // ---- Body store --------------------------------------------------------

  readonly bodyGet: (key: string) => Effect.Effect<Buffer | null, KvError>
  /**
   * Direct body write WITHOUT bumping any propagate channel. Used by
   * the puller's apply path: a frame that arrived via replication
   * already advanced its source channel; re-bumping the local
   * channel would create an infinite ping-pong as soon as both peers
   * run pullers concurrently. The `bodySet` primitive lets the
   * puller write locally without provoking re-propagation.
   *
   * Original-write paths (SIP-driven `PartitionedRelayStorage.putCall`)
   * MUST NOT use this — they need the channel side effect via
   * `channelWriteUpdate` to be visible to peers.
   */
  readonly bodySet: (
    key: string,
    value: Buffer,
    ttlSec: number
  ) => Effect.Effect<void, KvError>
  readonly bodyDel: (key: string) => Effect.Effect<void, KvError>
  readonly bodyMget: (
    keys: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<Buffer | null>, KvError>

  /**
   * Atomic local apply for the replication puller — SET body + SET
   * each index in a SINGLE exclusive section. The hot path on the
   * peer side (`resolveFromSipKey` → `storage.getIndex`) needs body
   * and indexes to either both exist or neither exist. Two separate
   * `bodySet` calls cycle the per-store mutex twice, opening a window
   * where a SIP fiber observes a body present but indexes absent
   * (or vice-versa) and 481s an in-flight call.
   *
   * Does NOT touch any propagate channel — that is the whole point of
   * `EchoApply` being one-way local. The originator's own write paths
   * (PRS.putCall with a peer) use `channelWriteUpdate`, which does
   * the same SET-body + SET-indexes atomically AND bumps the
   * originator's outgoing channel.
   */
  readonly applyReplicaUpdate: (args: {
    readonly bodyKey: string
    readonly bodyValue: Buffer
    readonly bodyTtlSec: number
    /** Per-call content version — see ChannelWriteUpdateArgs.callGen. */
    readonly callGen: number
    readonly indexes: ReadonlyArray<IndexWrite>
  }) => Effect.Effect<void, KvError>

  /**
   * Atomic local delete for the replication puller — DEL body + DEL
   * each named index in a SINGLE exclusive section. Same atomicity
   * concern as `applyReplicaUpdate`: a half-deleted state (body gone,
   * indexes lingering) would make `resolveFromSipKey` return a stale
   * callRef pointing at a missing body, exactly the failure shape the
   * tombstone redesign was meant to close.
   */
  readonly applyReplicaDelete: (args: {
    readonly bodyKey: string
    readonly indexKeys: ReadonlyArray<string>
  }) => Effect.Effect<void, KvError>

  // ---- Counter -----------------------------------------------------------

  readonly counterRead: (key: string) => Effect.Effect<number, KvError>

  // ---- Atomic composite ops ---------------------------------------------

  /**
   * Atomic write: SET body with TTL, INCR bucket counter, ZADD member into
   * the bucket-scoped sorted set, SET each index with its TTL — all in one
   * transaction. Bucket = `(channel, entryGen)`; storage derives the per-
   * bucket sorted set and counter by appending `:gen:{entryGen}` to the
   * `channel` and `counterKey` arguments.
   *
   * Re-writing the same `member` within the same bucket updates its score
   * (sorted-set semantics). Re-writing the same `member` under a DIFFERENT
   * `entryGen` creates an independent entry in a different bucket — both
   * exist; pull walks them in lex order.
   *
   * Returns the assigned counter value (the new score within the bucket).
   */
  readonly channelWriteUpdate: (
    args: ChannelWriteUpdateArgs
  ) => Effect.Effect<{ readonly counter: number }, KvError>

  /**
   * Atomic tombstone: DEL the body key, INCR bucket counter, ZADD member
   * (with the "D:" prefix) into the bucket-scoped sorted set, DEL each
   * named secondary index — all in one transaction. Same bucket
   * semantics as `channelWriteUpdate`.
   *
   * The wire-level signal of "this call was deleted" is the "D:" member
   * in the channel sorted-set — NOT a tombstone-shaped body. Pullers
   * that fetch via `channelPullBatch` see `body: null` for any D-member
   * (the body was DEL'd here) and treat it as an implicit DELETE in
   * `EchoApply`. This matches the policy in
   * docs/plan/lets-plan-a-proper-crystalline-emerson.md: a body slot
   * holds either a real Call JSON or nothing — never a "deletion
   * marker" payload.
   */
  readonly channelWriteTombstone: (
    args: ChannelWriteTombstoneArgs
  ) => Effect.Effect<{ readonly counter: number }, KvError>

  /**
   * Atomic batched pull across all buckets of `channel`, lex-ordered by
   * `(entryGen, counter)`. Walks buckets in ascending entryGen order;
   * within each bucket returns members with `score > since.counter` (when
   * `entryGen === since.gen`) or all members (when `entryGen > since.gen`).
   * Skips buckets with `entryGen < since.gen`. Stops accumulating at
   * `limit`. Each returned entry carries its bucket's `entryGen` and its
   * body's remaining TTL (`(expiresAtMs - nowMs) / 1000` for memory,
   * `PTTL` for Redis).
   *
   * `head` is the highest `(entryGen, counter)` across all buckets at
   * snapshot time. The puller uses this in noop frames as the
   * caught-up-to-head signal.
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
   * Per-call `:gen` sidecar key — holds a 4-byte BE callGen alongside
   * the body so the peer apply path can read callGen without decoding
   * the body. Written atomically with the body, DEL'd alongside it.
   */
  static readonly bodyGenSidecarKey = (bodyKey: string): string =>
    `${bodyKey}:gen`

  /** Encode a callGen as the 4-byte BE Buffer stored in the sidecar. */
  static readonly encodeCallGenSidecar = (callGen: number): Buffer => {
    const b = Buffer.allocUnsafe(4)
    // callGen is `_topology.gen`, a small integer that increments per
    // flush. Mod 2^32 covers ~136 years at 1 flush/sec; safe.
    b.writeUInt32BE(callGen >>> 0, 0)
    return b
  }

  /**
   * Decode a 4-byte BE Buffer from the sidecar. Returns `null` for
   * wrong-length / missing input — callers gate on null.
   */
  static readonly decodeCallGenSidecar = (
    buf: Buffer | null,
  ): number | null => {
    if (buf === null || buf.length !== 4) return null
    return buf.readUInt32BE(0)
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
   * Atomic write of (counter+1, body, callGen-sidecar, indexes, ZADD member).
   * Per Story 7d the channel is partitioned into per-`entryGen` buckets;
   * this Lua derives the bucket-scoped sorted-set key and counter key
   * from the base names by appending `:gen:{entryGen}`. The
   * bucket-membership marker (`gens:{channel}` SADD) makes the pull
   * script's bucket enumeration cheap.
   *
   * KEYS = [counterKeyBase, channelBase, bucketsSetKey, bodyKey, idx1, idx2, ...]
   * ARGV = [entryGen, member, bodyValue, bodyTtlSec, callGenSidecar,
   *         idxCount, idxValue1, idxTtl1, idxValue2, idxTtl2, ...]
   * Returns: counter (integer) — within the entryGen bucket
   */
  static readonly CHANNEL_WRITE_UPDATE_LUA = `
local entryGen = tonumber(ARGV[1])
local bucketCounterKey = KEYS[1] .. ":gen:" .. entryGen
local bucketChannelKey = KEYS[2] .. ":gen:" .. entryGen
local counter = redis.call("INCR", bucketCounterKey)
redis.call("SADD", KEYS[3], entryGen)
local bodyTtl = tonumber(ARGV[4])
redis.call("SETEX", KEYS[4], bodyTtl, ARGV[3])
redis.call("SETEX", KEYS[4] .. ":gen", bodyTtl, ARGV[5])
local idxCount = tonumber(ARGV[6])
for i = 1, idxCount do
  local key = KEYS[4 + i]
  local val = ARGV[6 + (i - 1) * 2 + 1]
  local ttl = tonumber(ARGV[6 + (i - 1) * 2 + 2])
  redis.call("SETEX", key, ttl, val)
end
redis.call("ZADD", bucketChannelKey, counter, ARGV[2])
return counter
`

  /**
   * Atomic tombstone write (counter+1, hard-DEL body, remove indexes,
   * ZADD D-member). Same per-bucket derivation as
   * CHANNEL_WRITE_UPDATE_LUA.
   *
   * KEYS = [counterKeyBase, channelBase, bucketsSetKey, bodyKey, idxToRemove1, idxToRemove2, ...]
   * ARGV = [entryGen, member, idxRemoveCount]
   * Returns: counter (integer) — within the entryGen bucket
   */
  /**
   * Atomic local apply for the replication puller — SETEX body +
   * SETEX callGen-sidecar + SETEX each index, no channel side
   * effect. Matches the in-memory backend's `applyReplicaUpdate`
   * exclusive() block.
   *
   * KEYS = [bodyKey, idx1, idx2, ...]
   * ARGV = [bodyValue, bodyTtlSec, callGenSidecar,
   *         idxCount, idxVal1, idxTtl1, idxVal2, idxTtl2, ...]
   * Returns: nothing meaningful.
   */
  static readonly APPLY_REPLICA_UPDATE_LUA = `
local bodyTtl = tonumber(ARGV[2])
redis.call("SETEX", KEYS[1], bodyTtl, ARGV[1])
redis.call("SETEX", KEYS[1] .. ":gen", bodyTtl, ARGV[3])
local idxCount = tonumber(ARGV[4])
for i = 1, idxCount do
  local k = KEYS[1 + i]
  local v = ARGV[4 + (i - 1) * 2 + 1]
  local t = tonumber(ARGV[4 + (i - 1) * 2 + 2])
  redis.call("SETEX", k, t, v)
end
return 1
`

  /**
   * Atomic local delete for the replication puller — DEL body + DEL
   * sidecar + DEL each named index. The sidecar key is derived from
   * the body key by appending ":gen".
   *
   * KEYS = [bodyKey, idx1, idx2, ...]
   * ARGV = []
   */
  static readonly APPLY_REPLICA_DELETE_LUA = `
redis.call("DEL", KEYS[1])
redis.call("DEL", KEYS[1] .. ":gen")
for i = 2, #KEYS do
  redis.call("DEL", KEYS[i])
end
return 1
`

  static readonly CHANNEL_WRITE_TOMBSTONE_LUA = `
local entryGen = tonumber(ARGV[1])
local bucketCounterKey = KEYS[1] .. ":gen:" .. entryGen
local bucketChannelKey = KEYS[2] .. ":gen:" .. entryGen
local counter = redis.call("INCR", bucketCounterKey)
redis.call("SADD", KEYS[3], entryGen)
redis.call("DEL", KEYS[4])
redis.call("DEL", KEYS[4] .. ":gen")
local removeCount = tonumber(ARGV[3])
for i = 1, removeCount do
  redis.call("DEL", KEYS[4 + i])
end
redis.call("ZADD", bucketChannelKey, counter, ARGV[2])
return counter
`

  /**
   * Atomic batched pull across all buckets of a channel, lex-ordered
   * by `(entryGen, counter)`. Walks per-bucket sorted sets in
   * ascending entryGen order. For each entry returns
   * `[entryGen, counter, member, body, bodyTtlMs, callGenSidecar]`
   * so the wire layer can stamp per-entry gen + callGen and the
   * receiver can preserve the body's remaining TTL.
   *
   * KEYS = [counterKeyBase, channelBase, bucketsSetKey]
   * ARGV = [sinceGen, sinceCounter, limit, prefixWithColon]
   *   - prefixWithColon: the RedisClient's per-pod key prefix WITH the
   *     trailing colon (e.g. "sipas:") — needed to construct the
   *     prefixed bodyKey from the unprefixed bodyKey suffix encoded in
   *     each ZSET member.
   * Returns: [headGen, headCounter,
   *           entryGen1, counter1, member1, body1, bodyTtlMs1, callGenSidecar1,
   *           entryGen2, counter2, member2, body2, bodyTtlMs2, callGenSidecar2,
   *           ...]
   *   - body* may be `false` (Redis-nil) when the body has been DEL'd or
   *     TTL'd between write and pull. The caller maps false → null.
   *   - bodyTtlMs* is the body's PTTL (ms remaining) or 0 when missing
   *     / no-expire. The caller divides by 1000 and ceils to seconds.
   *   - callGenSidecar* is the 4-byte BE Buffer at `${bodyKey}:gen` or
   *     `false` when missing.
   */
  static readonly CHANNEL_PULL_BATCH_LUA = `
local sinceGen = tonumber(ARGV[1])
local sinceCounter = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local prefix = ARGV[4]

-- Enumerate buckets via the per-channel "gens" set, sort numerically.
local rawGens = redis.call("SMEMBERS", KEYS[3])
local gens = {}
for _, g in ipairs(rawGens) do
  table.insert(gens, tonumber(g))
end
table.sort(gens)

-- Compute head: highest (entryGen, maxCounterInBucket) lex across all
-- buckets. Read each bucket's counter via GET.
local headGen = 0
local headCounter = 0
for _, g in ipairs(gens) do
  local cnt = tonumber(redis.call("GET", KEYS[1] .. ":gen:" .. g) or "0")
  if cnt > 0 and (g > headGen or (g == headGen and cnt > headCounter)) then
    headGen = g
    headCounter = cnt
  end
end

local response = { headGen, headCounter }
local emitted = 0
for _, g in ipairs(gens) do
  if emitted >= limit then break end
  if g >= sinceGen then
    local minScore
    if g == sinceGen then
      minScore = "(" .. sinceCounter
    else
      minScore = "(0"
    end
    local remaining = limit - emitted
    local rangeResult = redis.call("ZRANGEBYSCORE", KEYS[2] .. ":gen:" .. g, minScore, "+inf", "WITHSCORES", "LIMIT", 0, remaining)
    local i = 1
    while i < #rangeResult do
      local member = rangeResult[i]
      local score = tonumber(rangeResult[i + 1])
      local bodyKeySuffix = string.sub(member, 3)
      local prefixedBodyKey = prefix .. bodyKeySuffix
      local body = redis.call("GET", prefixedBodyKey)
      local pttl = -2
      if body ~= false then
        pttl = redis.call("PTTL", prefixedBodyKey)
        if pttl < 0 then pttl = 0 end
      else
        pttl = 0
      end
      local callGenSidecar = redis.call("GET", prefixedBodyKey .. ":gen")
      table.insert(response, g)
      table.insert(response, score)
      table.insert(response, member)
      table.insert(response, body)
      table.insert(response, pttl)
      table.insert(response, callGenSidecar)
      emitted = emitted + 1
      i = i + 2
    end
  end
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
 * Shape of an in-memory entry. The `value` is `string | Buffer` because
 * the same store holds both string-valued slots (index entries, counter
 * keys serialised as `String(n)`) and binary-valued slots (msgpack-
 * encoded call bodies). Counter helpers always read/write strings;
 * body helpers always read/write Buffers. The union avoids splitting
 * the store into two maps with disjoint key spaces.
 */
export interface MemoryStoreEntry {
  readonly value: string | Buffer
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
 * In-memory channel representation. Per Story 7d, every channel is
 * partitioned into per-`entryGen` buckets so the `(gen, counter)`
 * lex-ordered cycle-break works (mirror entries land in bucket
 * gen=0; originating entries in bucket gen=self.incarnationGen). A
 * channel's data structure is thus `Map<entryGen, ChannelBucket>`
 * where each `ChannelBucket` is a native `Map<member, counter>`.
 *
 * Buckets are kept in a per-`KvBackend`-instance sidecar (NOT in
 * the `MemoryStore`). The original design encoded channels as JSON
 * strings inside the same `MemoryStore`; profiling showed this was
 * O(N) per write (`JSON.parse` + `JSON.stringify` of the whole
 * channel state on every `channelWriteUpdate`) and made the SIP
 * scenario suite GC-thrash on workers with thousands of calls. The
 * native-Map representation keeps every operation O(1) (write) or
 * O(N) without parse cost (pull). The `MemoryStore` carries bodies,
 * indexes, and per-bucket counters only. `PeerFabric.snapshotPeer`
 * and other store-iteration callers are unaffected because they
 * only iterate body/idx keys.
 *
 * Per-bucket counter keys are derived from the caller's
 * `counterKey` arg by appending `:gen:{entryGen}` (matching the
 * Redis-side derivation), so each bucket has an independent
 * monotonic sequence.
 */
type ChannelBucket = Map<string, number>
type ChannelBuckets = Map<number, ChannelBucket>

const emptyChannelBucket = (): ChannelBucket => new Map<string, number>()
const emptyChannelBuckets = (): ChannelBuckets => new Map<number, ChannelBucket>()

/** Storage key for a per-bucket counter. */
const bucketCounterKeyOf = (counterKey: string, entryGen: number): string =>
  `${counterKey}:gen:${entryGen}`

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
  value: string | Buffer,
  expiresAtMs: number
): void => {
  MutableHashMap.set(store, key, { value, expiresAtMs })
}

/** Coerce a stored entry's value to a Buffer for body-read paths. */
const asBuffer = (v: string | Buffer): Buffer =>
  Buffer.isBuffer(v) ? v : Buffer.from(v)

/** Coerce a stored entry's value to a string for index-/counter-read paths. */
const asString = (v: string | Buffer): string =>
  Buffer.isBuffer(v) ? v.toString("utf8") : v

const removeEntry = (store: MemoryStore, key: string): void => {
  MutableHashMap.remove(store, key)
}

const getOrCreateChannelBuckets = (
  channels: Map<string, ChannelBuckets>,
  channel: string
): ChannelBuckets => {
  const existing = channels.get(channel)
  if (existing !== undefined) return existing
  const fresh = emptyChannelBuckets()
  channels.set(channel, fresh)
  return fresh
}

const getOrCreateChannelBucket = (
  buckets: ChannelBuckets,
  entryGen: number
): ChannelBucket => {
  const existing = buckets.get(entryGen)
  if (existing !== undefined) return existing
  const fresh = emptyChannelBucket()
  buckets.set(entryGen, fresh)
  return fresh
}

/**
 * Compute the channel's head tuple — the highest `(entryGen, counter)`
 * across all buckets at snapshot time. Used as the caught-up signal in
 * `channelPullBatch`'s response (server emits this in noop frames).
 *
 * Returns `(0, 0)` for an empty channel. The lex compare on the
 * puller side handles "no progress" correctly (the puller's watermark
 * will already be `≥ (0, 0)`).
 *
 * This walks per-bucket counter STORE entries (not the in-memory
 * bucket map size) — counter-key reads survive bucket-empty races
 * and match the Redis side's `GET seq:{channel}:gen:{entryGen}`.
 */
const computeHead = (
  buckets: ChannelBuckets | undefined
): { gen: number; counter: number } => {
  if (buckets === undefined || buckets.size === 0) return { gen: 0, counter: 0 }
  let bestGen = 0
  let bestCounter = 0
  for (const entryGen of buckets.keys()) {
    const bucket = buckets.get(entryGen)
    if (bucket === undefined || bucket.size === 0) continue
    let maxInBucket = 0
    for (const score of bucket.values()) {
      if (score > maxInBucket) maxInBucket = score
    }
    if (maxInBucket === 0) continue
    if (entryGen > bestGen || (entryGen === bestGen && maxInBucket > bestCounter)) {
      bestGen = entryGen
      bestCounter = maxInBucket
    }
  }
  return { gen: bestGen, counter: bestCounter }
}

const incrCounter = (
  store: MemoryStore,
  key: string,
  nowMs: number
): number => {
  const live = liveEntry(store, key, nowMs)
  const next = live === null ? 1 : Number(asString(live.value)) + 1
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
  const n = Number(asString(live.value))
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

  // Per-`KvBackend`-instance channel sidecar — `Map<channelKey,
  // Map<entryGen, Map<member, counter>>>`. Per Story 7d each channel
  // is partitioned into per-`entryGen` buckets; pull walks them in
  // lex order. Channels live for the lifetime of this KvBackend
  // instance; sharing a `MemoryStore` across instances does NOT
  // share the channels (use-case: `PeerFabric.simulated`'s per-peer
  // makeMemoryApiFor — channels are correctly per-peer).
  const channels = new Map<string, ChannelBuckets>()

  const nowMs = Clock.currentTimeMillis

  const bodySet: KvBackendApi["bodySet"] = (key, value, ttlSec) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        yield* Effect.sync(() =>
          setEntry(store, key, value, ms + ttlSec * 1000)
        )
      })
    )

  const bodyGet: KvBackendApi["bodyGet"] = (key) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        const live = liveEntry(store, key, ms)
        return live === null ? null : asBuffer(live.value)
      })
    )

  const bodyDel: KvBackendApi["bodyDel"] = (key) =>
    exclusive(Effect.sync(() => removeEntry(store, key)))

  const bodyMget: KvBackendApi["bodyMget"] = (keys) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        const out: Array<Buffer | null> = []
        for (const k of keys) {
          const live = liveEntry(store, k, ms)
          out.push(live === null ? null : asBuffer(live.value))
        }
        return out
      })
    )

  const applyReplicaUpdate: KvBackendApi["applyReplicaUpdate"] = (args) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        const expiresAtMs = ms + args.bodyTtlSec * 1000
        yield* Effect.sync(() => {
          setEntry(store, args.bodyKey, args.bodyValue, expiresAtMs)
          setEntry(
            store,
            KvBackend.bodyGenSidecarKey(args.bodyKey),
            KvBackend.encodeCallGenSidecar(args.callGen),
            expiresAtMs,
          )
          for (const idx of args.indexes) {
            setEntry(store, idx.key, idx.value, ms + idx.ttlSec * 1000)
          }
        })
      })
    )

  const applyReplicaDelete: KvBackendApi["applyReplicaDelete"] = (args) =>
    exclusive(
      Effect.sync(() => {
        removeEntry(store, args.bodyKey)
        removeEntry(store, KvBackend.bodyGenSidecarKey(args.bodyKey))
        for (const idx of args.indexKeys) {
          removeEntry(store, idx)
        }
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
          // Per-bucket counter — independent monotonic per (channel,
          // entryGen). Mirror writes (entryGen=0) and originating
          // writes (entryGen=self.gen) advance independent sequences.
          const counter = incrCounter(
            store,
            bucketCounterKeyOf(args.counterKey, args.entryGen),
            ms
          )
          const bodyExpiresAtMs = ms + args.bodyTtlSec * 1000
          setEntry(store, args.bodyKey, args.bodyValue, bodyExpiresAtMs)
          setEntry(
            store,
            KvBackend.bodyGenSidecarKey(args.bodyKey),
            KvBackend.encodeCallGenSidecar(args.callGen),
            bodyExpiresAtMs,
          )
          for (const idx of args.indexes) {
            setEntry(store, idx.key, idx.value, ms + idx.ttlSec * 1000)
          }
          // Bucket write: O(1). Re-writing the same `member` within
          // the same bucket replaces its counter (sorted-set semantics
          // within the bucket). The same member may also exist in
          // other buckets independently — pull walks all of them.
          const buckets = getOrCreateChannelBuckets(channels, args.channel)
          const bucket = getOrCreateChannelBucket(buckets, args.entryGen)
          bucket.set(args.member, counter)
          return { counter }
        })
      })
    )

  const channelWriteTombstone: KvBackendApi["channelWriteTombstone"] = (args) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        return yield* Effect.sync(() => {
          const counter = incrCounter(
            store,
            bucketCounterKeyOf(args.counterKey, args.entryGen),
            ms
          )
          // Hard-DEL the body slot: a deleted call must not leave a
          // "deletion marker" payload behind. Pullers see the body as
          // null when fetching this entry's bodyKey via
          // `channelPullBatch`; that maps cleanly to "delete" in
          // `EchoApply` without any tombstone-aware decode.
          removeEntry(store, args.bodyKey)
          removeEntry(store, KvBackend.bodyGenSidecarKey(args.bodyKey))
          for (const idxKey of args.indexesToRemove) {
            removeEntry(store, idxKey)
          }
          const buckets = getOrCreateChannelBuckets(channels, args.channel)
          const bucket = getOrCreateChannelBucket(buckets, args.entryGen)
          bucket.set(args.member, counter)
          return { counter }
        })
      })
    )

  const channelPullBatch: KvBackendApi["channelPullBatch"] = (args) =>
    exclusive(
      Effect.gen(function* () {
        const ms = yield* nowMs
        const buckets = channels.get(args.channel)

        // Compute head as max (entryGen, counter) lex across buckets,
        // BEFORE filtering. This is what the puller's noop-frame uses
        // as caught-up signal; needs to advance even when the puller
        // skips all entries (e.g. warm puller against gen=0 mirror
        // writes).
        const head = computeHead(buckets)

        if (buckets === undefined || buckets.size === 0) {
          return { entries: [] as ReadonlyArray<PulledEntry>, head }
        }

        // Walk buckets in ascending lex order of entryGen. Per
        // bucket, return entries with `counter > since.counter`
        // when `entryGen === since.gen`, or all entries (counter > 0)
        // when `entryGen > since.gen`. Skip buckets with
        // `entryGen < since.gen`.
        const sortedGens = Array.from(buckets.keys()).sort((a, b) => a - b)
        const entries: Array<PulledEntry> = []
        for (const entryGen of sortedGens) {
          if (entryGen < args.since.gen) continue
          const minCounter = entryGen === args.since.gen ? args.since.counter : 0
          const bucket = buckets.get(entryGen)!
          const filtered: Array<{ member: string; score: number }> = []
          for (const [member, score] of bucket) {
            if (score > minCounter) filtered.push({ member, score })
          }
          filtered.sort((a, b) => a.score - b.score)
          for (const { member, score } of filtered) {
            if (entries.length >= args.limit) break
            const bodyKey = KvBackend.bodyKeyFromMember(member)
            if (bodyKey === null) {
              return yield* new KvError({
                reason: `channelPullBatch: malformed member "${member}" in channel ${args.channel}`,
              })
            }
            const live = liveEntry(store, bodyKey, ms)
            const body_ttl_remaining_sec =
              live === null
                ? 0
                : Math.max(0, Math.ceil((live.expiresAtMs - ms) / 1000))
            const sidecarEntry = liveEntry(
              store,
              KvBackend.bodyGenSidecarKey(bodyKey),
              ms,
            )
            const callGen =
              sidecarEntry !== null
                ? KvBackend.decodeCallGenSidecar(asBuffer(sidecarEntry.value))
                : null
            entries.push({
              member,
              entryGen,
              score,
              body: live === null ? null : asBuffer(live.value),
              body_ttl_remaining_sec,
              callGen,
            })
          }
          if (entries.length >= args.limit) break
        }

        return { entries, head }
      })
    )

  return {
    bodyGet,
    bodySet,
    bodyDel,
    bodyMget,
    applyReplicaUpdate,
    applyReplicaDelete,
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

/** Coerce a Lua-array cell (Buffer when read via evalBuffer) to string. */
const cellToString = (cell: unknown): string | null => {
  if (Buffer.isBuffer(cell)) return cell.toString("utf8")
  if (typeof cell === "string") return cell
  return null
}

/** Coerce a Lua-array cell to a finite number, handling Buffer/string/number. */
const cellToNumber = (cell: unknown): number | null => {
  if (typeof cell === "number" && Number.isFinite(cell)) return cell
  if (Buffer.isBuffer(cell)) {
    const n = Number(cell.toString("utf8"))
    return Number.isFinite(n) ? n : null
  }
  const n = Number(cell)
  return Number.isFinite(n) ? n : null
}

/**
 * Decode the
 * `[headGen, headCounter, entryGen1, counter1, member1, body1, bodyTtlMs1, ...]`
 * payload returned by CHANNEL_PULL_BATCH_LUA (via `evalBuffer`) into a
 * typed result. `evalBuffer` returns every string cell as a Buffer; the
 * coercion helpers above normalise non-body cells back to number/string,
 * leaving only the body slot as a Buffer (or `null` when the body has
 * TTL'd / been DEL'd between channel write and pull).
 */
const decodePullBatchResult = (raw: unknown): ChannelPullResult => {
  if (!Array.isArray(raw) || raw.length < 2) {
    return { entries: [], head: { gen: 0, counter: 0 } }
  }
  const head = {
    gen: cellToNumber(raw[0]) ?? 0,
    counter: cellToNumber(raw[1]) ?? 0,
  }
  const entries: Array<PulledEntry> = []
  let i = 2
  const stride = 6 // [entryGen, counter, member, body, bodyTtlMs, callGenSidecar]
  while (i + stride - 1 < raw.length) {
    const entryGen = cellToNumber(raw[i])
    const score = cellToNumber(raw[i + 1])
    const member = cellToString(raw[i + 2])
    const bodyCell = raw[i + 3]
    const bodyTtlMs = cellToNumber(raw[i + 4])
    const sidecarCell = raw[i + 5]
    if (entryGen === null || score === null || member === null) {
      // Malformed payload — should never happen with our Lua; fail loudly
      // rather than silently swallow.
      break
    }
    const body_ttl_remaining_sec = bodyTtlMs !== null && bodyTtlMs > 0
      ? Math.max(0, Math.ceil(bodyTtlMs / 1000))
      : 0
    // Lua nil bodies arrive as `null`/`undefined` via evalBuffer (Redis-nil →
    // JS null). Buffer body is the post-migration shape; we also accept a
    // string body as legacy compat in case the Lua script renders a non-
    // binary slot (defensive — should never happen in practice).
    const body: Buffer | null = Buffer.isBuffer(bodyCell)
      ? bodyCell
      : typeof bodyCell === "string"
        ? Buffer.from(bodyCell)
        : null
    const sidecarBuf: Buffer | null = Buffer.isBuffer(sidecarCell)
      ? sidecarCell
      : typeof sidecarCell === "string"
        ? Buffer.from(sidecarCell)
        : null
    const callGen = KvBackend.decodeCallGenSidecar(sidecarBuf)
    entries.push({
      member,
      entryGen,
      score,
      body,
      body_ttl_remaining_sec,
      callGen,
    })
    i += stride
  }
  return { entries, head }
}

/**
 * Per-channel "gens" set key — the membership marker our Lua scripts
 * SADD into on every write. Pull reads it via SMEMBERS to enumerate
 * buckets in lex order.
 */
const channelGensSetOf = (channel: string): string => `${channel}:gens`

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
    redis.getBuffer(key).pipe(Effect.mapError(wrapRedisErr))

  const bodySet: KvBackendApi["bodySet"] = (key, value, ttlSec) =>
    redis.setexBuffer(key, ttlSec, value).pipe(Effect.mapError(wrapRedisErr))

  const bodyDel: KvBackendApi["bodyDel"] = (key) =>
    redis.del(key).pipe(Effect.mapError(wrapRedisErr), Effect.asVoid)

  const bodyMget: KvBackendApi["bodyMget"] = (keys) =>
    Effect.gen(function* () {
      // ioredis MGET via pipeline: one GET per key. Slower than a real
      // MGET but it goes through the prefix-aware ops surface, and the
      // call sites for body MGET are short-lists (~10s in pull-batch's
      // null-body race fallback), so the perf delta is negligible.
      const out: Array<Buffer | null> = []
      for (const k of keys) {
        const v = yield* redis.getBuffer(k).pipe(Effect.mapError(wrapRedisErr))
        out.push(v)
      }
      return out
    })

  const applyReplicaUpdate: KvBackendApi["applyReplicaUpdate"] = (args) => {
    const keys: Array<string> = [args.bodyKey]
    for (const idx of args.indexes) keys.push(idx.key)
    const argv: Array<string | number | Buffer> = [
      args.bodyValue,
      args.bodyTtlSec,
      KvBackend.encodeCallGenSidecar(args.callGen),
      args.indexes.length,
    ]
    for (const idx of args.indexes) {
      argv.push(idx.value)
      argv.push(idx.ttlSec)
    }
    return redis
      .evalBuffer(KvBackend.APPLY_REPLICA_UPDATE_LUA, keys, argv)
      .pipe(Effect.mapError(wrapRedisErr), Effect.asVoid)
  }

  const applyReplicaDelete: KvBackendApi["applyReplicaDelete"] = (args) => {
    const keys: Array<string> = [args.bodyKey, ...args.indexKeys]
    return redis
      .eval(KvBackend.APPLY_REPLICA_DELETE_LUA, keys, [])
      .pipe(Effect.mapError(wrapRedisErr), Effect.asVoid)
  }

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
    const bucketsSetKey = channelGensSetOf(args.channel)
    const keys: Array<string> = [
      args.counterKey,
      args.channel,
      bucketsSetKey,
      args.bodyKey,
    ]
    for (const idx of args.indexes) keys.push(idx.key)
    const argv: Array<string | number | Buffer> = [
      args.entryGen,
      args.member,
      args.bodyValue,
      args.bodyTtlSec,
      KvBackend.encodeCallGenSidecar(args.callGen),
      args.indexes.length,
    ]
    for (const idx of args.indexes) {
      argv.push(idx.value, idx.ttlSec)
    }
    return redis
      .evalBuffer(KvBackend.CHANNEL_WRITE_UPDATE_LUA, keys, argv)
      .pipe(
        Effect.mapError(wrapRedisErr),
        Effect.flatMap((raw) => {
          const counter = cellToNumber(raw)
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
    const bucketsSetKey = channelGensSetOf(args.channel)
    const keys: Array<string> = [
      args.counterKey,
      args.channel,
      bucketsSetKey,
      args.bodyKey,
    ]
    for (const k of args.indexesToRemove) keys.push(k)
    const argv: Array<string | number> = [
      args.entryGen,
      args.member,
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
      .evalBuffer(
        KvBackend.CHANNEL_PULL_BATCH_LUA,
        [args.counterKey, args.channel, channelGensSetOf(args.channel)],
        [args.since.gen, args.since.counter, args.limit, prefixWithColon]
      )
      .pipe(
        Effect.mapError(wrapRedisErr),
        Effect.map(decodePullBatchResult)
      )

  return {
    bodyGet,
    bodySet,
    bodyDel,
    bodyMget,
    applyReplicaUpdate,
    applyReplicaDelete,
    counterRead,
    channelWriteUpdate,
    channelWriteTombstone,
    channelPullBatch,
  }
}
