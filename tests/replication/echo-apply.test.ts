/**
 * makeReplicationApply (was makeEchoApply) — Story 7d apply path.
 *
 * Pins the partition derivation rules from
 * docs/replication/architecture.md §"Cycle-break and recovery":
 *
 *   - frame.partition === "pri"  → write to bak:{source}: on me
 *   - frame.partition === "bak"  → write to pri:{me}:    on me
 *
 * Every apply (regardless of partition) goes through ONE atomic
 * primitive: `channelWriteUpdate({ entryGen: 0, ... })`. The body
 * lands at the target bodyKey, the U-member lands in the gen=0 bucket
 * of the outgoing-to-source channel, and indexes derived from the
 * body via `callIndexKeysFromUnknown` are SETEX'd. Cycle-break is
 * structural (lex-ordering on `(entryGen, counter)`); the puller
 * always writes mirrors and warm pullers naturally skip them.
 *
 * Tombstones (op=delete) follow the same partition-flip + bucket=0
 * rule via `tombstone({ entryGen: 0, callGen, ... })`.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap } from "effect"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import { makeReplicationApply } from "../../src/replication/EchoApply.js"
import type { DataFrame } from "../../src/replication/ReplicationProtocol.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

const SELF = "worker-B"
const SOURCE = "worker-A"
const SELF_GEN = 7

const SINCE_COLD = { gen: 0, counter: 0 } as const

const setup = () => {
  const store = MutableHashMap.empty<string, MemoryStoreEntry>()
  const kv = KvBackend.makeMemoryUnsafe(store)
  const outgoingToSource = ChannelIndex.make(
    { self: SELF, peer: SOURCE, gen: SELF_GEN },
    kv
  )
  const apply = makeReplicationApply({
    outgoingChannel: outgoingToSource,
    bodyTtlSec: 60,
    localKv: kv,
    self: SELF,
    source: SOURCE,
  })
  return { kv, outgoingToSource, apply }
}

describe("makeReplicationApply — partition derivation", () => {
  it.effect(
    "frame.partition='pri' (forward) writes to bak:{source}: + adds gen=0 mirror entry to outgoing channel",
    () =>
      Effect.gen(function* () {
        const { kv, outgoingToSource, apply } = setup()
        const frame: DataFrame = {
          _tag: "Data",
          gen: 1,
          counter: 1,
          op: "update",
          partition: "pri",
          callRef: "X",
          body: { _topology: { gen: 1 }, name: "X" },
          body_ttl_remaining_sec: 60,
          latency_ms: 0,
        }
        yield* apply(frame)

        // Body landed in bak:{source}:.
        expect(yield* kv.bodyGet(`bak:${SOURCE}:call:X`)).toBe(
          '{"_topology":{"gen":1},"name":"X"}'
        )
        // Mirror entry in outgoing channel — entryGen=0 (sentinel).
        const batch = yield* outgoingToSource.pullBatch(SINCE_COLD, 100)
        expect(batch.entries.length).toBe(1)
        expect(batch.entries[0]!.member).toBe(`U:bak:${SOURCE}:call:X`)
        expect(batch.entries[0]!.entryGen).toBe(0)
      })
  )

  it.effect(
    "frame.partition='bak' (reverse) writes to pri:{self}: + adds gen=0 mirror entry to outgoing channel",
    () =>
      Effect.gen(function* () {
        const { kv, outgoingToSource, apply } = setup()
        const frame: DataFrame = {
          _tag: "Data",
          gen: 1,
          counter: 1,
          op: "update",
          partition: "bak",
          callRef: "Y",
          body: { _topology: { gen: 1 }, name: "Y" },
          body_ttl_remaining_sec: 60,
          latency_ms: 0,
        }
        yield* apply(frame)

        // Reverse-tagged frame routes to local pri:{self}: per the
        // partition flip. The mirror entry STILL lands on the
        // outgoing channel under entryGen=0 — cycle-break is
        // structural at the wire (lex-ordering excludes gen=0 from
        // warm pullers), not at the local-write step.
        expect(yield* kv.bodyGet(`pri:${SELF}:call:Y`)).toBe(
          '{"_topology":{"gen":1},"name":"Y"}'
        )
        const batch = yield* outgoingToSource.pullBatch(SINCE_COLD, 100)
        expect(batch.entries.length).toBe(1)
        expect(batch.entries[0]!.member).toBe(`U:pri:${SELF}:call:Y`)
        expect(batch.entries[0]!.entryGen).toBe(0)
      })
  )

  it.effect("frame.op='delete' writes a tombstone to the derived partition under entryGen=0", () =>
    Effect.gen(function* () {
      const { kv, outgoingToSource, apply } = setup()
      // Seed an existing body via apply, so the puller's index cache
      // captures its derived idx-list. Real flow is: source's PUT
      // arrives first (with body), then source's DELETE arrives
      // (body=null). The cache populated by step 1 supplies the
      // index list to step 2's tombstone.
      const initial: DataFrame = {
        _tag: "Data",
        gen: 1,
        counter: 1,
        op: "update",
        partition: "pri",
        callRef: "Z",
        body: { _topology: { gen: 1 }, original: true },
        body_ttl_remaining_sec: 60,
        latency_ms: 0,
      }
      yield* apply(initial)
      expect(yield* kv.bodyGet(`bak:${SOURCE}:call:Z`)).not.toBeNull()

      const tomb: DataFrame = {
        _tag: "Data",
        gen: 1,
        counter: 5,
        op: "delete",
        partition: "pri",
        callRef: "Z",
        body: { tombstone: true, callGen: 2 },
        body_ttl_remaining_sec: 180,
        latency_ms: 0,
      }
      yield* apply(tomb)

      // Body is now the tombstone marker — not null and not the
      // original value.
      const after = yield* kv.bodyGet(`bak:${SOURCE}:call:Z`)
      expect(after).not.toBe('{"_topology":{"gen":1},"original":true}')
      expect(after).not.toBeNull()

      // Channel has both U-member (counter 1) and D-member (counter 2)
      // in the gen=0 bucket — lex-ordered by counter within the bucket.
      const batch = yield* outgoingToSource.pullBatch(SINCE_COLD, 100)
      expect(batch.entries.length).toBe(2)
      expect(batch.entries[0]!.member).toBe(`U:bak:${SOURCE}:call:Z`)
      expect(batch.entries[0]!.entryGen).toBe(0)
      expect(batch.entries[1]!.member).toBe(`D:bak:${SOURCE}:call:Z`)
      expect(batch.entries[1]!.entryGen).toBe(0)
    })
  )

  it.effect("callGen content gate: incoming ≤ local skips the apply", () =>
    Effect.gen(function* () {
      const { kv, outgoingToSource, apply } = setup()
      // Apply once to populate local.
      yield* apply({
        _tag: "Data",
        gen: 1,
        counter: 1,
        op: "update",
        partition: "pri",
        callRef: "G",
        body: { _topology: { gen: 5 }, v: 5 },
        body_ttl_remaining_sec: 60,
        latency_ms: 0,
      })
      const localAfterFirst = yield* kv.bodyGet(`bak:${SOURCE}:call:G`)
      expect(localAfterFirst).toBe('{"_topology":{"gen":5},"v":5}')
      // Apply a frame with EQUAL callGen (5 vs 5 — gate is strict >).
      yield* apply({
        _tag: "Data",
        gen: 1,
        counter: 2,
        op: "update",
        partition: "pri",
        callRef: "G",
        body: { _topology: { gen: 5 }, v: 99 },
        body_ttl_remaining_sec: 60,
        latency_ms: 0,
      })
      // Local body unchanged — equal callGen does not supersede.
      expect(yield* kv.bodyGet(`bak:${SOURCE}:call:G`)).toBe(
        '{"_topology":{"gen":5},"v":5}'
      )
      // No second mirror entry on the channel either.
      const batch = yield* outgoingToSource.pullBatch(SINCE_COLD, 100)
      expect(batch.entries.length).toBe(1)
    })
  )

  it.effect("callGen content gate: incoming > local applies and bumps the channel", () =>
    Effect.gen(function* () {
      const { kv, outgoingToSource, apply } = setup()
      yield* apply({
        _tag: "Data",
        gen: 1,
        counter: 1,
        op: "update",
        partition: "pri",
        callRef: "H",
        body: { _topology: { gen: 5 }, v: 5 },
        body_ttl_remaining_sec: 60,
        latency_ms: 0,
      })
      // Stricter callGen — apply lands.
      yield* apply({
        _tag: "Data",
        gen: 1,
        counter: 2,
        op: "update",
        partition: "pri",
        callRef: "H",
        body: { _topology: { gen: 6 }, v: 6 },
        body_ttl_remaining_sec: 60,
        latency_ms: 0,
      })
      expect(yield* kv.bodyGet(`bak:${SOURCE}:call:H`)).toBe(
        '{"_topology":{"gen":6},"v":6}'
      )
      // Channel: same member overwritten in the gen=0 bucket → score
      // bumps to 2.
      const batch = yield* outgoingToSource.pullBatch(SINCE_COLD, 100)
      expect(batch.entries.length).toBe(1)
      expect(batch.entries[0]!.score).toBe(2)
    })
  )
})
