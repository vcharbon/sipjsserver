/**
 * Server emission loop semantics (Slice 4).
 *
 * Asserts the wire-protocol promises encoded into `buildPullStream`:
 *
 *   1. Frames are emitted in strictly ascending `(gen, counter)` order.
 *   2. When a batch is full (entries.length === chunk_size), the loop
 *      pulls the next batch immediately — no idle sleep.
 *   3. When a batch is partial, the loop emits a `noop` frame at the
 *      channel's head tuple `(head.gen, head.counter)` and then sleeps
 *      `noopIntervalMs`. (`head.gen` may differ from `serverGen` when
 *      gen=0 mirror entries exist on a channel whose `serverGen` bucket
 *      is still empty — see ReplLogServer's noop construction.)
 *   4. The `noop` frame is the caught-up signal: receiver flips
 *      `everCaughtUp = true` on first noop.
 *
 * Tests interrupt the long-lived stream by `Stream.take(N)` to bound
 * each scenario; in production the connection lifetime is the bound.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap, Stream } from "effect"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import { buildPullStream } from "../../src/replication/ReplLogServer.js"
import {
  decodeFrame,
  type PullFrame,
} from "../../src/replication/ReplicationProtocol.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"
import { bodyBuf, decodeBuf } from "../support/codecHelpers.js"

const SELF = "worker-A"
const PEER = "worker-B"
const GEN = 42

const setup = () => {
  const store = MutableHashMap.empty<string, MemoryStoreEntry>()
  const kv = KvBackend.makeMemoryUnsafe(store)
  const channel = ChannelIndex.make({ self: SELF, peer: PEER, gen: GEN }, kv)
  return { kv, channel }
}

/**
 * Decode a stream of length-prefixed-msgpack `Uint8Array` chunks into
 * `PullFrame`s. Post-msgpackr-migration the wire is binary: each frame
 * is `[4-byte BE uint32 length][msgpack payload]`. The accumulator
 * pattern mirrors `src/replication/NdjsonStream.ts:streamLengthPrefixedFrames`.
 */
const decodeStream = (
  stream: Stream.Stream<Uint8Array>,
  takeFrames: number
): Effect.Effect<ReadonlyArray<PullFrame>, never> =>
  Effect.gen(function* () {
    let acc: Buffer = Buffer.alloc(0)
    const frames: Array<PullFrame> = []
    const chunks: ReadonlyArray<Uint8Array> = yield* Stream.runCollect(
      stream.pipe(Stream.take(takeFrames * 4)) // safety cap on byte chunks
    )
    for (const chunk of chunks) {
      acc = Buffer.concat([acc, Buffer.from(chunk)])
      while (acc.length >= 4) {
        const length = acc.readUInt32BE(0)
        if (acc.length < 4 + length) break
        const payload = acc.subarray(4, 4 + length)
        acc = acc.subarray(4 + length)
        frames.push(decodeFrame(payload))
        if (frames.length >= takeFrames) return frames
      }
    }
    return frames
  })

describe("buildPullStream — empty channel emits a noop and waits", () => {
  it.live("first frame on an empty channel is a noop at (head.gen=0, counter=0)", () =>
    Effect.gen(function* () {
      const { channel } = setup()
      const stream = buildPullStream({
        channel,
        serverGen: GEN,
        initialSince: { gen: 0, counter: 0 },
        chunkSize: 100,
        noopIntervalMs: 5,
      })
      const frames = yield* decodeStream(stream, 1)
      expect(frames.length).toBe(1)
      expect(frames[0]?._tag).toBe("Noop")
      // Noop carries the channel's head tuple `(head.gen, head.counter)`.
      // An empty channel has head=(0, 0); the puller's watermark advance
      // to (0, 0) is a no-op, so subsequent originating writes at
      // gen=`serverGen`, counter=1.. clear the watermark and apply.
      expect(frames[0]?.gen).toBe(0)
      expect(frames[0]?.counter).toBe(0)
    })
  )
})

describe("buildPullStream — pre-existing entries are emitted as Data frames", () => {
  it.live("a single pre-existing write is emitted, followed by a noop", () =>
    Effect.gen(function* () {
      const { channel } = setup()
      yield* channel.write({ entryGen: GEN,
        partition: "pri",
        callRef: "abc",
        bodyValue: bodyBuf({ gen: 42, state: "active" }),
        bodyTtlSec: 60,
        indexes: [],
      })
      const stream = buildPullStream({
        channel,
        serverGen: GEN,
        initialSince: { gen: 0, counter: 0 },
        chunkSize: 100,
        noopIntervalMs: 5,
      })
      const frames = yield* decodeStream(stream, 2)
      expect(frames.length).toBe(2)
      expect(frames[0]?._tag).toBe("Data")
      const data = frames[0] as Extract<PullFrame, { _tag: "Data" }>
      expect(data.op).toBe("update")
      expect(data.partition).toBe("pri")
      expect(data.callRef).toBe("abc")
      expect(data.counter).toBe(1)
      expect(data.body).not.toBeNull()
      expect(decodeBuf(data.body as Buffer)).toEqual({ gen: 42, state: "active" })
      // Then a noop signaling caught-up at counter=1.
      expect(frames[1]?._tag).toBe("Noop")
      expect(frames[1]?.counter).toBe(1)
    })
  )

  it.live("frames are emitted in strictly ascending (gen, counter) order", () =>
    Effect.gen(function* () {
      const { channel } = setup()
      for (const ref of ["a", "b", "c", "d", "e"]) {
        yield* channel.write({ entryGen: GEN,
          partition: "pri",
          callRef: ref,
          bodyValue: bodyBuf({ gen: 42, ref }),
          bodyTtlSec: 60,
          indexes: [],
        })
      }
      const stream = buildPullStream({
        channel,
        serverGen: GEN,
        initialSince: { gen: 0, counter: 0 },
        chunkSize: 100,
        noopIntervalMs: 5,
      })
      const frames = yield* decodeStream(stream, 6) // 5 data + 1 noop
      const dataFrames = frames.filter(
        (f): f is Extract<PullFrame, { _tag: "Data" }> => f._tag === "Data"
      )
      expect(dataFrames.length).toBe(5)
      const counters = dataFrames.map((f) => f.counter)
      expect(counters).toEqual([1, 2, 3, 4, 5])
      // After the data frames, a noop at the head.
      expect(frames[5]?._tag).toBe("Noop")
      expect(frames[5]?.counter).toBe(5)
    })
  )
})

describe("buildPullStream — chunk_size honored, noop emitted on partial batch", () => {
  it.live("with chunk_size=2 and 5 entries, three batches: 2, 2, 1+noop", () =>
    Effect.gen(function* () {
      const { channel } = setup()
      for (const ref of ["a", "b", "c", "d", "e"]) {
        yield* channel.write({ entryGen: GEN,
          partition: "pri",
          callRef: ref,
          bodyValue: bodyBuf({}),
          bodyTtlSec: 60,
          indexes: [],
        })
      }
      const stream = buildPullStream({
        channel,
        serverGen: GEN,
        initialSince: { gen: 0, counter: 0 },
        chunkSize: 2,
        noopIntervalMs: 5,
      })
      // Expect 5 data frames + 1 noop (after the partial third batch).
      const frames = yield* decodeStream(stream, 6)
      const tags = frames.map((f) => f._tag)
      expect(tags).toEqual(["Data", "Data", "Data", "Data", "Data", "Noop"])
      const counters = frames
        .filter((f): f is Extract<PullFrame, { _tag: "Data" }> => f._tag === "Data")
        .map((f) => f.counter)
      expect(counters).toEqual([1, 2, 3, 4, 5])
    })
  )
})

describe("buildPullStream — sinceCounter respected", () => {
  it.live("initialSince > 0 skips earlier entries", () =>
    Effect.gen(function* () {
      const { channel } = setup()
      for (const ref of ["a", "b", "c"]) {
        yield* channel.write({ entryGen: GEN,
          partition: "pri",
          callRef: ref,
          bodyValue: bodyBuf({}),
          bodyTtlSec: 60,
          indexes: [],
        })
      }
      const stream = buildPullStream({
        channel,
        serverGen: GEN,
        initialSince: { gen: GEN, counter: 1 }, // skip a (score=1)
        chunkSize: 100,
        noopIntervalMs: 5,
      })
      const frames = yield* decodeStream(stream, 3) // 2 data + 1 noop
      const dataFrames = frames.filter(
        (f): f is Extract<PullFrame, { _tag: "Data" }> => f._tag === "Data"
      )
      expect(dataFrames.length).toBe(2)
      expect(dataFrames.map((f) => f.callRef)).toEqual(["b", "c"])
      expect(dataFrames.map((f) => f.counter)).toEqual([2, 3])
    })
  )
})

describe("buildPullStream — tombstones surface as delete frames", () => {
  it.live("a tombstone produces a Data frame with op=delete", () =>
    Effect.gen(function* () {
      const { channel } = setup()
      yield* channel.write({ entryGen: GEN,
        partition: "pri",
        callRef: "x",
        bodyValue: bodyBuf({ gen: 42 }),
        bodyTtlSec: 60,
        indexes: [],
      })
      yield* channel.tombstone({
        entryGen: GEN,
        partition: "pri",
        callRef: "x",
        indexesToRemove: [],
      })
      const stream = buildPullStream({
        channel,
        serverGen: GEN,
        initialSince: { gen: 0, counter: 0 },
        chunkSize: 100,
        noopIntervalMs: 5,
      })
      const frames = yield* decodeStream(stream, 3) // U + D + noop
      expect(frames[0]?._tag).toBe("Data")
      expect((frames[0] as Extract<PullFrame, { _tag: "Data" }>).op).toBe("update")
      expect(frames[1]?._tag).toBe("Data")
      expect((frames[1] as Extract<PullFrame, { _tag: "Data" }>).op).toBe("delete")
      expect(frames[2]?._tag).toBe("Noop")
    })
  )

  it.live("when the source body is missing, delete frame surfaces with body=null", () =>
    Effect.gen(function* () {
      // We model the post-tombstone-TTL state by writing the tombstone
      // then directly deleting the body — equivalent to TTL having
      // fired, without needing TestClock (which doesn't compose with
      // real-clock streaming).
      const { kv, channel } = setup()
      yield* channel.tombstone({
        entryGen: GEN,
        partition: "pri",
        callRef: "x",
        indexesToRemove: [],
      })
      yield* kv.bodyDel("pri:worker-A:call:x")
      const stream = buildPullStream({
        channel,
        serverGen: GEN,
        initialSince: { gen: 0, counter: 0 },
        chunkSize: 100,
        noopIntervalMs: 5,
      })
      const frames = yield* decodeStream(stream, 2)
      const data = frames[0] as Extract<PullFrame, { _tag: "Data" }>
      expect(data._tag).toBe("Data")
      expect(data.op).toBe("delete")
      expect(data.body).toBeNull()
    })
  )
})
