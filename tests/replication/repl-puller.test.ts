/**
 * Slice 4 — ReplPuller convergence + re-entrancy.
 *
 * Asserts:
 *   - Pulling a peer's `/replog` stream applies every entry to the
 *     local sidecar's `bak:{peer}:` partition.
 *   - `replpos:{peer}` advances per-entry; a second pull resumes from
 *     `lastSeq` and skips already-applied entries (idempotent).
 *   - Epoch advance on the producer triggers a full resync (lastSeq=0
 *     reset) on the consumer.
 *
 * Producer side: a real ReplLog wired to a producer-side store. The
 * test pipes `replLog.stream(...)` directly into the puller's
 * `applyStream` — no HTTP, no socket, but the wire format is the
 * actual NDJSON the production HTTP path would carry.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, MutableHashMap, Option, Stream } from "effect"
import {
  AtomicWriter,
  type MemoryStore,
  type MemoryStoreEntry,
} from "../../src/replication/AtomicWriter.js"
import { EpochCounter } from "../../src/replication/EpochCounter.js"
import { PropagateStream } from "../../src/replication/PropagateStream.js"
import { ReplLog } from "../../src/replication/ReplLog.js"
import { ReplPuller } from "../../src/replication/ReplPuller.js"
import { WriteNotifier } from "../../src/replication/WriteNotifier.js"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"

const setupProducer = (owner: string) => {
  const handle = PartitionedRelayStorage.makeMemoryApi()
  const store = handle.store
  const StorageLayer = Layer.sync(
    PartitionedRelayStorage,
    () => handle.api
  )
  const ReadServices = Layer.mergeAll(
    WriteNotifier.layer,
    StorageLayer,
    PropagateStream.memoryLayerFromStore(store),
    EpochCounter.memoryLayerFromStore(store, owner)
  )
  const ReplStack = AtomicWriter.memoryLayerFromStore(store).pipe(
    Layer.provideMerge(ReadServices)
  )
  return {
    store,
    layer: ReplLog.layer.pipe(Layer.provideMerge(ReplStack)),
  }
}

const consumerStore = (): MemoryStore =>
  MutableHashMap.empty<string, MemoryStoreEntry>()

describe("ReplPuller — apply backlog from a peer's /replog stream", () => {
  it.effect("drains the producer's backlog and writes bak: entries on the consumer", () => {
    const producer = setupProducer("worker-A")
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter)

    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
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
      const upstream = replLog.stream("worker-B", 0, { drainOnly: true })
      const result = yield* puller.applyStream("worker-A", upstream)

      expect(result.framesApplied).toBe(3)
      expect(result.caughtUpAtSeq).toBe(3)

      // Consumer's bak:worker-A:call:* partition is populated.
      const bak1 = MutableHashMap.get(
        consumer,
        AtomicWriter.callKey("bak", "worker-A", "ref-1")
      )
      expect(Option.isSome(bak1)).toBe(true)
      expect(Option.isSome(bak1) ? bak1.value.value : "").toContain('"v":1')

      // replpos:worker-A persisted with lastSeq=3.
      const pos = yield* puller.readPos("worker-A")
      expect(pos.lastSeq).toBe(3)
    }).pipe(Effect.provide(producer.layer))
  })

  it.effect("resume: a second pull starts at lastSeq and skips already-applied entries", () => {
    const producer = setupProducer("worker-A")
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter)

    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      const replLog = yield* ReplLog

      // Round 1 — write 2 entries, pull, verify state.
      yield* writer.put("pri", "worker-A", "ref-1", "{}", [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-2", "{}", [], 60, {
        peer: "worker-B",
      })
      const r1 = yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      expect(r1.framesApplied).toBe(2)

      // Round 2 — write 2 more, pull resuming from lastSeq=2.
      yield* writer.put("pri", "worker-A", "ref-3", "{}", [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-4", "{}", [], 60, {
        peer: "worker-B",
      })
      const pos = yield* puller.readPos("worker-A")
      const r2 = yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", pos.lastSeq, { drainOnly: true })
      )
      // Only the new entries (seq 3 and 4) are applied this round.
      expect(r2.framesApplied).toBe(2)
      const finalPos = yield* puller.readPos("worker-A")
      expect(finalPos.lastSeq).toBe(4)
    }).pipe(Effect.provide(producer.layer))
  })

  it.effect("idempotent re-apply: replaying an entry whose seq <= lastSeq is a no-op", () => {
    const producer = setupProducer("worker-A")
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter)

    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      yield* writer.put("pri", "worker-A", "ref-1", "{}", [], 60, {
        peer: "worker-B",
      })
      const replLog = yield* ReplLog

      // First pull — applies the single entry.
      const r1 = yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      expect(r1.framesApplied).toBe(1)

      // Second pull from since=0 — same entry replayed; lastSeq guards
      // it as a no-op (framesApplied=0).
      const r2 = yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      expect(r2.framesApplied).toBe(0)
    }).pipe(Effect.provide(producer.layer))
  })
})

describe("ReplPuller — epoch mismatch resync", () => {
  it.effect("a hello with a different epoch resets lastSeq to 0", () => {
    const producer = setupProducer("worker-A")
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter)

    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      const replLog = yield* ReplLog

      // Seed an entry under the current epoch, pull, verify.
      yield* writer.put("pri", "worker-A", "ref-1", "{}", [], 60, {
        peer: "worker-B",
      })
      yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      const pos1 = yield* puller.readPos("worker-A")
      expect(pos1.epoch).toBeGreaterThan(0)
      expect(pos1.lastSeq).toBe(1)

      // Forge a stale replpos with the wrong epoch — simulates the
      // case where the producer rebooted (epoch advanced) but our
      // bookkeeping still references the old incarnation.
      MutableHashMap.set(consumer, "replpos:worker-A", {
        value: JSON.stringify({ epoch: 99, lastSeq: 5 }),
        expiresAtMs: Number.MAX_SAFE_INTEGER,
      })

      // Pull again — the hello frame's epoch differs from 99, so the
      // puller resets lastSeq=0 and re-applies the entry from seq=0.
      const r = yield* puller.applyStream(
        "worker-A",
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      const pos2 = yield* puller.readPos("worker-A")
      expect(pos2.epoch).toBe(pos1.epoch) // adopted producer's epoch
      // After resync, the entry was re-applied (lastSeq=1).
      expect(pos2.lastSeq).toBe(1)
      // framesApplied = 1 because the reset made the seq>lastSeq check pass again.
      expect(r.framesApplied).toBe(1)
    }).pipe(Effect.provide(producer.layer))
  })
})
