/**
 * ChannelIndex unit tests + T3 storage-layout assertion.
 *
 * Verifies the replication-specific naming convention (channel key,
 * counter key, body key, member format) is applied consistently and
 * matches what the design doc D2/D3 describe. Two-worker scenarios
 * (cross-channel reads/writes) live in later slices — this file is
 * single-channel only.
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
        partition: "pri",
        callRef: "call-1",
        bodyValue: '{"gen":42,"x":1}',
        bodyTtlSec: 60,
        indexes: [],
      })
      // Body lives under pri:{self}:call:{ref}.
      const bodyEntry = MutableHashMap.get(store, "pri:worker-A:call:call-1")
      expect(Option.isSome(bodyEntry) ? bodyEntry.value.value : null).toBe(
        '{"gen":42,"x":1}'
      )
      // Channel index has the U-tagged member.
      const pulled = yield* chan.pullBatch(0, 10)
      expect(pulled.entries.length).toBe(1)
      expect(pulled.entries[0]?.member).toBe("U:pri:worker-A:call:call-1")
    })
  )

  it("bak write places body at bak:{peer}:call:{ref} (G7 reverse path)", () =>
    Effect.gen(function* () {
      const { store, chan } = setup()
      yield* chan.write({
        partition: "bak",
        callRef: "call-1",
        bodyValue: '{"gen":42,"x":2}',
        bodyTtlSec: 60,
        indexes: [],
      })
      // Body owner is peer, not self — "self acting as backup-on-behalf
      // of peer" stores under the peer's bak partition.
      const bodyEntry = MutableHashMap.get(store, "bak:worker-B:call:call-1")
      expect(Option.isSome(bodyEntry) ? bodyEntry.value.value : null).toBe(
        '{"gen":42,"x":2}'
      )
      const pulled = yield* chan.pullBatch(0, 10)
      expect(pulled.entries[0]?.member).toBe("U:bak:worker-B:call:call-1")
    })
  )

  it("counter increments per write across pri and bak", () =>
    Effect.gen(function* () {
      const { chan } = setup()
      const r1 = yield* chan.write({
        partition: "pri",
        callRef: "a",
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      const r2 = yield* chan.write({
        partition: "bak",
        callRef: "b",
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      const r3 = yield* chan.write({
        partition: "pri",
        callRef: "c",
        bodyValue: "{}",
        bodyTtlSec: 60,
        indexes: [],
      })
      expect([r1.counter, r2.counter, r3.counter]).toEqual([1, 2, 3])
      const head = yield* chan.currentCounter
      expect(head).toBe(3)
    })
  )

  it("re-write of the same call bumps its score (sorted-set semantics)", () =>
    Effect.gen(function* () {
      const { chan } = setup()
      yield* chan.write({
        partition: "pri",
        callRef: "a",
        bodyValue: '{"gen":42,"v":1}',
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* chan.write({
        partition: "pri",
        callRef: "b",
        bodyValue: '{"gen":42,"v":1}',
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* chan.write({
        partition: "pri",
        callRef: "a",
        bodyValue: '{"gen":42,"v":2}',
        bodyTtlSec: 60,
        indexes: [],
      })
      const pulled = yield* chan.pullBatch(0, 10)
      expect(pulled.entries.length).toBe(2)
      expect(pulled.entries[0]?.member).toBe("U:pri:worker-A:call:b")
      expect(pulled.entries[0]?.score).toBe(2)
      expect(pulled.entries[1]?.member).toBe("U:pri:worker-A:call:a")
      expect(pulled.entries[1]?.score).toBe(3)
      // Re-written body is the latest value.
      expect(pulled.entries[1]?.body).toBe('{"gen":42,"v":2}')
    })
  )

  it("indexes are written alongside the body and visible via bodyGet", () =>
    Effect.gen(function* () {
      const { store, chan } = setup()
      yield* chan.write({
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
  it("writes tombstone body with gen field, removes named indexes, ZADDs D:bodyKey", () =>
    Effect.gen(function* () {
      const { store, chan } = setup()
      // Pre-populate a U: write with indexes.
      yield* chan.write({
        partition: "pri",
        callRef: "call-1",
        bodyValue: '{"gen":42,"x":1}',
        bodyTtlSec: 60,
        indexes: [{ key: "idx:leg:CID-1", value: "call-1", ttlSec: 60 }],
      })
      // Then tombstone.
      yield* chan.tombstone({
        partition: "pri",
        callRef: "call-1",
        indexesToRemove: ["idx:leg:CID-1"],
      })
      // Body is now the tombstone marker.
      const bodyEntry = MutableHashMap.get(store, "pri:worker-A:call:call-1")
      expect(Option.isSome(bodyEntry) ? bodyEntry.value.value : null).toBe(
        '{"tombstone":true,"gen":42}'
      )
      // Index entry is gone.
      expect(
        Option.isNone(MutableHashMap.get(store, "idx:leg:CID-1"))
      ).toBe(true)
      // Channel has both U-member at score 1 AND D-member at score 2.
      const pulled = yield* chan.pullBatch(0, 10)
      expect(pulled.entries.length).toBe(2)
      expect(pulled.entries[0]?.member).toBe("U:pri:worker-A:call:call-1")
      expect(pulled.entries[1]?.member).toBe("D:pri:worker-A:call:call-1")
    })
  )

  it("tombstone of a never-written callRef still bumps counter and stores tombstone marker", () =>
    Effect.gen(function* () {
      const { chan } = setup()
      const r = yield* chan.tombstone({
        partition: "pri",
        callRef: "never-existed",
        indexesToRemove: [],
      })
      expect(r.counter).toBe(1)
      const pulled = yield* chan.pullBatch(0, 10)
      expect(pulled.entries.length).toBe(1)
      expect(pulled.entries[0]?.member).toBe("D:pri:worker-A:call:never-existed")
    })
  )

  it("tombstone embeds the worker's gen (carried via ChannelIndex constructor)", () =>
    Effect.gen(function* () {
      const { chan } = setup()
      yield* chan.tombstone({
        partition: "pri",
        callRef: "call-1",
        indexesToRemove: [],
      })
      const pulled = yield* chan.pullBatch(0, 10)
      // Tombstone payload includes our gen so future readers can sort
      // by (incoming.gen, incoming.counter).
      expect(pulled.entries[0]?.body).toBe('{"tombstone":true,"gen":42}')
    })
  )
})

describe("ChannelIndex — gen exposure", () => {
  it("gen is the constructor-supplied value, available for the wire-frame layer", () => {
    const { chan } = setup()
    expect(chan.gen).toBe(GEN)
  })
})
