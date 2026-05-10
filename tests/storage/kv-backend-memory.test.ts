/**
 * KvBackend (memory backend) — Slice 1 contract tests, updated for
 * Story 7d's per-`(channel, entryGen)` bucket layout.
 *
 * Asserts the storage primitive port behaves as the architecture
 * requires:
 *   - body get / del / mget round-trip and respect TTL.
 *   - channelWriteUpdate is atomic (per-bucket counter monotonic;
 *     body+indexes+ZADD together; member re-write within the SAME
 *     bucket updates score).
 *   - channelWriteTombstone follows the same atomicity contract and
 *     correctly removes named secondary indexes.
 *   - channelPullBatch lex-orders across buckets by `(entryGen,
 *     counter)`, returns entries with strict `(gen, counter) > since`,
 *     capped at limit, with body resolved via the "U:" / "D:" prefix
 *     convention (or null for missing/TTL'd bodies). Each entry
 *     carries its bucket's `entryGen` and the body's
 *     `body_ttl_remaining_sec`.
 *   - per-bucket counters never expire.
 *   - concurrent writers see monotonic counter assignment within a
 *     bucket.
 *
 * These tests are the first parity gate: every assertion here must
 * hold identically against the Redis backend (Slice 2's `port-parity`
 * suite).
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap } from "effect"
import { TestClock } from "effect/testing"
import {
  KvBackend,
  type KvBackendApi,
  type MemoryStore,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

const setup = (): {
  readonly store: MemoryStore
  readonly kv: KvBackendApi
} => {
  const store = MutableHashMap.empty<string, MemoryStoreEntry>()
  const kv = KvBackend.makeMemoryUnsafe(store)
  return { store, kv }
}

const CHANNEL = "propagate:self->peerA"
const COUNTER = "seq:self->peerA"

// Default originating bucket gen used by these tests (simulates a
// worker's incarnation gen). Mirror writes (entryGen=0) are exercised
// in the dedicated bucket-walk test below.
const GEN = 1
// Storage-level bucket counter key — derived in the same way the
// production primitive derives it (`${counterKey}:gen:${entryGen}`).
const BUCKET_COUNTER = `${COUNTER}:gen:${GEN}`
const SINCE_COLD = { gen: 0, counter: 0 } as const
const sinceWarm = (counter: number) => ({ gen: GEN, counter }) as const

const memberOf = KvBackend.memberOf

const bodyKey = (callRef: string): string => `pri:self:call:${callRef}`

describe("KvBackend.memory — body store", () => {
  it.effect("bodyGet returns null for missing key", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      const v = yield* kv.bodyGet("missing")
      expect(v).toBeNull()
    })
  )

  it.effect("channelWriteUpdate then bodyGet returns the body", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: '{"x":1}',
        bodyTtlSec: 60,
        indexes: [],
      })
      const v = yield* kv.bodyGet(bodyKey("a"))
      expect(v).toBe('{"x":1}')
    })
  )

  it.effect("bodyDel removes a previously-written body", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* kv.bodyDel(bodyKey("a"))
      const v = yield* kv.bodyGet(bodyKey("a"))
      expect(v).toBeNull()
    })
  )

  it.effect("bodyMget preserves order and returns null for missing keys", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "A",
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("c")),
        bodyKey: bodyKey("c"),
        bodyValue: "C",
        bodyTtlSec: 60,
        indexes: [],
      })
      const v = yield* kv.bodyMget([bodyKey("a"), bodyKey("b"), bodyKey("c")])
      expect(v).toEqual(["A", null, "C"])
    })
  )

  it.effect("body TTL: bodyGet returns null after expiry", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "x",
        bodyTtlSec: 30,
        indexes: [],
      })
      yield* TestClock.adjust("31 seconds")
      const v = yield* kv.bodyGet(bodyKey("a"))
      expect(v).toBeNull()
    })
  )
})

describe("KvBackend.memory — counter (per-bucket)", () => {
  it.effect("counterRead returns 0 for an unseen bucket counter key", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      const n = yield* kv.counterRead(BUCKET_COUNTER)
      expect(n).toBe(0)
    })
  )

  it.effect("bucket counter increments monotonically across writes in same bucket", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      const r1 = yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      const r2 = yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("b")),
        bodyKey: bodyKey("b"),
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      const r3 = yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("c")),
        bodyKey: bodyKey("c"),
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      expect([r1.counter, r2.counter, r3.counter]).toEqual([1, 2, 3])
      const head = yield* kv.counterRead(BUCKET_COUNTER)
      expect(head).toBe(3)
    })
  )

  it.effect("counter survives long simulated wall time without TTL", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      // Advance well past every reasonable TTL window.
      yield* TestClock.adjust("2 hours")
      const head = yield* kv.counterRead(BUCKET_COUNTER)
      expect(head).toBe(1)
    })
  )

  it.effect("per-bucket counters are independent (gen=0 mirror vs gen=GEN originating)", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      // Originating write: entryGen=GEN, counter=1 in that bucket.
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("o1")),
        bodyKey: bodyKey("o1"),
        bodyValue: "O",
        bodyTtlSec: 60,
        indexes: [],
      })
      // Mirror write: entryGen=0, counter=1 in ITS bucket — independent.
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: 0,
        member: memberOf("U", "bak:peerA:call:m1"),
        bodyKey: "bak:peerA:call:m1",
        bodyValue: "M",
        bodyTtlSec: 60,
        indexes: [],
      })
      expect(yield* kv.counterRead(BUCKET_COUNTER)).toBe(1)
      expect(yield* kv.counterRead(`${COUNTER}:gen:0`)).toBe(1)
    })
  )
})

describe("KvBackend.memory — channelWriteUpdate", () => {
  it.effect("writes body, counter, indexes, and member atomically", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      const result = yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "BODY",
        bodyTtlSec: 60,
        indexes: [
          { key: "idx:leg:CID-1", value: "a", ttlSec: 60 },
          { key: "idx:leg:CID-2", value: "a", ttlSec: 60 },
        ],
      })
      expect(result.counter).toBe(1)
      expect(yield* kv.bodyGet(bodyKey("a"))).toBe("BODY")
      expect(yield* kv.bodyGet("idx:leg:CID-1")).toBe("a")
      expect(yield* kv.bodyGet("idx:leg:CID-2")).toBe("a")
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        since: SINCE_COLD,
        limit: 10,
      })
      expect(pulled.entries.length).toBe(1)
      expect(pulled.entries[0]?.member).toBe(memberOf("U", bodyKey("a")))
      expect(pulled.entries[0]?.entryGen).toBe(GEN)
      expect(pulled.entries[0]?.score).toBe(1)
      expect(pulled.entries[0]?.body_ttl_remaining_sec).toBe(60)
      expect(pulled.head).toEqual({ gen: GEN, counter: 1 })
    })
  )

  it.effect("re-writing the same member within a bucket bumps its score (sorted-set semantics)", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "v1",
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("b")),
        bodyKey: bodyKey("b"),
        bodyValue: "B",
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "v2",
        bodyTtlSec: 60,
        indexes: [],
      })
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        since: SINCE_COLD,
        limit: 10,
      })
      // Two distinct members ("a" and "b"). "a" has score 3 (the latest
      // re-write), "b" has score 2. Order must be ascending by score.
      expect(pulled.entries.length).toBe(2)
      expect(pulled.entries[0]?.member).toBe(memberOf("U", bodyKey("b")))
      expect(pulled.entries[0]?.score).toBe(2)
      expect(pulled.entries[1]?.member).toBe(memberOf("U", bodyKey("a")))
      expect(pulled.entries[1]?.score).toBe(3)
      expect(pulled.entries[1]?.body).toBe("v2")
      expect(pulled.head).toEqual({ gen: GEN, counter: 3 })
    })
  )
})

describe("KvBackend.memory — channelWriteTombstone", () => {
  it.effect("writes tombstone body, removes indexes, bumps counter, ZADDs D-member", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      // Pre-populate with a U: write that has indexes.
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "BODY",
        bodyTtlSec: 60,
        indexes: [
          { key: "idx:leg:CID-1", value: "a", ttlSec: 60 },
          { key: "idx:leg:CID-2", value: "a", ttlSec: 60 },
        ],
      })
      // Then tombstone it. Body slot is hard-DEL'd (no tombstone JSON
      // payload) per docs/plan/lets-plan-a-proper-crystalline-emerson.md.
      const result = yield* kv.channelWriteTombstone({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("D", bodyKey("a")),
        bodyKey: bodyKey("a"),
        indexesToRemove: ["idx:leg:CID-1", "idx:leg:CID-2"],
      })
      expect(result.counter).toBe(2)
      // Body slot is now empty.
      expect(yield* kv.bodyGet(bodyKey("a"))).toBeNull()
      // Secondary indexes are gone.
      expect(yield* kv.bodyGet("idx:leg:CID-1")).toBeNull()
      expect(yield* kv.bodyGet("idx:leg:CID-2")).toBeNull()
      // Pull sees BOTH the original U-member at score 1 AND the new D-member at score 2.
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        since: SINCE_COLD,
        limit: 10,
      })
      expect(pulled.entries.length).toBe(2)
      expect(pulled.entries[0]?.member).toBe(memberOf("U", bodyKey("a")))
      expect(pulled.entries[1]?.member).toBe(memberOf("D", bodyKey("a")))
      // The D-member's body is null (the slot was hard-DEL'd by the
      // tombstone Lua). The puller distinguishes apply behavior by the
      // member's "U:"/"D:" prefix.
      expect(pulled.entries[1]?.body).toBeNull()
    })
  )

  it.effect("tombstone hard-DELs the body so the puller sees body=null immediately", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteTombstone({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("D", bodyKey("a")),
        bodyKey: bodyKey("a"),
        indexesToRemove: [],
      })
      // No clock advance needed — the body slot is empty as soon as
      // the tombstone is written.
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        since: SINCE_COLD,
        limit: 10,
      })
      expect(pulled.entries.length).toBe(1)
      expect(pulled.entries[0]?.member).toBe(memberOf("D", bodyKey("a")))
      expect(pulled.entries[0]?.body).toBeNull()
      expect(pulled.entries[0]?.body_ttl_remaining_sec).toBe(0)
    })
  )
})

describe("KvBackend.memory — channelPullBatch", () => {
  it.effect("respects since.counter strictly within a bucket (>, not >=)", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      for (const ref of ["a", "b", "c"]) {
        yield* kv.channelWriteUpdate({
          channel: CHANNEL,
          counterKey: COUNTER,
          entryGen: GEN,
          member: memberOf("U", bodyKey(ref)),
          bodyKey: bodyKey(ref),
          bodyValue: ref,
          bodyTtlSec: 60,
          indexes: [],
        })
      }
      // Warm pull from the GEN bucket strictly > 1 → returns scores 2 and 3 only.
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        since: sinceWarm(1),
        limit: 10,
      })
      expect(pulled.entries.map((e) => e.score)).toEqual([2, 3])
    })
  )

  it.effect("respects limit and emits in lex `(entryGen, counter)` order", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      for (const ref of ["a", "b", "c", "d", "e"]) {
        yield* kv.channelWriteUpdate({
          channel: CHANNEL,
          counterKey: COUNTER,
          entryGen: GEN,
          member: memberOf("U", bodyKey(ref)),
          bodyKey: bodyKey(ref),
          bodyValue: ref,
          bodyTtlSec: 60,
          indexes: [],
        })
      }
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        since: SINCE_COLD,
        limit: 3,
      })
      expect(pulled.entries.map((e) => e.score)).toEqual([1, 2, 3])
      expect(pulled.head).toEqual({ gen: GEN, counter: 5 })
    })
  )

  it.effect("returns empty entries when nothing newer than since", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "x",
        bodyTtlSec: 60,
        indexes: [],
      })
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        since: sinceWarm(100),
        limit: 10,
      })
      expect(pulled.entries.length).toBe(0)
      // head still reflects what the channel actually holds.
      expect(pulled.head).toEqual({ gen: GEN, counter: 1 })
    })
  )

  it.effect("returns null body for index entry whose body has TTL'd", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "x",
        bodyTtlSec: 30,
        indexes: [],
      })
      yield* TestClock.adjust("31 seconds")
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        since: SINCE_COLD,
        limit: 10,
      })
      expect(pulled.entries.length).toBe(1)
      expect(pulled.entries[0]?.body).toBeNull()
      expect(pulled.entries[0]?.body_ttl_remaining_sec).toBe(0)
    })
  )

  it.effect("malformed member returns a typed KvError", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: "malformed-no-prefix",
        bodyKey: "irrelevant",
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      const result = yield* Effect.exit(
        kv.channelPullBatch({
          channel: CHANNEL,
          counterKey: COUNTER,
          since: SINCE_COLD,
          limit: 10,
        })
      )
      expect(result._tag).toBe("Failure")
    })
  )

  it.effect("empty channel reads head=(0,0); no entries", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        since: SINCE_COLD,
        limit: 10,
      })
      expect(pulled.entries.length).toBe(0)
      expect(pulled.head).toEqual({ gen: 0, counter: 0 })
    })
  )

  it.effect("warm pull (since.gen > 0) skips mirror entries (entryGen=0); cold pull returns all", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      // One originating write into bucket gen=GEN.
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: GEN,
        member: memberOf("U", bodyKey("o1")),
        bodyKey: bodyKey("o1"),
        bodyValue: "O",
        bodyTtlSec: 60,
        indexes: [],
      })
      // One mirror write into bucket gen=0.
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        entryGen: 0,
        member: memberOf("U", "bak:peerA:call:m1"),
        bodyKey: "bak:peerA:call:m1",
        bodyValue: "M",
        bodyTtlSec: 60,
        indexes: [],
      })
      // Warm pull from GEN bucket, since=(GEN, 0): mirror NOT returned.
      const warm = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        since: sinceWarm(0),
        limit: 10,
      })
      expect(warm.entries.length).toBe(1)
      expect(warm.entries[0]?.entryGen).toBe(GEN)
      // Cold pull from (0, 0): both, in lex order — gen=0 first, then gen=GEN.
      const cold = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        since: SINCE_COLD,
        limit: 10,
      })
      expect(cold.entries.length).toBe(2)
      expect(cold.entries[0]?.entryGen).toBe(0)
      expect(cold.entries[1]?.entryGen).toBe(GEN)
      // Head = max lex tuple across buckets.
      expect(cold.head).toEqual({ gen: GEN, counter: 1 })
    })
  )
})

describe("KvBackend.memory — member encoding helpers", () => {
  it("memberOf composes prefix + bodyKey", () => {
    expect(KvBackend.memberOf("U", "pri:self:call:abc")).toBe(
      "U:pri:self:call:abc"
    )
    expect(KvBackend.memberOf("D", "pri:self:call:abc")).toBe(
      "D:pri:self:call:abc"
    )
  })

  it("bodyKeyFromMember strips the prefix", () => {
    expect(KvBackend.bodyKeyFromMember("U:pri:self:call:abc")).toBe(
      "pri:self:call:abc"
    )
    expect(KvBackend.bodyKeyFromMember("D:pri:self:call:abc")).toBe(
      "pri:self:call:abc"
    )
  })

  it("bodyKeyFromMember returns null for malformed input", () => {
    expect(KvBackend.bodyKeyFromMember("")).toBeNull()
    expect(KvBackend.bodyKeyFromMember("X:foo")).toBeNull()
    expect(KvBackend.bodyKeyFromMember("U-foo")).toBeNull()
    expect(KvBackend.bodyKeyFromMember("ab")).toBeNull()
  })
})
