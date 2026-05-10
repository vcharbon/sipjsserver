/**
 * makeReplicationApply — local-only apply path.
 *
 * After the echo redesign (docs/plan/lets-plan-a-proper-crystalline-emerson.md)
 * the puller's apply path writes ONLY to local storage; no mirror is
 * emitted onto the outgoing channel. These tests pin:
 *
 *   1. Partition flip:
 *      frame.partition === "pri"  → writes to bak:{source}: on me
 *      frame.partition === "bak"  → writes to pri:{me}: on me
 *
 *   2. UPDATE: body + derived indexes are set locally.
 *
 *   3. DELETE: body and cached indexes are hard-DEL'd locally.
 *
 *   4. callGen content gate on UPDATE: incoming ≤ local skips; incoming
 *      > local applies. The gate does NOT fire for DELETE — a delete
 *      always supersedes (with echo killed there is exactly one D-frame
 *      per call from the originator, so no crossing-tombstone scenario
 *      to mediate).
 *
 *   5. No mirror writes are emitted on the outgoing channel by any
 *      apply — independently constructed `outgoingToSource` channel
 *      stays empty.
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
  // Independently constructed outgoing channel — used ONLY by the
  // test to assert the apply path does NOT write to it.
  const outgoingToSource = ChannelIndex.make(
    { self: SELF, peer: SOURCE, gen: SELF_GEN },
    kv,
  )
  const apply = makeReplicationApply({
    bodyTtlSec: 60,
    localKv: kv,
    self: SELF,
    source: SOURCE,
  })
  return { kv, outgoingToSource, apply }
}

describe("makeReplicationApply — partition derivation + no echo", () => {
  it.effect(
    "frame.partition='pri' writes to bak:{source}: locally; outgoing channel stays empty",
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

        expect(yield* kv.bodyGet(`bak:${SOURCE}:call:X`)).toBe(
          '{"_topology":{"gen":1},"name":"X"}',
        )
        const batch = yield* outgoingToSource.pullBatch(SINCE_COLD, 100)
        expect(batch.entries.length).toBe(0)
      }),
  )

  it.effect(
    "frame.partition='bak' writes to pri:{self}: locally; outgoing channel stays empty",
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

        expect(yield* kv.bodyGet(`pri:${SELF}:call:Y`)).toBe(
          '{"_topology":{"gen":1},"name":"Y"}',
        )
        const batch = yield* outgoingToSource.pullBatch(SINCE_COLD, 100)
        expect(batch.entries.length).toBe(0)
      }),
  )

  it.effect("frame.op='delete' hard-DELs body + cached indexes; outgoing channel stays empty", () =>
    Effect.gen(function* () {
      const { kv, outgoingToSource, apply } = setup()
      // Seed with a call that has at least one derivable index so the
      // index cache captures something for the eventual DELETE to clear.
      const seed: DataFrame = {
        _tag: "Data",
        gen: 1,
        counter: 1,
        op: "update",
        partition: "pri",
        callRef: "Z",
        body: {
          _topology: { gen: 1 },
          aLeg: { callId: "cid-z", fromTag: "ftag-z", dialogs: [] },
          bLegs: [],
        },
        body_ttl_remaining_sec: 60,
        latency_ms: 0,
      }
      yield* apply(seed)
      expect(yield* kv.bodyGet(`bak:${SOURCE}:call:Z`)).not.toBeNull()
      expect(yield* kv.bodyGet("idx:leg:cid-z|ftag-z")).toBe("Z")

      const tomb: DataFrame = {
        _tag: "Data",
        gen: 1,
        counter: 5,
        op: "delete",
        partition: "pri",
        callRef: "Z",
        body: null,
        body_ttl_remaining_sec: 0,
        latency_ms: 0,
      }
      yield* apply(tomb)

      expect(yield* kv.bodyGet(`bak:${SOURCE}:call:Z`)).toBeNull()
      expect(yield* kv.bodyGet("idx:leg:cid-z|ftag-z")).toBeNull()
      const batch = yield* outgoingToSource.pullBatch(SINCE_COLD, 100)
      expect(batch.entries.length).toBe(0)
    }),
  )

  it.effect("callGen content gate: incoming ≤ local skips the apply (UPDATE only)", () =>
    Effect.gen(function* () {
      const { kv, apply } = setup()
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
      expect(yield* kv.bodyGet(`bak:${SOURCE}:call:G`)).toBe(
        '{"_topology":{"gen":5},"v":5}',
      )
      // Equal callGen — gate is strict >, so this is skipped.
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
      expect(yield* kv.bodyGet(`bak:${SOURCE}:call:G`)).toBe(
        '{"_topology":{"gen":5},"v":5}',
      )
    }),
  )

  it.effect("callGen content gate: incoming > local applies", () =>
    Effect.gen(function* () {
      const { kv, apply } = setup()
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
        '{"_topology":{"gen":6},"v":6}',
      )
    }),
  )

  it.effect(
    "delete is NOT gated by callGen: a stale-callGen delete still supersedes a higher-callGen local body",
    () =>
      Effect.gen(function* () {
        const { kv, apply } = setup()
        // Seed at callGen=10.
        yield* apply({
          _tag: "Data",
          gen: 1,
          counter: 1,
          op: "update",
          partition: "pri",
          callRef: "K",
          body: { _topology: { gen: 10 }, v: 10 },
          body_ttl_remaining_sec: 60,
          latency_ms: 0,
        })
        // Delete frame: body=null (no callGen on the wire). Even if
        // the apply could read a callGen, the DELETE path skips the
        // gate. Body must end up DEL'd.
        yield* apply({
          _tag: "Data",
          gen: 1,
          counter: 2,
          op: "delete",
          partition: "pri",
          callRef: "K",
          body: null,
          body_ttl_remaining_sec: 0,
          latency_ms: 0,
        })
        expect(yield* kv.bodyGet(`bak:${SOURCE}:call:K`)).toBeNull()
      }),
  )
})
