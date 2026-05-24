/**
 * ForkSiteTracker — per-fork-site live + cumulative counters.
 *
 * Wrap any Effect before passing it to Effect.forkIn / forkDaemon to
 * track how many fibers spawned at that call site are currently alive.
 * A site whose live counter grows unboundedly under sustained load is
 * the leak. The cumulative counter lets the operator distinguish "many
 * short-lived forks" (high total, low live) from "few never-released
 * forks" (low total, high live).
 *
 * Lifecycle: increment runs before the effect; decrement runs in
 * `Effect.ensuring`, which fires on success, failure, AND interrupt —
 * the only correct way to guarantee decrement across every exit path.
 */

import { Effect } from "effect"

export interface ForkSiteTracker {
  /** Wrap `eff` so its fork increments + decrements the named site counter. */
  readonly track: <A, E, R>(site: string, eff: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Snapshot of live (in-flight) fiber count per site. */
  readonly liveBySite: () => ReadonlyMap<string, number>
  /** Cumulative fork count per site (monotonic). */
  readonly totalBySite: () => ReadonlyMap<string, number>
}

export const makeForkSiteTracker = (): ForkSiteTracker => {
  const live = new Map<string, number>()
  const total = new Map<string, number>()

  const track = <A, E, R>(site: string, eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        live.set(site, (live.get(site) ?? 0) + 1)
        total.set(site, (total.get(site) ?? 0) + 1)
      })
      return yield* eff
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          const v = live.get(site) ?? 0
          if (v > 1) live.set(site, v - 1)
          else live.delete(site)
        })
      )
    )

  return {
    track,
    liveBySite: () => live,
    totalBySite: () => total,
  }
}
