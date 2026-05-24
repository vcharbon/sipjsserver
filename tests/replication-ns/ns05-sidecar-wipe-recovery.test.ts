/**
 * NS5 — sidecar wipe recovery via peer-scan-bootstrap.
 *
 * The original NS5 scenario relied on the now-removed mirror-echo
 * path: A wrote X, B's puller echoed it back into `propagate:B->A` at
 * `entryGen=0`, and A — after a sidecar wipe — cold-pulled that
 * reverse channel to recover X. Echo was removed in
 * docs/plan/lets-plan-a-proper-crystalline-emerson.md because it was
 * both wire noise (warm pullers skip gen=0) and a correctness bug
 * (update/delete crossing could resurrect deleted calls).
 *
 * The replacement is peer-scan-bootstrap
 * (docs/plan/echo-removal-grill-me-smooth-parasol.md): on respawn the
 * worker scans the peer's `bak:{self}:*` partition directly and
 * replays each entry into local `pri:{self}:*`. This NS5 rewrite
 * exercises that lifecycle end-to-end without echo.
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
  makeDirectBootstrapStream,
  runPeerScanBootstrap,
} from "../../src/replication/PeerScanBootstrap.js"
import { makeKvBackedMemoryUnsafe } from "../../src/cache/PartitionedRelayStorageKvBacked.js"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

const A_GEN_INITIAL = 1
const A_GEN_AFTER_WIPE = 100
const B_GEN = 2

describe("NS5 — sidecar wipe recovery via peer-scan-bootstrap", () => {
  it.live(
    "primary's sidecar wipe + respawn recovers state by scanning peer's bak partition",
    () =>
      Effect.gen(function* () {
        // ---- A's initial incarnation: storage + outgoing channel to B.
        const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kvA0 = KvBackend.makeMemoryUnsafe(storeA)
        const channelA0toB = ChannelIndex.make(
          { self: "worker-A", peer: "worker-B", gen: A_GEN_INITIAL },
          kvA0
        )

        // ---- B's storage + storage api + channel to A.
        const storeB = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kvB = KvBackend.makeMemoryUnsafe(storeB)
        const storageB = makeKvBackedMemoryUnsafe(storeB, {
          self: "worker-B",
          gen: B_GEN,
        })

        // ---- A writes X — body on A, U-member on A's outgoing channel.
        yield* channelA0toB.write({
          entryGen: channelA0toB.gen,
          partition: "pri",
          callRef: "X",
          bodyValue: Buffer.from('{"_topology":{"gen":1},"name":"X"}'),
          bodyTtlSec: 60,
          indexes: [],
        })

        // ---- B's puller pulls from A's channel; apply via
        //      makeReplicationApply (local-only, no echo). After this
        //      fiber catches up, B has `bak:worker-A:call:X`.
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

        yield* waitFor(
          () =>
            MutableRef.get(bView).everCaughtUp &&
            MutableRef.get(bView).entriesAppliedTotal >= 1
        )

        // B's bak:worker-A:call:X is now populated (the bedrock the
        // bootstrap will scan after A's wipe).
        expect(yield* kvB.bodyGet("bak:worker-A:call:X")).not.toBeNull()

        yield* Fiber.interrupt(bFiber)

        // ---- Wipe A's sidecar. Shared `storeA` is the only state A's
        //      KvBackend holds; clear it to simulate the pod restart.
        yield* Effect.sync(() => {
          for (const [k] of storeA) MutableHashMap.remove(storeA, k)
        })
        expect(yield* kvA0.bodyGet("pri:worker-A:call:X")).toBeNull()

        // ---- A's new incarnation: fresh KvBackend over the wiped
        //      store, bumped gen, run bootstrap against B.
        expect(A_GEN_AFTER_WIPE).toBeGreaterThan(A_GEN_INITIAL)
        const kvA1 = KvBackend.makeMemoryUnsafe(storeA)
        const channelA1toB = ChannelIndex.make(
          { self: "worker-A", peer: "worker-B", gen: A_GEN_AFTER_WIPE },
          kvA1
        )

        const results = yield* runPeerScanBootstrap({
          self: "worker-A",
          peers: [WorkerOrdinal("worker-B")],
          kv: kvA1,
          seedWatermark: () => Effect.void,
          overallTimeoutMs: 5_000,
          perPeerRetryDelayMs: 100,
          streamFactory: (peer) =>
            makeDirectBootstrapStream({
              self: "worker-A",
              source: peer as unknown as string,
              sourceGen: B_GEN,
              peerKv: kvB,
              peerStorage: storageB,
            }),
        })

        expect(results[0]!.outcome).toBe("ok")
        expect(results[0]!.entriesImported).toBe(1)

        // ---- A's pri:worker-A:call:X is back — scanned from B's
        //      bak partition, no echo, no reverse cold-pull.
        expect(yield* kvA1.bodyGet("pri:worker-A:call:X")).not.toBeNull()

        // ---- Bootstrap is one-way: A's outgoing channel is empty.
        const outBatch = yield* channelA1toB.pullBatch(
          { gen: 0, counter: 0 },
          1024
        )
        expect(outBatch.entries.length).toBe(0)
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
