/**
 * ReclaimRunner — happy-path on-restart recovery.
 *
 * Setup: workers A, B. Pretend B was the natural primary for a call
 * whose backup landed on A — A's `bak:B:` partition holds the entry.
 * Then "restart" B (fabric.rebootWorker clears its sidecar). Run
 * ReclaimRunner from B's perspective and assert:
 *   1. Local `pri:B:call:{ref}` exists — recovered from A.
 *   2. The flat index entry exists locally — set by `storage.putCall`
 *      from the index list `callIndexKeys` extracted from the JSON.
 *   3. `WorkerReadiness` flipped false → true around the run.
 *   4. The result counters reflect: `recoveredCalls=1`, `timedOut=false`.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
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

/**
 * Build a ReclaimRunner harness for worker `self`, sharing one fabric
 * across all workers. The returned `fabricBuilt` handle lets the test
 * seed peers' partitions directly via `storageLayerOf(peer)` and
 * inspect via `control.snapshotPeer`.
 */
const harnessBuilt = (
  self: WorkerOrdinal,
  workers: ReadonlyArray<WorkerOrdinal>
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

  const ReclaimLayer = ReclaimRunner.layer({
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

describe("ReclaimRunner.run — single peer with one entry", () => {
  it.effect("recovers a B-primary call from peer A's bak:B: partition + flips readiness true", () =>
    Effect.gen(function* () {
      const { layer, fabricBuilt } = harnessBuilt(B, [A, B])

      // Seed peer A's bak:B partition directly via A's storage layer
      // — bypasses the dual-write path (we're simulating "B was up
      // earlier and dual-wrote here, then crashed"). The seeded entry
      // names B as primary, A as backup, gen=2.
      const call = makeCall(B, A, "cid-restart", "ft-restart", 2)
      const json = yield* Schema.encodeEffect(JsonCallSchema)(call).pipe(
        Effect.orDie
      )
      const indexes = callIndexKeys(call)
      yield* Effect.gen(function* () {
        const storage = yield* PartitionedRelayStorage
        yield* storage.putCall("bak", B, call.callRef, json, indexes, 600)
      }).pipe(Effect.provide(fabricBuilt.fabric.storageLayerOf(A)))

      // Sanity: A holds the seeded backup, B's storage is empty.
      const snapA0 = yield* fabricBuilt.control.snapshotPeer(A)
      expect(snapA0.entries.map((e) => e.key)).toContain(
        PartitionedRelayStorage.callKey("bak", B, call.callRef)
      )
      const snapB0 = yield* fabricBuilt.control.snapshotPeer(B)
      expect(snapB0.entries).toHaveLength(0)

      // Now run reclaim on B.
      const result = yield* Effect.gen(function* () {
        const readiness = yield* WorkerReadiness
        const runner = yield* ReclaimRunner

        // Pre-condition: not-ready by default per D9.
        expect(yield* readiness.currentReady).toBe(false)

        const r = yield* runner.run

        // Post-condition: ready, regardless of how many calls were
        // recovered (the readiness gate is one-shot per run).
        expect(yield* readiness.currentReady).toBe(true)
        return r
      }).pipe(Effect.provide(layer))

      expect(result.recoveredCalls).toBe(1)
      expect(result.skippedByGen).toBe(0)
      expect(result.peersScanned).toBe(1)
      expect(result.peersFailed).toBe(0)
      expect(result.timedOut).toBe(false)

      // B's local pri:B partition now holds the call + the leg index.
      const snapB1 = yield* fabricBuilt.control.snapshotPeer(B)
      const keysB = snapB1.entries.map((e) => e.key)
      expect(keysB).toContain(
        PartitionedRelayStorage.callKey("pri", B, call.callRef)
      )
      // Flat index for the a-leg's leg-tag pair lands too — slice 6
      // mirrors `CallState.flushToRedis`'s indexes-list semantics.
      expect(keysB).toContain(
        PartitionedRelayStorage.indexKey(
          `leg:${call.aLeg.callId}|${call.aLeg.fromTag}`
        )
      )
    })
  )

  it.effect("skips entries when local already has equal-or-newer _topology.gen (D7)", () =>
    Effect.gen(function* () {
      const { layer, fabricBuilt } = harnessBuilt(B, [A, B])

      const callOld = makeCall(B, A, "cid-gen", "ft-gen", 1)
      const callNew = makeCall(B, A, "cid-gen", "ft-gen", 5)
      const indexes = callIndexKeys(callNew)

      // Seed peer A with an OLDER gen than what B already has locally.
      const oldJson = yield* Schema.encodeEffect(JsonCallSchema)(callOld).pipe(
        Effect.orDie
      )
      yield* Effect.gen(function* () {
        const storage = yield* PartitionedRelayStorage
        yield* storage.putCall("bak", B, callOld.callRef, oldJson, indexes, 600)
      }).pipe(Effect.provide(fabricBuilt.fabric.storageLayerOf(A)))

      // Pre-seed B's own pri:B with the NEWER gen — simulating the
      // case where B's dual-write fan-out already landed a fresher
      // value mid-restart and ReclaimRunner must not clobber it.
      const newJson = yield* Schema.encodeEffect(JsonCallSchema)(callNew).pipe(
        Effect.orDie
      )
      yield* Effect.gen(function* () {
        const storage = yield* PartitionedRelayStorage
        yield* storage.putCall("pri", B, callNew.callRef, newJson, indexes, 600)
      }).pipe(Effect.provide(fabricBuilt.fabric.storageLayerOf(B)))

      const result = yield* Effect.gen(function* () {
        const runner = yield* ReclaimRunner
        return yield* runner.run
      }).pipe(Effect.provide(layer))

      expect(result.recoveredCalls).toBe(0)
      expect(result.skippedByGen).toBe(1)
      expect(result.timedOut).toBe(false)

      // B's local pri:B still carries the newer-gen value.
      const snapB = yield* fabricBuilt.control.snapshotPeer(B)
      const callEntry = snapB.entries.find(
        (e) =>
          e.key === PartitionedRelayStorage.callKey("pri", B, callNew.callRef)
      )
      expect(callEntry).toBeDefined()
      const stored = JSON.parse(callEntry!.value) as {
        _topology?: { gen?: number }
      }
      expect(stored._topology?.gen).toBe(5)
    })
  )

  it.effect("no peers → run completes immediately, recovered=0, ready flipped true", () =>
    Effect.gen(function* () {
      // Self-only fabric: enumerator returns [] after filtering self.
      const { layer } = harnessBuilt(B, [B])
      const result = yield* Effect.gen(function* () {
        const readiness = yield* WorkerReadiness
        const runner = yield* ReclaimRunner
        const r = yield* runner.run
        expect(yield* readiness.currentReady).toBe(true)
        return r
      }).pipe(Effect.provide(layer))
      expect(result).toMatchObject({
        recoveredCalls: 0,
        skippedByGen: 0,
        peersScanned: 0,
        peersFailed: 0,
        timedOut: false,
      })
    })
  )
})
