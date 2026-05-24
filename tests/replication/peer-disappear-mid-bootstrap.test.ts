/**
 * T11 — peer-disappear-mid-bootstrap.
 *
 * Asserts the supervisor handles peer disappearance from any per-peer
 * fiber state, including the early ones (Discovered, Connecting,
 * pre-`everCaughtUp` Streaming). Per design §D7:
 *
 *   "Peer disappears mid-bootstrap (initial sync): drop the peer from
 *    the readiness-blocking set immediately. Worker continues toward
 *    Ready based on the remaining alive peers. The disappeared peer's
 *    fiber transitions to Disappeared with watermark preserved... The
 *    state machine MUST handle this transition out of PullingBootstrap
 *    directly (not only out of PullingSteady)."
 *
 * The supervisor itself is the unit under test here — its ability to
 * interrupt a fiber regardless of which sub-state it is in.
 */

import { describe, expect, it } from "@effect/vitest"
import {
  Duration,
  Effect,
  Fiber,
  MutableRef,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import type { PeerEnumeratorApi } from "../../src/cache/PeerEnumerator.js"
import {
  PullerTransportError,
  runPullerFiber,
  type PeerView,
} from "../../src/replication/PullerFiber.js"
import { makeReplicationSupervisor } from "../../src/replication/ReplicationSupervisor.js"

const peer1 = WorkerOrdinal("worker-1")
const peer2 = WorkerOrdinal("worker-2")

const dynamicEnumerator = (
  initial: ReadonlyArray<WorkerOrdinal>
): {
  enumerator: PeerEnumeratorApi
  set: (peers: ReadonlyArray<WorkerOrdinal>) => void
} => {
  const ref = MutableRef.make<ReadonlyArray<WorkerOrdinal>>(initial)
  return {
    enumerator: { currentPeers: Effect.sync(() => MutableRef.get(ref)) },
    set: (peers) => MutableRef.set(ref, peers),
  }
}

describe("T11 — peer disappears mid-bootstrap", () => {
  it.effect(
    "disappear in pre-Streaming state interrupts fiber and unblocks readiness path",
    () =>
      Effect.gen(function* () {
        // Peer 1's puller fiber is forked but stays in 'Connecting'
        // forever (its openStream returns a stream that never produces
        // a chunk). Disappearing peer1 should still interrupt the
        // fiber cleanly, via the supervisor's watch tick.
        const { enumerator, set } = dynamicEnumerator([peer1, peer2])

        const supervisor = makeReplicationSupervisor({
          enumerator,
          watchIntervalMs: 50,
          forkPullerFiber: (peer, viewRef) =>
            Effect.forkChild(
              runPullerFiber({
                peer,
                viewRef,
                openStream: () =>
                  // Stream that never produces a chunk — fiber is
                  // forever in Streaming/Connecting per the runForEach
                  // suspended state. Stream.never has no items.
                  Stream.never as Stream.Stream<Uint8Array, PullerTransportError>,
                applyFrame: () => Effect.void,
                chunkSize: 100,
              })
            ),
        })

        const supervisorFiber = yield* Effect.forkChild(supervisor.run)

        // Initial reconcile fires; both peers get fibers that go to
        // Streaming (the fiber sets state Streaming before consuming).
        yield* Effect.yieldNow
        yield* Effect.yieldNow

        let state = yield* supervisor.observe
        expect(state.alivePeers.has(peer1)).toBe(true)
        expect(state.alivePeers.has(peer2)).toBe(true)
        // Both still in pre-everCaughtUp state — no noop frame ever arrived.
        expect(state.perPeer.get(peer1)?.everCaughtUp).toBe(false)
        expect(state.perPeer.get(peer2)?.everCaughtUp).toBe(false)

        // Drop peer1 from the enumeration.
        set([peer2])
        yield* TestClock.adjust(Duration.millis(50))
        yield* Effect.yieldNow

        state = yield* supervisor.observe
        // peer1: fiber interrupted, view marked Disappeared,
        // alivePeers no longer contains it.
        expect(state.alivePeers.has(peer1)).toBe(false)
        expect(state.alivePeers.has(peer2)).toBe(true)
        const view1 = state.perPeer.get(peer1)!
        expect(view1.fiberState).toBe("Disappeared")
        // Watermark preserved at the initial (0,0) — never advanced
        // because no frames flowed.
        expect(view1.watermark).toEqual({ gen: 0, counter: 0 })

        yield* Fiber.interrupt(supervisorFiber)
      })
  )

  it.effect(
    "disappear in Discovered state (between fork and first stream open) is handled",
    () =>
      Effect.gen(function* () {
        // Synthetic puller: pretends to be Discovered forever — never
        // even calls openStream. This exercises the supervisor's
        // ability to interrupt a fiber that is still in the Discovered
        // sub-state per §D5.2.
        const { enumerator, set } = dynamicEnumerator([peer1])

        const viewRefs = new Map<WorkerOrdinal, MutableRef.MutableRef<PeerView>>()

        const supervisor = makeReplicationSupervisor({
          enumerator,
          watchIntervalMs: 50,
          forkPullerFiber: (peer, viewRef) =>
            Effect.gen(function* () {
              viewRefs.set(peer, viewRef)
              return yield* Effect.forkChild(Effect.never)
            }),
        })

        const supervisorFiber = yield* Effect.forkChild(supervisor.run)

        yield* Effect.yieldNow

        // viewRef state is Discovered (the supervisor's reconcile sets
        // that just before forking).
        const ref = viewRefs.get(peer1)!
        expect(MutableRef.get(ref).fiberState).toBe("Discovered")

        // Disappear.
        set([])
        yield* TestClock.adjust(Duration.millis(50))
        yield* Effect.yieldNow

        const state = yield* supervisor.observe
        expect(state.alivePeers.has(peer1)).toBe(false)
        expect(state.perPeer.get(peer1)?.fiberState).toBe("Disappeared")

        yield* Fiber.interrupt(supervisorFiber)
      })
  )

  it.effect(
    "remaining peers continue toward readiness while a disappeared peer's fiber is gone",
    () =>
      Effect.gen(function* () {
        // peer1 disappears mid-bootstrap; peer2's puller has already
        // received a noop and reached `everCaughtUp = true`. The
        // ReadinessController logic (Slice 6) reads alivePeers + the
        // view map; we assert that data shape is correct here.
        const { enumerator, set } = dynamicEnumerator([peer1, peer2])

        const supervisor = makeReplicationSupervisor({
          enumerator,
          watchIntervalMs: 50,
          forkPullerFiber: (peer, viewRef) =>
            Effect.gen(function* () {
              if (peer === peer2) {
                MutableRef.set(viewRef, {
                  ...MutableRef.get(viewRef),
                  fiberState: "Streaming",
                  everCaughtUp: true,
                  watermark: { gen: 7, counter: 4 },
                })
              }
              return yield* Effect.forkChild(Effect.never)
            }),
        })

        const supervisorFiber = yield* Effect.forkChild(supervisor.run)

        yield* Effect.yieldNow

        // peer1 disappears mid-bootstrap.
        set([peer2])
        yield* TestClock.adjust(Duration.millis(50))
        yield* Effect.yieldNow

        const state = yield* supervisor.observe

        // ReadinessController would compute: every alive peer must be
        // everCaughtUp. Disappeared peers don't count.
        const aliveAndCaught = [...state.alivePeers].every(
          (p) => state.perPeer.get(p)?.everCaughtUp === true
        )
        expect(aliveAndCaught).toBe(true)

        yield* Fiber.interrupt(supervisorFiber)
      })
  )
})
