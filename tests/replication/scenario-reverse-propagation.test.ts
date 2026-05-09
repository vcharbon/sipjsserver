/**
 * T6 — scenario reverse propagation under brief primary unavailability.
 *
 * Asserts G7: reverse-direction propagation is a first-class
 * steady-state concern. The mechanism survives a brief primary
 * unavailability — while A's puller is interrupted (e.g., GC pause,
 * overload glitch), B can write to its `bak:{A}:` on A's behalf via
 * its outgoing channel-to-A. When A's puller resumes, the
 * partition="bak" frames are applied via the reverse-direction
 * apply path into A's `pri:{A}:`.
 *
 * This is a variation of NS4 with the focus shifted: the test
 * simulates a STEADY STATE where both peers run mutual pullers,
 * one is briefly interrupted, traffic flows on the survivor,
 * and the recovering peer catches up automatically — no separate
 * recovery code path beyond the existing watermark-resume flow.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, MutableRef } from "effect"
import {
  forkPuller,
  makeWorker,
  waitFor,
} from "../replication-ns/twoWorkerHarness.js"

const A_GEN = 81
const B_GEN = 82

describe("T6 — reverse propagation under brief primary unavailability", () => {
  it.live(
    "B writes on A's behalf during A's puller outage; A reconciles via reverse path",
    () =>
      Effect.gen(function* () {
        const A = makeWorker({ self: "worker-A", peer: "worker-B", gen: A_GEN })
        const B = makeWorker({ self: "worker-B", peer: "worker-A", gen: B_GEN })

        // Steady state: A is primary for X. B's puller drains.
        yield* A.outgoing.write({
          partition: "pri",
          callRef: "X",
          bodyValue: '{"ver":"v0","gen":81}',
          bodyTtlSec: 60,
          indexes: [],
        })

        const bPuller = yield* forkPuller({ source: A, consumer: B })
        const aPullerInitial = yield* forkPuller({ source: B, consumer: A })

        yield* waitFor(() =>
          MutableRef.get(bPuller.viewRef).everCaughtUp &&
          MutableRef.get(bPuller.viewRef).entriesAppliedTotal >= 1
        )

        // Simulate brief A unavailability — interrupt A's puller. B
        // remains alive and observing A.
        yield* Fiber.interrupt(aPullerInitial.fiber)

        // While A is "down": B receives an in-dialog modification on
        // A's behalf and writes to its bak:{A}:call:X. This is the G7
        // reverse path that the LB-proxy enables.
        yield* B.outgoing.write({
          partition: "bak",
          callRef: "X",
          bodyValue: '{"ver":"v1-by-backup","gen":82}',
          bodyTtlSec: 60,
          indexes: [],
        })

        // Sanity: A's pri:{A}:call:X is still v0 — A hasn't pulled yet.
        const beforeRecovery = yield* A.kv.bodyGet("pri:worker-A:call:X")
        expect(beforeRecovery).toBe('{"ver":"v0","gen":81}')

        // A recovers — re-fork its puller. Resume from (0, 0) since
        // we discarded the prior view; in a real supervisor reconcile
        // the watermark would be preserved, but for this scenario
        // both paths converge on the latest tuple anyway.
        const aPullerRecovered = yield* forkPuller({ source: B, consumer: A })

        yield* waitFor(() =>
          MutableRef.get(aPullerRecovered.viewRef).everCaughtUp &&
          MutableRef.get(aPullerRecovered.viewRef).entriesAppliedTotal >= 1
        )

        // A's pri:{A}:call:X now holds the version B wrote during A's outage.
        const afterRecovery = yield* A.kv.bodyGet("pri:worker-A:call:X")
        expect(afterRecovery).toBe('{"ver":"v1-by-backup","gen":82}')

        yield* bPuller.stop
        yield* aPullerRecovered.stop
      })
  )
})
