/**
 * NS11 unit-test variant — watermark preserved across peer
 * disappear / reappear cycle.
 *
 * Covers:
 *   - `PullerFiber` apply rule: data frames advance the watermark by
 *     `(gen, counter)` strictly; out-of-order or stale re-delivery is a
 *     no-op; noop frames flip `everCaughtUp` sticky-true.
 *   - `ReplicationSupervisor` lifecycle: removing a peer interrupts its
 *     fiber and flips view to `Disappeared` while preserving the
 *     watermark; re-adding the peer forks a new fiber that resumes from
 *     the preserved watermark (no full re-bootstrap).
 *
 * Higher-level end-to-end NS11 (driven through real ChannelIndex +
 * server stream) lives in `tests/replication-ns/ns11-...`.
 */

import { describe, expect, it } from "@effect/vitest"
import {
  Duration,
  Effect,
  Fiber,
  MutableRef,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import type { PeerEnumeratorApi } from "../../src/cache/PeerEnumerator.js"
import {
  initialPeerView,
  PullerTransportError,
  runPullerFiber,
  type DataFrame,
  type PeerView,
} from "../../src/replication/PullerFiber.js"
import {
  encodeFrame,
  type DataFrame as ProtoDataFrame,
  type NoopFrame,
} from "../../src/replication/ReplicationProtocol.js"
import { makeReplicationSupervisor } from "../../src/replication/ReplicationSupervisor.js"
import { bodyBuf } from "../support/codecHelpers.js"

const dataFrame = (
  gen: number,
  counter: number,
  callRef: string,
  body: unknown = { gen, callRef }
): ProtoDataFrame => ({
  _tag: "Data",
  gen,
  counter,
  op: "update",
  partition: "pri",
  callRef,
  // Body Buffer post-msgpackr-migration; encode the test's JS object
  // through the real codec so the frame's bytes match what production
  // produces.
  body: bodyBuf(body),
  body_ttl_remaining_sec: 60,
  latency_ms: 0,
  callGen: gen,
  indexes: [],
})

const noopFrame = (gen: number, counter: number): NoopFrame => ({
  _tag: "Noop",
  gen,
  counter,
  latency_ms: 0,
})

const framesToBytes = (
  frames: ReadonlyArray<ProtoDataFrame | NoopFrame>
): Stream.Stream<Uint8Array, PullerTransportError> =>
  // `encodeFrame` already returns a length-prefixed Buffer chunk; stream
  // it through directly (no TextEncoder — payload is binary).
  Stream.fromIterable(frames.map((f): Uint8Array => encodeFrame(f)))

/** Bytes stream that emits the frames, then never completes — mimics the long-lived /replog stream. */
const longLivedFrames = (
  frames: ReadonlyArray<ProtoDataFrame | NoopFrame>
): Stream.Stream<Uint8Array, PullerTransportError> =>
  Stream.concat(framesToBytes(frames), Stream.never)

describe("PullerFiber — apply rule", () => {
  it.effect("data frames advance watermark monotonically", () =>
    Effect.gen(function* () {
      const viewRef = MutableRef.make(initialPeerView("A"))
      const applied: Array<DataFrame> = []
      const fiber = yield* Effect.forkChild(
        runPullerFiber({
          peer: "A",
          viewRef,
          openStream: () =>
            longLivedFrames([
              dataFrame(7, 1, "x"),
              dataFrame(7, 2, "y"),
              dataFrame(7, 3, "z"),
              noopFrame(7, 3),
            ]),
          applyFrame: (f) =>
            Effect.sync(() => {
              applied.push(f)
            }),
          chunkSize: 100,
        })
      )

      // Let the streaming fiber drain its frames.
      yield* TestClock.adjust(Duration.millis(1))
      yield* Effect.yieldNow

      const view = MutableRef.get(viewRef)
      expect(view.watermark).toEqual({ gen: 7, counter: 3 })
      expect(view.everCaughtUp).toBe(true)
      expect(view.entriesAppliedTotal).toBe(3)
      expect(view.noopsReceivedTotal).toBe(1)
      expect(applied.map((f) => f.callRef)).toEqual(["x", "y", "z"])

      yield* Fiber.interrupt(fiber)
    })
  )

  it.effect("re-delivered frame at or below watermark is a no-op (idempotent apply)", () =>
    Effect.gen(function* () {
      const viewRef = MutableRef.make(initialPeerView("A"))
      const applied: Array<DataFrame> = []
      const fiber = yield* Effect.forkChild(
        runPullerFiber({
          peer: "A",
          viewRef,
          openStream: () =>
            longLivedFrames([
              dataFrame(1, 1, "x"),
              dataFrame(1, 2, "y"),
              dataFrame(1, 1, "x"), // re-delivery of x
              dataFrame(1, 2, "y"), // re-delivery of y
              dataFrame(1, 3, "z"),
              noopFrame(1, 3),
            ]),
          applyFrame: (f) =>
            Effect.sync(() => {
              applied.push(f)
            }),
          chunkSize: 100,
        })
      )

      yield* TestClock.adjust(Duration.millis(1))
      yield* Effect.yieldNow

      // Only x, y, z applied — re-delivered frames skipped.
      expect(applied.map((f) => f.callRef)).toEqual(["x", "y", "z"])
      const view = MutableRef.get(viewRef)
      expect(view.watermark).toEqual({ gen: 1, counter: 3 })

      yield* Fiber.interrupt(fiber)
    })
  )

  it.effect("higher gen sorts above older gen regardless of counter (gen rollover)", () =>
    Effect.gen(function* () {
      const viewRef = MutableRef.make(initialPeerView("A", { gen: 1, counter: 1000 }))
      const applied: Array<DataFrame> = []
      const fiber = yield* Effect.forkChild(
        runPullerFiber({
          peer: "A",
          viewRef,
          openStream: () =>
            longLivedFrames([
              // gen 2, counter 1 — sorts above (1, 1000) because gen takes priority.
              dataFrame(2, 1, "rebooted-call"),
              noopFrame(2, 1),
            ]),
          applyFrame: (f) =>
            Effect.sync(() => {
              applied.push(f)
            }),
          chunkSize: 100,
        })
      )

      yield* TestClock.adjust(Duration.millis(1))
      yield* Effect.yieldNow

      expect(applied).toHaveLength(1)
      expect(applied[0]!.callRef).toBe("rebooted-call")
      const view = MutableRef.get(viewRef)
      expect(view.watermark).toEqual({ gen: 2, counter: 1 })

      yield* Fiber.interrupt(fiber)
    })
  )

  it.effect("noop without prior data still flips everCaughtUp", () =>
    Effect.gen(function* () {
      const viewRef = MutableRef.make(initialPeerView("A"))
      const fiber = yield* Effect.forkChild(
        runPullerFiber({
          peer: "A",
          viewRef,
          openStream: () => longLivedFrames([noopFrame(5, 0)]),
          applyFrame: () => Effect.void,
          chunkSize: 100,
        })
      )

      yield* TestClock.adjust(Duration.millis(1))
      yield* Effect.yieldNow

      const view = MutableRef.get(viewRef)
      expect(view.everCaughtUp).toBe(true)
      expect(view.watermark).toEqual({ gen: 5, counter: 0 })
      expect(view.entriesAppliedTotal).toBe(0)
      expect(view.noopsReceivedTotal).toBe(1)

      yield* Fiber.interrupt(fiber)
    })
  )
})

describe("PullerFiber — reconnect on transport error", () => {
  it.effect(
    "Stream.fail flips state to ErroredRetry; fiber backs off and reconnects from preserved watermark",
    () =>
      Effect.gen(function* () {
        const viewRef = MutableRef.make(initialPeerView("A"))
        const applied: Array<DataFrame> = []

        // First open: send one frame then fail. Second open: send the
        // next frame and a noop. The puller's openStream callback is
        // invoked once per Connecting cycle so we can drive both paths.
        let opens = 0
        const openStream = (args: {
          readonly sinceGen: number
          readonly sinceCounter: number
          readonly chunkSize: number
        }): Stream.Stream<Uint8Array, PullerTransportError> => {
          opens++
          if (opens === 1) {
            return Stream.concat(
              framesToBytes([dataFrame(1, 1, "first")]),
              Stream.fail(new PullerTransportError({ reason: "synthetic" }))
            )
          }
          // Second open: should resume from counter=1 (the watermark).
          expect(args.sinceGen).toBe(1)
          expect(args.sinceCounter).toBe(1)
          return longLivedFrames([
            dataFrame(1, 2, "second"),
            noopFrame(1, 2),
          ])
        }

        const fiber = yield* Effect.forkChild(
          runPullerFiber({
            peer: "A",
            viewRef,
            openStream,
            applyFrame: (f) =>
              Effect.sync(() => {
                applied.push(f)
              }),
            chunkSize: 100,
            initialBackoffMs: 50,
          })
        )

        // Drain first batch (1 frame) → fail → backoff sleep fires.
        yield* TestClock.adjust(Duration.millis(60))
        yield* Effect.yieldNow

        // Second open delivers next frame + noop.
        yield* TestClock.adjust(Duration.millis(1))
        yield* Effect.yieldNow

        expect(applied.map((f) => f.callRef)).toEqual(["first", "second"])
        const view = MutableRef.get(viewRef)
        expect(view.watermark).toEqual({ gen: 1, counter: 2 })
        expect(view.everCaughtUp).toBe(true)
        // lastError cleared by the successfully-applied second frame.
        expect(view.lastError).toBeNull()

        yield* Fiber.interrupt(fiber)
      })
  )
})

describe("ReplicationSupervisor — peer disappear/reappear preserves watermark", () => {
  const peer = WorkerOrdinal("worker-1")

  /** Build an enumerator backed by a `MutableRef<ReadonlyArray<WorkerOrdinal>>`. */
  const dynamicEnumerator = (
    initial: ReadonlyArray<WorkerOrdinal>
  ): {
    enumerator: PeerEnumeratorApi
    set: (peers: ReadonlyArray<WorkerOrdinal>) => void
  } => {
    const ref = MutableRef.make<ReadonlyArray<WorkerOrdinal>>(initial)
    return {
      enumerator: { currentPeers: Effect.sync(() => MutableRef.get(ref)) },
      set: (peers) => MutableRef.set(ref, peers),
    }
  }

  it.effect("disappear interrupts fiber and flips state to Disappeared; reappear re-forks", () =>
    Effect.gen(function* () {
      const { enumerator, set } = dynamicEnumerator([peer])
      const forks: Array<{ peer: WorkerOrdinal; sawWatermark: PeerView["watermark"] }> = []

      const supervisor = makeReplicationSupervisor({
        enumerator,
        watchIntervalMs: 100,
        forkPullerFiber: (p, viewRef) =>
          Effect.gen(function* () {
            forks.push({ peer: p, sawWatermark: MutableRef.get(viewRef).watermark })
            // Synthetic puller — flips everCaughtUp + sets watermark
            // (1, 5), then idles forever. Real puller is exercised by
            // PullerFiber tests above.
            return yield* Effect.forkChild(
              Effect.gen(function* () {
                MutableRef.set(viewRef, {
                  ...MutableRef.get(viewRef),
                  fiberState: "Streaming",
                  watermark: { gen: 1, counter: 5 },
                  everCaughtUp: true,
                })
                return yield* Effect.never
              })
            )
          }),
      })

      const supervisorFiber = yield* Effect.forkChild(supervisor.run)

      // Initial reconcile forks for peer-1.
      yield* Effect.yieldNow
      expect(forks).toHaveLength(1)
      expect(forks[0]!.sawWatermark).toEqual({ gen: 0, counter: 0 })

      // Wait for the synthetic puller to update view.
      yield* Effect.yieldNow
      let state = yield* supervisor.observe
      expect(state.alivePeers.has(peer)).toBe(true)
      expect(state.perPeer.get(peer)?.watermark).toEqual({ gen: 1, counter: 5 })
      expect(state.perPeer.get(peer)?.everCaughtUp).toBe(true)

      // Peer disappears.
      set([])
      yield* TestClock.adjust(Duration.millis(100))
      yield* Effect.yieldNow

      state = yield* supervisor.observe
      expect(state.alivePeers.has(peer)).toBe(false)
      // View is preserved; fiberState flipped to Disappeared but
      // watermark + everCaughtUp untouched.
      const disappeared = state.perPeer.get(peer)!
      expect(disappeared.fiberState).toBe("Disappeared")
      expect(disappeared.watermark).toEqual({ gen: 1, counter: 5 })
      expect(disappeared.everCaughtUp).toBe(true)

      // Peer reappears.
      set([peer])
      yield* TestClock.adjust(Duration.millis(100))
      yield* Effect.yieldNow

      // New fiber forked — it saw the PRESERVED watermark.
      expect(forks).toHaveLength(2)
      expect(forks[1]!.sawWatermark).toEqual({ gen: 1, counter: 5 })

      yield* Fiber.interrupt(supervisorFiber)
    })
  )
})
