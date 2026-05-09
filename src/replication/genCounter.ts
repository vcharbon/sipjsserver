/**
 * `(gen, counter)` tuple comparator and types.
 *
 * Every replicated frame carries `(gen, counter)` per design D4. The pair
 * is strictly ordered: `gen` is the high-order key (the source's
 * incarnation marker), `counter` is the low-order key (per-channel
 * monotonic value within an incarnation). This file is the single source
 * of truth for that ordering — the puller's apply rule, the source's
 * frame emission ordering, and the watermark-storage layer all use
 * `compareGenCounter`.
 *
 * Design ref: [docs/plan/grill-me-on-the-spicy-lark.md](../../docs/plan/grill-me-on-the-spicy-lark.md) §D4.
 */

export interface GenCounter {
  readonly gen: number
  readonly counter: number
}

/**
 * Lexicographic comparison: gen first, counter second. Returns `-1`,
 * `0`, or `1` per the standard `Array.sort` contract so callers can use
 * it directly with `Array.prototype.sort` if desired.
 */
export const compareGenCounter = (a: GenCounter, b: GenCounter): -1 | 0 | 1 => {
  if (a.gen < b.gen) return -1
  if (a.gen > b.gen) return 1
  if (a.counter < b.counter) return -1
  if (a.counter > b.counter) return 1
  return 0
}

/** True iff `a` strictly orders above `b`. Used by the puller's apply rule. */
export const isStrictlyGreater = (a: GenCounter, b: GenCounter): boolean =>
  compareGenCounter(a, b) === 1

/** A watermark of `(0, 0)` — the cold-start sentinel. Source emits everything. */
export const ORIGIN: GenCounter = { gen: 0, counter: 0 }
