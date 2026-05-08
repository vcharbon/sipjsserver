/**
 * PullLoopSupervisor — reactive fork-loop helper for replication consumers.
 *
 * The original boot path read `PeerEnumerator.currentPeers` exactly once
 * and forked one steady-state pull fiber per peer. That snapshot is
 * empty during the K8s StatefulSet bootstrap race: when worker-0 reads
 * the headless service's SRV records before worker-1 has been added by
 * the kubelet, the fork loop produces zero fibers and worker-0's
 * `bak:b2bua-worker-1:` partition stays permanently empty. The
 * ReclaimRunner safety net then has nothing to scan post-respawn.
 *
 * `supervisePullLoops` replaces that one-shot loop with a watcher that:
 *
 *   1. Reconciles immediately — forks a pull-loop fiber for every peer
 *      currently visible to the enumerator.
 *   2. Sleeps `watchIntervalMs`, then re-reads `currentPeers` and forks
 *      a new fiber for any peer it has not yet tracked.
 *
 * The supervisor never cancels fibers when peers disappear from the
 * enumeration: ReplPuller is internally resilient (it re-reads
 * `replpos:{peer}` at the start of every cycle and converts transport
 * errors to empty streams), so leaving a stale fiber dialling a gone
 * peer is the safer default — interrupting could create resume-position
 * drift if the peer comes back with the same epoch but a different
 * `lastSeq`.
 *
 * The supervisor itself runs forever (`Effect.forever`); callers either
 * yield* the supervisor as the terminal step of their consumer fiber or
 * fork it explicitly.
 */

import { Effect, Fiber, MutableHashMap } from "effect"
import type { WorkerOrdinal } from "../cache/PeerCachePort.js"
import type { PeerEnumeratorApi } from "../cache/PeerEnumerator.js"

export interface SupervisePullLoopsParams {
  readonly enumerator: PeerEnumeratorApi
  /**
   * Builds and forks a pull-loop fiber for `peer`. The supervisor
   * stores the returned fiber handle for idempotency bookkeeping; the
   * fiber's lifetime is owned by whatever scope the caller forks into
   * (production: `Effect.forkDetach`, tests: `Effect.forkChild`).
   */
  readonly forkPullLoop: (
    peer: WorkerOrdinal
  ) => Effect.Effect<Fiber.Fiber<void>>
  /**
   * Cadence of the reactive watcher poll. K8s StatefulSet startup
   * delay budget for the next pod is on the order of 1–10s, so a 1–2s
   * watch interval keeps the fork-on-appear latency well below the
   * first post-boot in-dialog request.
   */
  readonly watchIntervalMs: number
  /**
   * Optional hook fired once per peer when its pull loop is forked
   * for the first time. Used by main.ts for the steady-state log
   * line; tests can use it to observe forks deterministically.
   */
  readonly onFork?: (peer: WorkerOrdinal) => Effect.Effect<void>
}

export const supervisePullLoops = (
  params: SupervisePullLoopsParams
): Effect.Effect<never> =>
  Effect.gen(function* () {
    const fibers = MutableHashMap.empty<
      WorkerOrdinal,
      Fiber.Fiber<void>
    >()

    const reconcile = Effect.gen(function* () {
      const peers = yield* params.enumerator.currentPeers
      for (const peer of peers) {
        if (MutableHashMap.has(fibers, peer)) continue
        const fiber = yield* params.forkPullLoop(peer)
        MutableHashMap.set(fibers, peer, fiber)
        if (params.onFork !== undefined) {
          yield* params.onFork(peer)
        }
      }
    })

    yield* reconcile

    return yield* Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(`${params.watchIntervalMs} millis`)
        yield* reconcile
      })
    )
  })
