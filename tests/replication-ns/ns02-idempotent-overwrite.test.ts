/**
 * NS2 — idempotent overwrite by `(gen, counter)`.
 *
 * Scenario:
 *   1. A writes X (counter=1), then X again with new content
 *      (counter=2), then X again (counter=3). Same callRef, three
 *      writes — the channel's sorted-set semantics keep only the
 *      latest score for the member.
 *   2. B's puller drains; every frame is applied by the apply rule.
 *      The watermark advances monotonically; the local body matches
 *      the LATEST version.
 *
 * Asserts:
 *   - B's `bak:{A}:call:X` body matches the third write.
 *   - Watermark = A's (gen, counter=3).
 *   - The pulled batch on the source side at since=0 returns ONE
 *     entry for X (sorted-set semantics) at score 3, not three.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableRef } from "effect"
import {
  forkPuller,
  makeWorker,
  waitFor,
} from "./twoWorkerHarness.js"

const A_GEN = 21
const B_GEN = 22

describe("NS2 — idempotent overwrite", () => {
  it.live("three writes to same X collapse to a single channel entry; B holds the latest", () =>
    Effect.gen(function* () {
      const A = makeWorker({ self: "worker-A", peer: "worker-B", gen: A_GEN })
      const B = makeWorker({ self: "worker-B", peer: "worker-A", gen: B_GEN })

      for (const v of ["v1", "v2", "v3"] as const) {
        yield* A.outgoing.write({
          entryGen: A.outgoing.gen,
          partition: "pri",
          callRef: "X",
          bodyValue: JSON.stringify({ ver: v, gen: A_GEN }),
          bodyTtlSec: 60,
          indexes: [],
        })
      }

      // Source-side: the channel collapses to ONE member at score 3.
      const sourceBatch = yield* A.outgoing.pullBatch({ gen: 0, counter: 0 }, 100)
      expect(sourceBatch.entries.length).toBe(1)
      expect(sourceBatch.entries[0]!.score).toBe(3)

      const puller = yield* forkPuller({ source: A, consumer: B })

      yield* waitFor(
        () => MutableRef.get(puller.viewRef).watermark.counter >= 3
      )

      // B's body is v3.
      const body = yield* B.kv.bodyGet("bak:worker-A:call:X")
      expect(body).toBe('{"ver":"v3","gen":21}')

      // Watermark
      expect(MutableRef.get(puller.viewRef).watermark).toEqual({
        gen: A_GEN,
        counter: 3,
      })

      yield* puller.stop
    })
  )
})
