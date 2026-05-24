/**
 * PeerFabric.simulated — unit tests for the multi-peer in-memory fabric.
 *
 * Slice 5 of the HA-resilience plan, phase B. Verifies:
 *   - independent per-peer storage (a worker's putLocal stays in its
 *     own partition; another peer's snapshot is empty)
 *   - PeerCachePort routing across peers (worker A writes "remote"
 *     into worker B's store)
 *   - kill/reboot/partition/heal control surface
 *   - latency injection advances under TestClock
 *   - error-rate injection (deterministic via custom rng)
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  PartitionedRelayStorage,
  type PartitionRole,
} from "../../src/cache/PartitionedRelayStorage.js"
import {
  PeerFabric,
  PeerFabricControl,
} from "../../src/cache/PeerFabric.js"
import {
  PeerCachePort,
  WorkerOrdinal,
} from "../../src/cache/PeerCachePort.js"
import { bodyBuf } from "../support/codecHelpers.js"

const A = WorkerOrdinal("A")
const B = WorkerOrdinal("B")

const role: PartitionRole = "bak"

describe("PeerFabric.simulated", () => {
  it.effect("dispatches putCall from worker A's PeerCachePort to peer B's store", () =>
    Effect.gen(function* () {
      const fabric = yield* PeerFabric
      const control = yield* PeerFabricControl

      // Worker A's PeerCachePort runs through the fabric.
      const portLayer = fabric.cachePortLayerOf(A)

      yield* Effect.gen(function* () {
        const port = yield* PeerCachePort
        yield* port.putCall({
          peer: B,
          role,
          owner: A,
          callRef: "ref-1",
          state: bodyBuf({ hi: 1 }),
          indexes: ["leg:abc|tag1"],
          ttlSec: 60,
        })
      }).pipe(Effect.provide(portLayer))

      // B's snapshot should now hold the call + the index entry.
      const snapB = yield* control.snapshotPeer(B)
      const keys = snapB.entries.map((e) => e.key)
      expect(keys).toContain(PartitionedRelayStorage.callKey(role, A, "ref-1"))
      expect(keys).toContain(PartitionedRelayStorage.indexKey("leg:abc|tag1"))

      // A's snapshot should be empty (writes addressed to B did not land on A).
      const snapA = yield* control.snapshotPeer(A)
      expect(snapA.entries).toHaveLength(0)
    }).pipe(Effect.provide(PeerFabric.simulated([A, B])))
  )

  it.effect("kill marks peer dead; subsequent putCall fails with connection_refused", () =>
    Effect.gen(function* () {
      const fabric = yield* PeerFabric
      const control = yield* PeerFabricControl
      yield* control.killWorker(B)

      const portLayer = fabric.cachePortLayerOf(A)
      const result = yield* Effect.gen(function* () {
        const port = yield* PeerCachePort
        return yield* Effect.flip(
          port.putCall({
            peer: B,
            role,
            owner: A,
            callRef: "ref-2",
            state: bodyBuf({}),
            indexes: [],
            ttlSec: 60,
          })
        )
      }).pipe(Effect.provide(portLayer))

      expect(result.reason).toBe("connection_refused")

      // After reboot, writes succeed again — but the previous store
      // contents are gone (matches ephemeral sidecar Redis).
      yield* control.rebootWorker(B)
      yield* Effect.gen(function* () {
        const port = yield* PeerCachePort
        yield* port.putCall({
          peer: B,
          role,
          owner: A,
          callRef: "ref-3",
          state: bodyBuf({}),
          indexes: [],
          ttlSec: 60,
        })
      }).pipe(Effect.provide(portLayer))

      const snap = yield* control.snapshotPeer(B)
      expect(snap.health).toBe("alive")
      expect(snap.entries.map((e) => e.key)).toContain(
        PartitionedRelayStorage.callKey(role, A, "ref-3")
      )
    }).pipe(Effect.provide(PeerFabric.simulated([A, B])))
  )

  it.effect("partition makes A↔B writes fail; heal restores", () =>
    Effect.gen(function* () {
      const fabric = yield* PeerFabric
      const control = yield* PeerFabricControl
      yield* control.partition(A, B)

      const portLayer = fabric.cachePortLayerOf(A)
      const failed = yield* Effect.gen(function* () {
        const port = yield* PeerCachePort
        return yield* Effect.flip(
          port.putCall({
            peer: B,
            role,
            owner: A,
            callRef: "ref-p",
            state: bodyBuf({}),
            indexes: [],
            ttlSec: 60,
          })
        )
      }).pipe(Effect.provide(portLayer))
      expect(failed.reason).toBe("fabric_partitioned")

      yield* control.heal(A, B)
      yield* Effect.gen(function* () {
        const port = yield* PeerCachePort
        yield* port.putCall({
          peer: B,
          role,
          owner: A,
          callRef: "ref-p",
          state: bodyBuf({}),
          indexes: [],
          ttlSec: 60,
        })
      }).pipe(Effect.provide(portLayer))

      const snap = yield* control.snapshotPeer(B)
      expect(snap.entries.map((e) => e.key)).toContain(
        PartitionedRelayStorage.callKey(role, A, "ref-p")
      )
    }).pipe(Effect.provide(PeerFabric.simulated([A, B])))
  )

  it.effect("setLatency injects an Effect.sleep before dispatch", () =>
    Effect.gen(function* () {
      const fabric = yield* PeerFabric
      const control = yield* PeerFabricControl
      yield* control.setLatency(B, 250)

      const portLayer = fabric.cachePortLayerOf(A)
      const fiber = yield* Effect.gen(function* () {
        const port = yield* PeerCachePort
        yield* port.putCall({
          peer: B,
          role,
          owner: A,
          callRef: "ref-lat",
          state: bodyBuf({}),
          indexes: [],
          ttlSec: 60,
        })
      }).pipe(Effect.provide(portLayer), Effect.forkChild)

      // Before advancing the clock, the write should not have landed.
      yield* Effect.yieldNow
      const before = yield* control.snapshotPeer(B)
      expect(before.entries).toHaveLength(0)

      yield* TestClock.adjust(Duration.millis(300))
      yield* Fiber.join(fiber)

      const after = yield* control.snapshotPeer(B)
      expect(after.entries.map((e) => e.key)).toContain(
        PartitionedRelayStorage.callKey(role, A, "ref-lat")
      )
    }).pipe(Effect.provide(PeerFabric.simulated([A, B])))
  )

  it.effect("setErrorRate=1 with deterministic rng forces every write to fail", () =>
    Effect.gen(function* () {
      const fabric = yield* PeerFabric
      const control = yield* PeerFabricControl
      yield* control.setErrorRate(B, 1)

      const portLayer = fabric.cachePortLayerOf(A)
      const result = yield* Effect.gen(function* () {
        const port = yield* PeerCachePort
        return yield* Effect.flip(
          port.putCall({
            peer: B,
            role,
            owner: A,
            callRef: "ref-err",
            state: bodyBuf({}),
            indexes: [],
            ttlSec: 60,
          })
        )
      }).pipe(Effect.provide(portLayer))
      expect(result.reason).toBe("http_error")
      expect(result.detail).toBe("fabric injected error")
    }).pipe(Effect.provide(PeerFabric.simulated([A, B], { rng: () => 0 })))
  )

  it.effect("scan streams entries from peer's partition", () =>
    Effect.gen(function* () {
      const fabric = yield* PeerFabric
      const control = yield* PeerFabricControl

      // Seed B directly via its storage layer.
      yield* Effect.gen(function* () {
        const storage = yield* PartitionedRelayStorage
        yield* storage.putCall("bak", A, "ref-1", bodyBuf({ x: 1 }), [], 60)
        yield* storage.putCall("bak", A, "ref-2", bodyBuf({ x: 2 }), [], 60)
      }).pipe(Effect.provide(fabric.storageLayerOf(B)))

      const portLayer = fabric.cachePortLayerOf(A)
      const collected = yield* Effect.gen(function* () {
        const port = yield* PeerCachePort
        return yield* Stream.runCollect(
          port.scan({ peer: B, role: "bak", owner: A })
        )
      }).pipe(Effect.provide(portLayer))

      const refs = Array.from(collected, (e) => e.callRef).sort()
      expect(refs).toEqual(["ref-1", "ref-2"])

      // For symmetry, the snapshot agrees.
      const snap = yield* control.snapshotPeer(B)
      const keys = snap.entries.map((e) => e.key).sort()
      expect(keys).toContain(PartitionedRelayStorage.callKey("bak", A, "ref-1"))
      expect(keys).toContain(PartitionedRelayStorage.callKey("bak", A, "ref-2"))
    }).pipe(Effect.provide(PeerFabric.simulated([A, B])))
  )
})

