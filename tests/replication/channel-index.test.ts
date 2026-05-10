/**
 * ChannelIndex unit tests + T3 storage-layout assertion (post-Story-7d).
 *
 * Verifies the replication-specific naming convention (channel key,
 * counter key, body key, member format) is applied consistently and
 * matches what the architecture doc D2/D3 describe. Two-worker
 * scenarios (cross-channel reads/writes) live in the NS-suite —
 * this file is single-channel only.
 *
 * Story 7d additions:
 *   - `entryGen` is an explicit arg on `write` and `tombstone`. PRS
 *     originating writes pass `chan.gen` (the binding's incarnation
 *     gen); the puller's apply path passes `0` (mirror sentinel).
 *   - `tombstone` also takes a per-call `callGen` for the receiver's
 *     content gate; PRS computes it via RMW on the local existing body.
 *   - `pullBatch(since, limit)` takes `since: { gen, counter }` (lex
 *     watermark) instead of a single counter — enabling the lex
 *     ordering that breaks the cycle structurally.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap, Option } from "effect"
import {
  ChannelIndex,
  type ChannelIndexApi,
} from "../../src/replication/ChannelIndex.js"
import {
  KvBackend,
  type MemoryStore,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

const SELF = "worker-A"
const PEER = "worker-B"
const GEN = 42
const SINCE_COLD = { gen: 0, counter: 0 } as const

const setup = (): {
  readonly store: MemoryStore
  readonly chan: ChannelIndexApi
} => {
  const store = MutableHashMap.empty<string, MemoryStoreEntry>()
  const kv = KvBackend.makeMemoryUnsafe(store)
  const chan = ChannelIndex.make({ self: SELF, peer: PEER, gen: GEN }, kv)
  return { store, chan }
}

describe("ChannelIndex — naming convention (T3)", () => {
  it("channel key is propagate:{self}->{peer}", () => {
    expect(ChannelIndex.channelKey(SELF, PEER)).toBe("propagate:worker-A->worker-B")
  })

  it("counter key is seq:{self}->{peer}", () => {
    expect(ChannelIndex.counterKey(SELF, PEER)).toBe("seq:worker-A->worker-B")
  })

  it("body key is {partition}:{owner}:call:{callRef}", () => {
    expect(ChannelIndex.bodyKey("pri", SELF, "abc")).toBe("pri:worker-A:call:abc")
    expect(ChannelIndex.bodyKey("bak", PEER, "abc")).toBe("bak:worker-B:call:abc")
  })

  it("ownerFor: pri owner = self, bak owner = peer", () => {
    expect(ChannelIndex.ownerFor("pri", SELF, PEER)).toBe(SELF)
    expect(ChannelIndex.ownerFor("bak", SELF, PEER)).toBe(PEER)
  })
})

describe("ChannelIndex — write", () => {
  it("pri write places body at pri:{self}:call:{ref} and ZADDs U:bodyKey", () =>
    Effect.gen(function* () {
      const { store, chan } = setup()
      yield* chan.write({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "call-1",
        bodyValue: '{"_topology":{"gen":42},"x":1}',
        bodyTtlSec: 60,
        indexes: [],
      })
      // Body lives under pri:{self}:call:{ref}.
      const bodyEntry = MutableHashMap.get(store, "pri:worker-A:call:call-1")
      expect(Option.isSome(bodyEntry) ? bodyEntry.value.value : null).toBe(
        '{"_topology":{"gen":42},"x":1}'
      )
      // Channel index has the U-tagged member.
      const pulled = yield* chan.pullBatch(SINCE_COLD, 10)
      expect(pulled.entries.length).toBe(1)
      expect(pulled.entries[0]?.member).toBe("U:pri:worker-A:call:call-1")
      expect(pulled.entries[0]?.entryGen).toBe(chan.gen)
    })
  )

  it("bak write places body at bak:{peer}:call:{ref} (G7 reverse path)", () =>
    Effect.gen(function* () {
      const { store, chan } = setup()
      yield* chan.write({
        entryGen: chan.gen,
        partition: "bak",
        callRef: "call-1",
        bodyValue: '{"_topology":{"gen":42},"x":2}',
        bodyTtlSec: 60,
        indexes: [],
      })
      // Body owner is peer, not self — "self acting as backup-on-behalf
      // of peer" stores under the peer's bak partition.
      const bodyEntry = MutableHashMap.get(store, "bak:worker-B:call:call-1")
      expect(Option.isSome(bodyEntry) ? bodyEntry.value.value : null).toBe(
        '{"_topology":{"gen":42},"x":2}'
      )
      const pulled = yield* chan.pullBatch(SINCE_COLD, 10)
      expect(pulled.entries[0]?.member).toBe("U:bak:worker-B:call:call-1")
    })
  )

  it("counter increments per write across pri and bak (within the same bucket)", () =>
    Effect.gen(function* () {
      const { chan } = setup()
      const r1 = yield* chan.write({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "a",
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      const r2 = yield* chan.write({
        entryGen: chan.gen,
        partition: "bak",
        callRef: "b",
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      const r3 = yield* chan.write({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "c",
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      expect([r1.counter, r2.counter, r3.counter]).toEqual([1, 2, 3])
      // Head reflected via pullBatch, since per-bucket counters live
      // under derived storage keys.
      const pulled = yield* chan.pullBatch(SINCE_COLD, 10)
      expect(pulled.head).toEqual({ gen: chan.gen, counter: 3 })
    })
  )

  it("re-write of the same call within a bucket bumps its score (sorted-set semantics)", () =>
    Effect.gen(function* () {
      const { chan } = setup()
      yield* chan.write({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "a",
        bodyValue: '{"_topology":{"gen":1},"v":1}',
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* chan.write({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "b",
        bodyValue: '{"_topology":{"gen":1},"v":1}',
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* chan.write({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "a",
        bodyValue: '{"_topology":{"gen":2},"v":2}',
        bodyTtlSec: 60,
        indexes: [],
      })
      const pulled = yield* chan.pullBatch(SINCE_COLD, 10)
      expect(pulled.entries.length).toBe(2)
      expect(pulled.entries[0]?.member).toBe("U:pri:worker-A:call:b")
      expect(pulled.entries[0]?.score).toBe(2)
      expect(pulled.entries[1]?.member).toBe("U:pri:worker-A:call:a")
      expect(pulled.entries[1]?.score).toBe(3)
      // Re-written body is the latest value.
      expect(pulled.entries[1]?.body).toBe('{"_topology":{"gen":2},"v":2}')
    })
  )

  it("indexes are written alongside the body and visible via bodyGet", () =>
    Effect.gen(function* () {
      const { store, chan } = setup()
      yield* chan.write({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "call-1",
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [
          { key: "idx:leg:CID-1|tag-A", value: "call-1", ttlSec: 60 },
          { key: "idx:leg:CID-2", value: "call-1", ttlSec: 60 },
        ],
      })
      expect(
        Option.getOrUndefined(MutableHashMap.get(store, "idx:leg:CID-1|tag-A"))?.value
      ).toBe("call-1")
      expect(
        Option.getOrUndefined(MutableHashMap.get(store, "idx:leg:CID-2"))?.value
      ).toBe("call-1")
    })
  )
})

describe("ChannelIndex — tombstone", () => {
  it("writes tombstone body with callGen, removes named indexes, ZADDs D:bodyKey", () =>
    Effect.gen(function* () {
      const { store, chan } = setup()
      // Pre-populate a U: write with indexes.
      yield* chan.write({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "call-1",
        bodyValue: '{"_topology":{"gen":42},"x":1}',
        bodyTtlSec: 60,
        indexes: [{ key: "idx:leg:CID-1", value: "call-1", ttlSec: 60 }],
      })
      // Then tombstone — body slot is hard-DEL'd, indexes DEL'd,
      // D-member added to the channel.
      yield* chan.tombstone({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "call-1",
        indexesToRemove: ["idx:leg:CID-1"],
      })
      // Body slot is empty.
      expect(
        Option.isNone(MutableHashMap.get(store, "pri:worker-A:call:call-1"))
      ).toBe(true)
      // Index entry is gone.
      expect(
        Option.isNone(MutableHashMap.get(store, "idx:leg:CID-1"))
      ).toBe(true)
      // Channel has both U-member at score 1 AND D-member at score 2.
      const pulled = yield* chan.pullBatch(SINCE_COLD, 10)
      expect(pulled.entries.length).toBe(2)
      expect(pulled.entries[0]?.member).toBe("U:pri:worker-A:call:call-1")
      expect(pulled.entries[1]?.member).toBe("D:pri:worker-A:call:call-1")
      // The D-member's body is null (hard-DEL'd).
      expect(pulled.entries[1]?.body).toBeNull()
    })
  )

  it("tombstone of a never-written callRef still bumps counter and emits a D-member with body=null", () =>
    Effect.gen(function* () {
      const { chan } = setup()
      const r = yield* chan.tombstone({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "never-existed",
        indexesToRemove: [],
      })
      expect(r.counter).toBe(1)
      const pulled = yield* chan.pullBatch(SINCE_COLD, 10)
      expect(pulled.entries.length).toBe(1)
      expect(pulled.entries[0]?.member).toBe("D:pri:worker-A:call:never-existed")
      expect(pulled.entries[0]?.body).toBeNull()
    })
  )
})

describe("ChannelIndex — gen exposure", () => {
  it("gen is the constructor-supplied value, used as the originating entryGen", () => {
    const { chan } = setup()
    expect(chan.gen).toBe(GEN)
  })
})

describe("ChannelIndex — bucket separation (Story 7d)", () => {
  it("mirror writes (entryGen=0) coexist with originating writes (entryGen=chan.gen) on the same channel", () =>
    Effect.gen(function* () {
      const { chan } = setup()
      // Originating write into chan.gen bucket.
      yield* chan.write({
        entryGen: chan.gen,
        partition: "pri",
        callRef: "o",
        bodyValue: "O",
        bodyTtlSec: 60,
        indexes: [],
      })
      // Mirror write into entryGen=0 bucket.
      yield* chan.write({
        entryGen: 0,
        partition: "bak",
        callRef: "m",
        bodyValue: "M",
        bodyTtlSec: 60,
        indexes: [],
      })
      // Cold pull: both buckets walked in lex order — gen=0 first.
      const cold = yield* chan.pullBatch({ gen: 0, counter: 0 }, 10)
      expect(cold.entries.length).toBe(2)
      expect(cold.entries[0]?.entryGen).toBe(0)
      expect(cold.entries[1]?.entryGen).toBe(chan.gen)
      // Warm pull from chan.gen bucket: mirror NOT returned.
      const warm = yield* chan.pullBatch({ gen: chan.gen, counter: 0 }, 10)
      expect(warm.entries.length).toBe(1)
      expect(warm.entries[0]?.entryGen).toBe(chan.gen)
    })
  )
})
