/**
 * ReplicationSupervisor — peer-set subscription + per-peer fiber
 * lifecycle for the replication redesign (Slice 5).
 *
 * Responsibilities (per docs/plan/grill-me-on-the-spicy-lark.md §D5,
 * §D5.2, §D5.3):
 *
 *   1. Periodically read `PeerEnumerator.currentPeers`.
 *   2. For each peer present in the enumeration that has no fiber:
 *      fork a `runPullerFiber`. The puller's `viewRef` is preserved
 *      across disappear/reappear cycles; a re-fork resumes from the
 *      preserved watermark and the previously-set `everCaughtUp` flag.
 *   3. For each peer absent from the enumeration that still has a live
 *      fiber: interrupt the fiber and flip `fiberState := Disappeared`.
 *      The view ref is RETAINED — watermark is preserved forever per
 *      §D4 ("preserved forever across peer disappearance").
 *
 * Fibers are forked via `Effect.forkChild`, scoped to the supervisor's
 * lifetime: when the supervisor itself is interrupted (process exit /
 * test teardown) every per-peer fiber is interrupted automatically.
 *
 * Observability: `observe` returns a `SupervisorState` snapshot —
 * `alivePeers` (the latest enumeration, peers currently expected to
 * have a fiber) plus a `perPeer` map carrying every `PeerView` ever
 * created on this incarnation, including ones whose fiber has
 * Disappeared. The ReadinessController (Slice 6) consumes this.
 *
 * The supervisor itself runs forever (`Effect.forever`); callers either
 * `yield*` it as the terminal step of their consumer fiber or fork it
 * explicitly with `Effect.forkChild` / `Effect.forkScoped`.
 */

import {
  Effect,
  Fiber,
  MutableHashMap,
  MutableRef,
  Option,
} from "effect"
import type { WorkerOrdinal } from "../cache/PeerCachePort.js"
import type { PeerEnumeratorApi } from "../cache/PeerEnumerator.js"
import {
  initialPeerView,
  type PeerView,
} from "./PullerFiber.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SupervisorState {
  /** Peers currently visible to the enumerator (those that should have a fiber). */
  readonly alivePeers: ReadonlySet<WorkerOrdinal>
  /** Every peer ever seen on this incarnation, including Disappeared ones. */
  readonly perPeer: ReadonlyMap<WorkerOrdinal, PeerView>
}

export interface ReplicationSupervisorApi {
  /** Snapshot of the supervisor's view of the cluster. */
  readonly observe: Effect.Effect<SupervisorState>
}

export interface SuperviseReplicationParams {
  readonly enumerator: PeerEnumeratorApi
  /**
   * Builds a long-lived puller-loop Effect for `peer`. The supervisor
   * forks this Effect via `Effect.forkChild` and tracks the returned
   * fiber for interrupt-on-disappear bookkeeping. Implementations
   * typically construct a `runPullerFiber({ peer, viewRef, ... })` —
   * the supervisor passes the shared `viewRef` so the puller's writes
   * are visible to the supervisor's `observe`.
   */
  readonly forkPullerFiber: (
    peer: WorkerOrdinal,
    viewRef: MutableRef.MutableRef<PeerView>
  ) => Effect.Effect<Fiber.Fiber<void>>
  /** Cadence of the reactive watcher poll. Defaults to 1000ms. */
  readonly watchIntervalMs: number
  /** Optional hook fired once per peer when its fiber is forked. */
  readonly onFork?: (peer: WorkerOrdinal) => Effect.Effect<void>
  /** Optional hook fired once per peer when its fiber is interrupted on Disappear. */
  readonly onDisappear?: (peer: WorkerOrdinal) => Effect.Effect<void>
}

interface PeerSlot {
  fiber: Fiber.Fiber<void> | null
  readonly viewRef: MutableRef.MutableRef<PeerView>
}

// ---------------------------------------------------------------------------
// Supervisor entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the replication supervisor. Returns an Effect that runs forever
 * — the caller forks it. Also returns the `observe` accessor for the
 * readiness controller and tests via the tuple shape.
 *
 * Usage shape:
 *
 *   const { run, observe } = makeSupervisor(...)
 *   const fiber = yield* Effect.forkChild(run)
 *
 * Tests can read `observe` at any time without coordinating with the
 * supervisor's tick.
 */
export const makeReplicationSupervisor = (
  params: SuperviseReplicationParams
): {
  readonly run: Effect.Effect<never>
  readonly observe: Effect.Effect<SupervisorState>
} => {
  const slots = MutableHashMap.empty<WorkerOrdinal, PeerSlot>()

  const reconcile = Effect.gen(function* () {
    const peers = yield* params.enumerator.currentPeers
    const live = new Set<WorkerOrdinal>(peers)

    // 1. Add or re-fork: peers that are alive and have no fiber.
    for (const peer of peers) {
      const slotOpt = MutableHashMap.get(slots, peer)
      let slot: PeerSlot
      if (Option.isNone(slotOpt)) {
        // First-ever sighting of this peer this incarnation. Allocate
        // a fresh viewRef in the Discovered state with `(0,0)` watermark.
        slot = {
          fiber: null,
          viewRef: MutableRef.make(initialPeerView(peer)),
        }
        MutableHashMap.set(slots, peer, slot)
      } else {
        slot = slotOpt.value
      }
      if (slot.fiber !== null) continue // already running

      // Re-fork — preserve watermark and everCaughtUp from prior
      // incarnation; reset only the transient fiberState/lastError.
      const cur = MutableRef.get(slot.viewRef)
      MutableRef.set(slot.viewRef, {
        ...cur,
        fiberState: "Discovered",
        lastError: null,
      })
      const fiber = yield* params.forkPullerFiber(peer, slot.viewRef)
      slot.fiber = fiber
      if (params.onFork !== undefined) {
        yield* params.onFork(peer)
      }
    }

    // 2. Interrupt: peers that have a fiber but are no longer alive.
    for (const [peer, slot] of slots) {
      if (live.has(peer)) continue
      if (slot.fiber === null) continue
      const fiber = slot.fiber
      slot.fiber = null
      yield* Fiber.interrupt(fiber)
      const cur = MutableRef.get(slot.viewRef)
      MutableRef.set(slot.viewRef, {
        ...cur,
        fiberState: "Disappeared",
      })
      if (params.onDisappear !== undefined) {
        yield* params.onDisappear(peer)
      }
    }
  })

  const run: Effect.Effect<never> = Effect.gen(function* () {
    yield* reconcile
    return yield* Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(`${params.watchIntervalMs} millis`)
        yield* reconcile
      })
    )
  })

  const observe: Effect.Effect<SupervisorState> = Effect.sync(() => {
    const perPeer = new Map<WorkerOrdinal, PeerView>()
    const alivePeers = new Set<WorkerOrdinal>()
    for (const [peer, slot] of slots) {
      perPeer.set(peer, MutableRef.get(slot.viewRef))
      if (slot.fiber !== null) alivePeers.add(peer)
    }
    return { alivePeers, perPeer }
  })

  return { run, observe }
}
