/**
 * CallState dual-write fan-out — Slice 5 phase D.
 *
 * Exercises the CallState ↔ PeerCachePort wiring under
 * `PeerFabric.simulated`. Each test pins one CallState instance to a
 * named worker (matching the cookie's `w_pri`/`w_bak`) and asserts
 * what lands on which peer.
 *
 * Four named tests (per Slice 5 plan):
 *   - multi-peer-write              local + remote both observable
 *   - backup-write-fails            fabric injects error, local proceeds
 *   - gen-monotonicity              `_topology.gen` strictly increases
 *   - recovery-write-back-to-bak    self != primary → writes go to
 *                                   `bak:{primary}:`, NOT `pri:self:`
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { CallState } from "../../src/call/CallState.js"
import {
  PartitionedRelayStorage,
  type PartitionRole,
} from "../../src/cache/PartitionedRelayStorage.js"
import {
  PeerFabric,
  PeerFabricControl,
} from "../../src/cache/PeerFabric.js"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import {
  type Call,
  type Leg,
  deriveCallRef,
} from "../../src/call/CallModel.js"
import { testAppConfigDefaults } from "../support/testAppConfigDefaults.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const A = WorkerOrdinal("A")
const B = WorkerOrdinal("B")

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
  primary: string,
  backup: string,
  callId: string,
  fromTag: string,
  gen: number = 0
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
 * Build a CallState for worker `self`, plugged into the peer slot of
 * `self` for local writes and into the fabric-wide `PeerCachePort` for
 * remote writes. Returned layer also exposes `PeerFabric` and
 * `PeerFabricControl` so tests can inspect/assert.
 */
const harness = (
  self: WorkerOrdinal,
  workers: ReadonlyArray<WorkerOrdinal>,
  configOverrides?: Partial<AppConfigData>
) => {
  const fabric = PeerFabric.simulatedBuilt(workers)
  const config: AppConfigData = testAppConfigDefaults({
    workerOrdinalLabel: self,
    ...configOverrides,
  })
  const AppConfigLayer = Layer.succeed(AppConfig, config)
  const StorageLayer = fabric.fabric.storageLayerOf(self)
  const PortLayer = fabric.fabric.cachePortLayerOf(self)
  const callStateLayer = CallState.layer.pipe(
    Layer.provide(StorageLayer),
    Layer.provide(PortLayer),
    Layer.provideMerge(AppConfigLayer)
  )
  return Layer.mergeAll(callStateLayer, fabric.layer)
}

const callKey = (
  role: PartitionRole,
  owner: string,
  callRef: string
): string => PartitionedRelayStorage.callKey(role, owner, callRef)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CallState dual-write fan-out", () => {
  it.effect("multi-peer-write — local + remote both observable", () =>
    Effect.gen(function* () {
      const callState = yield* CallState
      const control = yield* PeerFabricControl

      const call = makeCall(A, B, "cid-1", "ft-1")
      yield* callState.create(call)
      yield* callState.flushToRedis(call.callRef)

      // Local write landed on A as `pri:A:call:{ref}` (self == primary).
      const snapA = yield* control.snapshotPeer(A)
      expect(snapA.entries.map((e) => e.key)).toContain(
        callKey("pri", A, call.callRef)
      )
      // Remote write landed on B as `bak:A:call:{ref}` (D16 / dual-write).
      // forkChild fan-out means the remote write may not have finished
      // by the time flushToRedis returns; yield once to drain.
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      const snapB = yield* control.snapshotPeer(B)
      expect(snapB.entries.map((e) => e.key)).toContain(
        callKey("bak", A, call.callRef)
      )
    }).pipe(Effect.provide(harness(A, [A, B])))
  )

  it.effect("backup-write-fails — local write proceeds, no error surfaced", () =>
    Effect.gen(function* () {
      const callState = yield* CallState
      const control = yield* PeerFabricControl

      // Force every B write to fail with http_error.
      yield* control.setErrorRate(B, 1)

      const call = makeCall(A, B, "cid-fail", "ft-fail")
      yield* callState.create(call)
      // flushToRedis must succeed even though the fan-out write fails.
      yield* callState.flushToRedis(call.callRef)

      // Local write lands.
      const snapA = yield* control.snapshotPeer(A)
      expect(snapA.entries.map((e) => e.key)).toContain(
        callKey("pri", A, call.callRef)
      )
      // Drain the fan-out fiber so the warning log is emitted (we don't
      // assert on log, but we want the fiber to settle before the test
      // ends to avoid leaking).
      yield* Effect.yieldNow
      // B never accepts the write.
      const snapB = yield* control.snapshotPeer(B)
      expect(
        snapB.entries.find((e) =>
          e.key === callKey("bak", A, call.callRef)
        )
      ).toBeUndefined()
    }).pipe(Effect.provide(harness(A, [A, B])))
  )

  it.effect("gen-monotonicity — _topology.gen strictly increases across flushes", () =>
    Effect.gen(function* () {
      const callState = yield* CallState
      const control = yield* PeerFabricControl

      const call = makeCall(A, B, "cid-gen", "ft-gen")
      yield* callState.create(call)

      const readGen = (entryKey: string, snap: { entries: ReadonlyArray<{ key: string; value: string }> }): number => {
        const e = snap.entries.find((x) => x.key === entryKey)
        if (e === undefined) return -1
        const parsed = JSON.parse(e.value) as { _topology?: { gen?: number } }
        return parsed._topology?.gen ?? -1
      }

      const seen: Array<number> = []
      for (let i = 0; i < 4; i++) {
        yield* callState.flushToRedis(call.callRef)
        // Drain dual-write fiber.
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        const snapA = yield* control.snapshotPeer(A)
        const localGen = readGen(callKey("pri", A, call.callRef), snapA)
        const snapB = yield* control.snapshotPeer(B)
        const remoteGen = readGen(callKey("bak", A, call.callRef), snapB)
        expect(localGen).toBe(remoteGen)
        seen.push(localGen)
      }

      // Strictly increasing.
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]).toBeGreaterThan(seen[i - 1]!)
      }
      // First flush bumps from 0 → 1.
      expect(seen[0]).toBe(1)
    }).pipe(Effect.provide(harness(A, [A, B])))
  )

  it.effect("recovery-write-back-to-bak — self != primary writes land in bak:{primary}:", () =>
    Effect.gen(function* () {
      // CallState's `self` is B (= the recovery worker). The call's
      // cookie names A as primary, B as backup, so when B serves this
      // call its writes must land in `bak:A:`, NOT `pri:B:` (D16).
      const callState = yield* CallState
      const control = yield* PeerFabricControl

      const call = makeCall(A, B, "cid-recovery", "ft-recovery")
      yield* callState.create(call)
      yield* callState.flushToRedis(call.callRef)
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      // Local write on B lands in `bak:A:` (D16): partitionOf sees
      // `parsed.primary === A !== self.B` → role "bak", primary "A".
      const snapB = yield* control.snapshotPeer(B)
      const keysB = snapB.entries.map((e) => e.key)
      expect(keysB).toContain(callKey("bak", A, call.callRef))
      // It MUST NOT have written to `pri:B:` — that partition is
      // reserved for calls B is the natural primary for.
      expect(keysB).not.toContain(callKey("pri", B, call.callRef))

      // Remote fan-out: cookie's bak == "B" == self.B → backupTarget
      // returns none (we don't write to ourselves). So peer A gets
      // nothing from this call.
      const snapA = yield* control.snapshotPeer(A)
      const keysA = snapA.entries.map((e) => e.key)
      expect(keysA).not.toContain(callKey("pri", A, call.callRef))
      expect(keysA).not.toContain(callKey("bak", A, call.callRef))
    }).pipe(Effect.provide(harness(B, [A, B])))
  )
})
