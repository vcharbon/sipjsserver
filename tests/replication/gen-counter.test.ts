/**
 * T9 — `(gen, counter)` tuple comparator correctness.
 *
 * Asserts the lexicographic ordering at every boundary the puller's
 * apply rule and the source's emission ordering will hit:
 *   - within an incarnation (gen equal, counter varies)
 *   - across incarnations (gen varies, counter wraps to 1)
 *   - identical tuples (no-op)
 *   - origin sentinel (0, 0) compares as the smallest tuple
 *
 * This is the foundational ordering the replication redesign relies on
 * for "no gen-mismatch frame" — see design-doc D4.
 */

import { describe, expect, it } from "vitest"
import {
  ORIGIN,
  compareGenCounter,
  isStrictlyGreater,
} from "../../src/replication/genCounter.js"

describe("compareGenCounter", () => {
  it("identical tuples compare equal", () => {
    expect(compareGenCounter({ gen: 5, counter: 10 }, { gen: 5, counter: 10 })).toBe(0)
    expect(compareGenCounter({ gen: 0, counter: 0 }, { gen: 0, counter: 0 })).toBe(0)
  })

  it("compares by gen first when gens differ", () => {
    expect(compareGenCounter({ gen: 1, counter: 100 }, { gen: 2, counter: 1 })).toBe(-1)
    expect(compareGenCounter({ gen: 2, counter: 1 }, { gen: 1, counter: 100 })).toBe(1)
  })

  it("compares by counter when gens are equal", () => {
    expect(compareGenCounter({ gen: 5, counter: 10 }, { gen: 5, counter: 11 })).toBe(-1)
    expect(compareGenCounter({ gen: 5, counter: 11 }, { gen: 5, counter: 10 })).toBe(1)
  })

  it("counter wrap to 1 on new gen sorts above any old-gen counter", () => {
    // Realistic scenario: peer rebooted (gen bumped); first frame post-boot
    // has counter=1. It must sort above an old-gen frame with counter=999.
    const oldFrame = { gen: 100, counter: 999 }
    const newFrame = { gen: 101, counter: 1 }
    expect(compareGenCounter(newFrame, oldFrame)).toBe(1)
  })

  it("origin (0,0) compares less than any positive tuple", () => {
    expect(compareGenCounter(ORIGIN, { gen: 0, counter: 1 })).toBe(-1)
    expect(compareGenCounter(ORIGIN, { gen: 1, counter: 0 })).toBe(-1)
    expect(compareGenCounter(ORIGIN, { gen: 1, counter: 1 })).toBe(-1)
  })
})

describe("isStrictlyGreater", () => {
  it("returns true only when strictly greater", () => {
    expect(isStrictlyGreater({ gen: 5, counter: 10 }, { gen: 5, counter: 10 })).toBe(false)
    expect(isStrictlyGreater({ gen: 5, counter: 11 }, { gen: 5, counter: 10 })).toBe(true)
    expect(isStrictlyGreater({ gen: 5, counter: 10 }, { gen: 5, counter: 11 })).toBe(false)
  })

  it("matches the puller's apply rule semantics", () => {
    // Puller's rule: apply iff (incoming) > (watermark).
    const watermark = { gen: 100, counter: 50 }
    expect(isStrictlyGreater({ gen: 100, counter: 51 }, watermark)).toBe(true)  // next entry
    expect(isStrictlyGreater({ gen: 100, counter: 50 }, watermark)).toBe(false) // duplicate
    expect(isStrictlyGreater({ gen: 100, counter: 49 }, watermark)).toBe(false) // out-of-order
    expect(isStrictlyGreater({ gen: 101, counter: 1 }, watermark)).toBe(true)   // new gen wraps
  })
})
