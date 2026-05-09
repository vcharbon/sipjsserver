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
 *      tombstone applied to A's `pri:{A}:`.
 *
 * Asserts:
 *   - B's bak:{A}:call:X body is now the tombstone marker (not the
 *     original "X" content).
 *   - A's pri:{A}:call:X body is also the tombstone marker (recovered
 *     via reverse propagation).
 *
 * The mechanism is symmetric: the puller does not care which side
 * wrote the tombstone — partition-tagged routing handles both
 * forward and reverse cleanup.
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
          callGen: 1,
          partition: "bak",
          callRef: "X",
          indexesToRemove: [],
        })

        // B's bak:{A}:call:X is now the tombstone marker (not the
        // original "X" content). Per Story 7d, the marker carries
        // the per-call `callGen` (set by PRS via RMW; in this test
        // we passed `callGen: 1` explicitly above).
        const bAfterTomb = yield* B.kv.bodyGet("bak:worker-A:call:X")
        expect(bAfterTomb).toBe('{"tombstone":true,"callGen":1}')

        // Step 3: A's puller drains B's outgoing-to-A. The reverse
        // tombstone arrives and DELs A's pri:{A}:call:X (well — sets
        // it to the tombstone marker; same observable result).
        const aPuller = yield* forkPuller({ source: B, consumer: A })

        // Wait for at least 2 frames applied: the original update
        // echo (from step 1) AND the new tombstone.
        yield* waitFor(() =>
          MutableRef.get(aPuller.viewRef).everCaughtUp &&
          MutableRef.get(aPuller.viewRef).entriesAppliedTotal >= 2
        )

        // A's pri:{A}:call:X is the tombstone marker (under the
        // reverse-direction apply rule).
        const aAfterTomb = yield* A.kv.bodyGet("pri:worker-A:call:X")
        // Slice 7c: the puller writes the body verbatim from the
        // wire (the body field on the data frame), preserving the
        // original writer's gen. Here the source is B (gen=52), so
        // A's local pri tombstone marker carries gen=52, NOT A's
        // local gen. This is correct: the marker tracks the writer
        // who originally tombstoned the call, which matters for
        // gen-monotonicity assertions across cluster respawns.
        expect(aAfterTomb).toBe('{"tombstone":true,"callGen":1}')

        yield* aPuller.stop
      })
  )
})
