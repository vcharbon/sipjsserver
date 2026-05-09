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

const decodeStream = (
  stream: Stream.Stream<Uint8Array>,
  takeFrames: number
): Effect.Effect<ReadonlyArray<PullFrame>, never> =>
  Effect.gen(function* () {
    const decoder = new TextDecoder()
    let buffer = ""
    const frames: Array<PullFrame> = []
    const chunks: ReadonlyArray<Uint8Array> = yield* Stream.runCollect(
      stream.pipe(Stream.take(takeFrames * 4))
    )
    for (const chunk of chunks) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl = buffer.indexOf("\n")
      while (nl !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const frame = decodeFrame(line)
        if (frame !== null) {
          frames.push(frame)
          if (frames.length >= takeFrames) return frames
        }
        nl = buffer.indexOf("\n")
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
        gen: 1,
        initialSince: 0,
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
        partition: "pri",
        callRef: "X",
        bodyValue: '{"gen":1,"state":"active"}',
        bodyTtlSec: 60,
        indexes: [],
      })
      const stream = buildPullStream({
        channel,
        gen: 1,
        initialSince: 0,
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
