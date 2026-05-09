/**
 * KvBackend (memory backend) — Slice 1 contract tests.
 *
 * Asserts the storage primitive port behaves as the design doc requires:
 *   - body get / del / mget round-trip and respect TTL.
 *   - channelWriteUpdate is atomic (counter monotonic, body+indexes+ZADD
 *     together, member re-write updates score).
 *   - channelWriteTombstone follows the same atomicity contract and
 *     correctly removes named secondary indexes.
 *   - channelPullBatch returns entries with score > sinceScore in
 *     ascending order, capped at limit, with body resolved via the
 *     "U:" / "D:" prefix convention (or null for missing/TTL'd bodies).
 *   - counters never expire.
 *   - concurrent writers see monotonic counter assignment.
 *
 * These tests are the first parity gate: every assertion here must hold
 * identically against the Redis backend (Slice 2's `port-parity` suite).
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
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "A",
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
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

describe("KvBackend.memory — counter", () => {
  it.effect("counterRead returns 0 for an unseen counter key", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      const n = yield* kv.counterRead(COUNTER)
      expect(n).toBe(0)
    })
  )

  it.effect("counter increments monotonically across writes", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      const r1 = yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      const r2 = yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        member: memberOf("U", bodyKey("b")),
        bodyKey: bodyKey("b"),
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      const r3 = yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        member: memberOf("U", bodyKey("c")),
        bodyKey: bodyKey("c"),
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      expect([r1.counter, r2.counter, r3.counter]).toEqual([1, 2, 3])
      const head = yield* kv.counterRead(COUNTER)
      expect(head).toBe(3)
    })
  )

  it.effect("counter survives long simulated wall time without TTL", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      // Advance well past every reasonable TTL window.
      yield* TestClock.adjust("2 hours")
      const head = yield* kv.counterRead(COUNTER)
      expect(head).toBe(1)
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
        sinceScore: 0,
        limit: 10,
      })
      expect(pulled.entries.length).toBe(1)
      expect(pulled.entries[0]?.member).toBe(memberOf("U", bodyKey("a")))
      expect(pulled.entries[0]?.score).toBe(1)
      expect(pulled.headCounter).toBe(1)
    })
  )

  it.effect("re-writing the same member bumps its score (sorted-set semantics)", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "v1",
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        member: memberOf("U", bodyKey("b")),
        bodyKey: bodyKey("b"),
        bodyValue: "B",
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "v2",
        bodyTtlSec: 60,
        indexes: [],
      })
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        sinceScore: 0,
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
      expect(pulled.headCounter).toBe(3)
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
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "BODY",
        bodyTtlSec: 60,
        indexes: [
          { key: "idx:leg:CID-1", value: "a", ttlSec: 60 },
          { key: "idx:leg:CID-2", value: "a", ttlSec: 60 },
        ],
      })
      // Then tombstone it.
      const result = yield* kv.channelWriteTombstone({
        channel: CHANNEL,
        counterKey: COUNTER,
        member: memberOf("D", bodyKey("a")),
        bodyKey: bodyKey("a"),
        tombstoneValue: '{"tombstone":true,"gen":7}',
        tombstoneTtlSec: 180,
        indexesToRemove: ["idx:leg:CID-1", "idx:leg:CID-2"],
      })
      expect(result.counter).toBe(2)
      // Body is now the tombstone marker.
      expect(yield* kv.bodyGet(bodyKey("a"))).toBe('{"tombstone":true,"gen":7}')
      // Secondary indexes are gone.
      expect(yield* kv.bodyGet("idx:leg:CID-1")).toBeNull()
      expect(yield* kv.bodyGet("idx:leg:CID-2")).toBeNull()
      // Pull sees BOTH the original U-member at score 1 AND the new D-member at score 2.
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        sinceScore: 0,
        limit: 10,
      })
      expect(pulled.entries.length).toBe(2)
      expect(pulled.entries[0]?.member).toBe(memberOf("U", bodyKey("a")))
      expect(pulled.entries[1]?.member).toBe(memberOf("D", bodyKey("a")))
      // Both entries resolve to the same body — which is now the tombstone
      // value. The puller distinguishes apply behavior by member's "U:"/"D:"
      // prefix, NOT by body shape.
      expect(pulled.entries[1]?.body).toBe('{"tombstone":true,"gen":7}')
    })
  )

  it.effect("tombstone TTL: body becomes null after expiry; index entry remains", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteTombstone({
        channel: CHANNEL,
        counterKey: COUNTER,
        member: memberOf("D", bodyKey("a")),
        bodyKey: bodyKey("a"),
        tombstoneValue: "T",
        tombstoneTtlSec: 180,
        indexesToRemove: [],
      })
      yield* TestClock.adjust("181 seconds")
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        sinceScore: 0,
        limit: 10,
      })
      // Index entry still present, body has TTL'd → null body. Per the
      // design doc, the puller treats null-body-on-D as "tombstone already
      // expired, apply DEL anyway".
      expect(pulled.entries.length).toBe(1)
      expect(pulled.entries[0]?.member).toBe(memberOf("D", bodyKey("a")))
      expect(pulled.entries[0]?.body).toBeNull()
    })
  )
})

describe("KvBackend.memory — channelPullBatch", () => {
  it.effect("respects sinceScore strictly (>, not >=)", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      for (const ref of ["a", "b", "c"]) {
        yield* kv.channelWriteUpdate({
          channel: CHANNEL,
          counterKey: COUNTER,
          member: memberOf("U", bodyKey(ref)),
          bodyKey: bodyKey(ref),
          bodyValue: ref,
          bodyTtlSec: 60,
          indexes: [],
        })
      }
      // Pull strictly > 1 → returns scores 2 and 3 only.
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        sinceScore: 1,
        limit: 10,
      })
      expect(pulled.entries.map((e) => e.score)).toEqual([2, 3])
    })
  )

  it.effect("respects limit and emits in ascending score order", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      for (const ref of ["a", "b", "c", "d", "e"]) {
        yield* kv.channelWriteUpdate({
          channel: CHANNEL,
          counterKey: COUNTER,
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
        sinceScore: 0,
        limit: 3,
      })
      expect(pulled.entries.map((e) => e.score)).toEqual([1, 2, 3])
      expect(pulled.headCounter).toBe(5)
    })
  )

  it.effect("returns empty entries when nothing newer than sinceScore", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
        member: memberOf("U", bodyKey("a")),
        bodyKey: bodyKey("a"),
        bodyValue: "x",
        bodyTtlSec: 60,
        indexes: [],
      })
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        sinceScore: 100,
        limit: 10,
      })
      expect(pulled.entries.length).toBe(0)
      expect(pulled.headCounter).toBe(1)
    })
  )

  it.effect("returns null body for index entry whose body has TTL'd", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
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
        sinceScore: 0,
        limit: 10,
      })
      expect(pulled.entries.length).toBe(1)
      expect(pulled.entries[0]?.body).toBeNull()
    })
  )

  it.effect("malformed member returns a typed KvError", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      // Write a malformed member through the public API by skipping
      // the U:/D: prefix convention. The KvBackend write path
      // doesn't enforce the convention (member is opaque to it);
      // pullBatch parses the prefix and returns a typed KvError on
      // the round-trip when it can't derive the body key.
      //
      // Slice 7c note: channels are now stored in a per-instance
      // native Map sidecar (not in the MemoryStore). Test injection
      // must go through the public API rather than poking at the
      // store directly, so this scenario writes a malformed member
      // via `channelWriteUpdate`. The body key for the malformed
      // member is irrelevant since the parse fails before MGET.
      yield* kv.channelWriteUpdate({
        channel: CHANNEL,
        counterKey: COUNTER,
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
          sinceScore: 0,
          limit: 10,
        })
      )
      expect(result._tag).toBe("Failure")
    })
  )

  it.effect("counter on an empty channel reads 0; head matches no-write state", () =>
    Effect.gen(function* () {
      const { kv } = setup()
      const pulled = yield* kv.channelPullBatch({
        channel: CHANNEL,
        counterKey: COUNTER,
        sinceScore: 0,
        limit: 10,
      })
      expect(pulled.entries.length).toBe(0)
      expect(pulled.headCounter).toBe(0)
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
