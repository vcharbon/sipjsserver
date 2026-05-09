/**
 * NS11 — peer-disappear-watermark.
 *
 * End-to-end black-box scenario through the real `ChannelIndex` +
 * server-side `buildPullStream`:
 *
 *   1. Worker A and worker B are both alive. B's puller is connected
 *      to A's outgoing channel.
 *   2. A writes call X. B's puller receives it; watermark advances.
 *   3. A disappears from B's enumerator. B's per-peer fiber is
 *      interrupted; view flips to Disappeared; watermark preserved.
 *   4. While A is "gone", A writes call Y to its own channel.
 *   5. A reappears in B's enumerator. B forks a new fiber that opens
 *      `/replog?gen={preserved.gen}&counter={preserved.counter}` —
 *      A's server replies with only Y (no re-delivery of X).
 *
 * Variant covered: in-memory `KvBackend` + real (it.live) clock — the
 * server-emission loop sleeps in real time between batches. Hybrid
 * Redis variant lands when the hybrid clock pump arrives.
 */

import { describe, expect, it } from "@effect/vitest"
import {
  Effect,
  Fiber,
  MutableHashMap,
  MutableRef,
  Stream,
} from "effect"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import {
  initialPeerView,
  PullerTransportError,
  runPullerFiber,
  type DataFrame,
} from "../../src/replication/PullerFiber.js"
import { buildPullStream } from "../../src/replication/ReplLogServer.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

const A_GEN = 42

describe("NS11 — peer disappear preserves watermark across reappear", () => {
  it.live(
    "puller resumes from preserved watermark; no re-delivery of pre-disappear entries",
    () =>
      Effect.gen(function* () {
        // ---- A's storage and outgoing channel to B -----------------
        const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kvA = KvBackend.makeMemoryUnsafe(storeA)
        const channelAtoB = ChannelIndex.make(
          { self: "worker-A", peer: "worker-B", gen: A_GEN },
          kvA
        )

        // ---- B's view ref + apply target (just an array of receipts).
        const viewRef = MutableRef.make(initialPeerView("worker-A"))
        const applied: Array<DataFrame> = []
        const applyFrame = (f: DataFrame): Effect.Effect<void> =>
          Effect.sync(() => {
            applied.push(f)
          })

        // ---- Connection control: a flag the test flips to simulate
        //      A being unreachable (fabric-style "peer dead"). When
        //      true, openStream returns a Stream.fail.
        const peerReachable = MutableRef.make(true)
        const openStream = (args: {
          readonly sinceGen: number
          readonly sinceCounter: number
          readonly chunkSize: number
        }): Stream.Stream<Uint8Array, PullerTransportError> => {
          if (!MutableRef.get(peerReachable)) {
            return Stream.fail(
              new PullerTransportError({ reason: "fabric-disabled" })
            )
          }
          return buildPullStream({
            channel: channelAtoB,
            gen: A_GEN,
            initialSince: args.sinceCounter,
            chunkSize: args.chunkSize,
            noopIntervalMs: 5,
          })
        }

        // ---- Step 1: write X on A BEFORE B starts pulling.
        yield* channelAtoB.write({
          partition: "pri",
          callRef: "X",
          bodyValue: '{"gen":42,"name":"X"}',
          bodyTtlSec: 60,
          indexes: [],
        })

        // ---- Step 2: fork B's puller; let it drain X + noop.
        const fiber1 = yield* Effect.forkChild(
          runPullerFiber({
            peer: "worker-A",
            viewRef,
            openStream,
            applyFrame,
            chunkSize: 100,
            initialBackoffMs: 50,
          })
        )

        // Wait until X arrives and everCaughtUp flips (driven by the
        // server's real-clock noop interval of 5ms).
        yield* waitFor(() => {
          const v = MutableRef.get(viewRef)
          return v.everCaughtUp && v.entriesAppliedTotal >= 1
        })

        const afterX = MutableRef.get(viewRef)
        expect(afterX.watermark).toEqual({ gen: A_GEN, counter: 1 })
        expect(afterX.everCaughtUp).toBe(true)
        expect(applied.map((f) => f.callRef)).toEqual(["X"])

        // ---- Step 3: simulate peer disappearance. The supervisor
        //      would interrupt the fiber here; we do it directly to
        //      isolate the puller's preserved-state behavior. View
        //      retains everything.
        yield* Fiber.interrupt(fiber1)

        // Watermark MUST be preserved on the view ref.
        expect(MutableRef.get(viewRef).watermark).toEqual({
          gen: A_GEN,
          counter: 1,
        })
        expect(MutableRef.get(viewRef).everCaughtUp).toBe(true)

        // ---- Step 4: write Y on A while B is "gone".
        yield* channelAtoB.write({
          partition: "pri",
          callRef: "Y",
          bodyValue: '{"gen":42,"name":"Y"}',
          bodyTtlSec: 60,
          indexes: [],
        })

        // ---- Step 5: re-fork puller — must resume from preserved
        //      watermark. (The supervisor's reconcile would do this.)
        // Reset just the transient state, leaving watermark + everCaughtUp.
        MutableRef.set(viewRef, {
          ...MutableRef.get(viewRef),
          fiberState: "Discovered",
          lastError: null,
        })
        const fiber2 = yield* Effect.forkChild(
          runPullerFiber({
            peer: "worker-A",
            viewRef,
            openStream,
            applyFrame,
            chunkSize: 100,
            initialBackoffMs: 50,
          })
        )

        // Wait until Y arrives. Y has counter=2; X had counter=1.
        yield* waitFor(() => MutableRef.get(viewRef).watermark.counter >= 2)

        const afterY = MutableRef.get(viewRef)
        expect(afterY.watermark).toEqual({ gen: A_GEN, counter: 2 })

        // CRITICAL: only Y was applied during the second incarnation —
        // X was not re-delivered, because the puller resumed from the
        // preserved watermark (1) rather than rebooting from (0,0).
        expect(applied.map((f) => f.callRef)).toEqual(["X", "Y"])

        yield* Fiber.interrupt(fiber2)
      })
  )
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Real-clock poll until `predicate()` returns true; bounded at 2s so a
 * broken puller fails the test with a clear message instead of hanging.
 */
const waitFor = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + 2000
    while (!predicate()) {
      if (Date.now() > deadline) {
        return yield* Effect.die(
          new Error("waitFor: predicate did not become true within 2s")
        )
      }
      yield* Effect.sleep("5 millis")
    }
  })
