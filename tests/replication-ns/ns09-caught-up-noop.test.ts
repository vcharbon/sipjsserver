/**
 * NS9 — caught-up signaling via noop frame.
 *
 * Scenario:
 *   1. Server has zero entries.
 *   2. Puller opens stream → first frame is noop at counter=0 (caught up).
 *   3. Source writes call X.
 *   4. Next frame on the stream is the data frame for X.
 *   5. After X, another noop signals caught-up at counter=1.
 *
 * Variant: in-memory `KvBackend` + fake clock. Real-Redis variant lands
 * with the hybrid clock pump.
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
import { bodyBuf } from "../support/codecHelpers.js"

// Length-prefixed-msgpack frame re-assembler (mirrors
// `src/replication/NdjsonStream.ts:streamLengthPrefixedFrames`).
const decodeStream = (
  stream: Stream.Stream<Uint8Array>,
  takeFrames: number
): Effect.Effect<ReadonlyArray<PullFrame>, never> =>
  Effect.gen(function* () {
    let acc: Buffer = Buffer.alloc(0)
    const frames: Array<PullFrame> = []
    const chunks: ReadonlyArray<Uint8Array> = yield* Stream.runCollect(
      stream.pipe(Stream.take(takeFrames * 4))
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

describe("NS9 — caught-up-noop signal", () => {
  it.live("empty channel: first frame is noop at counter=0 → puller flips everCaughtUp", () =>
    Effect.gen(function* () {
      const store = MutableHashMap.empty<string, MemoryStoreEntry>()
      const kv = KvBackend.makeMemoryUnsafe(store)
      const channel = ChannelIndex.make(
        { self: "worker-A", peer: "worker-B", gen: 1 },
        kv
      )
      const stream = buildPullStream({
        channel,
        serverGen: 1,
        initialSince: { gen: 0, counter: 0 },
        chunkSize: 100,
        noopIntervalMs: 5,
      })
      const frames = yield* decodeStream(stream, 1)
      expect(frames.length).toBe(1)
      expect(frames[0]?._tag).toBe("Noop")
      expect(frames[0]?.counter).toBe(0)
    })
  )

  it.live("write → puller sees data frame then noop, signaling caught-up at new head", () =>
    Effect.gen(function* () {
      const store = MutableHashMap.empty<string, MemoryStoreEntry>()
      const kv = KvBackend.makeMemoryUnsafe(store)
      const channel = ChannelIndex.make(
        { self: "worker-A", peer: "worker-B", gen: 1 },
        kv
      )
      yield* channel.write({
        entryGen: channel.gen,
        partition: "pri",
        callRef: "X",
        bodyValue: bodyBuf({ gen: 1, state: "active" }),
        bodyTtlSec: 60,
        indexes: [],
      })
      const stream = buildPullStream({
        channel,
        serverGen: 1,
        initialSince: { gen: 0, counter: 0 },
        chunkSize: 100,
        noopIntervalMs: 5,
      })
      const frames = yield* decodeStream(stream, 2)
      expect(frames[0]?._tag).toBe("Data")
      expect((frames[0] as Extract<PullFrame, { _tag: "Data" }>).callRef).toBe("X")
      expect((frames[0] as Extract<PullFrame, { _tag: "Data" }>).counter).toBe(1)
      expect(frames[1]?._tag).toBe("Noop")
      expect(frames[1]?.counter).toBe(1)
    })
  )
})
