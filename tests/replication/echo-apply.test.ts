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
 *
 * Bodies are fabricated through the SAME msgpackr codec the production
 * write path uses (`bodyBuf`), so this suite exercises the real
 * encode → wire → decode round-trip.
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
import { bodyBuf, bufToString, decodeBuf } from "../support/codecHelpers.js"
import { callIndexKeysFromUnknown } from "../../src/call/CallModel.js"

/**
 * Extract callGen + indexes from a JS body for a wire frame. Tests
 * historically used the body bytes alone; with the opaque-apply
 * cut-over (commit 4) the frame carries these explicitly.
 */
const stampMetadata = (
  body: Record<string, unknown>,
): { callGen: number; indexes: ReadonlyArray<string> } => {
  const topology = body["_topology"]
  const gen =
    topology !== null &&
    typeof topology === "object" &&
    typeof (topology as { gen?: unknown }).gen === "number"
      ? Math.max(0, (topology as { gen: number }).gen)
      : 0
  return { callGen: gen, indexes: callIndexKeysFromUnknown(body) }
}

const SELF = "worker-B"
const SOURCE = "worker-A"
const SELF_GEN = 7

const SINCE_COLD = { gen: 0, counter: 0 } as const

const setup = () => {
  const store = MutableHashMap.empty<string, MemoryStoreEntry>()
  const kv = KvBackend.makeMemoryUnsafe(store)
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

const expectDecodedEqual = (
  buf: Buffer | null,
  expected: unknown,
): void => {
  expect(buf).not.toBeNull()
  expect(decodeBuf(buf as Buffer)).toEqual(expected)
}

describe("makeReplicationApply — partition derivation + no echo", () => {
  it.effect(
    "frame.partition='pri' writes to bak:{source}: locally; outgoing channel stays empty",
    () =>
      Effect.gen(function* () {
        const { kv, outgoingToSource, apply } = setup()
        const callBody = { _topology: { gen: 1 }, name: "X" }
        const frame: DataFrame = {
          _tag: "Data",
          gen: 1,
          counter: 1,
          op: "update",
          partition: "pri",
          callRef: "X",
          body: bodyBuf(callBody),
          body_ttl_remaining_sec: 60,
          latency_ms: 0,
          ...stampMetadata(callBody),
        }
        yield* apply(frame)

        expectDecodedEqual(
          yield* kv.bodyGet(`bak:${SOURCE}:call:X`),
          callBody,
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
        const callBody = { _topology: { gen: 1 }, name: "Y" }
        const frame: DataFrame = {
          _tag: "Data",
          gen: 1,
          counter: 1,
          op: "update",
          partition: "bak",
          callRef: "Y",
          body: bodyBuf(callBody),
          body_ttl_remaining_sec: 60,
          latency_ms: 0,
          ...stampMetadata(callBody),
        }
        yield* apply(frame)

        expectDecodedEqual(
          yield* kv.bodyGet(`pri:${SELF}:call:Y`),
          callBody,
        )
        const batch = yield* outgoingToSource.pullBatch(SINCE_COLD, 100)
        expect(batch.entries.length).toBe(0)
      }),
  )

  it.effect("frame.op='delete' hard-DELs body + cached indexes; outgoing channel stays empty", () =>
    Effect.gen(function* () {
      const { kv, outgoingToSource, apply } = setup()
      const seedBody = {
        _topology: { gen: 1 },
        aLeg: { callId: "cid-z", fromTag: "ftag-z", dialogs: [] },
        bLegs: [],
      }
      const seed: DataFrame = {
        _tag: "Data",
        gen: 1,
        counter: 1,
        op: "update",
        partition: "pri",
        callRef: "Z",
        body: bodyBuf(seedBody),
        body_ttl_remaining_sec: 60,
        latency_ms: 0,
        ...stampMetadata(seedBody),
      }
      yield* apply(seed)
      expect(yield* kv.bodyGet(`bak:${SOURCE}:call:Z`)).not.toBeNull()
      const idxBuf = yield* kv.bodyGet("idx:leg:cid-z|ftag-z")
      expect(idxBuf).not.toBeNull()
      expect(bufToString(idxBuf as Buffer)).toBe("Z")

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
        callGen: 2,
        indexes: ["leg:cid-z|ftag-z"],
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
      const initial = { _topology: { gen: 5 }, v: 5 }
      yield* apply({
        _tag: "Data",
        gen: 1,
        counter: 1,
        op: "update",
        partition: "pri",
        callRef: "G",
        body: bodyBuf(initial),
        body_ttl_remaining_sec: 60,
        latency_ms: 0,
        ...stampMetadata(initial),
      })
      expectDecodedEqual(
        yield* kv.bodyGet(`bak:${SOURCE}:call:G`),
        initial,
      )
      // Equal callGen — gate is strict >, so this is skipped.
      const equalCallGen = { _topology: { gen: 5 }, v: 99 }
      yield* apply({
        _tag: "Data",
        gen: 1,
        counter: 2,
        op: "update",
        partition: "pri",
        callRef: "G",
        body: bodyBuf(equalCallGen),
        body_ttl_remaining_sec: 60,
        latency_ms: 0,
        ...stampMetadata(equalCallGen),
      })
      expectDecodedEqual(
        yield* kv.bodyGet(`bak:${SOURCE}:call:G`),
        initial,
      )
    }),
  )

  it.effect("callGen content gate: incoming > local applies", () =>
    Effect.gen(function* () {
      const { kv, apply } = setup()
      const initialH = { _topology: { gen: 5 }, v: 5 }
      yield* apply({
        _tag: "Data",
        gen: 1,
        counter: 1,
        op: "update",
        partition: "pri",
        callRef: "H",
        body: bodyBuf(initialH),
        body_ttl_remaining_sec: 60,
        latency_ms: 0,
        ...stampMetadata(initialH),
      })
      const updated = { _topology: { gen: 6 }, v: 6 }
      yield* apply({
        _tag: "Data",
        gen: 1,
        counter: 2,
        op: "update",
        partition: "pri",
        callRef: "H",
        body: bodyBuf(updated),
        body_ttl_remaining_sec: 60,
        latency_ms: 0,
        ...stampMetadata(updated),
      })
      expectDecodedEqual(
        yield* kv.bodyGet(`bak:${SOURCE}:call:H`),
        updated,
      )
    }),
  )

  it.effect(
    "delete is NOT gated by callGen: a stale-callGen delete still supersedes a higher-callGen local body",
    () =>
      Effect.gen(function* () {
        const { kv, apply } = setup()
        // Seed at callGen=10.
        const seedK = { _topology: { gen: 10 }, v: 10 }
        yield* apply({
          _tag: "Data",
          gen: 1,
          counter: 1,
          op: "update",
          partition: "pri",
          callRef: "K",
          body: bodyBuf(seedK),
          body_ttl_remaining_sec: 60,
          latency_ms: 0,
          ...stampMetadata(seedK),
        })
        // Delete frame: body=null. The DELETE path skips the callGen
        // gate; body must end up DEL'd even with a stale callGen.
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
          callGen: 5,
          indexes: [],
        })
        expect(yield* kv.bodyGet(`bak:${SOURCE}:call:K`)).toBeNull()
      }),
  )
})
