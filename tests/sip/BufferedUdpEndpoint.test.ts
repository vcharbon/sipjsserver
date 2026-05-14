/**
 * Unit tests for BufferedUdpEndpoint.
 *
 * Mounts a stub `UdpEndpoint` whose `send` can be configured per test:
 *   - immediate success (fast)
 *   - hangs forever (`Effect.never`) until interrupted (slow)
 *   - fails with SendError
 *
 * Tests assert: caller-side non-blocking behaviour, per-peer isolation,
 * queue cap (drop-newest), idle reclamation, max-peers eviction, and
 * SendError swallowing.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  makeBufferedSendCounters,
  wrapEndpoint,
  type BufferedSendCounters,
} from "../../src/sip/BufferedUdpEndpoint.js"
import {
  SendError,
  type UdpEndpoint,
  type UdpEndpointCounters,
  type UdpPacket,
} from "../../src/sip/SignalingNetwork.js"

// ---------------------------------------------------------------------------
// Stub UdpEndpoint
// ---------------------------------------------------------------------------

interface SendRecord {
  readonly host: string
  readonly port: number
  readonly buf: Buffer
}

interface StubOpts {
  /** Per-host send behaviour. Default: immediate success. */
  readonly behaviour?: (host: string) => "ok" | "hang" | "fail"
}

const makeStub = (
  opts: StubOpts = {},
): Effect.Effect<{
  readonly endpoint: UdpEndpoint
  readonly sends: ReadonlyArray<SendRecord>
}> =>
  Effect.gen(function* () {
    const sends: SendRecord[] = []
    const behaviour = opts.behaviour ?? (() => "ok" as const)
    const counters: UdpEndpointCounters = {
      enqueued: 0,
      tailDropped: 0,
      preIngressDropped: 0,
      preIngressReplies: 0,
    }
    const send = (buf: Buffer, port: number, host: string) =>
      Effect.gen(function* () {
        sends.push({ host, port, buf })
        const verdict = behaviour(host)
        if (verdict === "ok") return
        if (verdict === "fail") {
          return yield* new SendError({ message: `stub fail to ${host}:${port}` })
        }
        // hang
        yield* Effect.never
      })
    // Construct a no-traffic queue for `messages` so callers can still subscribe.
    const queue = yield* Queue.unbounded<UdpPacket>()
    const endpoint: UdpEndpoint = {
      localAddress: { ip: "0.0.0.0", port: 0 },
      send,
      messages: Stream.fromQueue(queue),
      poll: () => Effect.succeed(null),
      take: () => Effect.never,
      queueDepth: () => 0,
      queueMax: 0,
      counters,
    }
    return { endpoint, sends }
  })

// ---------------------------------------------------------------------------
// Defaults for opts
// ---------------------------------------------------------------------------

const defaultOpts = (counters: BufferedSendCounters) => ({
  perPeerQueueMax: 4,
  idleTtlMs: 5_000,
  maxPeers: 4,
  sweepIntervalMs: 1_000,
  counters,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BufferedUdpEndpoint — caller-side non-blocking", () => {
  it.effect("send returns immediately even when inner.send hangs forever", () =>
    Effect.gen(function* () {
      const counters = makeBufferedSendCounters()
      const { endpoint, sends } = yield* makeStub({ behaviour: () => "hang" })
      const wrapped = yield* wrapEndpoint(endpoint, defaultOpts(counters))

      // Each of these would block for 5s+ under the old direct-call shape.
      yield* wrapped.send(Buffer.from("a"), 5060, "slow.local")
      yield* wrapped.send(Buffer.from("b"), 5060, "slow.local")
      yield* wrapped.send(Buffer.from("c"), 5060, "slow.local")

      // Inner.send was called once (the first packet); the next two sit in queue.
      // Allow the drainer fiber a chance to dequeue+invoke the first.
      yield* Effect.yieldNow
      expect(sends.length).toBe(1)
      expect(counters.enqueued).toBe(3)
      expect(counters.droppedQueueFull).toBe(0)
    }),
  )
})

describe("BufferedUdpEndpoint — per-peer isolation", () => {
  it.effect("fast peer keeps draining while slow peer's drainer is stuck", () =>
    Effect.gen(function* () {
      const counters = makeBufferedSendCounters()
      const { endpoint, sends } = yield* makeStub({
        behaviour: (host) => (host === "slow.local" ? "hang" : "ok"),
      })
      const wrapped = yield* wrapEndpoint(endpoint, defaultOpts(counters))

      yield* wrapped.send(Buffer.from("s1"), 5060, "slow.local")
      yield* wrapped.send(Buffer.from("f1"), 5060, "fast.local")
      yield* wrapped.send(Buffer.from("f2"), 5060, "fast.local")
      yield* wrapped.send(Buffer.from("f3"), 5060, "fast.local")

      // Pump enough scheduler turns that the fast drainer can process its queue.
      for (let i = 0; i < 8; i++) yield* Effect.yieldNow

      const fastSends = sends.filter((s) => s.host === "fast.local")
      const slowSends = sends.filter((s) => s.host === "slow.local")
      expect(fastSends.length).toBe(3)
      // Slow drainer is stuck on the first packet; never advances.
      expect(slowSends.length).toBe(1)
    }),
  )
})

describe("BufferedUdpEndpoint — per-peer queue cap", () => {
  it.effect("drops newest when peer queue is full", () =>
    Effect.gen(function* () {
      const counters = makeBufferedSendCounters()
      const { endpoint } = yield* makeStub({ behaviour: () => "hang" })
      const wrapped = yield* wrapEndpoint(endpoint, {
        ...defaultOpts(counters),
        perPeerQueueMax: 2,
      })

      // Five sends issued back-to-back as a synchronous burst before the
      // drainer fiber gets scheduled. With cap=2, the queue accepts the
      // first two and drops the rest.
      yield* wrapped.send(Buffer.from("1"), 5060, "x.local")
      yield* wrapped.send(Buffer.from("2"), 5060, "x.local")
      yield* wrapped.send(Buffer.from("3"), 5060, "x.local")
      yield* wrapped.send(Buffer.from("4"), 5060, "x.local")
      yield* wrapped.send(Buffer.from("5"), 5060, "x.local")

      expect(counters.enqueued).toBe(2)
      expect(counters.droppedQueueFull).toBe(3)
    }),
  )
})

describe("BufferedUdpEndpoint — idle reclamation", () => {
  it.effect("a peer with no progress for idleTtlMs is reclaimed by the sweeper", () =>
    Effect.gen(function* () {
      const counters = makeBufferedSendCounters()
      const { endpoint } = yield* makeStub({ behaviour: () => "ok" })
      const wrapped = yield* wrapEndpoint(endpoint, {
        ...defaultOpts(counters),
        idleTtlMs: 5_000,
        sweepIntervalMs: 1_000,
      })

      yield* wrapped.send(Buffer.from("one"), 5060, "x.local")
      yield* Effect.yieldNow
      expect(wrapped.peerCount()).toBe(1)

      // Advance past idleTtl. Sweeper fires every 1s; after 6s the peer's
      // lastProgressMs is older than idleTtlMs and gets reclaimed.
      yield* TestClock.adjust("6 seconds")
      yield* Effect.yieldNow

      expect(wrapped.peerCount()).toBe(0)
      expect(counters.reclaimedIdle).toBe(1)
    }),
  )

  it.effect("reclaiming a peer with a non-empty queue increments droppedEvictedWithQueue", () =>
    Effect.gen(function* () {
      const counters = makeBufferedSendCounters()
      const { endpoint } = yield* makeStub({ behaviour: () => "hang" })
      const wrapped = yield* wrapEndpoint(endpoint, {
        ...defaultOpts(counters),
        perPeerQueueMax: 8,
        idleTtlMs: 5_000,
        sweepIntervalMs: 1_000,
      })

      // First send goes into inner.send (hung); next 3 sit in queue.
      yield* wrapped.send(Buffer.from("a"), 5060, "x.local")
      yield* wrapped.send(Buffer.from("b"), 5060, "x.local")
      yield* wrapped.send(Buffer.from("c"), 5060, "x.local")
      yield* wrapped.send(Buffer.from("d"), 5060, "x.local")
      yield* Effect.yieldNow

      yield* TestClock.adjust("6 seconds")
      yield* Effect.yieldNow

      expect(counters.reclaimedIdle).toBe(1)
      // 3 queued packets dropped on reclamation (the 4th was in flight).
      expect(counters.droppedEvictedWithQueue).toBe(3)
    }),
  )

  it.effect("a reclaimed peer's key can be re-enqueued cleanly", () =>
    Effect.gen(function* () {
      const counters = makeBufferedSendCounters()
      const { endpoint, sends } = yield* makeStub({ behaviour: () => "ok" })
      const wrapped = yield* wrapEndpoint(endpoint, {
        ...defaultOpts(counters),
        idleTtlMs: 1_000,
        sweepIntervalMs: 500,
      })

      yield* wrapped.send(Buffer.from("first"), 5060, "x.local")
      yield* Effect.yieldNow

      yield* TestClock.adjust("2 seconds")
      yield* Effect.yieldNow
      expect(wrapped.peerCount()).toBe(0)

      yield* wrapped.send(Buffer.from("second"), 5060, "x.local")
      yield* Effect.yieldNow
      expect(wrapped.peerCount()).toBe(1)
      expect(sends.length).toBe(2)
    }),
  )
})

describe("BufferedUdpEndpoint — max-peers eviction", () => {
  it.effect("creating a peer at maxPeers evicts the oldest (idle-LRU)", () =>
    Effect.gen(function* () {
      const counters = makeBufferedSendCounters()
      const { endpoint } = yield* makeStub({ behaviour: () => "hang" })
      const wrapped = yield* wrapEndpoint(endpoint, {
        ...defaultOpts(counters),
        maxPeers: 2,
        idleTtlMs: 60_000,
        sweepIntervalMs: 30_000,
      })

      yield* wrapped.send(Buffer.from("a"), 5060, "h1")
      yield* TestClock.adjust("10 millis")
      yield* wrapped.send(Buffer.from("b"), 5060, "h2")
      yield* Effect.yieldNow
      expect(wrapped.peerCount()).toBe(2)

      // Third peer triggers cap eviction. h1 is the oldest, gets evicted.
      yield* TestClock.adjust("10 millis")
      yield* wrapped.send(Buffer.from("c"), 5060, "h3")
      yield* Effect.yieldNow

      expect(wrapped.peerCount()).toBe(2)
      expect(counters.reclaimedCap).toBe(1)
    }),
  )
})

describe("BufferedUdpEndpoint — inner send errors", () => {
  it.effect("SendError from inner.send is swallowed; drainer continues; caller unaffected", () =>
    Effect.gen(function* () {
      const counters = makeBufferedSendCounters()
      const { endpoint, sends } = yield* makeStub({ behaviour: () => "fail" })
      const wrapped = yield* wrapEndpoint(endpoint, defaultOpts(counters))

      yield* wrapped.send(Buffer.from("a"), 5060, "x.local")
      yield* wrapped.send(Buffer.from("b"), 5060, "x.local")
      yield* wrapped.send(Buffer.from("c"), 5060, "x.local")

      for (let i = 0; i < 8; i++) yield* Effect.yieldNow

      // All three attempted; all three failed; drainer kept going.
      expect(sends.length).toBe(3)
      expect(counters.innerSendErrors).toBe(3)
      expect(counters.enqueued).toBe(3)
    }),
  )
})

describe("BufferedUdpEndpoint — pass-through reads", () => {
  it.effect("messages, poll, take, queueDepth, queueMax delegate to inner", () =>
    Effect.gen(function* () {
      const counters = makeBufferedSendCounters()
      const { endpoint } = yield* makeStub()
      const wrapped = yield* wrapEndpoint(endpoint, defaultOpts(counters))

      expect(wrapped.localAddress).toEqual(endpoint.localAddress)
      expect(wrapped.queueMax).toBe(endpoint.queueMax)
      expect(wrapped.counters).toBe(endpoint.counters)
      expect(yield* wrapped.poll()).toBeNull()
    }),
  )
})
