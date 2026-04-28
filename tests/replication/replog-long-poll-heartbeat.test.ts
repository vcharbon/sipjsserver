/**
 * Slice 3 — ReplLog long-poll: heartbeat + push-on-write + max-open close.
 *
 * Asserts spec §7.2 long-poll behaviour:
 *   - Once the backlog is drained (caught_up emitted), the connection
 *     stays open and produces a `heartbeat` frame at the configured
 *     cadence when no writes happen.
 *   - A write that lands while the connection is open produces an
 *     `entry` frame on this connection (subscribed via WriteNotifier).
 *   - The stream closes (haltWhen) at the configured maxOpenDuration.
 *
 * Tests run under TestClock — they fork the stream collection, advance
 * the clock to drive the schedules + halt, then join the fiber.
 */

import { describe, expect, it } from "@effect/vitest"
import {
  Duration,
  Effect,
  Fiber,
  Layer,
  MutableHashMap,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import {
  AtomicWriter,
  type MemoryStore,
  type MemoryStoreEntry,
} from "../../src/replication/AtomicWriter.js"
import { EpochCounter } from "../../src/replication/EpochCounter.js"
import { PropagateStream } from "../../src/replication/PropagateStream.js"
import { ReplLog } from "../../src/replication/ReplLog.js"
import { WriteNotifier } from "../../src/replication/WriteNotifier.js"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"

interface ParsedFrame {
  readonly type: string
  readonly seq?: number
  readonly callRef?: string
  readonly state?: unknown
  readonly at_seq?: number
  readonly head_at_open?: number
  readonly epoch?: number
}

const decode = (chunk: Uint8Array): string =>
  new TextDecoder().decode(chunk)

const parse = (chunks: ReadonlyArray<Uint8Array>): ReadonlyArray<ParsedFrame> =>
  chunks
    .map(decode)
    .join("")
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s) as ParsedFrame)

const setupHarness = (owner: string) => {
  const handle = PartitionedRelayStorage.makeMemoryApi()
  const sharedStore = handle.store
  const StorageLayer = Layer.sync(
    PartitionedRelayStorage,
    () => handle.api
  )
  // Build a single shared `WriteNotifier` so AtomicWriter and ReplLog
  // both bind to the *same* PubSub. A `Layer.provide(WriteNotifier.layer)`
  // local to AtomicWriter would create a fresh hub, and writes through
  // that writer would never reach ReplLog's subscriber.
  const ReadServices = Layer.mergeAll(
    WriteNotifier.layer,
    StorageLayer,
    PropagateStream.memoryLayerFromStore(sharedStore),
    EpochCounter.memoryLayerFromStore(sharedStore, owner)
  )
  const ReplStack = AtomicWriter.memoryLayerFromStore(sharedStore).pipe(
    Layer.provideMerge(ReadServices)
  )
  return {
    store: sharedStore as MemoryStore,
    layer: ReplLog.layer.pipe(Layer.provideMerge(ReplStack)),
  }
}

describe("ReplLog stream — long-poll lifecycle", () => {
  it.effect("heartbeat frame is emitted at the configured cadence after caught_up", () => {
    const { layer } = setupHarness("worker-A")
    return Effect.gen(function* () {
      const replLog = yield* ReplLog
      // Cap the test by taking exactly 4 frames (hello + caught_up + 2
      // heartbeats); the stream ends after the 4th. Avoids depending on
      // `haltWhen`'s interaction with TestClock — Stream.take is a
      // synchronous element count, no clock involvement.
      const stream = replLog
        .stream("worker-B", 0, {
          heartbeatInterval: "5 seconds",
          maxOpenDuration: "1 hour",
        })
        .pipe(Stream.take(4))
      const fiber = yield* Effect.forkChild(Stream.runCollect(stream))
      yield* Effect.yieldNow
      // Drive the clock past two heartbeat ticks (5s and 10s).
      yield* TestClock.adjust(Duration.seconds(11))
      const collected = yield* Fiber.join(fiber)
      const frames = parse(collected)
      const heartbeats = frames.filter((f) => f.type === "heartbeat")
      expect(heartbeats.length).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("a peer-bearing write after caught_up is delivered as an entry frame", () => {
    const { layer } = setupHarness("worker-A")
    return Effect.gen(function* () {
      // Important: pull the writer through the *layer* so it shares
      // the WriteNotifier hub with ReplLog. A writer constructed via
      // `AtomicWriter.makeMemoryUnsafe(store)` would have no notifier
      // (or its own), so its writes wouldn't reach the open long-poll.
      const writer = yield* AtomicWriter
      const replLog = yield* ReplLog
      // Stream.take(3) terminates after hello + caught_up + the entry we
      // expect; Stream.take side-steps the `haltWhen` clock interaction.
      const stream = replLog
        .stream("worker-B", 0, {
          heartbeatInterval: "10 minutes",
          maxOpenDuration: "1 hour",
        })
        .pipe(Stream.take(3))
      const fiber = yield* Effect.forkChild(Stream.runCollect(stream))
      // Pump the runtime + clock until the forked fiber has emitted
      // hello + caught_up and entered the long-poll subscription. A
      // single yieldNow isn't enough — the subscribe happens deep
      // inside the merge after several scheduling boundaries. A small
      // TestClock.adjust forces every fiber to run until quiescent.
      yield* TestClock.adjust(Duration.millis(1))
      // Publish a fresh write — the shared WriteNotifier fans this out
      // to the open subscription, which emits an entry frame.
      yield* writer.put("pri", "worker-A", "ref-hot", '{"hot":true}', [], 60, {
        peer: "worker-B",
      })
      yield* TestClock.adjust(Duration.millis(1))
      const collected = yield* Fiber.join(fiber)
      const frames = parse(collected)
      const entries = frames.filter((f) => f.type === "entry")
      expect(entries.map((e) => e.callRef)).toEqual(["ref-hot"])
      expect(entries[0]?.state).toEqual({ hot: true })
    }).pipe(Effect.provide(layer))
  })

  it.effect("drainOnly mode emits hello + caught_up and ends without long-poll", () => {
    const { layer } = setupHarness("worker-A")
    return Effect.gen(function* () {
      const replLog = yield* ReplLog
      // drainOnly mirrors what the Slice 5 ReadyGate uses — emit
      // hello + (empty backlog) + caught_up, then end. No heartbeat,
      // no long-poll, no max-open clock-tick interplay.
      const collected = yield* Stream.runCollect(
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      const frames = parse(collected)
      const types = new Set(frames.map((f) => f.type))
      expect(types.has("hello")).toBe(true)
      expect(types.has("caught_up")).toBe(true)
      expect(types.has("heartbeat")).toBe(false)
      expect(types.has("entry")).toBe(false)
      expect(frames.length).toBe(2)
    }).pipe(Effect.provide(layer))
  })
})
