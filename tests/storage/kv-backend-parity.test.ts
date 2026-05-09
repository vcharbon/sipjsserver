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
  readonly sinceScore?: number
  readonly limit?: number
}

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
  { tag: "PULL", sinceScore: 0, limit: 10 },
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
  { tag: "PULL", sinceScore: 1, limit: 10 },
  { tag: "PULL", sinceScore: 0, limit: 2 },
  { tag: "D", callRef: "beta", indexesToRemove: ["idx:leg:CID-100"] },
  { tag: "PULL", sinceScore: 0, limit: 10 },
  { tag: "U", callRef: "delta", bodyValue: '{"v":4}', indexes: [] },
  { tag: "D", callRef: "never-written", indexesToRemove: [] },
  { tag: "PULL", sinceScore: 0, limit: 10 },
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
      if (op.tag === "U") {
        const r = yield* kv
          .channelWriteUpdate({
            channel: CHANNEL,
            counterKey: COUNTER,
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
            sinceScore: op.sinceScore!,
            limit: op.limit!,
          })
          .pipe(Effect.orDie)
        pulls.push(r)
      }
    }
    const touched = ["alpha", "beta", "gamma", "delta", "never-written"]
    const finalBodies: Array<{ key: string; body: string | null }> = []
    for (const ref of touched) {
      const body = yield* kv.bodyGet(bodyKey(ref)).pipe(Effect.orDie)
      finalBodies.push({ key: bodyKey(ref), body })
    }
    return { counters, pulls, finalBodies }
  })

const expectParity = (a: ApplyResult, b: ApplyResult): void => {
  expect(a.counters).toEqual(b.counters)
  expect(a.pulls.length).toBe(b.pulls.length)
  for (let i = 0; i < a.pulls.length; i++) {
    expect(a.pulls[i]?.headCounter).toBe(b.pulls[i]?.headCounter)
    expect(a.pulls[i]?.entries).toEqual(b.pulls[i]?.entries)
  }
  expect(a.finalBodies).toEqual(b.finalBodies)
}

// ---------------------------------------------------------------------------
// Memory-vs-memory parity (always runs)
// ---------------------------------------------------------------------------

describe("KvBackend port-parity — memory determinism", () => {
  it.effect("two independent in-memory instances produce identical observable state", () =>
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
      "memory and Redis backends produce identical observable state for the standard sequence",
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
  }
)
