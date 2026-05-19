/**
 * Deterministic chaos scheduler.
 *
 * Given a `seed`, the scheduler emits the same sequence of chaos events
 * (type + relative-time) every run. Reproducibility is the point: when
 * a 24h soak surfaces a weird failure at hour 12, re-running with the
 * same seed (and same start-of-SOAK timestamp) replays the same chaos
 * pattern.
 *
 * The scheduler does NOT execute events — it only decides what should
 * happen and when. Execution is the orchestrator's job (chaosOps.ts).
 *
 * Algorithm:
 *
 *   1. Inter-arrival drawn uniform-random in
 *      [chaosMinIntervalSec, chaosMaxIntervalSec].
 *   2. Event type drawn from a weighted distribution; weights default
 *      to the table in docs/plan/long-endurence-tests-session-hidden-graham.md
 *      (worker pod kill 30%, proxy 30%, limiter Redis 5%, node shutdown 35%).
 *   3. Constraint enforcement (replica-count safety, MIN_INTERVAL after
 *      a previous event, target-ready after recovery) is the
 *      orchestrator's job at fire time. The scheduler hands off events
 *      to a constraint gate; rejected events are skipped.
 *
 * The PRNG is a tiny mulberry32 — fast, seedable, deterministic across
 * runs and hosts. We don't need cryptographic strength.
 */

import type { ChaosEventType } from "./chaosOps.js"

export interface ScheduledEvent {
  /** Sequential index within the run; useful for analyzer joins. */
  readonly index: number
  /** Seconds from t=0 (= start of SOAK phase). */
  readonly relativeSec: number
  readonly type: ChaosEventType
}

export interface SchedulerOpts {
  readonly seed: number
  readonly chaosMinIntervalSec: number
  readonly chaosMaxIntervalSec: number
  /** Total SOAK duration in seconds. */
  readonly soakDurationSec: number
  /**
   * Override the default event-type weight distribution. Missing keys
   * fall back to the default table.
   */
  readonly weights?: Partial<Record<ChaosEventType, number>>
}

const DEFAULT_WEIGHTS: Record<ChaosEventType, number> = {
  "worker-pod-graceful": 3,
  "worker-pod-api-delete-force": 2,
  "worker-pod-kill9": 13,
  "proxy-pod-graceful": 3,
  "proxy-pod-kill9": 3,
  "proxy-cutoff-vrrp": 3,
  "limiter-redis-graceful": 2.5,
  "limiter-redis-kill9": 2.5,
  "node-shutdown-app": 10,
  "node-shutdown-edge": 10,
  // Network-chaos catalog. Weights set after per-event validation —
  // see docs/plan/2026-05-15-validate-new-chaos-events-sliced.md.
  //   - `proxy-full-isolate` still at 0: VIP fail-over doesn't trigger
  //     (keepalived `nopreempt`); total outage for cut duration.
  //   - `non-emergency-burst` at 5: overload-protection rework
  //     (2026-05-16) demonstrated 0% cross-stream collateral at the
  //     default 200 CAPS burst; analyzer's NO-DATA on the burst stream
  //     itself is cosmetic — wire-level proxy counters confirm
  //     ~99% rejection. See docs/adr/0006-overload-five-gate-and-aimd.md.
  "worker-cut-from-proxy-hard": 5,
  "worker-cut-from-peers-hard": 3,
  "worker-cut-from-limiter-redis-hard": 5,
  "worker-isolate-all-hard": 2,
  "worker-cut-from-proxy-loss30": 3,
  "proxy-full-isolate": 0,
  "non-emergency-burst": 5,
}

/**
 * Build the full event schedule up front. The orchestrator iterates
 * the array and waits until each event's `relativeSec` mark before
 * firing it — but reserves the right to skip events whose constraint
 * gate fails.
 */
export const buildSchedule = (opts: SchedulerOpts): ReadonlyArray<ScheduledEvent> => {
  const rng = mulberry32(opts.seed >>> 0)
  const weights: Record<ChaosEventType, number> = {
    ...DEFAULT_WEIGHTS,
    ...(opts.weights ?? {}),
  }
  const cumulative = buildCumulative(weights)
  const events: Array<ScheduledEvent> = []
  let t = 0
  let index = 0
  while (true) {
    const span = opts.chaosMaxIntervalSec - opts.chaosMinIntervalSec
    const interval = opts.chaosMinIntervalSec + rng() * span
    t = t + interval
    if (t >= opts.soakDurationSec) break
    const u = rng()
    const type = pickType(cumulative, u)
    events.push({ index, relativeSec: t, type })
    index += 1
  }
  return events
}

interface CumulativeBucket {
  readonly type: ChaosEventType
  readonly upper: number
}

const buildCumulative = (
  weights: Record<ChaosEventType, number>,
): ReadonlyArray<CumulativeBucket> => {
  const total = Object.values(weights).reduce((a, b) => a + b, 0)
  if (total <= 0) {
    throw new Error(`scheduler weights sum to ${total}; must be > 0`)
  }
  let acc = 0
  const buckets: Array<CumulativeBucket> = []
  for (const [type, w] of Object.entries(weights) as Array<[ChaosEventType, number]>) {
    if (w <= 0) continue
    acc += w / total
    buckets.push({ type, upper: acc })
  }
  return buckets
}

const pickType = (
  cumulative: ReadonlyArray<CumulativeBucket>,
  u: number,
): ChaosEventType => {
  for (const b of cumulative) {
    if (u <= b.upper) return b.type
  }
  // Floating-point rounding edge — fall back to the last bucket.
  return cumulative[cumulative.length - 1]!.type
}

/**
 * Mulberry32 PRNG. Tiny, fast, seedable. Not cryptographically secure
 * — irrelevant for chaos scheduling.
 *
 * Source: https://gist.github.com/tommyettinger/46a3f8f2a8b62f3c64d7
 */
const mulberry32 = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Build the smoke-mode schedule: exactly two events at fixed offsets
 * (one worker kill -9, one node shutdown). Independent of seed so the
 * smoke pipeline is fully deterministic.
 */
export const buildSmokeSchedule = (): ReadonlyArray<ScheduledEvent> => [
  { index: 0, relativeSec: 60, type: "worker-pod-kill9" },
  { index: 1, relativeSec: 180, type: "node-shutdown-app" },
]
