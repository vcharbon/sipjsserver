/**
 * Unit tests for SignalingNetwork (simulated + real layers).
 *
 * The simulated layer is the primary focus — all routing, transit delay,
 * preIngress hook, and undeliverable behavior lives there. The real layer
 * gets one smoke test (bind on a taken port → BindError).
 */

import * as dgram from "node:dgram"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  BindError,
  PreIngressAction,
  SignalingNetwork,
  type UdpEndpoint,
} from "../../src/sip/SignalingNetwork.js"

const TRANSIT = 15
const simulatedLayer = SignalingNetwork.simulated({ transitDelayMs: TRANSIT })

/** Pull the next message from an endpoint's stream. Caller is expected to
 * have already advanced TestClock past the transit delay. */
const pullOne = (ep: UdpEndpoint) =>
  ep.messages.pipe(Stream.take(1), Stream.runCollect)

describe("SignalingNetwork.simulated — bind", () => {
  it.effect("rejects second bind on the same ip:port with BindError{already_bound}", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      yield* net.bindUdp({ ip: "10.0.0.1", port: 5060, queueMax: 16 })

      const second = yield* Effect.result(
        net.bindUdp({ ip: "10.0.0.1", port: 5060, queueMax: 16 })
      )

      expect(second._tag).toBe("Failure")
      if (second._tag === "Failure") {
        const failure = second.failure
        expect(failure).toBeInstanceOf(BindError)
        expect((failure as BindError).reason).toBe("already_bound")
        expect((failure as BindError).ip).toBe("10.0.0.1")
        expect((failure as BindError).port).toBe(5060)
      }
    }).pipe(Effect.provide(simulatedLayer))
  )

  it.effect("allows same port on different IPs", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const a = yield* net.bindUdp({ ip: "10.0.0.1", port: 5060, queueMax: 16 })
      const b = yield* net.bindUdp({ ip: "10.0.0.2", port: 5060, queueMax: 16 })

      expect(a.localAddress).toEqual({ ip: "10.0.0.1", port: 5060 })
      expect(b.localAddress).toEqual({ ip: "10.0.0.2", port: 5060 })
    }).pipe(Effect.provide(simulatedLayer))
  )
})

describe("SignalingNetwork.simulated — send/receive", () => {
  it.effect("delivers packet to bound peer after transit delay", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const sender = yield* net.bindUdp({ ip: "10.0.0.1", port: 5060, queueMax: 16 })
      const receiver = yield* net.bindUdp({ ip: "10.0.0.2", port: 5060, queueMax: 16 })

      yield* sender.send(Buffer.from("hello"), 5060, "10.0.0.2")

      // Advance virtual clock past the transit delay; the forked delivery
      // fiber wakes up and offers to the receiver's ingress queue.
      yield* TestClock.adjust(`${TRANSIT} millis`)

      const received = yield* pullOne(receiver)
      expect(received.length).toBe(1)
      const pkt = received[0]!
      expect(pkt.raw.toString()).toBe("hello")
      expect(pkt.rinfo).toEqual({ address: "10.0.0.1", port: 5060 })
      expect(receiver.counters.enqueued).toBe(1)
    }).pipe(Effect.provide(simulatedLayer))
  )

  it.effect("stamps arrivalMs at ingress time (virtual clock under TestClock)", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const sender = yield* net.bindUdp({ ip: "10.0.0.1", port: 5060, queueMax: 16 })
      const receiver = yield* net.bindUdp({ ip: "10.0.0.2", port: 5060, queueMax: 16 })

      // Bump virtual time to a nonzero baseline so the stamp is
      // distinguishable from the TestClock origin.
      yield* TestClock.adjust("1000 millis")

      yield* sender.send(Buffer.from("stamped"), 5060, "10.0.0.2")
      yield* TestClock.adjust(`${TRANSIT} millis`)

      const polled = yield* receiver.poll()
      expect(polled).not.toBeNull()
      // arrivalMs == base (1000ms) + transit (15ms). Stamped inside the
      // simulated fabric, not at dequeue time.
      expect(polled!.arrivalMs).toBe(1000 + TRANSIT)
    }).pipe(Effect.provide(simulatedLayer))
  )

  it.effect("poll returns null when queue is empty", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const ep = yield* net.bindUdp({ ip: "10.0.0.1", port: 5060, queueMax: 16 })
      const polled = yield* ep.poll()
      expect(polled).toBeNull()
    }).pipe(Effect.provide(simulatedLayer))
  )

  it.effect("send to unbound destination records undeliverable (no error)", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const sender = yield* net.bindUdp({ ip: "10.0.0.1", port: 5060, queueMax: 16 })

      // No endpoint bound at 10.0.0.99:5060
      yield* sender.send(Buffer.from("void"), 5060, "10.0.0.99")
      yield* TestClock.adjust(`${TRANSIT} millis`)

      const drained = yield* net.drainUndeliverable()
      expect(drained.length).toBe(1)
      expect(drained[0]!.src).toEqual({ ip: "10.0.0.1", port: 5060 })
      expect(drained[0]!.dst).toEqual({ ip: "10.0.0.99", port: 5060 })
      expect(drained[0]!.raw.toString()).toBe("void")

      // drain clears the buffer
      const secondDrain = yield* net.drainUndeliverable()
      expect(secondDrain.length).toBe(0)
    }).pipe(Effect.provide(simulatedLayer))
  )
})

describe("SignalingNetwork.simulated — preIngress hook", () => {
  it.effect("accept path enqueues and increments `enqueued` counter", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const sender = yield* net.bindUdp({ ip: "10.0.0.1", port: 5060, queueMax: 16 })
      const receiver = yield* net.bindUdp({
        ip: "10.0.0.2",
        port: 5060,
        queueMax: 16,
        preIngress: () => PreIngressAction.accept(),
      })

      yield* sender.send(Buffer.from("a"), 5060, "10.0.0.2")
      yield* TestClock.adjust(`${TRANSIT} millis`)

      const received = yield* pullOne(receiver)
      expect(received.length).toBe(1)
      expect(receiver.counters.enqueued).toBe(1)
      expect(receiver.counters.preIngressDropped).toBe(0)
      expect(receiver.counters.preIngressReplies).toBe(0)
    }).pipe(Effect.provide(simulatedLayer))
  )

  it.effect("drop path skips enqueue and increments `preIngressDropped`", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const sender = yield* net.bindUdp({ ip: "10.0.0.1", port: 5060, queueMax: 16 })
      const receiver = yield* net.bindUdp({
        ip: "10.0.0.2",
        port: 5060,
        queueMax: 16,
        preIngress: () => PreIngressAction.drop(),
      })

      yield* sender.send(Buffer.from("drop-me"), 5060, "10.0.0.2")
      yield* TestClock.adjust(`${TRANSIT} millis`)

      expect(receiver.counters.preIngressDropped).toBe(1)
      expect(receiver.counters.enqueued).toBe(0)
      expect(receiver.queueDepth()).toBe(0)
    }).pipe(Effect.provide(simulatedLayer))
  )

  it.effect("reply path round-trips a buffer back to source after transit delay", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const sender = yield* net.bindUdp({ ip: "10.0.0.1", port: 5060, queueMax: 16 })
      const receiver = yield* net.bindUdp({
        ip: "10.0.0.2",
        port: 5060,
        queueMax: 16,
        preIngress: () => PreIngressAction.reply({ buf: Buffer.from("pong") }),
      })

      yield* sender.send(Buffer.from("ping"), 5060, "10.0.0.2")

      // First transit: ping reaches the receiver, preIngress fires, forks
      // a reply back to sender. Receiver never enqueues the ping.
      yield* TestClock.adjust(`${TRANSIT} millis`)
      expect(receiver.counters.preIngressReplies).toBe(1)
      expect(receiver.counters.enqueued).toBe(0)

      // Second transit: reply arrives at sender.
      yield* TestClock.adjust(`${TRANSIT} millis`)

      const received = yield* pullOne(sender)
      expect(received.length).toBe(1)
      const pkt = received[0]!
      expect(pkt.raw.toString()).toBe("pong")
      expect(pkt.rinfo).toEqual({ address: "10.0.0.2", port: 5060 })
    }).pipe(Effect.provide(simulatedLayer))
  )
})

// ---------------------------------------------------------------------------
// Real layer
// ---------------------------------------------------------------------------

describe("SignalingNetwork.real — bind error surfacing", () => {
  it.live("bind on a port held by another socket fails with BindError{os_error}", () =>
    Effect.gen(function* () {
      // Grab a port with a real UDP socket so we know it's taken.
      const blocker = yield* Effect.acquireRelease(
        Effect.callback<dgram.Socket>((resume) => {
          const s = dgram.createSocket("udp4")
          s.once("listening", () => resume(Effect.succeed(s)))
          s.once("error", (err) => resume(Effect.die(err)))
          s.bind(0, "127.0.0.1")
        }),
        (s) => Effect.callback<void>((resume) => s.close(() => resume(Effect.void)))
      )
      const takenPort = blocker.address().port

      const net = yield* SignalingNetwork
      const attempt = yield* Effect.result(
        net.bindUdp({ ip: "127.0.0.1", port: takenPort, queueMax: 16 })
      )

      expect(attempt._tag).toBe("Failure")
      if (attempt._tag === "Failure") {
        const failure = attempt.failure
        expect(failure).toBeInstanceOf(BindError)
        expect((failure as BindError).reason).toBe("os_error")
        expect((failure as BindError).port).toBe(takenPort)
      }
    }).pipe(Effect.provide(SignalingNetwork.real))
  )
})

describe("SignalingNetwork.real vs realTracing — drainTrace partition", () => {
  // Regression: production layer MUST NOT accumulate NetworkTraceEntry on
  // every send/recv, otherwise every SIP frame's Buffer is retained for
  // process lifetime (root cause of an arrayBuffers leak). The two
  // layers are wire-equivalent; only `drainTrace()` differs.

  it.live("real: drainTrace returns empty even after a send", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const ep = yield* net.bindUdp({ ip: "127.0.0.1", port: 0, queueMax: 16 })
      yield* ep.send(Buffer.from("ping"), ep.localAddress.port, "127.0.0.1")
      const drained = yield* net.drainTrace()
      expect(drained.length).toBe(0)
    }).pipe(Effect.provide(SignalingNetwork.real))
  )

  it.live("realTracing: drainTrace returns the send entry", () =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      const ep = yield* net.bindUdp({ ip: "127.0.0.1", port: 0, queueMax: 16 })
      yield* ep.send(Buffer.from("ping"), ep.localAddress.port, "127.0.0.1")
      // Pull the recv side too so we exercise both push paths.
      yield* pullOne(ep)
      const drained = yield* net.drainTrace()
      expect(drained.length).toBeGreaterThanOrEqual(1)
      // Second drain returns [] (clear-on-read).
      const second = yield* net.drainTrace()
      expect(second.length).toBe(0)
    }).pipe(Effect.provide(SignalingNetwork.realTracing))
  )
})
