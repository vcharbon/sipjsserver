/**
 * Integration test — production HTTP-backed puller transport delivers
 * frames end-to-end.
 *
 * Mounts the SAME `makePullerOpenStream` helper that `main.ts` consumes
 * in front of the SAME `addReplLogRoutes` route handler the worker
 * serves, glued together by `FakeHttpFabric` (in-memory `HttpClient` ↔
 * `HttpRouter`). Source A writes one body via its outgoing channel;
 * runs the puller for a brief window; asserts the data frame round-
 * tripped through:
 *
 *   makePullerOpenStream  → HttpClientRequest.get(/replog?…)
 *                        → FakeHttpFabric.execute
 *                        → addReplLogRoutes / ReplLogServer.stream
 *                        → buildPullStream → ChannelIndex.pullBatch
 *                        → NDJSON bytes
 *                        → HttpClientResponse.stream
 *                        → PullerFiber.consumeStream → applyFrame
 *
 * If `main.ts` ever regresses to a Stream.fail stub or a typo'd URL
 * shape, this test goes red. Fake-clock matrix tests do NOT exercise
 * this path because `tests/support/k8sFakeStack.ts` wires its own
 * `buildPullStream` shortcut for speed.
 */

import { describe, expect, it } from "@effect/vitest"
import {
  Effect,
  Fiber,
  Layer,
  MutableHashMap,
  MutableRef,
  Scope,
} from "effect"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import {
  initialPeerView,
  runPullerFiber,
  type DataFrame,
} from "../../src/replication/PullerFiber.js"
import {
  addReplLogRoutes,
  ReplLogServer,
} from "../../src/replication/ReplLogServer.js"
import { makePullerOpenStream } from "../../src/replication/PullerHttpTransport.js"
import { PeerEndpointResolver } from "../../src/cache/PeerEndpointResolver.js"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"
import { makeKvBackedMemoryUnsafe } from "../../src/cache/PartitionedRelayStorageKvBacked.js"
import {
  FakeHttpClientLayer,
  FakeHttpFabric,
  FakeHttpFabricLayer,
} from "../support/FakeHttpFabric.js"

const A_ORD = "worker-A"
const B_ORD = "worker-B"
const A_HOST = "worker-a.svc"
const A_PORT = 8080
const A_GEN = 42

describe("PullerHttpTransport — end-to-end via FakeHttpFabric", () => {
  it.live(
    "production openStream + ReplLogServer route delivers a Data frame from A to B",
    () =>
      Effect.gen(function* () {
        // ---- Source A: kv store, outgoing channel A → B, ReplLogServer.
        const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kvA = KvBackend.makeMemoryUnsafe(storeA)
        const channelAtoB = ChannelIndex.make(
          { self: A_ORD, peer: B_ORD, gen: A_GEN },
          kvA
        )
        const storageA = makeKvBackedMemoryUnsafe(storeA, {
          self: A_ORD,
          gen: A_GEN,
        })
        const replServer = ReplLogServer.makeUnsafe(kvA, storageA, {
          self: A_ORD,
          gen: A_GEN,
          // Tighter idle interval keeps the test fast; production default
          // is 100ms.
          noopIntervalMs: 5,
        })

        // ---- Build A's HttpRouter with /replog mounted, register it
        //      with the fabric at A_HOST:A_PORT.
        const fabric = yield* FakeHttpFabric
        const aRouter = yield* HttpRouter.make
        yield* addReplLogRoutes(aRouter).pipe(
          Effect.provideService(ReplLogServer, replServer)
        )
        yield* fabric.register(A_HOST, A_PORT, aRouter)

        // ---- Source A writes one entry on the outgoing channel BEFORE
        //      B starts pulling, so the cold-pull (since=(0,0)) finds it.
        yield* channelAtoB.write({
          entryGen: channelAtoB.gen,
          partition: "pri",
          callRef: "X",
          bodyValue: '{"_topology":{"gen":1},"name":"X"}',
          bodyTtlSec: 60,
          indexes: [
            { key: "idx:leg:test|tag", value: "X", ttlSec: 60 },
          ],
        })

        // ---- B's transport: SAME factory `main.ts` uses.
        const httpClient = yield* HttpClient.HttpClient
        const resolver: PeerEndpointResolver["Service"] = {
          resolve: (peer) =>
            peer === (A_ORD as unknown as WorkerOrdinal)
              ? Effect.succeed(`http://${A_HOST}:${A_PORT}`)
              : Effect.fail({
                  _tag: "PeerEndpointResolveError",
                  peer,
                  reason: "unknown_peer",
                } as never),
        }
        const openStream = makePullerOpenStream({
          self: B_ORD,
          source: A_ORD,
          client: httpClient,
          resolver,
        })

        const viewRef = MutableRef.make(initialPeerView(A_ORD))
        const applied: Array<DataFrame> = []
        const fiber = yield* Effect.forkChild(
          runPullerFiber({
            peer: A_ORD,
            viewRef,
            openStream,
            applyFrame: (frame) =>
              Effect.sync(() => {
                applied.push(frame)
              }),
            chunkSize: 100,
            initialBackoffMs: 50,
          })
        )

        yield* waitFor(() => {
          const v = MutableRef.get(viewRef)
          return v.everCaughtUp && v.entriesAppliedTotal >= 1
        })

        const view = MutableRef.get(viewRef)
        expect(view.fiberState).toBe("Streaming")
        expect(view.everCaughtUp).toBe(true)
        expect(view.bytesReceivedTotal).toBeGreaterThan(0)
        expect(view.entriesAppliedTotal).toBe(1)
        expect(applied).toHaveLength(1)
        expect(applied[0]!.callRef).toBe("X")
        expect(applied[0]!.partition).toBe("pri")
        expect(applied[0]!.op).toBe("update")

        yield* Fiber.interrupt(fiber)
      }).pipe(
        Effect.provide(
          FakeHttpClientLayer.pipe(Layer.provideMerge(FakeHttpFabricLayer))
        ),
        Effect.scoped
      ),
    { timeout: 5_000 }
  )
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Real-clock poll until `predicate()` returns true; bounded at 3s.
 * Mirrors `tests/replication-ns/ns11-...` precedent.
 */
const waitFor = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + 3000
    while (!predicate()) {
      if (Date.now() > deadline) {
        return yield* Effect.die(
          new Error("waitFor: predicate did not become true within 3s")
        )
      }
      yield* Effect.sleep("5 millis")
    }
  })

// Ensure unused imports don't break the strict tsc — the helper module
// exports them but the test only uses a subset. Keep this no-op
// reference so the linter does not strip the imports we may need
// when extending the test later.
void Scope.Scope
