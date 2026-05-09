/**
 * ReadinessController — Slice 6 worker-state machine.
 *
 * Asserts the T_min/T_max + everCaughtUp aggregation rules per
 * docs/plan/grill-me-on-the-spicy-lark.md §D5.1, §D6:
 *
 *   - Stay Booting/Bootstrapping until `t >= T_min` (no flapping at boot).
 *   - Once all alive peers have `everCaughtUp = true`, transition to Ready.
 *   - If `t >= T_max` and not all alive peers are caught up, transition
 *     to Ready anyway with a WARN naming stalled peers.
 *   - Once Ready, never returns to Bootstrapping (no flap on later peer
 *     trouble).
 *   - `drain` flips state to Draining and calls `markReady(false)`.
 */

import { describe, expect, it } from "@effect/vitest"
import {
  Duration,
  Effect,
  Fiber,
  MutableHashMap,
  MutableRef,
} from "effect"
import { TestClock } from "effect/testing"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import { initialPeerView, type PeerView } from "../../src/replication/PullerFiber.js"
import { makeReadinessController } from "../../src/replication/ReadinessController.js"
import type { SupervisorState } from "../../src/replication/ReplicationSupervisor.js"

// ---------------------------------------------------------------------------
// Test harness — a synthetic SupervisorState backed by mutable state we can
// drive from the test body.
// ---------------------------------------------------------------------------

const peer1 = WorkerOrdinal("worker-1")
const peer2 = WorkerOrdinal("worker-2")

interface Harness {
  observeState: Effect.Effect<SupervisorState>
  setAlive: (peers: ReadonlyArray<WorkerOrdinal>) => void
  setCaughtUp: (peer: WorkerOrdinal, caught: boolean) => void
}

const makeHarness = (): Harness => {
  const alive = MutableRef.make<ReadonlySet<WorkerOrdinal>>(new Set())
  const views = MutableHashMap.empty<WorkerOrdinal, PeerView>()
  return {
    observeState: Effect.sync(() => {
      const perPeer = new Map<WorkerOrdinal, PeerView>()
      for (const [k, v] of views) perPeer.set(k, v)
      return {
        alivePeers: MutableRef.get(alive),
        perPeer,
      }
    }),
    setAlive: (peers) => {
      MutableRef.set(alive, new Set(peers))
      for (const p of peers) {
        if (!MutableHashMap.has(views, p)) {
          MutableHashMap.set(views, p, initialPeerView(p))
        }
      }
    },
    setCaughtUp: (peer, caught) => {
      const cur = MutableHashMap.get(views, peer)
      if (cur._tag === "Some") {
        MutableHashMap.set(views, peer, { ...cur.value, everCaughtUp: caught })
      } else {
        MutableHashMap.set(views, peer, {
          ...initialPeerView(peer),
          everCaughtUp: caught,
        })
      }
    },
  }
}

const setup = (
  config: { tMinMs: number; tMaxMs: number; tickIntervalMs: number }
) => {
  const harness = makeHarness()
  const markReadyCalls: Array<boolean> = []
  const ctrl = makeReadinessController({
    observeState: harness.observeState,
    markReady: (ready) =>
      Effect.sync(() => {
        markReadyCalls.push(ready)
      }),
    tickIntervalMs: config.tickIntervalMs,
    tMinMs: config.tMinMs,
    tMaxMs: config.tMaxMs,
  })
  return { harness, ctrl, markReadyCalls }
}

describe("ReadinessController — happy path", () => {
  it.effect("stays Booting until first peer appears, then Bootstrapping → Ready after T_min when caught up", () =>
    Effect.gen(function* () {
      const { harness, ctrl, markReadyCalls } = setup({
        tickIntervalMs: 100,
        tMinMs: 3_000,
        tMaxMs: 60_000,
      })

      const fiber = yield* Effect.forkChild(ctrl.run)

      // No peers yet.
      yield* TestClock.adjust(Duration.millis(200))
      expect(yield* ctrl.observe).toBe("Booting")

      // Peer appears, but not caught up. T_min not yet reached.
      harness.setAlive([peer1])
      yield* TestClock.adjust(Duration.millis(100))
      expect(yield* ctrl.observe).toBe("Bootstrapping")

      // Peer marks caught up before T_min.
      harness.setCaughtUp(peer1, true)
      yield* TestClock.adjust(Duration.millis(500))
      // Still not Ready — T_min floor protects from flap.
      expect(yield* ctrl.observe).toBe("Bootstrapping")
      expect(markReadyCalls).toEqual([])

      // Cross T_min. Tick after T_min reaches Ready.
      yield* TestClock.adjust(Duration.millis(3_000))
      expect(yield* ctrl.observe).toBe("Ready")
      expect(markReadyCalls).toEqual([true])

      yield* Fiber.interrupt(fiber)
    })
  )

  it.effect("multiple peers — Ready waits until ALL alive peers report everCaughtUp", () =>
    Effect.gen(function* () {
      const { harness, ctrl, markReadyCalls } = setup({
        tickIntervalMs: 100,
        tMinMs: 1_000,
        tMaxMs: 60_000,
      })

      const fiber = yield* Effect.forkChild(ctrl.run)

      harness.setAlive([peer1, peer2])
      harness.setCaughtUp(peer1, true)

      // Past T_min, but peer2 not caught up.
      yield* TestClock.adjust(Duration.millis(2_000))
      expect(yield* ctrl.observe).toBe("Bootstrapping")
      expect(markReadyCalls).toEqual([])

      harness.setCaughtUp(peer2, true)
      yield* TestClock.adjust(Duration.millis(150))
      expect(yield* ctrl.observe).toBe("Ready")
      expect(markReadyCalls).toEqual([true])

      yield* Fiber.interrupt(fiber)
    })
  )
})

describe("ReadinessController — T_max ceiling", () => {
  it.effect("flips Ready at T_max even if peers are not caught up (with WARN)", () =>
    Effect.gen(function* () {
      const { harness, ctrl, markReadyCalls } = setup({
        tickIntervalMs: 100,
        tMinMs: 1_000,
        tMaxMs: 5_000,
      })

      const fiber = yield* Effect.forkChild(ctrl.run)

      harness.setAlive([peer1, peer2])
      harness.setCaughtUp(peer1, true)
      // peer2 stays uncaught.

      // Approach T_max.
      yield* TestClock.adjust(Duration.millis(4_000))
      expect(yield* ctrl.observe).toBe("Bootstrapping")
      expect(markReadyCalls).toEqual([])

      // Cross T_max.
      yield* TestClock.adjust(Duration.millis(1_500))
      expect(yield* ctrl.observe).toBe("Ready")
      expect(markReadyCalls).toEqual([true])

      yield* Fiber.interrupt(fiber)
    })
  )
})

describe("ReadinessController — once-Ready-stays-Ready invariant", () => {
  it.effect("peer disappears post-Ready: state stays Ready, markReady not re-fired", () =>
    Effect.gen(function* () {
      const { harness, ctrl, markReadyCalls } = setup({
        tickIntervalMs: 100,
        tMinMs: 500,
        tMaxMs: 60_000,
      })

      const fiber = yield* Effect.forkChild(ctrl.run)

      harness.setAlive([peer1])
      harness.setCaughtUp(peer1, true)
      yield* TestClock.adjust(Duration.millis(1_000))
      expect(yield* ctrl.observe).toBe("Ready")
      expect(markReadyCalls).toEqual([true])

      // Peer goes un-caught (e.g. ErroredRetry post-Ready).
      harness.setCaughtUp(peer1, false)
      yield* TestClock.adjust(Duration.millis(500))
      expect(yield* ctrl.observe).toBe("Ready")
      expect(markReadyCalls).toEqual([true])

      // Peer disappears entirely.
      harness.setAlive([])
      yield* TestClock.adjust(Duration.millis(500))
      expect(yield* ctrl.observe).toBe("Ready")
      expect(markReadyCalls).toEqual([true])

      yield* Fiber.interrupt(fiber)
    })
  )
})

describe("ReadinessController — drain flips to Draining and signals not-ready", () => {
  it.effect("drain after Ready: state goes Draining, markReady(false) fired exactly once", () =>
    Effect.gen(function* () {
      const { harness, ctrl, markReadyCalls } = setup({
        tickIntervalMs: 100,
        tMinMs: 500,
        tMaxMs: 60_000,
      })

      const fiber = yield* Effect.forkChild(ctrl.run)

      harness.setAlive([peer1])
      harness.setCaughtUp(peer1, true)
      yield* TestClock.adjust(Duration.millis(1_000))
      expect(yield* ctrl.observe).toBe("Ready")

      yield* ctrl.drain
      expect(yield* ctrl.observe).toBe("Draining")
      expect(markReadyCalls).toEqual([true, false])

      // Idempotent — second drain is no-op.
      yield* ctrl.drain
      expect(markReadyCalls).toEqual([true, false])

      yield* Fiber.interrupt(fiber)
    })
  )

  it.effect("drain before Ready: state still goes Draining; markReady(false) fired", () =>
    Effect.gen(function* () {
      const { harness, ctrl, markReadyCalls } = setup({
        tickIntervalMs: 100,
        tMinMs: 5_000,
        tMaxMs: 60_000,
      })

      const fiber = yield* Effect.forkChild(ctrl.run)

      harness.setAlive([peer1])
      // Don't ever flip caught-up before draining.
      yield* TestClock.adjust(Duration.millis(500))

      yield* ctrl.drain
      expect(yield* ctrl.observe).toBe("Draining")
      expect(markReadyCalls).toEqual([false])

      yield* Fiber.interrupt(fiber)
    })
  )
})
