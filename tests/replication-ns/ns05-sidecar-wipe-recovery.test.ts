/**
 * NS5 — sidecar wipe recovery.
 *
 * Scenario (per docs/plan/grill-me-on-the-spicy-lark.md §D9-NS):
 *   1. Worker A writes call X. A's outgoing channel-to-B carries an
 *      entry; the puller on B drains it via the real `buildPullStream`.
 *   2. The puller's applyFrame is wired through `makeReplicationApply`, so
 *      after apply B's bak:{A}: contains X AND B's outgoing channel-to-A
 *      carries an echoed entry stamped with B's gen.
 *   3. A's sidecar Redis is wiped (clear all keys). A's process
 *      "restarts" with a higher gen via `EpochCounter.fixedForTesting`.
 *   4. A's NEW incarnation runs a puller against B's outgoing
 *      channel-to-A starting at since=(0,0).
 *   5. B's stream replays the echoed entry to A. A's applyFrame routes
 *      the partition="bak" frame to its OWN pri:{A}: (reverse-direction
 *      apply) — A reacquires X without any explicit bootstrap.
 *
 * Asserts: A's `pri:worker-A:call:X` body exists after recovery, AND
 * the new gen is strictly greater than the pre-wipe gen.
 *
 * Variant: in-memory KvBackend + real (it.live) clock — the server
 * emission loop's noop sleep is real-time.
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
import { makeReplicationApply } from "../../src/replication/EchoApply.js"
import {
  initialPeerView,
  PullerTransportError,
  runPullerFiber,
} from "../../src/replication/PullerFiber.js"
import { buildPullStream } from "../../src/replication/ReplLogServer.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

const A_GEN_INITIAL = 1
const A_GEN_AFTER_WIPE = 100 // simulates a higher restartCount
const B_GEN = 2

describe("NS5 — sidecar wipe recovery", () => {
  it.live(
    "primary's sidecar wipe + restart recovers state via reverse-direction echo",
    () =>
      Effect.gen(function* () {
        // ---- Setup A's storage + channel-to-B (initial incarnation).
        const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kvA0 = KvBackend.makeMemoryUnsafe(storeA)
        const channelA0toB = ChannelIndex.make(
          { self: "worker-A", peer: "worker-B", gen: A_GEN_INITIAL },
          kvA0
        )

        // ---- Setup B's storage + channel-to-A.
        const storeB = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kvB = KvBackend.makeMemoryUnsafe(storeB)
        const channelBtoA = ChannelIndex.make(
          { self: "worker-B", peer: "worker-A", gen: B_GEN },
          kvB
        )

        // ---- A writes X. Body lives in A's storage; A's channel-to-B
        //      now has the U-member at counter 1.
        yield* channelA0toB.write({
          entryGen: channelA0toB.gen,
          partition: "pri",
          callRef: "X",
          bodyValue: '{"gen":1,"name":"X"}',
          bodyTtlSec: 60,
          indexes: [],
        })

        // ---- Fork B's puller against A's channel-to-B; apply via
        //      EchoApply so writes to bak:{A}: also bump B's
        //      outgoing channel-to-A.
        const bView = MutableRef.make(initialPeerView("worker-A"))
        const bApply = makeReplicationApply({
          self: "worker-B",
          source: "worker-A",
          outgoingChannel: channelBtoA,
          localKv: kvB,
          bodyTtlSec: 60,
        })
        const openFromA0 = (args: {
          readonly sinceGen: number
          readonly sinceCounter: number
          readonly chunkSize: number
        }): Stream.Stream<Uint8Array, PullerTransportError> =>
          buildPullStream({
            channel: channelA0toB,
            serverGen: A_GEN_INITIAL,
            initialSince: { gen: args.sinceGen, counter: args.sinceCounter },
            chunkSize: args.chunkSize,
            noopIntervalMs: 5,
          })
        const bFiber = yield* Effect.forkChild(
          runPullerFiber({
            peer: "worker-A",
            viewRef: bView,
            openStream: openFromA0,
            applyFrame: (f) => bApply(f).pipe(Effect.orDie),
            chunkSize: 100,
            initialBackoffMs: 50,
          })
        )

        // Wait for B to apply X.
        yield* waitFor(() => MutableRef.get(bView).everCaughtUp &&
          MutableRef.get(bView).entriesAppliedTotal >= 1)

        // Verify B's bak:{A}:call:X exists AND B's channel-to-A has
        // the echoed entry.
        expect(yield* kvB.bodyGet("bak:worker-A:call:X")).not.toBeNull()
        const bToAEntries = yield* channelBtoA.pullBatch({ gen: 0, counter: 0 }, 100)
        expect(bToAEntries.entries.length).toBe(1)
        expect(bToAEntries.entries[0]!.member).toBe("U:bak:worker-A:call:X")

        yield* Fiber.interrupt(bFiber)

        // ---- Step 3: wipe A's sidecar. The MutableHashMap is shared
        //      between any KvBackend instance using `storeA` — clear it.
        yield* Effect.sync(() => {
          for (const [k] of storeA) MutableHashMap.remove(storeA, k)
        })

        // Sanity: A's body for X is gone after wipe.
        expect(yield* kvA0.bodyGet("pri:worker-A:call:X")).toBeNull()

        // ---- Step 4: A's new incarnation. Higher gen.
        expect(A_GEN_AFTER_WIPE).toBeGreaterThan(A_GEN_INITIAL)
        const kvA1 = KvBackend.makeMemoryUnsafe(storeA)
        const channelA1toB = ChannelIndex.make(
          { self: "worker-A", peer: "worker-B", gen: A_GEN_AFTER_WIPE },
          kvA1
        )

        // A's puller against B's channel-to-A; apply via EchoApply so
        // the recovered state lands in pri:{A}: AND echos onward.
        const aView = MutableRef.make(initialPeerView("worker-B"))
        const aApply = makeReplicationApply({
          self: "worker-A",
          source: "worker-B",
          outgoingChannel: channelA1toB,
          localKv: kvA1,
          bodyTtlSec: 60,
        })
        const openFromB = (args: {
          readonly sinceGen: number
          readonly sinceCounter: number
          readonly chunkSize: number
        }): Stream.Stream<Uint8Array, PullerTransportError> =>
          buildPullStream({
            channel: channelBtoA,
            serverGen: B_GEN,
            initialSince: { gen: args.sinceGen, counter: args.sinceCounter },
            chunkSize: args.chunkSize,
            noopIntervalMs: 5,
          })
        const aFiber = yield* Effect.forkChild(
          runPullerFiber({
            peer: "worker-B",
            viewRef: aView,
            openStream: openFromB,
            applyFrame: (f) => aApply(f).pipe(Effect.orDie),
            chunkSize: 100,
            initialBackoffMs: 50,
          })
        )

        // ---- Step 5: wait for A to apply the reverse frame.
        yield* waitFor(() => MutableRef.get(aView).everCaughtUp &&
          MutableRef.get(aView).entriesAppliedTotal >= 1)

        // A's pri:{A}:call:X exists — recovered via reverse path.
        expect(yield* kvA1.bodyGet("pri:worker-A:call:X")).not.toBeNull()

        yield* Fiber.interrupt(aFiber)
      })
  )
})

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
