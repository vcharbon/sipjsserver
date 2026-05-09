/**
 * NS10 — tuple-conflict resolution at the puller.
 *
 * Asserts the puller's apply rule picks the strictly-higher
 * `(gen, counter)` tuple even when conflicting writes for the same
 * callRef arrive in unexpected order.
 *
 * Two interleaving cases are exercised:
 *   - **Out-of-order arrival within one connection**: a frame with
 *     a lower tuple than the watermark is dropped (idempotent).
 *   - **Cross-gen conflict**: a higher-gen frame overrides any
 *     prior lower-gen state for the same callRef.
 *
 * The tuple comparator is `compareGenCounter` from
 * `ReplicationProtocol.ts`; the apply rule lives in
 * `runPullerFiber` (PullerFiber.ts:applyOne).
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, MutableRef, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  initialPeerView,
  PullerTransportError,
  runPullerFiber,
  type DataFrame,
} from "../../src/replication/PullerFiber.js"
import {
  encodeFrame,
  type DataFrame as ProtoDataFrame,
  type NoopFrame,
} from "../../src/replication/ReplicationProtocol.js"

const enc = new TextEncoder()

const dataFrame = (
  gen: number,
  counter: number,
  callRef: string,
  ver: string
): ProtoDataFrame => ({
  _tag: "Data",
  gen,
  counter,
  op: "update",
  partition: "pri",
  callRef,
  body: { ver, _topology: { gen: counter } },
  body_ttl_remaining_sec: 60,
  latency_ms: 0,
})

const noopFrame = (gen: number, counter: number): NoopFrame => ({
  _tag: "Noop",
  gen,
  counter,
  latency_ms: 0,
})

const longLivedFrames = (
  frames: ReadonlyArray<ProtoDataFrame | NoopFrame>
): Stream.Stream<Uint8Array, PullerTransportError> =>
  Stream.concat(
    Stream.fromIterable(frames.map((f) => enc.encode(encodeFrame(f)))),
    Stream.never
  )

describe("NS10 — tuple-conflict resolution", () => {
  it.effect(
    "out-of-order frame within same gen: lower tuple is dropped (idempotent)",
    () =>
      Effect.gen(function* () {
        const viewRef = MutableRef.make(initialPeerView("A"))
        const applied: Array<DataFrame> = []
        const fiber = yield* Effect.forkChild(
          runPullerFiber({
            peer: "A",
            viewRef,
            // Frames out of order: counter=2 first, then a stale counter=1.
            // The protocol guarantees ascending order from the server, but
            // the apply rule still must defend against a re-delivery.
            openStream: () =>
              longLivedFrames([
                dataFrame(5, 2, "X", "v2"),
                dataFrame(5, 1, "X", "v1"), // out-of-order — must be dropped
                noopFrame(5, 2),
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

        // Only the higher tuple was applied.
        expect(applied.map((f) => f.counter)).toEqual([2])
        expect(MutableRef.get(viewRef).watermark).toEqual({ gen: 5, counter: 2 })

        yield* Fiber.interrupt(fiber)
      })
  )

  it.effect(
    "higher-gen frame overrides prior lower-gen state for same callRef",
    () =>
      Effect.gen(function* () {
        const viewRef = MutableRef.make(initialPeerView("A"))
        const applied: Array<DataFrame> = []
        const fiber = yield* Effect.forkChild(
          runPullerFiber({
            peer: "A",
            viewRef,
            openStream: () =>
              longLivedFrames([
                // Old gen.
                dataFrame(1, 100, "X", "old"),
                // New gen — much higher tuple regardless of counter.
                dataFrame(10, 1, "X", "new"),
                noopFrame(10, 1),
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

        // Both applied (each was strictly greater than the prior
        // watermark when encountered), but the watermark ends at the
        // higher tuple.
        expect(applied.map((f) => `${f.gen}/${f.counter}`)).toEqual([
          "1/100",
          "10/1",
        ])
        const view = MutableRef.get(viewRef)
        expect(view.watermark).toEqual({ gen: 10, counter: 1 })
        // Last-applied frame body is "new". Per Story 7d the
        // dataFrame helper stamps `_topology.gen = counter` so the
        // puller's content gate has a monotonic per-call version
        // for the cross-direction race protection (separate from the
        // wire-level (gen, counter) watermark).
        const last = applied[applied.length - 1]!
        expect(last.body).toEqual({ ver: "new", _topology: { gen: 1 } })

        yield* Fiber.interrupt(fiber)
      })
  )

  it.effect("equal tuple is NOT applied (strict inequality only)", () =>
    Effect.gen(function* () {
      const viewRef = MutableRef.make(
        initialPeerView("A", { gen: 5, counter: 5 })
      )
      const applied: Array<DataFrame> = []
      const fiber = yield* Effect.forkChild(
        runPullerFiber({
          peer: "A",
          viewRef,
          openStream: () =>
            longLivedFrames([
              dataFrame(5, 5, "X", "same-tuple"),
              dataFrame(5, 6, "X", "advance"),
              noopFrame(5, 6),
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

      expect(applied.map((f) => f.counter)).toEqual([6])

      yield* Fiber.interrupt(fiber)
    })
  )
})
