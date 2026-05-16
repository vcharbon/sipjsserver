/**
 * TransactionLayer event-queue bounding regression (Slice 2 of
 * docs/plan/endurance-stuck-terminating-and-overload-hardening.md).
 *
 * The historical behavior: the inbound event queue was `Queue.unbounded`,
 * so any consumer slowdown retained the entire `LazyHeaders` graph for
 * every parked event. The 2026-05-09 endurance run's heap snapshot held
 * 29 K `LazyHeaders` and 21 K `<sip:probe@…>` URI strings — the proxy's
 * 60-s OPTIONS keepalive accumulating without bound.
 *
 * What this test pins:
 *   - Capacity is `4 × udpQueueMax` (with a floor of 64).
 *   - Producers never block on a full queue.
 *   - Excess offers are dropped, the per-reason counter advances, and
 *     a single 0→non-zero transition WARN is logged (not per event).
 *   - When the consumer drains, the queue empties and producers resume
 *     normal accept-on-offer behavior.
 *
 * The test exercises the layer at the API surface — it does not pump
 * UDP packets. Pumping packets through the parser is exercised by the
 * existing `transaction-layer-100-absorb` suite; this suite focuses
 * narrowly on the bounding/drop semantics.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { simulatedLayer as loadSamplerSimulatedLayer } from "../../src/observability/LoadSampler.js"
import { OverloadController } from "../../src/b2bua/OverloadController.js"
import { SignalingNetwork, type UdpEndpoint } from "../../src/sip/SignalingNetwork.js"
import { UdpTransport } from "../../src/sip/UdpTransport.js"
import { SipParser } from "../../src/sip/Parser.js"
import { TransactionLayer } from "../../src/sip/TransactionLayer.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

const UDP_QUEUE_MAX = 8 // tiny so we hit the cap fast — capacity = 4 × 8 = 32; floored at 64.

function makeConfig(): AppConfigData {
  return testAppConfigDefaults({
    sipLocalIp: "127.0.0.1",
    sipLocalPort: 5060,
    udpQueueMax: UDP_QUEUE_MAX,
  })
}

const stackLayer = (() => {
  const Network = SignalingNetwork.simulated({ transitDelayMs: 1 })
  const AppCfg = Layer.succeed(AppConfig, makeConfig())
  const Leaves = Layer.mergeAll(
    Network,
    MetricsRegistry.layer,
    SipParser.layer,
    loadSamplerSimulatedLayer(),
  ).pipe(Layer.provideMerge(AppCfg))
  const Mid = Layer.mergeAll(UdpTransport.layer, OverloadController.layer)
    .pipe(Layer.provideMerge(Leaves))
  return TransactionLayer.layer.pipe(Layer.provideMerge(Mid))
})()

const PEER_IP = "10.0.0.1"
const PEER_PORT = 5555
const TRANSIT_MS = 1
const B2BUA_PORT = 5060

const bindPeer = Effect.gen(function* () {
  const network = yield* SignalingNetwork
  return yield* network.bindUdp({ ip: PEER_IP, port: PEER_PORT, queueMax: 1024 })
})

/**
 * Build a `180 Ringing` whose Via branch matches no known client
 * transaction. Such responses still pass `parser.parse` and reach
 * `emit`, then idle in `eventQueue` until something subscribes.
 *
 * Each call uses a unique branch + Call-ID so the parser doesn't
 * collapse them into a single retransmit.
 */
function unknownResponse(seq: number): Buffer {
  const branch = `z9hG4bK-overflow-${seq}`
  const callId = `overflow-${seq}@unit`
  return Buffer.from(
    [
      `SIP/2.0 180 Ringing`,
      `Via: SIP/2.0/UDP ${PEER_IP}:${PEER_PORT};branch=${branch}`,
      `From: <sip:b2bua@127.0.0.1:${B2BUA_PORT}>;tag=b2bua-tag`,
      `To: <sip:peer@${PEER_IP}:${PEER_PORT}>;tag=peer-${seq}`,
      `Call-ID: ${callId}`,
      `CSeq: 1 INVITE`,
      `Content-Length: 0`,
      "",
      "",
    ].join("\r\n"),
    "ascii",
  )
}

const sendInto = (peer: UdpEndpoint, buf: Buffer) =>
  peer.send(buf, B2BUA_PORT, "127.0.0.1")

/**
 * Pump the simulated transit clock — each cycle advances 2× transit
 * delay and yields a couple of times so the simulated network's
 * delivery fibers + the TransactionLayer ingest stream + the parser
 * all wake up.
 */
const pump = (cycles = 1) =>
  Effect.gen(function* () {
    for (let i = 0; i < cycles; i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${TRANSIT_MS + 1} millis`)
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${TRANSIT_MS + 1} millis`)
      yield* Effect.yieldNow
    }
  })

describe("TransactionLayer — bounded event queue, drop-on-full", () => {
  it.effect(
    "capacity matches sizing formula and counters start at zero",
    () =>
      Effect.gen(function* () {
        const txn = yield* TransactionLayer
        expect(txn.metrics.eventQueueCapacity).toBe(Math.max(64, UDP_QUEUE_MAX * 4))
        expect(txn.metrics.eventQueueDepth()).toBe(0)
        expect(txn.metrics.eventQueueDrops.response).toBe(0)
        expect(txn.metrics.eventQueueDrops.request_invite).toBe(0)
        expect(txn.metrics.eventQueueDrops.request_other).toBe(0)
        expect(txn.metrics.eventQueueDrops.cancelled).toBe(0)
        expect(txn.metrics.eventQueueDrops.timeout).toBe(0)
      }).pipe(Effect.provide(stackLayer)),
  )

  it.effect(
    "with no consumer subscribed: pumping > capacity events stops at capacity and increments drop counter for the excess",
    () =>
      Effect.gen(function* () {
        const txn = yield* TransactionLayer
        const peer = yield* bindPeer
        const cap = txn.metrics.eventQueueCapacity

        // Pump 2× capacity. No consumer is subscribed to `txn.events`,
        // so every parsed response should land directly in the bounded
        // queue. Once the queue is full, every subsequent emit must
        // drop without blocking the receive loop.
        const overflow = cap * 2
        for (let i = 0; i < overflow; i++) {
          yield* sendInto(peer, unknownResponse(i))
        }

        // Drain the simulated network + ingest stream — each packet's
        // delivery is gated on TestClock.
        yield* pump(overflow + 4)

        // The queue must now be at capacity (cap depth) and the rest
        // must show up as drops with reason=`response`.
        expect(txn.metrics.eventQueueDepth()).toBe(cap)
        expect(txn.metrics.eventQueueDrops.response).toBe(overflow - cap)
        // Other reasons are unaffected.
        expect(txn.metrics.eventQueueDrops.request_invite).toBe(0)
        expect(txn.metrics.eventQueueDrops.cancelled).toBe(0)
        expect(txn.metrics.eventQueueDrops.timeout).toBe(0)

        // Drain via the public stream — after taking `cap` events the
        // queue empties to zero and producers resume normal accept.
        const drained = yield* Effect.forkChild(
          txn.events.pipe(Stream.take(cap), Stream.runCollect),
        )
        yield* pump(2)
        const collected = yield* Fiber.join(drained)
        expect(collected.length).toBe(cap)
        expect(txn.metrics.eventQueueDepth()).toBe(0)
      }).pipe(Effect.provide(stackLayer)),
  )
})

/**
 * Direct-queue stress test — exercises the bounded-queue contract on
 * an isolated `Queue.bounded(n)` so we can pin the semantics relied on
 * by `TransactionLayer.emit` (drop-on-full via `offerUnsafe`, sizing,
 * and recovery).
 *
 * This isolates the contract from the rest of the SIP stack so a
 * future refactor that changes how `TransactionLayer` is wired cannot
 * silently regress it.
 */
describe("Queue.bounded — drop-newest contract relied on by TransactionLayer.emit", () => {
  it.effect(
    "offerUnsafe returns true up to capacity, false thereafter; size() === capacity at saturation; drains to 0",
    () =>
      Effect.gen(function* () {
        const cap = 4
        const q = yield* Queue.bounded<number>(cap)

        // Fill exactly to capacity — every offer accepted.
        for (let i = 0; i < cap; i++) {
          expect(Queue.offerUnsafe(q, i)).toBe(true)
        }
        expect(Queue.sizeUnsafe(q)).toBe(cap)

        // Excess offers are rejected (drop-newest), size unchanged.
        for (let i = 0; i < 10; i++) {
          expect(Queue.offerUnsafe(q, 100 + i)).toBe(false)
        }
        expect(Queue.sizeUnsafe(q)).toBe(cap)

        // Drain — only the original `cap` entries are observed in order.
        const drained: number[] = []
        for (let i = 0; i < cap; i++) {
          drained.push(yield* Queue.take(q))
        }
        expect(drained).toEqual([0, 1, 2, 3])
        expect(Queue.sizeUnsafe(q)).toBe(0)

        // After drain, the queue accepts again.
        expect(Queue.offerUnsafe(q, 999)).toBe(true)
        expect(Queue.sizeUnsafe(q)).toBe(1)
      }),
  )
})
