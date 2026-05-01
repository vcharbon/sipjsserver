/**
 * Unit tests for the seeded-Random plumbing in MessageHelpers / CallModel.
 *
 * The identifier generators (`newTag`, `newBranch`, `newCallId`) and
 * `randomInitialCSeq` read from the current fiber's Effect `Random`
 * reference via `currentRng()`. Wrapping a program with
 * `Random.withSeed(seed)` therefore makes the entire identifier stream
 * reproducible — slice 1.1 of the failover-harness plan.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Random } from "effect"
import {
  currentRng,
  newBranch,
  newCallId,
  newTag,
} from "../../src/sip/MessageHelpers.js"
import { randomInitialCSeq } from "../../src/call/CallModel.js"

const SEED = "slice-1.1-fixed-seed"

const collect = Effect.sync(() => ({
  tags: [newTag(), newTag(), newTag()],
  branches: [newBranch(), newBranch()],
  callIds: [newCallId("worker.local"), newCallId("worker.local")],
  cseqs: [randomInitialCSeq(), randomInitialCSeq()],
}))

describe("MessageHelpers — seeded RNG plumbing", () => {
  it.effect(
    "two runs with the same seed produce identical tag/branch/callId/CSeq sequences",
    () =>
      Effect.gen(function* () {
        const first = yield* collect.pipe(Random.withSeed(SEED))
        const second = yield* collect.pipe(Random.withSeed(SEED))
        expect(first).toEqual(second)
      }),
  )

  it.effect("different seeds produce different sequences", () =>
    Effect.gen(function* () {
      const a = yield* collect.pipe(Random.withSeed(1))
      const b = yield* collect.pipe(Random.withSeed(0xdeadbeef))
      expect(a).not.toEqual(b)
    }),
  )

  it.effect("randomInitialCSeq is a multiple of 1000 in [1000, 2_000_000]", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 50; i++) {
        const c = randomInitialCSeq()
        expect(c % 1000).toBe(0)
        expect(c).toBeGreaterThanOrEqual(1000)
        expect(c).toBeLessThanOrEqual(2_000_000)
      }
    }).pipe(Random.withSeed(SEED)),
  )

  it.effect("newBranch yields the RFC-3261 magic-cookie prefix", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 10; i++) {
        const b = newBranch()
        expect(b.startsWith("z9hG4bK")).toBe(true)
        expect(b.length).toBe("z9hG4bK".length + 16)
      }
    }).pipe(Random.withSeed(SEED)),
  )

  it.effect("newCallId embeds the supplied host", () =>
    Effect.gen(function* () {
      const id = newCallId("alice.example")
      expect(id.endsWith("@alice.example")).toBe(true)
    }).pipe(Random.withSeed(SEED)),
  )

  it("currentRng falls back to Math.random outside any Effect fiber", () => {
    // Direct call from vitest's bare sync context — no fiber set globally.
    const rng = currentRng()
    const v = rng.nextDoubleUnsafe()
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(1)
  })
})
