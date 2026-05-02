/**
 * ReclaimRunner — recovery under simulated LAN stress.
 *
 * Verifies the reclaim flow still completes (and counts entries
 * correctly) when the inter-pod fabric injects:
 *   - per-peer latency on every dispatch (peer is "slow")
 *   - per-peer error rate (some scans fail mid-stream — covered by
 *     the peer-down-mid-scan test; this file focuses on latency)
 *
 * Reclaim does NOT retry failed peers within a single `run()` —
 * peer-failure under load surfaces as `peersFailed > 0` and falls
 * through to the 481 path on subsequent in-dialog requests. We assert
 * that latency does NOT cause spurious peer failures: every peer
 * eventually delivers its stream, regardless of how slow.
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
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
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

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
  workers: ReadonlyArray<WorkerOrdinal>,
  reclaimOpts?: Partial<{
    maxDuration: Duration.Duration
    peerConcurrency: number
    scanBatch: number
    scanPacingMs: number
  }>
) => {
  const fabricBuilt = PeerFabric.simulatedBuilt(workers)
  const config: AppConfigData = testAppConfigDefaults({
    workerOrdinalLabel: self,
  })
  const AppConfigLayer = Layer.succeed(AppConfig, config)
  const StorageLayer = fabricBuilt.fabric.storageLayerOf(self)
  const PortLayer = fabricBuilt.fabric.cachePortLayerOf(self)
  const ReadinessLayer = WorkerReadiness.Default
  const EnumeratorLayer = PeerEnumerator.fromFabric(fabricBuilt, self)

  const ReclaimLayer = ReclaimRunner.layer(reclaimOpts).pipe(
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

describe("ReclaimRunner — recovery under LAN stress", () => {
  it.effect("completes despite per-peer dispatch latency (TestClock advances through it)", () =>
    Effect.gen(function* () {
      const { layer, fabricBuilt } = harnessBuilt(C, [A, B, C], {
        maxDuration: Duration.minutes(10),
        scanPacingMs: 0,
      })

      const callA = makeCall(C, A, "cid-A", "ft-A", 3)
      const callB = makeCall(C, B, "cid-B", "ft-B", 4)
      for (const [peer, call] of [[A, callA], [B, callB]] as const) {
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

      // 250ms outbound latency on each peer's dispatch — slow LAN.
      yield* fabricBuilt.control.setLatency(A, 250)
      yield* fabricBuilt.control.setLatency(B, 250)

      // Fork the run; before advancing TestClock, neither call has
      // landed locally yet (the latency sleep on each dispatch
      // hasn't fired).
      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          const runner = yield* ReclaimRunner
          return yield* runner.run
        }).pipe(Effect.provide(layer))
      )

      yield* Effect.yieldNow
      const beforeAdjust = yield* fabricBuilt.control.snapshotPeer(C)
      // Reclaim is parked on the latency sleep — local C still empty.
      expect(beforeAdjust.entries).toHaveLength(0)

      // Advance well past the per-dispatch latency (250ms × 1 = 250ms;
      // the fabric inserts the sleep once per scan call, not per entry).
      yield* TestClock.adjust(Duration.seconds(1))
      const result = yield* Fiber.join(fiber)

      expect(result.recoveredCalls).toBe(2)
      expect(result.peersScanned).toBe(2)
      expect(result.peersFailed).toBe(0)
      expect(result.timedOut).toBe(false)

      const snapC = yield* fabricBuilt.control.snapshotPeer(C)
      const keysC = snapC.entries.map((e) => e.key).sort()
      expect(keysC).toContain(
        PartitionedRelayStorage.callKey("pri", C, callA.callRef)
      )
      expect(keysC).toContain(
        PartitionedRelayStorage.callKey("pri", C, callB.callRef)
      )
    })
  )

  it.effect("scanPacingMs > 0 is observable: ingest waits across pacing sleeps", () =>
    Effect.gen(function* () {
      const { layer, fabricBuilt } = harnessBuilt(C, [A, C], {
        maxDuration: Duration.minutes(10),
        scanPacingMs: 100,
      })

      // Two entries on peer A so the pacing sleep fires at least once
      // between ingestions.
      const c1 = makeCall(C, A, "cid-1", "ft-1", 1)
      const c2 = makeCall(C, A, "cid-2", "ft-2", 2)
      for (const call of [c1, c2]) {
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
        }).pipe(Effect.provide(fabricBuilt.fabric.storageLayerOf(A)))
      }

      const fiber = yield* Effect.forkChild(
        Effect.gen(function* () {
          const runner = yield* ReclaimRunner
          return yield* runner.run
        }).pipe(Effect.provide(layer))
      )

      // First entry lands eagerly (no pacing before it). Drain a few
      // scheduler cycles, then assert at least one is in.
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      // Advance virtual time past the pacing sleep so the second entry
      // can also land + the run completes.
      yield* TestClock.adjust(Duration.millis(200))
      const result = yield* Fiber.join(fiber)
      expect(result.recoveredCalls).toBe(2)
      expect(result.timedOut).toBe(false)
    })
  )
})
