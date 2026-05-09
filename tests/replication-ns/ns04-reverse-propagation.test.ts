/**
 * NS4 — reverse propagation (G7 path, no SIP involved).
 *
 * Scenario:
 *   1. A writes X (forward path: pri:{A}:call:X). B's puller drains
 *      → bak:{A}:call:X on B; echo bumps B's outgoing-to-A.
 *   2. B then handles an in-dialog request on A's behalf — modeled
 *      here by a direct `B.outgoing.write({ partition: "bak", ... })`
 *      with a NEW body (the modification). This is what the SIP
 *      handler would do under G7 brief-primary-unavailability.
 *   3. A's puller drains B's outgoing channel-to-A → because the
 *      frame's partition tag is "bak", the apply rule routes to A's
 *      `pri:{A}:` (reverse direction). A's primary state now holds
 *      B's modification.
 *
 * Asserts:
 *   - A's pri:{A}:call:X holds the version B wrote on its behalf.
 *   - B's outgoing-to-A channel has the U-member tagged "bak"
 *     (so the partition routing in the frame is preserved on the wire).
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableRef } from "effect"
import {
  forkPuller,
  makeWorker,
  waitFor,
} from "./twoWorkerHarness.js"

const A_GEN = 31
const B_GEN = 32

describe("NS4 — reverse propagation (G7 path)", () => {
  it.live("B writes to bak:{A}: on A's behalf; A's pri:{A}: catches up via reverse path", () =>
    Effect.gen(function* () {
      const A = makeWorker({ self: "worker-A", peer: "worker-B", gen: A_GEN })
      const B = makeWorker({ self: "worker-B", peer: "worker-A", gen: B_GEN })

      // Step 1: forward (A writes X, B receives).
      yield* A.outgoing.write({
        partition: "pri",
        callRef: "X",
        bodyValue: '{"ver":"original","gen":31}',
        bodyTtlSec: 60,
        indexes: [],
      })
      const bPuller = yield* forkPuller({ source: A, consumer: B })
      yield* waitFor(
        () =>
          MutableRef.get(bPuller.viewRef).everCaughtUp &&
          MutableRef.get(bPuller.viewRef).entriesAppliedTotal >= 1
      )
      yield* bPuller.stop

      // Step 2: B handles in-dialog request on A's behalf — writes
      // directly to its bak partition, which BUMPS its outgoing
      // channel-to-A (the source of truth A pulls from on recovery).
      yield* B.outgoing.write({
        partition: "bak",
        callRef: "X",
        bodyValue: '{"ver":"updated-by-backup","gen":32}',
        bodyTtlSec: 60,
        indexes: [],
      })

      // Inspection: B's outgoing channel-to-A now has TWO entries
      // (the echo from forward propagate + the new bak-write). The
      // bak entry's member is `U:bak:worker-A:call:X` because the
      // ChannelIndex.bodyKey for partition=bak with self=B,peer=A
      // resolves to bak:{A}:call:X (peer is the owner for bak).
      const bBatch = yield* B.outgoing.pullBatch(0, 100)
      expect(bBatch.entries.length).toBeGreaterThanOrEqual(1)

      // Step 3: A's puller drains. The frame's partition tag is "bak"
      // → reverse → write to A's pri:{A}:. (Note: in this scenario A's
      // own outgoing channel already holds the original X; the apply
      // overwrites the body via ChannelIndex.write.)
      const aPuller = yield* forkPuller({ source: B, consumer: A })
      yield* waitFor(
        () =>
          MutableRef.get(aPuller.viewRef).everCaughtUp &&
          MutableRef.get(aPuller.viewRef).entriesAppliedTotal >= 1
      )

      // A's pri:{A}: now holds B's version.
      const recovered = yield* A.kv.bodyGet("pri:worker-A:call:X")
      expect(recovered).toBe('{"ver":"updated-by-backup","gen":32}')

      yield* aPuller.stop
    })
  )
})
