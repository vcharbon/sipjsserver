/**
 * TransactionLayer absorption of `100 Trying`.
 *
 * RFC 3261 §17 / §8.1.3.4: 100 Trying is a hop-by-hop progress indicator only —
 * it MUST NOT be forwarded by an upstream UAC. The TransactionLayer drops it
 * after updating any matching client transaction's retransmit/state machine.
 *
 * Behavioral test: a peer endpoint sends a `100 Trying` (and then a `180
 * Ringing` so we have a positive control event to wait on) into the
 * TransactionLayer's bound port; only the 180 should appear on the
 * `events` stream. Verified for INVITE, BYE and OPTIONS CSeq methods to
 * pin the unconditional behavior.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { SignalingNetwork, type UdpEndpoint } from "../../src/sip/SignalingNetwork.js"
import { UdpTransport } from "../../src/sip/UdpTransport.js"
import { TransactionLayer } from "../../src/sip/TransactionLayer.js"
import { OverloadController } from "../../src/b2bua/OverloadController.js"
import { SipParser } from "../../src/sip/Parser.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

const TRANSIT_MS = 5
const B2BUA_IP = "127.0.0.1"
const B2BUA_PORT = 5070
const PEER_IP = "10.0.0.1"
const PEER_PORT = 5555

function testConfig(): AppConfigData {
  return testAppConfigDefaults({
    sipLocalIp: B2BUA_IP,
    sipLocalPort: B2BUA_PORT,
    redisKeyPrefix: "test",
    cdrFilePath: "/tmp/cdr.jsonl",
    httpStatusPort: 3002,
    callControlUrl: "http://localhost:3002",
  })
}

const stackLayer = (() => {
  const Network = SignalingNetwork.simulated({ transitDelayMs: TRANSIT_MS })
  const AppCfg = Layer.succeed(AppConfig, testConfig())
  const Leaves = Layer.mergeAll(Network, MetricsRegistry.layer, SipParser.layer)
    .pipe(Layer.provideMerge(AppCfg))
  const Mid = Layer.mergeAll(UdpTransport.layer, OverloadController.layer)
    .pipe(Layer.provideMerge(Leaves))
  const Top = TransactionLayer.layer.pipe(Layer.provideMerge(Mid))
  return Top
})()

const bindPeer = Effect.gen(function* () {
  const network = yield* SignalingNetwork
  return yield* network.bindUdp({ ip: PEER_IP, port: PEER_PORT, queueMax: 16 })
})

function response(status: number, reason: string, cseqMethod: string, branch: string, callId: string, withToTag: boolean): Buffer {
  const lines = [
    `SIP/2.0 ${status} ${reason}`,
    `Via: SIP/2.0/UDP ${PEER_IP}:${PEER_PORT};branch=${branch}`,
    `From: <sip:b2bua@${B2BUA_IP}:${B2BUA_PORT}>;tag=b2bua-tag`,
    withToTag
      ? `To: <sip:peer@${PEER_IP}:${PEER_PORT}>;tag=peer-tag`
      : `To: <sip:peer@${PEER_IP}:${PEER_PORT}>`,
    `Call-ID: ${callId}`,
    `CSeq: 1 ${cseqMethod}`,
    `Content-Length: 0`,
    "",
    "",
  ]
  return Buffer.from(lines.join("\r\n"), "ascii")
}

const send = (ep: UdpEndpoint, buf: Buffer) =>
  ep.send(buf, B2BUA_PORT, B2BUA_IP)

describe("TransactionLayer — absorbs 100 Trying", () => {
  for (const method of ["INVITE", "BYE", "OPTIONS"] as const) {
    it.effect(`100 Trying for CSeq ${method} is dropped; the next ${method} 180 (with To-tag) is delivered`, () =>
      Effect.gen(function* () {
        const txn = yield* TransactionLayer
        const peer = yield* bindPeer

        // Subscribe BEFORE sending so we don't race the stream.
        const collectFiber = yield* Effect.forkChild(
          txn.events.pipe(Stream.take(1), Stream.runCollect)
        )

        const callId = `absorb-${method}@${PEER_IP}`
        // 100 Trying — should be silently absorbed.
        yield* send(peer, response(100, "Trying", method, `z9hG4bK-100-${method}`, callId, false))
        // 180 Ringing with To-tag — should be the FIRST event observed.
        yield* send(peer, response(180, "Ringing", method, `z9hG4bK-180-${method}`, callId, true))

        // Advance virtual clock past the transit delay so the simulated
        // delivery fibers wake up and feed both packets into the parser.
        yield* TestClock.adjust(`${TRANSIT_MS * 4} millis`)

        const collected = yield* Fiber.join(collectFiber)
        expect(collected.length).toBe(1)
        const first = collected[0]!
        expect(first.type).toBe("message")
        if (first.type !== "message") return
        expect(first.message.type).toBe("response")
        if (first.message.type !== "response") return
        expect(first.message.status).toBe(180)
        // The parser+absorption pair guarantees a non-empty To-tag here.
        expect(first.message.parsed.to.tag).toBe("peer-tag")
      }).pipe(Effect.provide(stackLayer)),
    )
  }
})
