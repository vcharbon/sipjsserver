/**
 * Slice A — replication observability tests.
 *
 * Asserts the four signals added to `ReplMetrics`:
 *   - `recordSeen`/`recordApplied` populate the `lagSeq` gauge as the
 *     difference between the two.
 *   - The forked sampler fiber emits a 1s aggregation log every 5 ticks
 *     and updates the instant gauges.
 *   - `recordFrameLag` populates the histogram per peer.
 *   - The connection_event server logs (server-open/hello/caught-up/
 *     close) fire on the corresponding stream points.
 *   - The connection_event client logs fire on applyStream open / hello /
 *     caught_up / close.
 *   - An `entry` frame WITH `tx_ms` populates the histogram on the
 *     consumer; one WITHOUT `tx_ms` does not.
 */

import { describe, expect, it } from "@effect/vitest"
import {
  Duration,
  Effect,
  Layer,
  Logger,
  MutableHashMap,
  References,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"
import {
  AtomicWriter,
  type MemoryStore,
  type MemoryStoreEntry,
} from "../../src/replication/AtomicWriter.js"
import { EpochCounter } from "../../src/replication/EpochCounter.js"
import { PropagateStream } from "../../src/replication/PropagateStream.js"
import { ReplLog } from "../../src/replication/ReplLog.js"
import { ReplMetrics } from "../../src/replication/ReplMetrics.js"
import { ReplPuller } from "../../src/replication/ReplPuller.js"
import { WriteNotifier } from "../../src/replication/WriteNotifier.js"

interface CapturedLog {
  readonly level: string
  readonly message: unknown
  readonly annotations: Readonly<Record<string, unknown>>
}

const makeCapturingLogger = (sink: CapturedLog[]) =>
  Logger.make((opts) => {
    const annotations = opts.fiber.getRef(References.CurrentLogAnnotations)
    sink.push({
      level: opts.logLevel,
      message: opts.message,
      annotations: { ...(annotations as Readonly<Record<string, unknown>>) },
    })
  })

const messageStr = (m: unknown): string => {
  if (Array.isArray(m)) return m.map((x) => String(x)).join(" ")
  return String(m)
}

const setupHarness = (owner: string) => {
  const handle = PartitionedRelayStorage.makeMemoryApi()
  const sharedStore = handle.store
  const StorageLayer = Layer.sync(PartitionedRelayStorage, () => handle.api)
  const ReadServices = Layer.mergeAll(
    WriteNotifier.layer,
    StorageLayer,
    PropagateStream.memoryLayerFromStore(sharedStore),
    EpochCounter.memoryLayerFromStore(sharedStore, owner)
  )
  const ReplStack = AtomicWriter.memoryLayerFromStore(sharedStore).pipe(
    Layer.provideMerge(ReadServices)
  )
  const Metrics = ReplMetrics.layer.pipe(Layer.provideMerge(ReplStack))
  return {
    store: sharedStore as MemoryStore,
    layer: ReplLog.layer.pipe(Layer.provideMerge(Metrics)),
  }
}

describe("ReplMetrics — record API populates the snapshot", () => {
  it.effect("recordSeen / recordApplied set lagSeq = seen - applied", () => {
    const { layer } = setupHarness("worker-A")
    return Effect.gen(function* () {
      const metrics = yield* ReplMetrics
      yield* metrics.recordSeen("worker-B", 10)
      yield* metrics.recordApplied("worker-B", 7)
      // Drive the sampler at least once so the cell.lagSeq instant
      // gauge reflects (seen - applied).
      yield* TestClock.adjust(Duration.millis(200))
      const snap = yield* metrics.snapshot
      const entry = snap.perPeer.find(([p]) => p === "worker-B")
      expect(entry).toBeDefined()
      expect(entry?.[1].lagSeq).toBe(3)
    }).pipe(Effect.provide(layer))
  })

  it.effect("recordFrameLag observes into the histogram", () => {
    const { layer } = setupHarness("worker-A")
    return Effect.gen(function* () {
      const metrics = yield* ReplMetrics
      yield* metrics.recordFrameLag("worker-B", 3)
      yield* metrics.recordFrameLag("worker-B", 7)
      yield* metrics.recordFrameLag("worker-B", 25)
      const snap = yield* metrics.snapshot
      const entry = snap.perPeer.find(([p]) => p === "worker-B")
      expect(entry).toBeDefined()
      const hist = entry![1].frameLag
      expect(hist.count).toBe(3)
      expect(hist.sum).toBe(35)
      // 3 falls in bucket-0 (le=1? no, 3 > 1, so le=5), 7 → le=10,
      // 25 → le=50. Buckets are [1,5,10,50,100,500,1000,5000].
      // 3 lands in bucket index 1 (le=5), 7 in bucket index 2 (le=10),
      // 25 in bucket index 3 (le=50).
      expect(hist.counts[1]).toBe(1)
      expect(hist.counts[2]).toBe(1)
      expect(hist.counts[3]).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("sampler fiber emits a 1s aggregation log after 5 ticks", () => {
    const { layer } = setupHarness("worker-A")
    const sink: CapturedLog[] = []
    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      const metrics = yield* ReplMetrics
      // Seed the cell with a write so the sampler sees this peer.
      yield* writer.put("pri", "worker-A", "ref-seed", "{}", [], 60, {
        peer: "worker-B",
      })
      // Inject a non-zero lag so the sampled values aren't all zero.
      yield* metrics.recordSeen("worker-B", 100)
      yield* metrics.recordApplied("worker-B", 95)
      // 5 sample ticks @ 200ms = 1 window. Use 1100ms so the 5th tick
      // has fully fired.
      yield* TestClock.adjust(Duration.millis(1100))
      const samplerLogs = sink
        .filter((e) => messageStr(e.message).includes("repl: sampler-window"))
      expect(samplerLogs.length).toBeGreaterThanOrEqual(1)
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Logger.layer([makeCapturingLogger(sink)])),
      Effect.provideService(References.MinimumLogLevel, "Info")
    )
  })
})

describe("ReplLog — connection_event server logs fire on stream lifecycle", () => {
  it.effect("server-open / server-hello / server-caught-up fire on drainOnly stream", () => {
    const { layer } = setupHarness("worker-A")
    const sink: CapturedLog[] = []
    return Effect.gen(function* () {
      const replLog = yield* ReplLog
      yield* Stream.runCollect(
        replLog.stream("worker-B", 0, { drainOnly: true })
      )
      const messages = sink.map((e) => messageStr(e.message))
      expect(messages.some((m) => m.includes("repl: server-open"))).toBe(true)
      expect(messages.some((m) => m.includes("repl: server-hello"))).toBe(true)
      expect(messages.some((m) => m.includes("repl: server-caught-up"))).toBe(
        true
      )
      expect(messages.some((m) => m.includes("repl: server-close"))).toBe(true)
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Logger.layer([makeCapturingLogger(sink)])),
      Effect.provideService(References.MinimumLogLevel, "Debug")
    )
  })
})

describe("ReplPuller — connection_event client logs and frame_lag recording", () => {
  it.effect("client-open / client-hello / client-caught-up / client-close fire", () => {
    const { layer } = setupHarness("worker-A")
    const consumer = MutableHashMap.empty<string, MemoryStoreEntry>()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const sink: CapturedLog[] = []
    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      const replLog = yield* ReplLog
      const metrics = yield* ReplMetrics
      const puller = ReplPuller.makeMemoryUnsafe(
        consumer,
        consumerWriter,
        "worker-B",
        metrics
      )
      yield* writer.put("pri", "worker-A", "ref-1", '{"v":1}', [], 60, {
        peer: "worker-B",
      })
      const upstream = replLog.stream("worker-B", 0, { drainOnly: true })
      const result = yield* puller.applyStream("worker-A", upstream)
      expect(result.framesApplied).toBe(1)
      const messages = sink.map((e) => messageStr(e.message))
      expect(messages.some((m) => m.includes("repl: client-open"))).toBe(true)
      expect(messages.some((m) => m.includes("repl: client-hello"))).toBe(true)
      expect(messages.some((m) => m.includes("repl: client-caught-up"))).toBe(
        true
      )
      expect(messages.some((m) => m.includes("repl: client-close"))).toBe(true)
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Logger.layer([makeCapturingLogger(sink)])),
      Effect.provideService(References.MinimumLogLevel, "Info")
    )
  })

  it.effect("entry frame WITH tx_ms records into the histogram", () => {
    const { layer } = setupHarness("worker-A")
    const consumer = MutableHashMap.empty<string, MemoryStoreEntry>()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    return Effect.gen(function* () {
      const writer = yield* AtomicWriter
      const replLog = yield* ReplLog
      const metrics = yield* ReplMetrics
      const puller = ReplPuller.makeMemoryUnsafe(
        consumer,
        consumerWriter,
        "worker-B",
        metrics
      )
      yield* writer.put("pri", "worker-A", "ref-1", "{}", [], 60, {
        peer: "worker-B",
      })
      // Apply the live stream — the producer ReplLog stamps tx_ms on
      // every entry frame at emit time (Slice A wire-format change).
      const upstream = replLog.stream("worker-B", 0, { drainOnly: true })
      yield* puller.applyStream("worker-A", upstream)
      const snap = yield* metrics.snapshot
      const entry = snap.perPeer.find(([p]) => p === "worker-A")
      // The puller records under `peer` = its caller-of-applyStream
      // arg, which is "worker-A" here.
      expect(entry).toBeDefined()
      expect(entry![1].frameLag.count).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("synthetic entry frame WITHOUT tx_ms is silently ignored by the histogram", () => {
    const { layer } = setupHarness("worker-A")
    const consumer = MutableHashMap.empty<string, MemoryStoreEntry>()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    return Effect.gen(function* () {
      const metrics = yield* ReplMetrics
      const puller = ReplPuller.makeMemoryUnsafe(
        consumer,
        consumerWriter,
        "worker-B",
        metrics
      )
      // Hand-craft an NDJSON byte stream where the entry frame has no
      // tx_ms field, simulating an older producer build.
      const lines = [
        JSON.stringify({ type: "hello", epoch: 0, head_at_open: 1 }),
        JSON.stringify({
          type: "entry",
          seq: 1,
          callRef: "ref-1",
          state: { v: 1 },
          direction: "forward",
        }),
        JSON.stringify({ type: "caught_up", at_seq: 1 }),
      ]
      const encoder = new TextEncoder()
      const bytes = encoder.encode(lines.join("\n") + "\n")
      const upstream = Stream.make(bytes)
      const r = yield* puller.applyStream("worker-A", upstream)
      expect(r.framesApplied).toBe(1)
      const snap = yield* metrics.snapshot
      const entry = snap.perPeer.find(([p]) => p === "worker-A")
      expect(entry).toBeDefined()
      // The histogram stays empty because the entry carried no tx_ms.
      expect(entry![1].frameLag.count).toBe(0)
    }).pipe(Effect.provide(layer))
  })
})

describe("AtomicWriter.queueDepth — memory backend", () => {
  it.effect("returns 0 on an empty propagate set, growing as writes land", () =>
    Effect.gen(function* () {
      const store = MutableHashMap.empty<string, MemoryStoreEntry>()
      const writer = AtomicWriter.makeMemoryUnsafe(store)
      // Empty up-front.
      expect(yield* writer.queueDepth("worker-B")).toBe(0)
      // Two distinct callRefs ⇒ depth 2 (compaction happens within
      // the same callRef, not across; ZADD-replaces-score only
      // collapses repeated writes to the same member).
      yield* writer.put("pri", "worker-A", "ref-1", "{}", [], 60, {
        peer: "worker-B",
      })
      yield* writer.put("pri", "worker-A", "ref-2", "{}", [], 60, {
        peer: "worker-B",
      })
      expect(yield* writer.queueDepth("worker-B")).toBe(2)
      // A repeat write to ref-1 doesn't grow the set (same member).
      yield* writer.put("pri", "worker-A", "ref-1", "{}", [], 60, {
        peer: "worker-B",
      })
      expect(yield* writer.queueDepth("worker-B")).toBe(2)
    }).pipe(
      Effect.provide(WriteNotifier.noopLayer)
    )
  )
})

