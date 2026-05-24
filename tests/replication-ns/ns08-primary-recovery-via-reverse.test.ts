/**
 * NS8 — primary recovery via reverse-path originating writes.
 *
 * Scenario:
 *   1. A writes X. B's puller catches up: B's bak:{A}:call:X exists.
 *      The puller's apply path is local-only (no echo to channelBtoA).
 *   2. A is killed: storage wiped, gen bumps via simulated restartCount.
 *   3. While A is rebooting, B receives an in-dialog request for X
 *      (modeled by writing X into B's bak:{A}: via
 *      `channelBtoA.write(entryGen=channelBtoA.gen, partition="bak", ...)`
 *      — B as a writer-on-A's-behalf, an ORIGINATING entry on B's
 *      outgoing-to-A channel).
 *   4. A starts up with a higher gen and pulls from B's channel-to-A.
 *      The reverse entry (partition="bak") routes via the apply
 *      rule's partition flip into A's pri:{A}:call:X.
 *
 * This is the **legitimate** reverse-direction recovery primitive.
 * It does NOT depend on echo — B writes ON A's behalf at its own
 * originating gen, and A's puller picks up that single entry.
 *
 * Variant: in-memory KvBackend + real (it.live) clock.
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
const B_GEN = 2

describe("NS8 — primary recovery via reverse", () => {
  it.live(
    "killed primary reacquires its pri: state from backup's outgoing channel after restart",
    () =>
      Effect.gen(function* () {
        // ---- A's initial incarnation.
        const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kvA0 = KvBackend.makeMemoryUnsafe(storeA)
        const channelA0toB = ChannelIndex.make(
          { self: "worker-A", peer: "worker-B", gen: A_GEN_INITIAL },
          kvA0
        )

        // ---- B (single incarnation across the test).
        const storeB = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kvB = KvBackend.makeMemoryUnsafe(storeB)
        const channelBtoA = ChannelIndex.make(
          { self: "worker-B", peer: "worker-A", gen: B_GEN },
          kvB
        )

        // ---- Step 1: A writes X. B's puller drains; apply is local-
        // only (no echo), so bak:{A}:call:X exists in kvB but
        // channelBtoA stays untouched by the apply.
        yield* channelA0toB.write({
          entryGen: channelA0toB.gen,
          partition: "pri",
          callRef: "X",
          bodyValue: Buffer.from('{"gen":1,"v":"original"}'),
          bodyTtlSec: 60,
          indexes: [],
        })

        const bView = MutableRef.make(initialPeerView("worker-A"))
        const bApply = makeReplicationApply({
          self: "worker-B",
          source: "worker-A",
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

        yield* waitFor(() =>
          MutableRef.get(bView).everCaughtUp &&
          MutableRef.get(bView).entriesAppliedTotal >= 1
        )

        // Sanity: B has the original X via the bak partition; with
        // echo killed, channelBtoA is empty until B writes on A's
        // behalf in step 3.
        expect(yield* kvB.bodyGet("bak:worker-A:call:X")).not.toBeNull()
        const beforeBye = yield* channelBtoA.pullBatch({ gen: 0, counter: 0 }, 100)
        expect(beforeBye.entries.length).toBe(0)

        yield* Fiber.interrupt(bFiber)

        // ---- Step 2: A is killed (wipe storage). Will restart with
        // higher gen below.
        yield* Effect.sync(() => {
          for (const [k] of storeA) MutableHashMap.remove(storeA, k)
        })

        // ---- Step 3: while A is down, B handles an in-dialog request
        // on A's behalf — B writes a NEW version of X to its bak:{A}:
        // via channelBtoA.write (G7 reverse path: B is acting on A's
        // behalf). The new entry overrides the prior one in
        // channelBtoA (sorted-set: same member, newer score).
        yield* channelBtoA.write({
          entryGen: channelBtoA.gen,
          partition: "bak",
          callRef: "X",
          bodyValue: Buffer.from('{"gen":2,"v":"updated-by-backup"}'),
          bodyTtlSec: 60,
          indexes: [],
        })

        // ---- Step 4: A reboots with higher gen and pulls from B's
        // outgoing channel.
        const kvA1 = KvBackend.makeMemoryUnsafe(storeA)

        const aView = MutableRef.make(initialPeerView("worker-B"))
        const aApply = makeReplicationApply({
          self: "worker-A",
          source: "worker-B",
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

        // Wait until A has applied at least one entry — that's the
        // recovery write.
        yield* waitFor(() =>
          MutableRef.get(aView).everCaughtUp &&
          MutableRef.get(aView).entriesAppliedTotal >= 1
        )

        // ---- Assert: A's pri:{A}:call:X exists, recovered via the
        // reverse path. The body should be the LATEST one (the one
        // B wrote during A's downtime).
        const recoveredBody = yield* kvA1.bodyGet("pri:worker-A:call:X")
        expect(recoveredBody).not.toBeNull()
        expect(recoveredBody!.toString("utf8")).toContain("updated-by-backup")

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
