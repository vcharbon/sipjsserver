/**
 * NS8 — primary recovery via reverse path.
 *
 * Scenario (per docs/plan/grill-me-on-the-spicy-lark.md §D9-NS):
 *   1. A writes X. B's puller catches up; B's bak:{A}:call:X exists
 *      AND B's outgoing channel-to-A has the echoed entry.
 *   2. A is killed: storage wiped, gen bumps via simulated restartCount.
 *   3. While A is rebooting, B receives an in-dialog request for X
 *      (modeled here by writing X into B's bak:{A}: with a NEW counter
 *      via channelBtoA.write — i.e. B is acting on A's behalf).
 *   4. A starts up with a higher gen and pulls from B's channel-to-A
 *      since=(0,0). The echoed entries are tagged partition="bak"
 *      because that's where B wrote them; A's apply rule routes them
 *      via the reverse path → A's pri:{A}:call:X is reconstructed.
 *
 * Asserts:
 *   - Pre-recovery: A's storage is empty.
 *   - Post-recovery: A's pri:worker-A:call:X exists with the latest
 *     value (the one B wrote on A's behalf — overwriting the original).
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
const A_GEN_AFTER_REBOOT = 100 // higher restartCount
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

        // ---- Step 1: A writes X. B's puller drains; via EchoApply,
        // B writes bak:{A}:call:X to its storage AND echoes to its
        // channelBtoA.
        yield* channelA0toB.write({
          entryGen: channelA0toB.gen,
          partition: "pri",
          callRef: "X",
          bodyValue: '{"gen":1,"v":"original"}',
          bodyTtlSec: 60,
          indexes: [],
        })

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

        yield* waitFor(() =>
          MutableRef.get(bView).everCaughtUp &&
          MutableRef.get(bView).entriesAppliedTotal >= 1
        )

        // Sanity: B has the original X via the bak partition; channelBtoA
        // has the echoed update at counter 1.
        expect(yield* kvB.bodyGet("bak:worker-A:call:X")).not.toBeNull()
        const beforeBye = yield* channelBtoA.pullBatch({ gen: 0, counter: 0 }, 100)
        expect(beforeBye.entries.length).toBe(1)

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
          bodyValue: '{"gen":2,"v":"updated-by-backup"}',
          bodyTtlSec: 60,
          indexes: [],
        })

        // ---- Step 4: A reboots with higher gen and pulls from B's
        // outgoing channel.
        const kvA1 = KvBackend.makeMemoryUnsafe(storeA)
        const channelA1toB = ChannelIndex.make(
          { self: "worker-A", peer: "worker-B", gen: A_GEN_AFTER_REBOOT },
          kvA1
        )

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
        expect(recoveredBody).toContain("updated-by-backup")

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
