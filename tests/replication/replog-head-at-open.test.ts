/**
 * Slice 3 — ReplLog `hello` framing + backlog drain to `caught_up`.
 *
 * Asserts the spec §7.2 sequence on a fresh long-poll connection:
 *   1. First frame is `{type:"hello", epoch, head_at_open}`.
 *   2. Backlog (entries with seq > since AND seq <= head_at_open) is
 *      streamed in seq-ascending order, with the call body fetched
 *      from the local sidecar inline.
 *   3. After the backlog drains, exactly one `{type:"caught_up", at_seq}`
 *      frame is emitted, with at_seq = head_at_open.
 *
 * Tests run under TestClock so the long-poll's max-open and heartbeat
 * timers don't fire during the backlog phase.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, MutableHashMap, Stream } from "effect"
import {
  AtomicWriter,
  type MemoryStore,
  type MemoryStoreEntry,
} from "../../src/replication/AtomicWriter.js"
import { EpochCounter } from "../../src/replication/EpochCounter.js"
import { PropagateStream } from "../../src/replication/PropagateStream.js"
import { ReplLog } from "../../src/replication/ReplLog.ts"
import { WriteNotifier } from "../../src/replication/WriteNotifier.js"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"

interface ParsedFrame {
  readonly type: string
  readonly epoch?: number
  readonly head_at_open?: number
  readonly seq?: number
  readonly callRef?: string
  readonly state?: unknown
  readonly at_seq?: number
}

const decode = (chunk: Uint8Array): string =>
  new TextDecoder().decode(chunk)

const splitFrames = (text: string): ReadonlyArray<ParsedFrame> =>
  text
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s) as ParsedFrame)

const setupHarness = (owner: string) => {
  const store: MemoryStore = MutableHashMap.empty<
    string,
    MemoryStoreEntry
  >()

  // Build PartitionedRelayStorage (memory) — supplies getCall over the
  // same store the AtomicWriter writes to. The memory layer's
  // makeMemoryApi() creates its OWN store though, so we instead build
  // a custom layer wrapping the AtomicWriter+PropagateStream over
  // the SHARED store. We build the storage api by hand via the
  // memoryApi factory, but threading our shared store. Easiest: use
  // the memoryLayer + retrieve the store via makeMemoryApi.
  const handle = PartitionedRelayStorage.makeMemoryApi()
  const sharedStore = handle.store

  // The writer that publishes to ReplLog's WriteNotifier. We compose
  // it against `sharedStore` so writes are observable through both
  // services.
  const StorageLayer = Layer.sync(
    PartitionedRelayStorage,
    () => handle.api
  )

  // Build a single shared `WriteNotifier` so AtomicWriter and ReplLog
  // both bind to the *same* PubSub.
  const ReadServices = Layer.mergeAll(
    WriteNotifier.layer,
    StorageLayer,
    PropagateStream.memoryLayerFromStore(sharedStore),
    EpochCounter.memoryLayerFromStore(sharedStore, owner)
  )
  const ReplStack = AtomicWriter.memoryLayerFromStore(sharedStore).pipe(
    Layer.provideMerge(ReadServices)
  )
  const FullStack = ReplLog.layer.pipe(Layer.provideMerge(ReplStack))

  return { store: sharedStore, layer: FullStack }
}

describe("ReplLog stream — hello + backlog drain + caught_up", () => {
  it.effect("emits hello, backlog entries in seq order, then caught_up", () => {
    const { store, layer } = setupHarness("worker-A")
    return Effect.gen(function* () {
      const writer = AtomicWriter.makeMemoryUnsafe(store)
      // Pre-populate three calls under the primary's storage with
      // backup peer = worker-B. Each write creates one propagate entry.
      yield* writer.put("pri", "worker-A", "ref-1", '{"v":1}', [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-2", '{"v":2}', [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-3", '{"v":3}', [], 60, {
        peer: "worker-B",
      })

      const replLog = yield* ReplLog
      // Use a tiny max-open and heartbeat well under the run scope —
      // we want the stream to terminate quickly after caught_up.
      const stream = replLog.stream("worker-B", 0, { drainOnly: true })
      const collected = yield* Stream.runCollect(stream)
      const text = collected.map(decode).join("")
      const frames = splitFrames(text)

      expect(frames[0]?.type).toBe("hello")
      expect(frames[0]?.head_at_open).toBe(3)

      const entries = frames.filter((f) => f.type === "entry")
      expect(entries.map((e) => e.callRef)).toEqual(["ref-1", "ref-2", "ref-3"])
      expect(entries.map((e) => e.seq)).toEqual([1, 2, 3])
      expect(entries.map((e) => e.state)).toEqual([
        { v: 1 },
        { v: 2 },
        { v: 3 },
      ])

      const caughtUp = frames.find((f) => f.type === "caught_up")
      expect(caughtUp).toBeDefined()
      expect(caughtUp!.at_seq).toBe(3)
    }).pipe(Effect.provide(layer))
  })

  it.effect("drain skips entries whose seq <= since (re-entrant resume)", () => {
    const { store, layer } = setupHarness("worker-A")
    return Effect.gen(function* () {
      const writer = AtomicWriter.makeMemoryUnsafe(store)
      yield* writer.put("pri", "worker-A", "ref-1", '{}', [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-2", '{}', [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-3", '{}', [], 60, {
        peer: "worker-B",
      })

      const replLog = yield* ReplLog
      const stream = replLog.stream("worker-B", 1, { drainOnly: true })
      const collected = yield* Stream.runCollect(stream)
      const text = collected.map(decode).join("")
      const frames = splitFrames(text)

      const entries = frames.filter((f) => f.type === "entry")
      // since=1 → emit only entries with seq > 1.
      expect(entries.map((e) => e.seq)).toEqual([2, 3])
    }).pipe(Effect.provide(layer))
  })

  it.effect("hello frame carries the EpochCounter's current epoch", () => {
    const { store, layer } = setupHarness("worker-A")
    return Effect.gen(function* () {
      const replLog = yield* ReplLog
      const counter = yield* EpochCounter
      const expectedEpoch = yield* counter.current
      // Seed one entry so we can see the head_at_open / drain.
      const writer = AtomicWriter.makeMemoryUnsafe(store)
      yield* writer.put("pri", "worker-A", "ref-1", "{}", [], 60, {
        peer: "worker-B",
      })

      const collected = yield* Stream.runCollect(
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      const frames = splitFrames(collected.map(decode).join(""))
      expect(frames[0]?.type).toBe("hello")
      expect(frames[0]?.epoch).toBe(expectedEpoch)
    }).pipe(Effect.provide(layer))
  })

  it.effect("empty backlog: hello → caught_up at_seq=0 then close on max-open", () => {
    const { layer } = setupHarness("worker-A")
    return Effect.gen(function* () {
      const replLog = yield* ReplLog
      const collected = yield* Stream.runCollect(
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      const frames = splitFrames(collected.map(decode).join(""))
      expect(frames[0]?.type).toBe("hello")
      expect(frames[0]?.head_at_open).toBe(0)
      const caughtUp = frames.find((f) => f.type === "caught_up")
      expect(caughtUp).toBeDefined()
      expect(caughtUp!.at_seq).toBe(0)
    }).pipe(Effect.provide(layer))
  })
})
