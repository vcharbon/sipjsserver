/**
 * T7 — steady-state lag observation.
 *
 * Asserts G3 (sub-second steady-state replication lag). The puller's
 * applied DataFrames carry `latency_ms` derived from the body's
 * `written_at_ms` stamp; this test verifies the wiring is correct
 * end-to-end so a production observability dashboard backed by these
 * values reflects reality.
 *
 * Scope: under in-memory KvBackend + real (it.live) clock, write 50
 * calls with a body stamped with `written_at_ms = Date.now()` and
 * assert the puller observes them with `latency_ms` ≥ 0 and bounded
 * (we verify boundedness, not absolute value — k8s tier owns the
 * 500-writes-per-second + P99 ≤ 1s assertion per design doc §D9 T7).
 */

import { describe, expect, it } from "@effect/vitest"
import {
  Effect,
  Fiber,
  MutableHashMap,
  MutableRef,
  Stream,
} from "effect"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import {
  initialPeerView,
  PullerTransportError,
  runPullerFiber,
  type DataFrame,
} from "../../src/replication/PullerFiber.js"
import { buildPullStream } from "../../src/replication/ReplLogServer.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"

const A_GEN = 99
const N_CALLS = 50

describe("T7 — steady-state lag through the puller", () => {
  it.live(
    "puller captures latency_ms from body.written_at_ms; lag bounded under steady writes",
    () =>
      Effect.gen(function* () {
        const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
        const kvA = KvBackend.makeMemoryUnsafe(storeA)
        const channel = ChannelIndex.make(
          { self: "worker-A", peer: "worker-B", gen: A_GEN },
          kvA
        )

        // Write N_CALLS, each with `written_at_ms` stamped at write
        // time. Spaced ~2ms apart in real time so the puller actually
        // observes a non-trivial lag spread.
        const writeStartedAt = Date.now()
        for (let i = 0; i < N_CALLS; i++) {
          const nowMs = Date.now()
          yield* channel.write({
            entryGen: channel.gen,
            partition: "pri",
            callRef: `c-${i}`,
            bodyValue: JSON.stringify({
              _topology: { gen: i + 1 },
              i,
              written_at_ms: nowMs,
            }),
            bodyTtlSec: 60,
            indexes: [],
          })
          // tiny sleep to avoid all writes landing in the same ms
          yield* Effect.sleep("1 millis")
        }

        const captured: Array<DataFrame> = []
        const viewRef = MutableRef.make(initialPeerView("worker-A"))

        const fiber = yield* Effect.forkChild(
          runPullerFiber({
            peer: "worker-A",
            viewRef,
            openStream: (args): Stream.Stream<Uint8Array, PullerTransportError> =>
              buildPullStream({
                channel,
                serverGen: A_GEN,
                initialSince: { gen: args.sinceGen, counter: args.sinceCounter },
                chunkSize: args.chunkSize,
                noopIntervalMs: 5,
              }),
            applyFrame: (f) =>
              Effect.sync(() => {
                captured.push(f)
              }),
            chunkSize: 100,
            initialBackoffMs: 50,
          })
        )

        yield* waitFor(() =>
          MutableRef.get(viewRef).everCaughtUp &&
          MutableRef.get(viewRef).entriesAppliedTotal >= N_CALLS
        )

        const completedAt = Date.now()
        const totalDuration = completedAt - writeStartedAt

        // Every frame carries a non-negative latency_ms.
        for (const f of captured) {
          expect(f.latency_ms).toBeGreaterThanOrEqual(0)
        }

        // No applied frame's latency exceeds the total wall-clock
        // duration of the test (a sanity check on the wiring).
        for (const f of captured) {
          expect(f.latency_ms).toBeLessThanOrEqual(totalDuration + 100)
        }

        // P50 latency well under the test's total duration —
        // individual frames are not waiting on the whole batch.
        const sorted = [...captured.map((f) => f.latency_ms)].sort(
          (a, b) => a - b
        )
        const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0
        // Loose bound: the inner-loop test, not a perf gate. K8s tier
        // owns the strict P99 ≤ 1s assertion.
        expect(p50).toBeLessThan(2_000)

        yield* Fiber.interrupt(fiber)
      })
  )
})

const waitFor = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + 5000
    while (!predicate()) {
      if (Date.now() > deadline) {
        return yield* Effect.die(
          new Error("waitFor: predicate did not become true within 5s")
        )
      }
      yield* Effect.sleep("5 millis")
    }
  })
