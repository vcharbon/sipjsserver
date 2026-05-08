/**
 * PullLoopSupervisor — reactive fork-on-appear contract.
 *
 * Pins the bootstrap-race fix from
 * docs/plan/replication-pull-fork-on-peer-discovery.md: when a peer
 * isn't visible to the enumerator at boot but appears on a later
 * refresh, the supervisor must fork a pull-loop fiber for it. The
 * one-shot loop in main.ts used to miss this case and leave
 * worker-0's `bak:b2bua-worker-1:` permanently empty.
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, MutableRef } from "effect"
import { TestClock } from "effect/testing"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import type { PeerEnumeratorApi } from "../../src/cache/PeerEnumerator.js"
import { supervisePullLoops } from "../../src/replication/PullLoopSupervisor.js"

const peer1 = WorkerOrdinal("b2bua-worker-1")
const peer2 = WorkerOrdinal("b2bua-worker-2")

const WATCH_INTERVAL_MS = 1_000

const makeDynamicEnumerator = (
  initial: ReadonlyArray<WorkerOrdinal>
): {
  enumerator: PeerEnumeratorApi
  set: (peers: ReadonlyArray<WorkerOrdinal>) => void
} => {
  const ref = MutableRef.make<ReadonlyArray<WorkerOrdinal>>(initial)
  return {
    enumerator: {
      currentPeers: Effect.sync(() => MutableRef.get(ref)),
    },
    set: (peers) => MutableRef.set(ref, peers),
  }
}

describe("supervisePullLoops", () => {
  it.effect(
    "forks a pull loop on the next refresh after a peer appears (StatefulSet bootstrap race)",
    () =>
      Effect.gen(function* () {
        const { enumerator, set } = makeDynamicEnumerator([])
        const forks: Array<WorkerOrdinal> = []
        const forkPullLoop = (peer: WorkerOrdinal) =>
          Effect.gen(function* () {
            forks.push(peer)
            return yield* Effect.forkChild(Effect.never)
          })

        const supervisor = yield* Effect.forkChild(
          supervisePullLoops({
            enumerator,
            forkPullLoop,
            watchIntervalMs: WATCH_INTERVAL_MS,
          })
        )

        // Initial reconcile sees an empty enumeration — no forks.
        yield* Effect.yieldNow
        expect(forks).toEqual([])

        // Peer appears (e.g. worker-1's pod made it into the headless
        // service after worker-0's first SRV poll).
        set([peer1])

        // Watcher tick: sleep elapses, reconcile re-reads currentPeers.
        yield* TestClock.adjust(Duration.millis(WATCH_INTERVAL_MS))
        expect(forks).toEqual([peer1])

        // Idempotency: subsequent ticks must not re-fork the same peer.
        yield* TestClock.adjust(Duration.millis(WATCH_INTERVAL_MS * 3))
        expect(forks).toEqual([peer1])

        // A second peer joining is forked too.
        set([peer1, peer2])
        yield* TestClock.adjust(Duration.millis(WATCH_INTERVAL_MS))
        expect(forks).toEqual([peer1, peer2])

        yield* Fiber.interrupt(supervisor)
      })
  )

  it.effect("forks immediately for peers visible at the initial reconcile", () =>
    Effect.gen(function* () {
      const { enumerator } = makeDynamicEnumerator([peer1, peer2])
      const forks: Array<WorkerOrdinal> = []
      const forkPullLoop = (peer: WorkerOrdinal) =>
        Effect.gen(function* () {
          forks.push(peer)
          return yield* Effect.forkChild(Effect.never)
        })

      const supervisor = yield* Effect.forkChild(
        supervisePullLoops({
          enumerator,
          forkPullLoop,
          watchIntervalMs: WATCH_INTERVAL_MS,
        })
      )

      // The initial reconcile runs synchronously before the watcher
      // hits its first sleep — both peers are forked without needing
      // to advance TestClock.
      yield* Effect.yieldNow
      expect([...forks].sort()).toEqual([peer1, peer2].sort())

      yield* Fiber.interrupt(supervisor)
    })
  )

  it.effect(
    "does not re-fork a peer that disappears and reappears (idempotent on flap)",
    () =>
      Effect.gen(function* () {
        const { enumerator, set } = makeDynamicEnumerator([peer1])
        const forks: Array<WorkerOrdinal> = []
        const forkPullLoop = (peer: WorkerOrdinal) =>
          Effect.gen(function* () {
            forks.push(peer)
            return yield* Effect.forkChild(Effect.never)
          })

        const supervisor = yield* Effect.forkChild(
          supervisePullLoops({
            enumerator,
            forkPullLoop,
            watchIntervalMs: WATCH_INTERVAL_MS,
          })
        )

        yield* Effect.yieldNow
        expect(forks).toEqual([peer1])

        // Peer flaps out and back in — the supervisor leaves the
        // existing fiber alone; ReplPuller's per-cycle `replpos` read
        // means a stale fiber recovers naturally on its own when the
        // peer comes back.
        set([])
        yield* TestClock.adjust(Duration.millis(WATCH_INTERVAL_MS))
        set([peer1])
        yield* TestClock.adjust(Duration.millis(WATCH_INTERVAL_MS))

        expect(forks).toEqual([peer1])

        yield* Fiber.interrupt(supervisor)
      })
  )
})
