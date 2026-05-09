/**
 * KvBackend port-parity test (T12).
 *
 * Runs the same operation sequence against the in-memory backend AND a
 * real Redis backend, and asserts they produce byte-identical observable
 * state at every checkpoint. This is the parity gate that closes the gap
 * which produced the K8s-only bug fixed in commit `d6a2b7b`.
 *
 * Modes:
 *   - Memory-only (default): runs the sequence against two independent
 *     in-memory backend instances; asserts internal determinism.
 *     Always runs in `npm run test`.
 *   - Memory + Redis (opt-in): set `KV_BACKEND=redis` to enable. Runs the
 *     sequence against both backends and asserts cross-backend parity.
 *     Skipped silently if Redis is unreachable, with a console.warn so
 *     CI surfaces the skip.
 *
 * The sequence intentionally avoids TTL-expiry assertions — TTL behavior
 * is real-time on Redis and impossible to control deterministically
 * without a hybrid clock pump (deferred to a later slice when we have a
 * real use case for parity-tested TTL behavior; the dedicated TTL
 * scenarios in the NS-suite cover memory-side TTL via TestClock).
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap, Scope } from "effect"
import {
  KvBackend,
  type KvBackendApi,
  type MemoryStoreEntry,
  type ChannelPullResult,
} from "../../src/storage/KvBackend.js"
import { makeRedisOps, type RedisOps } from "../../src/redis/RedisClient.js"

// ---------------------------------------------------------------------------
// Shared sequence DSL
// ---------------------------------------------------------------------------

const memberOf = KvBackend.memberOf
const bodyKey = (callRef: string): string => `pri:self:call:${callRef}`

interface OpRecord {
  readonly tag: "U" | "D" | "PULL"
  readonly callRef?: string
  readonly bodyValue?: string
  readonly indexes?: ReadonlyArray<{ key: string; value: string; ttlSec: number }>
  readonly indexesToRemove?: ReadonlyArray<string>
  readonly sinceGen?: number
  readonly sinceCounter?: number
  readonly limit?: number
  /**
   * Per-op override for the bucket the U/D lands in. Defaults to
   * `PARITY_GEN`. Multi-bucket sequences set this explicitly to
   * mix mirror writes (entryGen=0) with originating writes (entryGen
   * = worker incarnation gen) on the same channel.
   */
  readonly entryGen?: number
}

// All originating writes use a fixed bucket gen for parity. Per Story
// 7d the storage primitive partitions every channel by `entryGen`; the
// parity sequence stays inside a single bucket so memory and Redis
// pull lex orders are equivalent (single-bucket walk = counter-only
// order).
const PARITY_GEN = 7

/**
 * Deterministic sequence covering: writes (with and without indexes),
 * tombstones (with index removal), pulls at varying watermarks, re-writes
 * of existing members (sorted-set re-score semantics), and a tombstone of
 * a never-written callRef (graceful no-prior-state).
 */
const SEQUENCE: ReadonlyArray<OpRecord> = [
  { tag: "U", callRef: "alpha", bodyValue: '{"v":1}', indexes: [] },
  {
    tag: "U",
    callRef: "beta",
    bodyValue: '{"v":2}',
    indexes: [{ key: "idx:leg:CID-100", value: "beta", ttlSec: 60 }],
  },
  { tag: "PULL", sinceGen: 0, sinceCounter: 0, limit: 10 },
  { tag: "U", callRef: "alpha", bodyValue: '{"v":1.1}', indexes: [] },
  {
    tag: "U",
    callRef: "gamma",
    bodyValue: '{"v":3}',
    indexes: [
      { key: "idx:leg:CID-200", value: "gamma", ttlSec: 60 },
      { key: "idx:leg:CID-201", value: "gamma", ttlSec: 60 },
    ],
  },
  { tag: "PULL", sinceGen: PARITY_GEN, sinceCounter: 1, limit: 10 },
  { tag: "PULL", sinceGen: 0, sinceCounter: 0, limit: 2 },
  { tag: "D", callRef: "beta", indexesToRemove: ["idx:leg:CID-100"] },
  { tag: "PULL", sinceGen: 0, sinceCounter: 0, limit: 10 },
  { tag: "U", callRef: "delta", bodyValue: '{"v":4}', indexes: [] },
  { tag: "D", callRef: "never-written", indexesToRemove: [] },
  { tag: "PULL", sinceGen: 0, sinceCounter: 0, limit: 10 },
]

const CHANNEL = "propagate:self->peerA"
const COUNTER = "seq:self->peerA"

interface ApplyResult {
  readonly counters: ReadonlyArray<number>
  readonly pulls: ReadonlyArray<ChannelPullResult>
  readonly finalBodies: ReadonlyArray<{ key: string; body: string | null }>
}

const applySequence = (
  kv: KvBackendApi
): Effect.Effect<ApplyResult, never> =>
  Effect.gen(function* () {
    const counters: Array<number> = []
    const pulls: Array<ChannelPullResult> = []
    for (const op of SEQUENCE) {
      yield* runOp(kv, op, counters, pulls)
    }
    const touched = ["alpha", "beta", "gamma", "delta", "never-written"]
    const finalBodies: Array<{ key: string; body: string | null }> = []
    for (const ref of touched) {
      const body = yield* kv.bodyGet(bodyKey(ref)).pipe(Effect.orDie)
      finalBodies.push({ key: bodyKey(ref), body })
    }
    return { counters, pulls, finalBodies }
  })

/**
 * Run a single op against the backend, mirroring the structure of
 * `applySequence` but reusable across multiple sequences (single-bucket
 * vs multi-bucket vs cross-incarnation).
 */
const runOp = (
  kv: KvBackendApi,
  op: OpRecord,
  counters: Array<number>,
  pulls: Array<ChannelPullResult>
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const entryGen = op.entryGen ?? PARITY_GEN
    if (op.tag === "U") {
      const r = yield* kv
        .channelWriteUpdate({
          channel: CHANNEL,
          counterKey: COUNTER,
          entryGen,
          member: memberOf("U", bodyKey(op.callRef!)),
          bodyKey: bodyKey(op.callRef!),
          bodyValue: op.bodyValue!,
          bodyTtlSec: 60,
          indexes: op.indexes ?? [],
        })
        .pipe(Effect.orDie)
      counters.push(r.counter)
    } else if (op.tag === "D") {
      const r = yield* kv
        .channelWriteTombstone({
          channel: CHANNEL,
          counterKey: COUNTER,
          entryGen,
          member: memberOf("D", bodyKey(op.callRef!)),
          bodyKey: bodyKey(op.callRef!),
          tombstoneValue: '{"tombstone":true}',
          tombstoneTtlSec: 180,
          indexesToRemove: op.indexesToRemove ?? [],
        })
        .pipe(Effect.orDie)
      counters.push(r.counter)
    } else {
      const r = yield* kv
        .channelPullBatch({
          channel: CHANNEL,
          counterKey: COUNTER,
          since: { gen: op.sinceGen ?? 0, counter: op.sinceCounter ?? 0 },
          limit: op.limit!,
        })
        .pipe(Effect.orDie)
      pulls.push(r)
    }
  })

// ---------------------------------------------------------------------------
// Multi-bucket sequence — exercises the Story 7d cycle-break primitives
// ---------------------------------------------------------------------------

/**
 * Mirror writes (entryGen=0) interleaved with originating writes
 * (entryGen=PARITY_GEN), pulled at varying lex watermarks. Asserts the
 * Lua's per-channel "gens" SADD + numeric sort + per-bucket
 * ZRANGEBYSCORE walk produces identical output to the memory backend's
 * native-Map + numeric-sort path.
 *
 * Critical invariants this exercises (none touched by SEQUENCE above):
 *   - Cold pull (gen=0, counter=0) returns gen=0 entries before
 *     gen=PARITY_GEN entries, lex order.
 *   - Warm pull (gen=PARITY_GEN, counter=N) skips gen=0 entries
 *     entirely.
 *   - Same callRef in both buckets coexists as two independent entries
 *     (mirror at gen=0 + originating at gen=PARITY_GEN); ZADD member
 *     re-write semantics apply within each bucket but NOT across.
 *   - head tuple computed across all buckets.
 *   - per-entry entryGen propagated correctly through PulledEntry.
 */
const MIRROR_GEN = 0
const MULTI_BUCKET_SEQUENCE: ReadonlyArray<OpRecord> = [
  // Mirror write to bucket gen=0.
  { tag: "U", callRef: "alpha", bodyValue: '{"v":1,"src":"mirror"}', entryGen: MIRROR_GEN },
  // Cold pull: returns the mirror entry. head=(0, 1).
  { tag: "PULL", sinceGen: 0, sinceCounter: 0, limit: 10 },
  // Originating write to bucket gen=PARITY_GEN.
  { tag: "U", callRef: "beta", bodyValue: '{"v":2,"src":"orig"}' },
  // Cold pull: returns BOTH (gen=0 first, then gen=PARITY_GEN).
  { tag: "PULL", sinceGen: 0, sinceCounter: 0, limit: 10 },
  // Warm pull from gen=PARITY_GEN bucket: skips the mirror.
  { tag: "PULL", sinceGen: PARITY_GEN, sinceCounter: 0, limit: 10 },
  // Same callRef in BOTH buckets — distinct entries.
  { tag: "U", callRef: "alpha", bodyValue: '{"v":1,"src":"orig"}' }, // gen=PARITY_GEN
  // Cold pull returns alpha-mirror + beta-orig + alpha-orig (3 entries).
  { tag: "PULL", sinceGen: 0, sinceCounter: 0, limit: 10 },
  // Mirror tombstone in gen=0 bucket.
  { tag: "D", callRef: "alpha", entryGen: MIRROR_GEN, indexesToRemove: [] },
  // Re-write the mirror member (same callRef) — score bumps within gen=0 bucket.
  { tag: "U", callRef: "alpha", bodyValue: '{"v":3,"src":"mirror2"}', entryGen: MIRROR_GEN },
  // Final cold pull with limit=2: tests across-bucket cursor.
  { tag: "PULL", sinceGen: 0, sinceCounter: 0, limit: 2 },
  // Final cold pull, full: head should be the max lex tuple across both buckets.
  { tag: "PULL", sinceGen: 0, sinceCounter: 0, limit: 100 },
]

const applyMultiBucketSequence = (
  kv: KvBackendApi
): Effect.Effect<ApplyResult, never> =>
  Effect.gen(function* () {
    const counters: Array<number> = []
    const pulls: Array<ChannelPullResult> = []
    for (const op of MULTI_BUCKET_SEQUENCE) {
      yield* runOp(kv, op, counters, pulls)
    }
    const touched = ["alpha", "beta"]
    const finalBodies: Array<{ key: string; body: string | null }> = []
    for (const ref of touched) {
      const body = yield* kv.bodyGet(bodyKey(ref)).pipe(Effect.orDie)
      finalBodies.push({ key: bodyKey(ref), body })
    }
    return { counters, pulls, finalBodies }
  })

// ---------------------------------------------------------------------------
// Cross-incarnation sequence — exercises bucket persistence across gens
// ---------------------------------------------------------------------------

/**
 * Simulates a sidecar surviving a process restart: the worker's
 * incarnation gen changes from GEN1 to GEN2; old-incarnation buckets
 * persist in storage and the puller's lex-walk steps through them in
 * gen-ascending order. This is the "old incarnation's bucket persists
 * if the sidecar survives" case called out in
 * docs/replication/architecture.md §"Storage layout".
 */
const GEN1 = 5
const GEN2 = 8
const CROSS_INCARNATION_SEQUENCE: ReadonlyArray<OpRecord> = [
  // Old incarnation writes one entry.
  { tag: "U", callRef: "old", bodyValue: '{"v":"old"}', entryGen: GEN1 },
  // New incarnation begins; some originating writes.
  { tag: "U", callRef: "new1", bodyValue: '{"v":"n1"}', entryGen: GEN2 },
  { tag: "U", callRef: "new2", bodyValue: '{"v":"n2"}', entryGen: GEN2 },
  // Cold pull walks both buckets in gen order: GEN1 first, then GEN2.
  { tag: "PULL", sinceGen: 0, sinceCounter: 0, limit: 10 },
  // A puller mid-incarnation (since=GEN1, counter=1): returns NOTHING from GEN1
  // (counter > 1 has no entries) but ALL of GEN2 (gen > sinceGen).
  { tag: "PULL", sinceGen: GEN1, sinceCounter: 1, limit: 10 },
  // A puller already past GEN2's first counter: returns only counter > 1 from GEN2.
  { tag: "PULL", sinceGen: GEN2, sinceCounter: 1, limit: 10 },
]

const applyCrossIncarnationSequence = (
  kv: KvBackendApi
): Effect.Effect<ApplyResult, never> =>
  Effect.gen(function* () {
    const counters: Array<number> = []
    const pulls: Array<ChannelPullResult> = []
    for (const op of CROSS_INCARNATION_SEQUENCE) {
      yield* runOp(kv, op, counters, pulls)
    }
    return { counters, pulls, finalBodies: [] }
  })

const expectParity = (a: ApplyResult, b: ApplyResult): void => {
  expect(a.counters).toEqual(b.counters)
  expect(a.pulls.length).toBe(b.pulls.length)
  for (let i = 0; i < a.pulls.length; i++) {
    expect(a.pulls[i]?.head).toEqual(b.pulls[i]?.head)
    expect(a.pulls[i]?.entries).toEqual(b.pulls[i]?.entries)
  }
  expect(a.finalBodies).toEqual(b.finalBodies)
}

// ---------------------------------------------------------------------------
// Memory-vs-memory parity (always runs)
// ---------------------------------------------------------------------------

describe("KvBackend port-parity — memory determinism", () => {
  it.effect("two independent in-memory instances produce identical observable state (single-bucket sequence)", () =>
    Effect.gen(function* () {
      const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
      const storeB = MutableHashMap.empty<string, MemoryStoreEntry>()
      const a = KvBackend.makeMemoryUnsafe(storeA)
      const b = KvBackend.makeMemoryUnsafe(storeB)
      const ra = yield* applySequence(a)
      const rb = yield* applySequence(b)
      expectParity(ra, rb)
    })
  )

  it.effect("two independent in-memory instances produce identical observable state (multi-bucket Story 7d sequence)", () =>
    Effect.gen(function* () {
      const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
      const storeB = MutableHashMap.empty<string, MemoryStoreEntry>()
      const a = KvBackend.makeMemoryUnsafe(storeA)
      const b = KvBackend.makeMemoryUnsafe(storeB)
      const ra = yield* applyMultiBucketSequence(a)
      const rb = yield* applyMultiBucketSequence(b)
      expectParity(ra, rb)
    })
  )

  it.effect("two independent in-memory instances produce identical observable state (cross-incarnation sequence)", () =>
    Effect.gen(function* () {
      const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
      const storeB = MutableHashMap.empty<string, MemoryStoreEntry>()
      const a = KvBackend.makeMemoryUnsafe(storeA)
      const b = KvBackend.makeMemoryUnsafe(storeB)
      const ra = yield* applyCrossIncarnationSequence(a)
      const rb = yield* applyCrossIncarnationSequence(b)
      expectParity(ra, rb)
    })
  )
})

// ---------------------------------------------------------------------------
// Memory-vs-Redis parity (opt-in via KV_BACKEND=redis)
// ---------------------------------------------------------------------------

const REDIS_PARITY_ENABLED = process.env.KV_BACKEND === "redis"
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"

const PARITY_PREFIX = `kv-parity-${process.pid}-${Date.now()}`

const buildRedisBackend: Effect.Effect<
  { backend: KvBackendApi; teardown: Effect.Effect<void> },
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const ops: RedisOps = yield* makeRedisOps(REDIS_URL, PARITY_PREFIX, "parity-test")
  const prefixWithColon = `${PARITY_PREFIX}:`
  const backend = KvBackend.makeRedisUnsafe(ops, prefixWithColon)
  const teardown = Effect.tryPromise({
    try: async () => {
      const keys = await ops.raw.keys(`${PARITY_PREFIX}:*`)
      if (keys.length > 0) await ops.raw.del(...keys)
    },
    catch: (e) => new Error(`teardown failed: ${String(e)}`),
  }).pipe(Effect.orDie)
  return { backend, teardown }
})

describe.skipIf(!REDIS_PARITY_ENABLED)(
  "KvBackend port-parity — memory vs Redis",
  () => {
    it.live(
      "memory and Redis backends produce identical observable state for the single-bucket sequence",
      () =>
        Effect.gen(function* () {
          const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
          const memBackend = KvBackend.makeMemoryUnsafe(storeA)
          const { backend: redisBackend, teardown } = yield* buildRedisBackend
          const memResult = yield* applySequence(memBackend)
          const redisResult = yield* applySequence(redisBackend)
          try {
            expectParity(memResult, redisResult)
          } finally {
            yield* teardown
          }
        }).pipe(Effect.scoped)
    )

    it.live(
      "memory and Redis backends produce identical observable state for the multi-bucket Story 7d sequence",
      () =>
        Effect.gen(function* () {
          const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
          const memBackend = KvBackend.makeMemoryUnsafe(storeA)
          const { backend: redisBackend, teardown } = yield* buildRedisBackend
          const memResult = yield* applyMultiBucketSequence(memBackend)
          const redisResult = yield* applyMultiBucketSequence(redisBackend)
          try {
            expectParity(memResult, redisResult)
          } finally {
            yield* teardown
          }
        }).pipe(Effect.scoped)
    )

    it.live(
      "memory and Redis backends produce identical observable state for the cross-incarnation sequence",
      () =>
        Effect.gen(function* () {
          const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
          const memBackend = KvBackend.makeMemoryUnsafe(storeA)
          const { backend: redisBackend, teardown } = yield* buildRedisBackend
          const memResult = yield* applyCrossIncarnationSequence(memBackend)
          const redisResult = yield* applyCrossIncarnationSequence(redisBackend)
          try {
            expectParity(memResult, redisResult)
          } finally {
            yield* teardown
          }
        }).pipe(Effect.scoped)
    )
  }
)
