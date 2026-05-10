/**
 * NS14 — symmetric tombstone (BYE handled by backup on primary's behalf).
 *
 * Scenario:
 *   1. A writes X (forward). B's puller catches up — B's bak:{A}:call:X
 *      holds the body; B's outgoing channel-to-A has the echoed entry.
 *   2. While A is "briefly unavailable", a BYE for X is routed to B.
 *      B writes a tombstone to its OWN `bak:{A}:` via
 *      `channelBtoA.tombstone({ partition: "bak", ... })` — bumping
 *      its outgoing channel-to-A with a D-member tagged "bak".
 *   3. A's puller drains B's outgoing-to-A. The frame is `op=delete,
 *      partition=bak` — the apply rule routes it via the REVERSE path:
 *      hard-DEL applied to A's `pri:{A}:`.
 *
 * Asserts:
 *   - B's bak:{A}:call:X is empty (hard-DEL'd by B's tombstone).
 *   - A's pri:{A}:call:X is empty (hard-DEL'd via reverse-direction
 *     apply on the puller).
 *
 * The mechanism is symmetric: the puller does not care which side
 * wrote the tombstone — partition-tagged routing handles both
 * forward and reverse cleanup. Body slots never hold a tombstone
 * payload (see docs/plan/lets-plan-a-proper-crystalline-emerson.md).
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableRef } from "effect"
import {
  forkPuller,
  makeWorker,
  waitFor,
} from "./twoWorkerHarness.js"

const A_GEN = 51
const B_GEN = 52

describe("NS14 — symmetric tombstone from backup", () => {
  it.live(
    "B writes a tombstone to bak:{A}: on A's behalf; A's pri:{A}: cleans up via reverse",
    () =>
      Effect.gen(function* () {
        const A = makeWorker({ self: "worker-A", peer: "worker-B", gen: A_GEN })
        const B = makeWorker({ self: "worker-B", peer: "worker-A", gen: B_GEN })

        // Step 1: A writes X. B's puller catches up.
        yield* A.outgoing.write({
          entryGen: A.outgoing.gen,
          partition: "pri",
          callRef: "X",
          bodyValue: '{"name":"X","gen":51}',
          bodyTtlSec: 60,
          indexes: [],
        })
        const bPuller = yield* forkPuller({ source: A, consumer: B })
        yield* waitFor(() =>
          MutableRef.get(bPuller.viewRef).everCaughtUp &&
          MutableRef.get(bPuller.viewRef).entriesAppliedTotal >= 1
        )
        // Sanity: B has X's body in bak:{A}:.
        expect(yield* B.kv.bodyGet("bak:worker-A:call:X")).toBe(
          '{"name":"X","gen":51}'
        )
        yield* bPuller.stop

        // Step 2: B writes a tombstone for X to its own bak:{A}: via
        // its outgoing channel-to-A. ChannelIndex.tombstone with
        // partition="bak" + self=B + peer=A resolves the body key to
        // bak:{A}:call:X (peer is the owner under the bak partition).
        yield* B.outgoing.tombstone({
          entryGen: B.outgoing.gen,
          partition: "bak",
          callRef: "X",
          indexesToRemove: [],
        })

        // B's bak:{A}:call:X is empty — body slot was hard-DEL'd.
        expect(yield* B.kv.bodyGet("bak:worker-A:call:X")).toBeNull()

        // Step 3: A's puller drains B's outgoing-to-A. The reverse
        // tombstone arrives and hard-DELs A's pri:{A}:call:X via the
        // reverse-direction apply rule.
        const aPuller = yield* forkPuller({ source: B, consumer: A })

        // Wait for the tombstone frame to land. With echo killed,
        // there is exactly one frame on B's outgoing channel-to-A
        // — the tombstone B wrote in step 2 above. (Pre-echo-removal,
        // a second frame existed — B's echo of A's original write —
        // but that path is gone.)
        yield* waitFor(() =>
          MutableRef.get(aPuller.viewRef).everCaughtUp &&
          MutableRef.get(aPuller.viewRef).entriesAppliedTotal >= 1
        )

        // A's pri:{A}:call:X is empty.
        expect(yield* A.kv.bodyGet("pri:worker-A:call:X")).toBeNull()

        yield* aPuller.stop
      })
  )
})
