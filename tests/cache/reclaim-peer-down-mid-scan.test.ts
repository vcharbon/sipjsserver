/**
 * ReclaimRunner — peer down mid-reclaim.
 *
 * Verifies that a single dead/unreachable peer does not abort the
 * whole reclaim run. The runner should:
 *   1. Catch the `PeerScanError` from the failed peer's stream.
 *   2. Increment `peersFailed` for that peer.
 *   3. Continue processing other peers' streams to completion.
 *   4. Still flip `WorkerReadiness` to ready at the end.
 *
 * Two scenarios:
 *   a. Peer is killed BEFORE the scan starts → fabric returns
 *      `connection_refused` immediately on the scan dispatch.
 *   b. Fabric's per-peer error rate set to 1 → simulates a peer
 *      whose relay is reachable but failing every request.
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Layer, Schema } from "effect"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"
import { PeerFabric } from "../../src/cache/PeerFabric.js"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import { PeerEnumerator } from "../../src/cache/PeerEnumerator.js"
import { WorkerReadiness } from "../../src/cache/WorkerReadiness.js"
import { ReclaimRunner } from "../../src/cache/ReclaimRunner.js"
import {
  Call as CallSchema,
  callIndexKeys,
  deriveCallRef,
  type Call,
  type Leg,
} from "../../src/call/CallModel.js"
import { testAppConfigDefaults } from "../support/testAppConfigDefaults.js"

const A = WorkerOrdinal("A")
const B = WorkerOrdinal("B")
const C = WorkerOrdinal("C")

const JsonCallSchema = Schema.fromJsonString(CallSchema)

const makeLeg = (callId: string, fromTag: string): Leg => ({
  legId: "a",
  callId,
  fromTag,
  source: { address: "127.0.0.1", port: 5060 },
  state: "trying",
  disposition: "pending",
  dialogs: [],
})

const makeCall = (
  primary: WorkerOrdinal,
  backup: WorkerOrdinal,
  callId: string,
  fromTag: string,
  gen = 1
): Call => ({
  callRef: deriveCallRef(primary, callId, fromTag),
  aLeg: makeLeg(callId, fromTag),
  bLegs: [],
  activePeer: null,
  limiterEntries: [],
  timers: [],
  cdrEvents: [],
  state: "active",
  createdAt: 0,
  aLegInvite: {
    uri: "sip:test@example.com",
    headers: [],
    body: new Uint8Array(),
  },
  tagMap: [],
  _topology: { pri: primary, bak: backup, gen },
})

const harnessBuilt = (
  self: WorkerOrdinal,
  workers: ReadonlyArray<WorkerOrdinal>
) => {
  const fabricBuilt = PeerFabric.simulatedBuilt(workers, {
    // Deterministic rng so error-rate behavior is reproducible.
    rng: () => 0,
  })
  const config: AppConfigData = testAppConfigDefaults({
    workerOrdinalLabel: self,
  })
  const AppConfigLayer = Layer.succeed(AppConfig, config)
  const StorageLayer = fabricBuilt.fabric.storageLayerOf(self)
  const PortLayer = fabricBuilt.fabric.cachePortLayerOf(self)
  const ReadinessLayer = WorkerReadiness.Default
  // NOTE: build the enumerator from a *static set* of "all peers" so a
  // killed peer is still attempted (and fails). `fromFabric` drops
  // dead peers from enumeration entirely, which would silently hide
  // the failure path we want to assert here. In production the
  // analogue is "DNS still resolves the SRV record but the relay is
  // down" — DNS lookups don't fast-fail on connection issues.
  const otherPeers = workers.filter((w) => w !== self)
  const EnumeratorLayer = PeerEnumerator.staticSet(otherPeers)

  const ReclaimLayer = ReclaimRunner.layer({
    maxDuration: Duration.minutes(10),
    scanPacingMs: 0,
  }).pipe(
    Layer.provide(ReadinessLayer),
    Layer.provide(EnumeratorLayer),
    Layer.provide(StorageLayer),
    Layer.provide(PortLayer),
    Layer.provide(AppConfigLayer)
  )

  const layer = Layer.mergeAll(
    ReclaimLayer,
    ReadinessLayer,
    StorageLayer,
    fabricBuilt.layer
  )
  return { layer, fabricBuilt }
}

describe("ReclaimRunner — peer down during reclaim", () => {
  it.effect("dead peer counted as peersFailed; healthy peers still recover", () =>
    Effect.gen(function* () {
      const { layer, fabricBuilt } = harnessBuilt(C, [A, B, C])

      // Seed both peers with one entry each in C's bak partition.
      const callOnA = makeCall(C, A, "cid-on-a", "ft-on-a", 1)
      const callOnB = makeCall(C, B, "cid-on-b", "ft-on-b", 1)
      for (const [peer, call] of [[A, callOnA], [B, callOnB]] as const) {
        const json = yield* Schema.encodeEffect(JsonCallSchema)(call).pipe(
          Effect.orDie
        )
        yield* Effect.gen(function* () {
          const storage = yield* PartitionedRelayStorage
          yield* storage.putCall(
            "bak",
            C,
            call.callRef,
            json,
            callIndexKeys(call),
            600
          )
        }).pipe(Effect.provide(fabricBuilt.fabric.storageLayerOf(peer)))
      }

      // Kill peer A — its relay is dead; fabric replies
      // connection_refused. B is still alive.
      yield* fabricBuilt.control.killWorker(A)

      const result = yield* Effect.gen(function* () {
        const readiness = yield* WorkerReadiness
        const runner = yield* ReclaimRunner
        const r = yield* runner.run
        // Always flips ready, even when a peer fails.
        expect(yield* readiness.currentReady).toBe(true)
        return r
      }).pipe(Effect.provide(layer))

      expect(result.peersScanned).toBe(2)
      expect(result.peersFailed).toBe(1)
      // B's entry recovered; A's entry not visible because A is dead.
      expect(result.recoveredCalls).toBe(1)
      expect(result.timedOut).toBe(false)

      const snapC = yield* fabricBuilt.control.snapshotPeer(C)
      const keysC = snapC.entries.map((e) => e.key)
      expect(keysC).toContain(
        PartitionedRelayStorage.callKey("pri", C, callOnB.callRef)
      )
      expect(keysC).not.toContain(
        PartitionedRelayStorage.callKey("pri", C, callOnA.callRef)
      )
    })
  )

  it.effect("peer with errorRate=1 surfaces as peersFailed; other peers recover normally", () =>
    Effect.gen(function* () {
      const { layer, fabricBuilt } = harnessBuilt(C, [A, B, C])

      // Two entries on peer A, two on peer B — some scans will fail.
      const cA1 = makeCall(C, A, "cid-A1", "ft-A1", 1)
      const cA2 = makeCall(C, A, "cid-A2", "ft-A2", 1)
      const cB1 = makeCall(C, B, "cid-B1", "ft-B1", 1)
      const cB2 = makeCall(C, B, "cid-B2", "ft-B2", 1)
      for (const [peer, calls] of [[A, [cA1, cA2]], [B, [cB1, cB2]]] as const) {
        for (const call of calls) {
          const json = yield* Schema.encodeEffect(JsonCallSchema)(call).pipe(
            Effect.orDie
          )
          yield* Effect.gen(function* () {
            const storage = yield* PartitionedRelayStorage
            yield* storage.putCall(
              "bak",
              C,
              call.callRef,
              json,
              callIndexKeys(call),
              600
            )
          }).pipe(Effect.provide(fabricBuilt.fabric.storageLayerOf(peer)))
        }
      }

      // Force every scan addressed to A to fail. B is healthy.
      yield* fabricBuilt.control.setErrorRate(A, 1)

      const result = yield* Effect.gen(function* () {
        const runner = yield* ReclaimRunner
        return yield* runner.run
      }).pipe(Effect.provide(layer))

      expect(result.peersScanned).toBe(2)
      expect(result.peersFailed).toBe(1)
      expect(result.recoveredCalls).toBe(2) // both of B's entries
    })
  )
})
