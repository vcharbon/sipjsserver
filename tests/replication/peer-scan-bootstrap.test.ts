/**
 * Peer-scan-bootstrap lock-in tests.
 *
 * Covers the four load-bearing correctness properties from
 * docs/plan/echo-removal-grill-me-smooth-parasol.md §7:
 *
 *   1. Happy path — peer's bak partition replays into local pri.
 *   2. Idempotency — running bootstrap twice is a no-op the second
 *      time (no spurious local channel writes).
 *   3. Retry-then-fail — transport-class errors retry once, then
 *      surface as outcome="error" without crashing.
 *   4. Timeout — unresponsive peer's per-attempt budget bounds wall
 *      time; outcome="timeout".
 *
 * The streaming-bound (large partition) and boot-snapshot-freeze
 * scenarios are exercised by the K8s endurance smoke and the
 * sip-front-proxy failover scenarios respectively; pulling them into
 * a unit test would replicate that whole harness.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, MutableHashMap, Stream } from "effect"
import { ChannelIndex } from "../../src/replication/ChannelIndex.js"
import {
  makeDirectBootstrapStream,
  runPeerScanBootstrap,
  type BootstrapMetricsHooks,
} from "../../src/replication/PeerScanBootstrap.js"
import { PullerTransportError } from "../../src/replication/PullerFiber.js"
import type { BootstrapEvent } from "../../src/replication/PullerHttpTransport.js"
import { makeKvBackedMemoryUnsafe } from "../../src/cache/PartitionedRelayStorageKvBacked.js"
import { WorkerOrdinal } from "../../src/cache/PeerCachePort.js"
import {
  KvBackend,
  type MemoryStoreEntry,
} from "../../src/storage/KvBackend.js"
import { bodyBuf, decodeBuf } from "../support/codecHelpers.js"

const A = "worker-A"
const B = "worker-B"
const A_GEN = 100
const B_GEN = 5

// Helper — bake the standard two-worker substrate (A's empty stack +
// B's stack pre-seeded with `bak:A:*` entries representing calls that
// A originated before its sidecar got wiped).
const makeTwoWorker = (callRefs: ReadonlyArray<string>) => {
  // A's storage — empty (post-wipe).
  const storeA = MutableHashMap.empty<string, MemoryStoreEntry>()
  const kvA = KvBackend.makeMemoryUnsafe(storeA)

  // B's storage — pre-seeded with `bak:A:call:{ref}` and the
  // `propagate:B->A` channel.
  const storeB = MutableHashMap.empty<string, MemoryStoreEntry>()
  const kvB = KvBackend.makeMemoryUnsafe(storeB)
  const storageB = makeKvBackedMemoryUnsafe(storeB, { self: B, gen: B_GEN })
  const channelBtoA = ChannelIndex.make(
    { self: B, peer: A, gen: B_GEN },
    kvB
  )

  // Independent outgoing channel on A — used purely to assert
  // bootstrap is a one-way read (no echo).
  const channelAtoB = ChannelIndex.make(
    { self: A, peer: B, gen: A_GEN },
    kvA
  )

  // Seed: each callRef written into B's bak:A:* via storageB.putCall.
  // The opts.peer=A means the write also bumps `propagate:B->A` —
  // exactly the path the originating peer's puller would have produced
  // had B handled the call on A's behalf.
  const seedEffect = Effect.gen(function* () {
    for (let i = 0; i < callRefs.length; i++) {
      const ref = callRefs[i]!
      const body = bodyBuf({
        _topology: { gen: 1 },
        name: ref,
        index: i,
      })
      yield* storageB.putCall("bak", A, ref, body, [], 600).pipe(Effect.orDie)
    }
  })

  return {
    storeA,
    kvA,
    storeB,
    kvB,
    storageB,
    channelBtoA,
    channelAtoB,
    seedEffect,
  }
}

describe("runPeerScanBootstrap — happy path", () => {
  it.effect("replays peer's bak:{A}:* into local pri:{A}:* and seeds watermark", () =>
    Effect.gen(function* () {
      const callRefs = ["call-1", "call-2", "call-3"]
      const setup = makeTwoWorker(callRefs)
      yield* setup.seedEffect

      // Capture watermark seeds for assertion.
      let observedHead: { gen: number; counter: number } | null = null

      const results = yield* runPeerScanBootstrap({
        self: A,
        peers: [WorkerOrdinal(B)],
        kv: setup.kvA,
        seedWatermark: ({ watermark }) =>
          Effect.sync(() => {
            observedHead = watermark
          }),
        overallTimeoutMs: 5_000,
        perPeerRetryDelayMs: 100,
        streamFactory: (peer) =>
          makeDirectBootstrapStream({
            self: A,
            source: peer as unknown as string,
            sourceGen: B_GEN,
            peerKv: setup.kvB,
            peerStorage: setup.storageB,
          }),
      })

      // ---- All entries recovered into A's pri:A:*.
      for (const ref of callRefs) {
        const body = yield* setup.kvA.bodyGet(`pri:${A}:call:${ref}`)
        expect(body).not.toBeNull()
        if (body !== null) {
          const parsed = decodeBuf(body) as { name: string }
          expect(parsed.name).toBe(ref)
        }
      }

      // ---- Outcome + counts.
      expect(results.length).toBe(1)
      expect(results[0]!.peer).toBe(WorkerOrdinal(B))
      expect(results[0]!.outcome).toBe("ok")
      expect(results[0]!.entriesImported).toBe(callRefs.length)
      expect(results[0]!.error).toBeNull()

      // ---- Head was seeded. For this test B's channel is empty
      //      (the seeds go directly to `bak:A:*` without bumping
      //      `propagate:B->A`), so head is `{0,0}` — but seedWatermark
      //      MUST still have been called exactly once with that tuple.
      expect(observedHead).not.toBeNull()
      const head = observedHead as unknown as { gen: number; counter: number }
      expect(head.gen).toBe(0)
      expect(head.counter).toBe(0)

      // ---- Bootstrap MUST NOT write to A's outgoing channel — it is
      //      a one-way read. (No echo path may have crept back in.)
      const outBatch = yield* setup.channelAtoB
        .pullBatch({ gen: 0, counter: 0 }, 1024)
        .pipe(Effect.orDie)
      expect(outBatch.entries.length).toBe(0)
    })
  )
})

describe("runPeerScanBootstrap — idempotency", () => {
  it.effect("second run is a no-op against unchanged peer state", () =>
    Effect.gen(function* () {
      const callRefs = ["alpha", "beta"]
      const setup = makeTwoWorker(callRefs)
      yield* setup.seedEffect

      const seedNoop = () => Effect.void
      const cfg = {
        self: A,
        peers: [WorkerOrdinal(B)],
        kv: setup.kvA,
        seedWatermark: () => seedNoop(),
        overallTimeoutMs: 5_000,
        perPeerRetryDelayMs: 100,
        streamFactory: (peer: WorkerOrdinal) =>
          makeDirectBootstrapStream({
            self: A,
            source: peer as unknown as string,
            sourceGen: B_GEN,
            peerKv: setup.kvB,
            peerStorage: setup.storageB,
          }),
      }

      const r1 = yield* runPeerScanBootstrap(cfg)
      expect(r1[0]!.outcome).toBe("ok")
      expect(r1[0]!.entriesImported).toBe(callRefs.length)

      // Snapshot A's body bytes between runs.
      const beforeBytes = new Map<string, Buffer>()
      for (const ref of callRefs) {
        const body = yield* setup.kvA.bodyGet(`pri:${A}:call:${ref}`)
        if (body !== null) beforeBytes.set(ref, body)
      }

      const r2 = yield* runPeerScanBootstrap(cfg)
      expect(r2[0]!.outcome).toBe("ok")
      expect(r2[0]!.entriesImported).toBe(callRefs.length)

      // Body bytes unchanged — applyReplicaUpdate overwrites with
      // byte-identical content.
      for (const ref of callRefs) {
        const body = yield* setup.kvA.bodyGet(`pri:${A}:call:${ref}`)
        expect(body).not.toBeNull()
        const prev = beforeBytes.get(ref)
        expect(prev).not.toBeUndefined()
        expect((body as Buffer).equals(prev as Buffer)).toBe(true)
      }

      // Outgoing channel still empty.
      const outBatch = yield* setup.channelAtoB
        .pullBatch({ gen: 0, counter: 0 }, 1024)
        .pipe(Effect.orDie)
      expect(outBatch.entries.length).toBe(0)
    })
  )
})

describe("runPeerScanBootstrap — retry-then-fail", () => {
  // it.live: the retry loop uses `Effect.sleep(perPeerRetryDelayMs)` —
  // under TestClock the sleep blocks forever unless we advance the
  // clock manually, which would defeat the simplicity of the test.
  it.live("transport errors retry once then surface outcome=error", () =>
    Effect.gen(function* () {
      const setup = makeTwoWorker([])
      let attempts = 0

      const results = yield* runPeerScanBootstrap({
        self: A,
        peers: [WorkerOrdinal(B)],
        kv: setup.kvA,
        seedWatermark: () => Effect.void,
        overallTimeoutMs: 5_000,
        perPeerRetryDelayMs: 50,
        streamFactory: () => {
          attempts += 1
          return Stream.fail(
            new PullerTransportError({
              reason: `synthetic failure ${attempts}`,
            })
          )
        },
      })

      expect(attempts).toBe(2) // initial + one retry
      expect(results.length).toBe(1)
      expect(results[0]!.outcome).toBe("error")
      expect(results[0]!.entriesImported).toBe(0)
      expect(results[0]!.error).toContain("synthetic failure")
    })
  )
})

describe("runPeerScanBootstrap — retry-then-succeed", () => {
  it.live("transport error on attempt 1, OK on attempt 2 → outcome=ok", () =>
    Effect.gen(function* () {
      const callRefs = ["x"]
      const setup = makeTwoWorker(callRefs)
      yield* setup.seedEffect
      let attempts = 0

      const results = yield* runPeerScanBootstrap({
        self: A,
        peers: [WorkerOrdinal(B)],
        kv: setup.kvA,
        seedWatermark: () => Effect.void,
        overallTimeoutMs: 5_000,
        perPeerRetryDelayMs: 50,
        streamFactory: (peer) => {
          attempts += 1
          if (attempts === 1) {
            return Stream.fail(
              new PullerTransportError({ reason: "flaky-first-attempt" })
            )
          }
          return makeDirectBootstrapStream({
            self: A,
            source: peer as unknown as string,
            sourceGen: B_GEN,
            peerKv: setup.kvB,
            peerStorage: setup.storageB,
          })
        },
      })

      expect(attempts).toBe(2)
      expect(results[0]!.outcome).toBe("ok")
      expect(results[0]!.entriesImported).toBe(callRefs.length)
      const body = yield* setup.kvA.bodyGet(`pri:${A}:call:x`)
      expect(body).not.toBeNull()
    })
  )
})

describe("runPeerScanBootstrap — timeout", () => {
  // it.live: the timeout is wall-clock-bounded; under TestClock we
  // would have to advance the clock manually.
  it.live("unresponsive peer trips the outer budget → outcome=timeout", () =>
    Effect.gen(function* () {
      const setup = makeTwoWorker([])

      // Stream that never emits a frame nor closes — pure sleep-forever.
      const neverEmits: Stream.Stream<BootstrapEvent, PullerTransportError> =
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Effect.never as Effect.Effect<unknown>
            return Stream.empty
          })
        )

      const startMs = Date.now()
      const results = yield* runPeerScanBootstrap({
        self: A,
        peers: [WorkerOrdinal(B)],
        kv: setup.kvA,
        seedWatermark: () => Effect.void,
        overallTimeoutMs: 200, // tight to keep the test fast
        perPeerRetryDelayMs: 50,
        streamFactory: () => neverEmits,
      })
      const elapsed = Date.now() - startMs

      expect(results[0]!.outcome).toBe("timeout")
      expect(results[0]!.entriesImported).toBe(0)
      // Test runs against real wall clock (it.effect doesn't substitute
      // a TestClock here because Effect.timeoutOption uses Clock); the
      // tight budget caps the wall time well under one second.
      expect(elapsed).toBeLessThan(2_000)
    })
  )
})

describe("runPeerScanBootstrap — metrics hooks", () => {
  it.effect("records started, completed, entries, duration", () =>
    Effect.gen(function* () {
      const callRefs = ["m1", "m2"]
      const setup = makeTwoWorker(callRefs)
      yield* setup.seedEffect

      const observed = {
        started: 0,
        completed: [] as Array<[string, string]>,
        imported: [] as Array<[string, number]>,
        durations: [] as Array<[string, number]>,
      }
      const hooks: BootstrapMetricsHooks = {
        recordStarted: () => {
          observed.started += 1
        },
        recordCompleted: (peer, outcome) => {
          observed.completed.push([peer, outcome])
        },
        recordEntriesImported: (peer, count) => {
          observed.imported.push([peer, count])
        },
        recordDurationMs: (peer, ms) => {
          observed.durations.push([peer, ms])
        },
      }

      yield* runPeerScanBootstrap({
        self: A,
        peers: [WorkerOrdinal(B)],
        kv: setup.kvA,
        seedWatermark: () => Effect.void,
        overallTimeoutMs: 5_000,
        perPeerRetryDelayMs: 100,
        metrics: hooks,
        streamFactory: (peer) =>
          makeDirectBootstrapStream({
            self: A,
            source: peer as unknown as string,
            sourceGen: B_GEN,
            peerKv: setup.kvB,
            peerStorage: setup.storageB,
          }),
      })

      expect(observed.started).toBe(1)
      expect(observed.completed).toEqual([[B, "ok"]])
      expect(observed.imported).toEqual([[B, callRefs.length]])
      expect(observed.durations.length).toBe(1)
      expect(observed.durations[0]![0]).toBe(B)
      expect(observed.durations[0]![1]).toBeGreaterThanOrEqual(0)
    })
  )
})
