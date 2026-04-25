/**
 * CancelBranchLru — proxy-local, branch→target cache with TTL.
 *
 * RFC 3261 §16.10 / §17.2.3: a stateless proxy must forward a CANCEL to the
 * same downstream that the matching INVITE was forwarded to. The match key
 * is the topmost Via branch + sent-by + method "CANCEL"; for a stateless
 * proxy that means we simply remember "for this branch I sent the INVITE to
 * X" and reuse X for the CANCEL.
 *
 * The cache holds entries for ~32 s — long enough for the SIP Timer C
 * window (3 min) is excessive at the proxy hop because once any downstream
 * response (provisional or final) traverses us, the UA-side state machine
 * controls retries; what matters is that the CANCEL the UAC dispatches in
 * the first few seconds of ringing finds the right downstream. 32 s
 * comfortably covers user-driven CANCEL on a ringing call.
 *
 * Implementation: a single `MutableHashMap<branch, Entry>` (per repo
 * convention for hot-path maps — `Ref<HashMap>` would copy on every write)
 * paired with a periodic sweep fiber that deletes entries past their
 * `expiresAtMs`. Reads are O(1) and never block.
 */

import { Clock, Effect, Layer, MutableHashMap, Option, type Scope, ServiceMap } from "effect"
import type { SocketAddr } from "./RoutingStrategy.js"

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default per-entry TTL — see header comment. */
export const DEFAULT_TTL_MS = 32_000
/** Default sweep cadence — half the TTL keeps the map's max size near 1× working set. */
export const DEFAULT_SWEEP_INTERVAL_MS = 16_000

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface CancelBranchLruApi {
  /** Remember the downstream target we forwarded an INVITE with `branch` to. */
  readonly remember: (branch: string, target: SocketAddr) => Effect.Effect<void>
  /** Look up the previously-remembered target for a CANCEL's branch. */
  readonly lookup: (branch: string) => Effect.Effect<Option.Option<SocketAddr>>
  /** Current map size — for tests and metrics. */
  readonly size: () => number
}

export class CancelBranchLru extends ServiceMap.Service<CancelBranchLru, CancelBranchLruApi>()(
  "@sipjsserver/sip-front-proxy/CancelBranchLru"
) {
  /**
   * Default Layer: 32 s TTL, 16 s sweep. Tests can build their own layer with
   * `CancelBranchLru.layer({ ttlMs, sweepIntervalMs })` to drive deterministic
   * eviction under TestClock.
   */
  static readonly Default: Layer.Layer<CancelBranchLru> = Layer.effect(
    CancelBranchLru,
    makeCancelBranchLru({})
  )

  /** Build a layer with explicit TTL / sweep interval (for tests). */
  static readonly layer = (opts: {
    readonly ttlMs?: number
    readonly sweepIntervalMs?: number
  }): Layer.Layer<CancelBranchLru> =>
    Layer.effect(CancelBranchLru, makeCancelBranchLru(opts))
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface Entry {
  readonly target: SocketAddr
  readonly expiresAtMs: number
}

function makeCancelBranchLru(opts: {
  readonly ttlMs?: number
  readonly sweepIntervalMs?: number
}): Effect.Effect<CancelBranchLruApi, never, Scope.Scope> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS

  return Effect.gen(function* () {
    const table = MutableHashMap.empty<string, Entry>()

    const remember = (branch: string, target: SocketAddr) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        yield* Effect.sync(() =>
          MutableHashMap.set(table, branch, { target, expiresAtMs: nowMs + ttlMs })
        )
      })

    const lookup = (branch: string) =>
      Effect.gen(function* () {
        const entry = Option.getOrUndefined(MutableHashMap.get(table, branch))
        if (entry === undefined) return Option.none<SocketAddr>()
        const nowMs = yield* Clock.currentTimeMillis
        if (entry.expiresAtMs <= nowMs) {
          yield* Effect.sync(() => MutableHashMap.remove(table, branch))
          return Option.none<SocketAddr>()
        }
        return Option.some(entry.target)
      })

    const size = () => MutableHashMap.size(table)

    // Periodic sweep — Effect.sleep so TestClock can drive it. The fiber is
    // forked into the layer's scope, so it gets cancelled when the layer is
    // released.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep(`${sweepIntervalMs} millis`)
          const nowMs = yield* Clock.currentTimeMillis
          yield* Effect.sync(() => {
            const expired: string[] = []
            for (const [branch, entry] of table) {
              if (entry.expiresAtMs <= nowMs) expired.push(branch)
            }
            for (const branch of expired) MutableHashMap.remove(table, branch)
          })
        })
      )
    )

    return { remember, lookup, size } satisfies CancelBranchLruApi
  })
}
