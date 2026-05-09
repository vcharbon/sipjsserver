/**
 * T2 — primary-bounded-cost (INV1).
 *
 * Asserts that the primary's outgoing channel-to-peer is naturally
 * bounded by the active-call count (per the design doc §D2: "no hard
 * ring-cap; the propagate index is naturally bounded by the maximum
 * active-call count per partition plus at most a 3-min window of
 * tombstones").
 *
 * Strategy: simulate sustained churn over 1 hour (TestClock) while
 * keeping the active-call count at a fixed N. After every cycle —
 * write, delete, advance clock past tombstone TTL, re-write —
 * the channel size must stay bounded by `2N` (N U-members for the
 * current active set + N D-members for the most recent delete).
 *
 * Same callRef written or deleted again replaces the existing
 * member at a new score (sorted-set semantics) — it does not
 * accumulate. INV1 holds because a steady-state working set keeps
 * the index width fixed in the number of distinct callRefs.
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, MutableHashMap } from "effect"
import { TestClock } from "effect/testing"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

const A_GEN = 71
const N = 50

describe("T2 — primary-bounded-cost", () => {
  it.effect(
    "1 hour TestClock churn: channel size stays bounded by 2N (active + tombstones)",
    () =>
      Effect.gen(function* () {
        const store = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kv = KvBackend.makeMemoryUnsafe(store)
        const channel = ChannelIndex.make(
          { self: "worker-A", peer: "worker-B", gen: A_GEN },
          kv
        )

        const refs = Array.from({ length: N }, (_, i) => `call-${i}`)

        // Phase 1: write all N calls.
        for (const ref of refs) {
          yield* channel.write({
            entryGen: channel.gen,
            partition: "pri",
            callRef: ref,
            bodyValue: '{"name":"' + ref + '"}',
            bodyTtlSec: 600,
            indexes: [],
          })
        }
        let batch = yield* channel.pullBatch({ gen: 0, counter: 0 }, 1000)
        expect(batch.entries.length).toBe(N)

        // Phase 2: tombstone all N. Channel grows to 2N.
        for (const ref of refs) {
          yield* channel.tombstone({
            entryGen: channel.gen,
            callGen: 1,
            partition: "pri",
            callRef: ref,
            indexesToRemove: [],
          })
        }
        batch = yield* channel.pullBatch({ gen: 0, counter: 0 }, 1000)
        expect(batch.entries.length).toBe(2 * N)

        // Phase 3: 30 cycles of churn over 1 hour TestClock.
        // Each cycle: advance 2 minutes, re-write all N, tombstone again.
        // Verify the channel size NEVER exceeds 2N.
        const observedMaxima: Array<number> = []
        for (let cycle = 0; cycle < 30; cycle++) {
          // Advance past one tombstone-TTL window (3 min).
          yield* TestClock.adjust(Duration.minutes(2))

          // Re-write all N calls. Each U-member's score is bumped to
          // a fresh counter value; the prior U-member with the same
          // member key is replaced in place.
          for (const ref of refs) {
            yield* channel.write({
              entryGen: channel.gen,
              partition: "pri",
              callRef: ref,
              bodyValue: '{"name":"' + ref + '","cycle":' + cycle + '}',
              bodyTtlSec: 600,
              indexes: [],
            })
          }
          // Tombstone all N — D-members likewise replace prior D-members.
          for (const ref of refs) {
            yield* channel.tombstone({
              entryGen: channel.gen,
              callGen: 1,
              partition: "pri",
              callRef: ref,
              indexesToRemove: [],
            })
          }

          batch = yield* channel.pullBatch({ gen: 0, counter: 0 }, 1000)
          observedMaxima.push(batch.entries.length)
          // INV1: never above 2N over the full 1-hour simulation.
          expect(batch.entries.length).toBeLessThanOrEqual(2 * N)
        }

        // After 30 churn cycles + advancing > 1 hour, the channel
        // is still 2N — bounded by the working set, not by the
        // total churn rate.
        expect(observedMaxima.every((n) => n === 2 * N)).toBe(true)
      })
  )
})
