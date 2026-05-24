/**
 * Deterministic fixture mixer. Builds a pool of `Call` fixtures sampled
 * from the five `FixtureKind`s with weights that approximate a healthy
 * worker's call-state histogram mid-soak.
 *
 * The same `seed` always yields the same kind sequence and the same per-
 * kind index sequence, so bench output is reproducible across runs.
 *
 * Weight calibration source (starter values — recalibrate from a fresh
 * /debug/memory scrape before locking budgets):
 *   - confirmed steady-state dominates a healthy soak (~55 %)
 *   - early (pre-200) churn ~15 %
 *   - re-INVITE storm contribution ~15 % (cap-defense scenarios)
 *   - terminating bucket from histogram ~10 %
 *   - abuse-malformed slice ~5 % (matches the 1 cap × 3 archetypes mix)
 */

import type { Call } from "../../../src/call/CallModel.js"
import { buildFixture, type FixtureKind } from "./fixtureKinds.js"

export interface FixtureMix {
  readonly weights: Record<FixtureKind, number>
  readonly seed: number
}

export const DEFAULT_MIX: FixtureMix = {
  weights: {
    EARLY: 0.15,
    CONFIRMED_STEADY: 0.55,
    REINVITE_STORM: 0.15,
    TERMINATING: 0.10,
    ABUSE_MALFORMED: 0.05,
  },
  seed: 1779536619892,
}

/** Mulberry32 — small, fast, deterministic PRNG keyed on `seed`. */
const mulberry32 = (seed: number) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pickKind = (mix: FixtureMix, rand: () => number): FixtureKind => {
  const r = rand()
  let acc = 0
  for (const [k, w] of Object.entries(mix.weights) as Array<[FixtureKind, number]>) {
    acc += w
    if (r < acc) return k
  }
  return "CONFIRMED_STEADY"
}

/**
 * Pre-build a pool of `count` fixtures from the mix. The bench loop
 * cycles through this pool (`pool[i % pool.length]`) so per-iteration
 * cost is purely codec, not fixture construction.
 */
export const buildFixturePool = (mix: FixtureMix, count: number): ReadonlyArray<Call> => {
  const rand = mulberry32(mix.seed)
  const pool: Call[] = new Array(count)
  for (let i = 0; i < count; i++) {
    pool[i] = buildFixture(pickKind(mix, rand), i)
  }
  return pool
}

/**
 * Diagnostic count of how many fixtures of each kind landed in the
 * pool. Printed once at the top of bench output so reviewers can see
 * the shape distribution they're measuring against.
 */
export const tallyKinds = (
  pool: ReadonlyArray<Call>,
): Record<FixtureKind, number> => {
  const out: Record<FixtureKind, number> = {
    EARLY: 0,
    CONFIRMED_STEADY: 0,
    REINVITE_STORM: 0,
    TERMINATING: 0,
    ABUSE_MALFORMED: 0,
  }
  for (const c of pool) {
    const tail = c.callRef.split("|").at(-1) as FixtureKind | undefined
    if (tail !== undefined && tail in out) out[tail]++
  }
  return out
}
