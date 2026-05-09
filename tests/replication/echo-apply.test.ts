/**
 * EchoApply — Slice 6 helper that builds the puller's `applyFrame`.
 *
 * Pins the partition derivation rules from
 * docs/plan/grill-me-on-the-spicy-lark.md §D5:
 *
 *   - frame.partition === "pri"  → write to bak:{source}: on me
 *   - frame.partition === "bak"  → write to pri:{me}:    on me
 *   - In both cases, echo to outgoing-channel-to-source.
 *
 * Tombstones (op=delete) and updates (op=create/update) take the same
 * derivation path.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap } from "effect"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import { makeEchoApply } from "../../src/replication/EchoApply.js"
import type { DataFrame } from "../../src/replication/ReplicationProtocol.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

const SELF = "worker-B"
const SOURCE = "worker-A"
const SELF_GEN = 7

const setup = () => {
  const store = MutableHashMap.empty<string, MemoryStoreEntry>()
  const kv = KvBackend.makeMemoryUnsafe(store)
  const outgoingToSource = ChannelIndex.make(
    { self: SELF, peer: SOURCE, gen: SELF_GEN },
    kv
  )
  const apply = makeEchoApply({
    outgoingChannel: outgoingToSource,
    bodyTtlSec: 60,
  })
  return { kv, outgoingToSource, apply }
}

describe("makeEchoApply — partition derivation", () => {
  it.effect("frame.partition='pri' (forward) writes to bak:{source}: + echoes to channel-to-source", () =>
    Effect.gen(function* () {
      const { kv, outgoingToSource, apply } = setup()
      const frame: DataFrame = {
        _tag: "Data",
        gen: 1,
        counter: 1,
        op: "update",
        partition: "pri",
        callRef: "X",
        body: { name: "X" },
        latency_ms: 0,
      }
      yield* apply(frame)

      // Body landed in bak:{source}:.
      expect(yield* kv.bodyGet(`bak:${SOURCE}:call:X`)).toBe('{"name":"X"}')
      // Echoed to outgoing channel — counter 1.
      const batch = yield* outgoingToSource.pullBatch(0, 100)
      expect(batch.entries.length).toBe(1)
      expect(batch.entries[0]!.member).toBe(`U:bak:${SOURCE}:call:X`)
      expect(batch.entries[0]!.score).toBe(1)
    })
  )

  it.effect("frame.partition='bak' (reverse) writes to pri:{self}: + echoes to channel-to-source", () =>
    Effect.gen(function* () {
      const { kv, outgoingToSource, apply } = setup()
      const frame: DataFrame = {
        _tag: "Data",
        gen: 1,
        counter: 1,
        op: "update",
        partition: "bak",
        callRef: "Y",
        body: { name: "Y" },
        latency_ms: 0,
      }
      yield* apply(frame)

      expect(yield* kv.bodyGet(`pri:${SELF}:call:Y`)).toBe('{"name":"Y"}')
      const batch = yield* outgoingToSource.pullBatch(0, 100)
      expect(batch.entries.length).toBe(1)
      expect(batch.entries[0]!.member).toBe(`U:pri:${SELF}:call:Y`)
    })
  )

  it.effect("frame.op='delete' writes a tombstone to the derived partition", () =>
    Effect.gen(function* () {
      const { kv, outgoingToSource, apply } = setup()
      // Seed an existing body to delete.
      yield* outgoingToSource.write({
        partition: "bak",
        callRef: "Z",
        bodyValue: '{"original":true}',
        bodyTtlSec: 60,
        indexes: [],
      })
      expect(yield* kv.bodyGet(`bak:${SOURCE}:call:Z`)).not.toBeNull()

      const tomb: DataFrame = {
        _tag: "Data",
        gen: 1,
        counter: 5,
        op: "delete",
        partition: "pri",
        callRef: "Z",
        body: null,
        latency_ms: 0,
      }
      yield* apply(tomb)

      // Body is now the tombstone marker — not null and not the
      // original value (the channel's tombstone path encodes a JSON
      // marker via ChannelIndex).
      const after = yield* kv.bodyGet(`bak:${SOURCE}:call:Z`)
      expect(after).not.toBe('{"original":true}')
      expect(after).not.toBeNull()

      // Channel has both U-member and D-member.
      const batch = yield* outgoingToSource.pullBatch(0, 100)
      expect(batch.entries.length).toBe(2)
      expect(batch.entries[0]!.member).toBe(`U:bak:${SOURCE}:call:Z`)
      expect(batch.entries[1]!.member).toBe(`D:bak:${SOURCE}:call:Z`)
    })
  )
})
