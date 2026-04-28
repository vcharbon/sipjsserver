/**
 * Slice 5 — ReadyGate boot handshake.
 *
 * Asserts spec §8 behaviour:
 *   - Happy path: all enumerated peers drain to caught_up; readiness
 *     flips true; unreconciled is empty.
 *   - 30 s ceiling: a peer whose stream hangs forever is recorded as
 *     unreconciled when the ceiling fires; readiness still flips.
 *   - No peers (cold cluster): readiness flips immediately; both
 *     synced and unreconciled are empty.
 *
 * Tests run under TestClock. The ceiling-timeout test forks the
 * `run` Effect, advances time past the ceiling, then joins.
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
import { ReadyGate, ReplogClient } from "../../src/replication/ReadyGate.js"
import { ReplLog, type ReplLogApi } from "../../src/replication/ReplLog.js"
import { ReplPuller } from "../../src/replication/ReplPuller.js"
import { WriteNotifier } from "../../src/replication/WriteNotifier.js"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"
import { PeerEnumerator } from "../../src/cache/PeerEnumerator.js"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import { WorkerReadiness } from "../../src/cache/WorkerReadiness.js"

// Helpers ---------------------------------------------------------------

const consumerStore = (): MemoryStore =>
  MutableHashMap.empty<string, MemoryStoreEntry>()

const buildProducer = (owner: string) => {
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
  // Build everything bottom-up, then expose ReplLog + AtomicWriter +
  // the inner read services as one combined layer so test code can
  // `yield* AtomicWriter` and `yield* ReplLog` from the same scope.
  const StackWithWriter = AtomicWriter.memoryLayerFromStore(store).pipe(
    Layer.provideMerge(ReadServices)
  )
  return ReplLog.layer.pipe(Layer.provideMerge(StackWithWriter))
}

interface ProducerHarness {
  readonly run: <A, E>(eff: Effect.Effect<A, E, ReplLog | AtomicWriter>) => Effect.Effect<A, E>
  readonly streamFor: (caller: string) => Stream.Stream<Uint8Array, never>
}

const harnessFor = (owner: string): ProducerHarness => {
  const layer = buildProducer(owner)
  // The ReplLog instance is built once per harness and we close over it
  // so producer-side puts AND ReplLog.stream invocations share the same
  // underlying state (PropagateStream + AtomicWriter from the same store).
  let cachedReplLog: ReplLogApi | undefined

  const ensureLog = Effect.gen(function* () {
    if (cachedReplLog !== undefined) return cachedReplLog
    cachedReplLog = yield* ReplLog
    return cachedReplLog
  })

  return {
    run: <A, E>(eff: Effect.Effect<A, E, ReplLog | AtomicWriter>): Effect.Effect<A, E> =>
      eff.pipe(Effect.provide(layer)),
    streamFor: (caller: string): Stream.Stream<Uint8Array, never> =>
      Stream.unwrap(
        ensureLog.pipe(Effect.provide(layer), Effect.map((rl) => rl.stream(caller, 0, { drainOnly: true })))
      ),
  }
}

const PeerEnumeratorStatic = (peers: ReadonlyArray<string>) =>
  Layer.sync(PeerEnumerator, () => ({
    currentPeers: Effect.succeed(peers.map(WorkerOrdinal)),
  }))

interface ReadinessProbe {
  readonly readiness: { ready: boolean }
  readonly layer: Layer.Layer<WorkerReadiness>
}

const readinessProbe = (): ReadinessProbe => {
  const state = { ready: false }
  return {
    readiness: state,
    layer: Layer.sync(WorkerReadiness, () => ({
      markReady: (v: boolean) =>
        Effect.sync(() => {
          state.ready = v
        }),
      isReady: Effect.sync(() => state.ready),
    })),
  }
}

// Tests -----------------------------------------------------------------

describe("ReadyGate — happy path", () => {
  it.effect("all peers drain to caught_up; readiness flips; unreconciled empty", () => {
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter)
    const probe = readinessProbe()

    // Two peers, each with one entry in their propagate set.
    const peerB = harnessFor("worker-B")
    const peerC = harnessFor("worker-C")

    const ReplogClientLayer = Layer.sync(ReplogClient, () => ({
      streamFromPeer: (peer: string) => {
        if (peer === "worker-B") return peerB.streamFor("worker-A")
        if (peer === "worker-C") return peerC.streamFor("worker-A")
        return Stream.empty
      },
    }))

    const Stack = ReadyGate.layer().pipe(
      Layer.provide(
        Layer.mergeAll(
          PeerEnumeratorStatic(["worker-B", "worker-C"]),
          probe.layer,
          Layer.sync(ReplPuller, () => puller),
          ReplogClientLayer
        )
      )
    )

    return Effect.gen(function* () {
      // Seed each peer with one write so propagate has data to drain.
      yield* peerB.run(
        Effect.gen(function* () {
          const w = yield* AtomicWriter
          yield* w.put("pri", "worker-B", "ref-1", "{}", [], 60, {
            peer: "worker-A",
          })
        })
      )
      yield* peerC.run(
        Effect.gen(function* () {
          const w = yield* AtomicWriter
          yield* w.put("pri", "worker-C", "ref-2", "{}", [], 60, {
            peer: "worker-A",
          })
        })
      )

      const gate = yield* ReadyGate
      const result = yield* gate.run

      expect(result.synced.sort()).toEqual(["worker-B", "worker-C"])
      expect(result.unreconciled).toEqual([])
      expect(probe.readiness.ready).toBe(true)
    }).pipe(Effect.provide(Stack))
  })
})

describe("ReadyGate — empty cluster", () => {
  it.effect("no peers: readiness flips immediately, both lists empty", () => {
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter)
    const probe = readinessProbe()
    const ReplogClientLayer = Layer.sync(ReplogClient, () => ({
      streamFromPeer: () => Stream.empty,
    }))

    const Stack = ReadyGate.layer().pipe(
      Layer.provide(
        Layer.mergeAll(
          PeerEnumeratorStatic([]),
          probe.layer,
          Layer.sync(ReplPuller, () => puller),
          ReplogClientLayer
        )
      )
    )

    return Effect.gen(function* () {
      const gate = yield* ReadyGate
      const result = yield* gate.run
      expect(result.synced).toEqual([])
      expect(result.unreconciled).toEqual([])
      expect(probe.readiness.ready).toBe(true)
    }).pipe(Effect.provide(Stack))
  })
})

describe("ReadyGate — 30 s ceiling", () => {
  it.effect("a peer whose stream never ends is recorded as unreconciled", () => {
    const consumer = consumerStore()
    const consumerWriter = AtomicWriter.makeMemoryUnsafe(consumer)
    const puller = ReplPuller.makeMemoryUnsafe(consumer, consumerWriter)
    const probe = readinessProbe()

    // Stream.never never produces a frame ⇒ caught_up never seen.
    const ReplogClientLayer = Layer.sync(ReplogClient, () => ({
      streamFromPeer: () => Stream.never,
    }))

    const Stack = ReadyGate.layer({ maxDuration: "5 seconds" }).pipe(
      Layer.provide(
        Layer.mergeAll(
          PeerEnumeratorStatic(["worker-Z"]),
          probe.layer,
          Layer.sync(ReplPuller, () => puller),
          ReplogClientLayer
        )
      )
    )

    return Effect.gen(function* () {
      const gate = yield* ReadyGate
      const fiber = yield* Effect.forkChild(gate.run)
      yield* TestClock.adjust(Duration.seconds(6))
      const result = yield* Fiber.join(fiber)
      expect(result.unreconciled).toEqual(["worker-Z"])
      expect(result.synced).toEqual([])
      // Readiness STILL flips — the gate guarantees forward progress
      // even when peers don't catch up within the ceiling.
      expect(probe.readiness.ready).toBe(true)
    }).pipe(Effect.provide(Stack))
  })
})
