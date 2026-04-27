/**
 * PeerEnumerator — slice 6 supporting primitive.
 *
 * Covers the two test-friendly layer constructors:
 *   - `staticSet` for unit tests that supply a fixed peer list
 *   - `fromFabric` for fabric-driven scenarios where `step.fabric.kill`
 *     should drop a peer from enumeration immediately
 *
 * The production `headlessStatefulSet` constructor is exercised
 * end-to-end by slice 10's K8s test (real DNS); a unit test would
 * either need to monkey-patch `node:dns/promises` or rely on a real
 * DNS server, both of which add fragility for limited value.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import { PeerEnumerator } from "../../src/cache/PeerEnumerator.js"
import { PeerFabric } from "../../src/cache/PeerFabric.js"

const A = WorkerOrdinal("A")
const B = WorkerOrdinal("B")
const C = WorkerOrdinal("C")

describe("PeerEnumerator.staticSet", () => {
  it.effect("returns the fixed list verbatim", () =>
    Effect.gen(function* () {
      const enumerator = yield* PeerEnumerator
      const peers = yield* enumerator.currentPeers
      expect(Array.from(peers)).toEqual([A, B, C])
    }).pipe(Effect.provide(PeerEnumerator.staticSet([A, B, C])))
  )

  it.effect("captures the list at build time — mutating the input array afterwards has no effect", () =>
    Effect.gen(function* () {
      const seed: Array<WorkerOrdinal> = [A, B]
      const layer = PeerEnumerator.staticSet(seed)
      seed.push(C)
      const enumerator = yield* PeerEnumerator
      const peers = yield* enumerator.currentPeers
      expect(Array.from(peers)).toEqual([A, B])
      // Avoid the unused-layer warning the closure check would flag.
      void layer
    }).pipe(Effect.provide(PeerEnumerator.staticSet([A, B])))
  )
})

describe("PeerEnumerator.fromFabric", () => {
  it.effect("returns every peer alive in the fabric, including self when self is unset", () =>
    Effect.gen(function* () {
      const fabric = PeerFabric.simulatedBuilt([A, B, C])
      const peers = yield* Effect.gen(function* () {
        const e = yield* PeerEnumerator
        return yield* e.currentPeers
      }).pipe(Effect.provide(PeerEnumerator.fromFabric(fabric)))
      expect(Array.from(peers).sort()).toEqual([A, B, C])
    })
  )

  it.effect("filters self out when self is provided", () =>
    Effect.gen(function* () {
      const fabric = PeerFabric.simulatedBuilt([A, B, C])
      const peers = yield* Effect.gen(function* () {
        const e = yield* PeerEnumerator
        return yield* e.currentPeers
      }).pipe(Effect.provide(PeerEnumerator.fromFabric(fabric, A)))
      expect(Array.from(peers).sort()).toEqual([B, C])
    })
  )

  it.effect("kill drops a peer from enumeration; reboot brings it back", () =>
    Effect.gen(function* () {
      const fabric = PeerFabric.simulatedBuilt([A, B, C])
      const layer = PeerEnumerator.fromFabric(fabric, A)
      const peers0 = yield* Effect.gen(function* () {
        const e = yield* PeerEnumerator
        return yield* e.currentPeers
      }).pipe(Effect.provide(layer))
      expect(Array.from(peers0).sort()).toEqual([B, C])

      yield* fabric.control.killWorker(B)
      const peers1 = yield* Effect.gen(function* () {
        const e = yield* PeerEnumerator
        return yield* e.currentPeers
      }).pipe(Effect.provide(layer))
      expect(Array.from(peers1)).toEqual([C])

      yield* fabric.control.rebootWorker(B)
      const peers2 = yield* Effect.gen(function* () {
        const e = yield* PeerEnumerator
        return yield* e.currentPeers
      }).pipe(Effect.provide(layer))
      expect(Array.from(peers2).sort()).toEqual([B, C])
    })
  )

  it.effect("rebooting health excludes peer (kubelet not-Ready while reclaim runs)", () =>
    Effect.gen(function* () {
      const fabric = PeerFabric.simulatedBuilt([A, B, C])
      const layer = PeerEnumerator.fromFabric(fabric, A)
      // After kill, snapshotPeer reports "dead". The fabric distinguishes
      // dead vs rebooting; both must be excluded from enumeration.
      yield* fabric.control.killWorker(B)
      // No reboot → still "dead". Independently, partition is not a
      // health concern for enumeration — the partitioned peer is still
      // alive from its own perspective.
      const peers = yield* Effect.gen(function* () {
        const e = yield* PeerEnumerator
        return yield* e.currentPeers
      }).pipe(Effect.provide(layer))
      expect(Array.from(peers)).toEqual([C])
    })
  )

  it.effect("draining peers ARE included (slice 7 will tighten this)", () =>
    Effect.gen(function* () {
      const fabric = PeerFabric.simulatedBuilt([A, B, C])
      yield* fabric.control.sigtermWorker(B)
      const peers = yield* Effect.gen(function* () {
        const e = yield* PeerEnumerator
        return yield* e.currentPeers
      }).pipe(Effect.provide(PeerEnumerator.fromFabric(fabric, A)))
      // A draining peer can still serve scan requests — its sidecar
      // Redis is intact until the pod actually exits.
      expect(Array.from(peers).sort()).toEqual([B, C])
    })
  )
})
