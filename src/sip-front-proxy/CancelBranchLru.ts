/**
 * CancelBranchLru — proxy-local, (Call-ID, CSeq number)→target cache with
 * TTL. The historical name kept for backwards compatibility — the cache
 * still solves the CANCEL correlation problem, but the key has been
 * rewritten as of PR3b (see "Keying" below).
 *
 * RFC 3261 §16.10 / §17.2.3: a stateless proxy must forward a CANCEL to the
 * same downstream that the matching INVITE was forwarded to.
 *
 * Keying — RFC 3261 §9.1. A CANCEL request shares its Request-URI, From,
 * To (no tag), Call-ID, and **CSeq number** with the INVITE it cancels;
 * only the CSeq method differs (`CANCEL` vs `INVITE`). At the same hop the
 * UAC reuses the INVITE's top-Via branch on the CANCEL too — but at the
 * **proxy** the relevant branch is the upstream UAC's, not the proxy's
 * outbound branch. Earlier PRs keyed the LRU on the proxy's outbound
 * branch, which papered over the mismatch only because `ForwardAll` always
 * targets the same downstream and could fall back via
 * `selectForNewDialog`. With `LoadBalancer` the fallback would re-shard
 * the CANCEL to a different worker than the INVITE — a real bug. Keying
 * on `(Call-ID, CSeq number)` is the canonical correlator and works at
 * any hop regardless of whether the upstream rewrote the branch.
 *
 * The cache holds entries for ~32 s — Timer C goes up to 3 min, but at
 * the proxy hop what matters is that the CANCEL the UAC dispatches in
 * the first few seconds of ringing finds the right downstream. 32 s
 * comfortably covers user-driven CANCEL on a ringing call.
 *
 * Implementation: a single `MutableHashMap<key, Entry>` (per repo
 * convention for hot-path maps — `Ref<HashMap>` would copy on every write)
 * paired with a periodic sweep fiber that deletes entries past their
 * `expiresAtMs`. Reads are O(1) and never block.
 *
 * The `key` is built by `callIdCseqKey(callId, cseqNum)` which the proxy
 * core calls on both sides (INVITE remember + CANCEL lookup). Format is
 * `<callId>|<cseq>` — `|` is an illegal Call-ID character per RFC 3261's
 * `word` grammar so the join is unambiguous.
 */

import { Clock, Effect, Layer, MutableHashMap, Option, type Scope, ServiceMap } from "effect"
import { ProxyMetrics } from "./observability/Metrics.js"
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

/**
 * Build the composite key for an INVITE or matching CANCEL. The CANCEL's
 * Call-ID and CSeq number are guaranteed identical to the INVITE's per
 * RFC 3261 §9.1. We delimit with `|`, which is illegal inside an RFC 3261
 * Call-ID `word`, so the resulting string is unambiguous.
 */
export const callIdCseqKey = (callId: string, cseqNum: number): string =>
  `${callId}|${cseqNum}`

export interface CancelBranchLruApi {
  /**
   * Remember the downstream target we forwarded an INVITE to. The key is
   * the `(Call-ID, CSeq number)` composite produced by `callIdCseqKey`.
   */
  readonly remember: (key: string, target: SocketAddr) => Effect.Effect<void>
  /**
   * Look up the previously-remembered target for a CANCEL. The key is the
   * `(Call-ID, CSeq number)` composite produced by `callIdCseqKey` — the
   * CANCEL's Call-ID and CSeq number match the INVITE's per RFC 3261 §9.1.
   */
  readonly lookup: (key: string) => Effect.Effect<Option.Option<SocketAddr>>
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
    // Metrics provided inline so the public layer signature is unchanged
    // (existing tests just provide CancelBranchLru.Default / .layer(opts)).
    const metrics = yield* (Effect.gen(function* () {
      return yield* ProxyMetrics
    }).pipe(Effect.provide(ProxyMetrics.Default)))

    const remember = (key: string, target: SocketAddr) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        yield* Effect.sync(() =>
          MutableHashMap.set(table, key, { target, expiresAtMs: nowMs + ttlMs })
        )
      })

    const lookup = (key: string) =>
      Effect.gen(function* () {
        const entry = Option.getOrUndefined(MutableHashMap.get(table, key))
        if (entry === undefined) return Option.none<SocketAddr>()
        const nowMs = yield* Clock.currentTimeMillis
        if (entry.expiresAtMs <= nowMs) {
          yield* Effect.sync(() => MutableHashMap.remove(table, key))
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
          let expiredCount = 0
          yield* Effect.sync(() => {
            const expired: string[] = []
            for (const [k, entry] of table) {
              if (entry.expiresAtMs <= nowMs) expired.push(k)
            }
            for (const k of expired) MutableHashMap.remove(table, k)
            expiredCount = expired.length
          })
          if (expiredCount > 0) {
            for (let i = 0; i < expiredCount; i++) {
              yield* metrics.recordCancelLookup("expired_sweep")
            }
          }
        })
      )
    )

    return { remember, lookup, size } satisfies CancelBranchLruApi
  })
}
