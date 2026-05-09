/**
 * NS1 — forward propagation.
 *
 * Scenario:
 *   1. Worker A writes call X to its `pri:{A}:` partition (its own
 *      outgoing channel-to-B carries the U-member).
 *   2. Worker B's puller drains A's channel, applies via EchoApply,
 *      so B's `bak:{A}:call:X` gets the body AND B's outgoing
 *      channel-to-A picks up the echoed entry.
 *
 * Asserts the design-doc §D2 storage layout:
 *   - body lands at `bak:{A}:call:X` on B (NOT `pri:{B}:`).
 *   - the source (gen, counter) flows into B's view watermark.
 *   - the echoed entry appears on `propagate:{B}->{A}` so A could
 *     later pull it via since=0 cold start.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableRef } from "effect"
import {
  forkPuller,
  makeWorker,
  waitFor,
} from "./twoWorkerHarness.js"

const A_GEN = 11
const B_GEN = 12

describe("NS1 — forward propagation", () => {
  it.live("A writes X → B's bak:{A}:call:X has the body, indexes echoed", () =>
    Effect.gen(function* () {
      const A = makeWorker({ self: "worker-A", peer: "worker-B", gen: A_GEN })
      const B = makeWorker({ self: "worker-B", peer: "worker-A", gen: B_GEN })

      // A writes X.
      yield* A.outgoing.write({
        partition: "pri",
        callRef: "X",
        bodyValue: '{"name":"X","gen":11}',
        bodyTtlSec: 60,
        indexes: [],
      })

      const puller = yield* forkPuller({ source: A, consumer: B })

      yield* waitFor(
        () =>
          MutableRef.get(puller.viewRef).everCaughtUp &&
          MutableRef.get(puller.viewRef).entriesAppliedTotal >= 1
      )

      // Body landed on bak:{A}: on B.
      expect(yield* B.kv.bodyGet("bak:worker-A:call:X")).toBe(
        '{"name":"X","gen":11}'
      )

      // Watermark advanced to A's (gen, counter=1).
      expect(MutableRef.get(puller.viewRef).watermark).toEqual({
        gen: A_GEN,
        counter: 1,
      })

      // Echo: B's outgoing channel-to-A holds the propagated entry.
      const echoBatch = yield* B.outgoing.pullBatch(0, 100)
      expect(echoBatch.entries.length).toBe(1)
      expect(echoBatch.entries[0]!.member).toBe("U:bak:worker-A:call:X")

      yield* puller.stop
    })
  )
})
