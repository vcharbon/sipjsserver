/**
 * NS7 — backup re-bootstrap from primary.
 *
 * Scenario:
 *   1. Primary A writes 50 calls. B's puller catches up (verified via
 *      everCaughtUp + entriesAppliedTotal >= 50).
 *   2. B's sidecar is wiped. B's process "restarts" with a higher gen.
 *      Watermark and view are gone (fresh allocation, not preserved
 *      across worker restart per §D5.2).
 *   3. B's new incarnation runs a puller against A's channel from
 *      since=(0,0). A's stream replays all 50 entries.
 *   4. Assert B's bak:{A}: holds all 50 calls again within bounded time.
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

const A_GEN = 5

const N_CALLS = 50

describe("NS7 — backup re-bootstrap", () => {
  it.live(
    "backup loses sidecar; new incarnation re-acquires all calls from primary",
    () =>
      Effect.gen(function* () {
        // ---- A: persistent across the whole test.
        const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kvA = KvBackend.makeMemoryUnsafe(storeA)
        const channelAtoB = ChannelIndex.make(
          { self: "worker-A", peer: "worker-B", gen: A_GEN },
          kvA
        )

        // Write N calls.
        for (let i = 0; i < N_CALLS; i++) {
          yield* channelAtoB.write({
            entryGen: channelAtoB.gen,
            partition: "pri",
            callRef: `call-${i}`,
            bodyValue: `{"gen":${A_GEN},"i":${i}}`,
            bodyTtlSec: 60,
            indexes: [],
          })
        }

        // ---- B (initial incarnation): puller drains A.
        const storeB0 = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kvB0 = KvBackend.makeMemoryUnsafe(storeB0)

        const b0View = MutableRef.make(initialPeerView("worker-A"))
        const b0Apply = makeReplicationApply({
          self: "worker-B",
          source: "worker-A",
          localKv: kvB0,
          bodyTtlSec: 60,
        })
        const openA = (args: {
          readonly sinceGen: number
          readonly sinceCounter: number
          readonly chunkSize: number
        }): Stream.Stream<Uint8Array, PullerTransportError> =>
          buildPullStream({
            channel: channelAtoB,
            serverGen: A_GEN,
            initialSince: { gen: args.sinceGen, counter: args.sinceCounter },
            chunkSize: args.chunkSize,
            noopIntervalMs: 5,
          })
        const b0Fiber = yield* Effect.forkChild(
          runPullerFiber({
            peer: "worker-A",
            viewRef: b0View,
            openStream: openA,
            applyFrame: (f) => b0Apply(f).pipe(Effect.orDie),
            chunkSize: 100,
            initialBackoffMs: 50,
          })
        )

        // Wait for B to catch up on all N calls.
        yield* waitFor(() =>
          MutableRef.get(b0View).everCaughtUp &&
          MutableRef.get(b0View).entriesAppliedTotal >= N_CALLS
        )

        // Verify B0 has all the bak entries.
        for (let i = 0; i < N_CALLS; i++) {
          expect(yield* kvB0.bodyGet(`bak:worker-A:call:call-${i}`)).not.toBeNull()
        }

        yield* Fiber.interrupt(b0Fiber)

        // ---- Wipe B. New incarnation with fresh storage and higher gen.
        const storeB1 = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kvB1 = KvBackend.makeMemoryUnsafe(storeB1)

        const b1View = MutableRef.make(initialPeerView("worker-A"))
        const b1Apply = makeReplicationApply({
          self: "worker-B",
          source: "worker-A",
          localKv: kvB1,
          bodyTtlSec: 60,
        })
        const b1Fiber = yield* Effect.forkChild(
          runPullerFiber({
            peer: "worker-A",
            viewRef: b1View,
            openStream: openA,
            applyFrame: (f) => b1Apply(f).pipe(Effect.orDie),
            chunkSize: 100,
            initialBackoffMs: 50,
          })
        )

        yield* waitFor(() =>
          MutableRef.get(b1View).everCaughtUp &&
          MutableRef.get(b1View).entriesAppliedTotal >= N_CALLS
        )

        // B1 also recovered all N calls.
        for (let i = 0; i < N_CALLS; i++) {
          expect(yield* kvB1.bodyGet(`bak:worker-A:call:call-${i}`)).not.toBeNull()
        }
        expect(MutableRef.get(b1View).watermark.gen).toBe(A_GEN)
        expect(MutableRef.get(b1View).watermark.counter).toBeGreaterThanOrEqual(
          N_CALLS
        )

        yield* Fiber.interrupt(b1Fiber)
      })
  )
})

const waitFor = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + 5000
    while (!predicate()) {
      if (Date.now() > deadline) {
        return yield* Effect.die(
          new Error("waitFor: predicate did not become true within 5s")
        )
      }
      yield* Effect.sleep("5 millis")
    }
  })
