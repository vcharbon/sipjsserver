/**
 * Transit-only PR2 — response routing by Via stack (RFC 3261 §16.7.3).
 *
 * The proxy receives a 200 OK that has its own Via on top (just like one
 * the proxy itself stamped on the way out) and Alice's Via second. The
 * proxy must (a) verify the top Via is "us" by sent-by host:port match,
 * (b) pop it, (c) forward to Alice using the next Via's `received` /
 * `rport` / `sent-by`.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import { ProxyCore } from "../../../src/sip-front-proxy/index.js"
import {
  bindUdpEndpoint,
  proxyOnlyFakeStackLayer,
} from "../../support/proxy-only-fakeStack.js"

const PROXY = { host: "10.0.0.1", port: 5060 }
const ALICE = { host: "10.0.0.2", port: 5060 }
const BOB = { host: "10.0.0.3", port: 5060 }
const TRANSIT_MS = 5

const layer = proxyOnlyFakeStackLayer({
  proxyAddr: PROXY,
  forwardTarget: BOB,
  transitDelayMs: TRANSIT_MS,
})

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

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

describe("sip-front-proxy/transit-only — response routing by Via", () => {
  it.effect("200 OK with our Via on top is forwarded to the next-Via address", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyCore
      const alice = yield* bindUdpEndpoint(ALICE)
      const bob = yield* bindUdpEndpoint(BOB)

      // Synthesize a 200 OK as Bob would send it: top Via is the proxy
      // (would be popped), second Via is Alice. We construct it directly
      // (no preceding INVITE round-trip needed for this assertion).
      const okBuf = Buffer.from(
        [
          `SIP/2.0 200 OK`,
          `Via: SIP/2.0/UDP ${PROXY.host}:${PROXY.port};branch=z9hG4bK-proxy-fake;rport=${PROXY.port};received=${PROXY.host}`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-x;rport=${ALICE.port};received=${ALICE.host}`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>;tag=bob-tag`,
          `Call-ID: respresp@alice`,
          `CSeq: 1 INVITE`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* bob.send(okBuf, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()

      const atAlice = yield* alice.poll()
      expect(atAlice).not.toBeNull()
      const parsed = parse(atAlice!.raw)
      if (parsed.type !== "response") throw new Error("expected response")
      expect(parsed.status).toBe(200)
      expect(parsed.parsed.vias.length).toBe(1)
      expect(parsed.parsed.vias[0]!.host).toBe(ALICE.host)
    }).pipe(Effect.provide(layer))
  )

  it.effect("response with foreign top Via (not us) is dropped", () =>
    Effect.gen(function* () {
      const proxy = yield* ProxyCore
      const alice = yield* bindUdpEndpoint(ALICE)
      const bob = yield* bindUdpEndpoint(BOB)

      const okBuf = Buffer.from(
        [
          `SIP/2.0 200 OK`,
          `Via: SIP/2.0/UDP 99.99.99.99:5060;branch=z9hG4bK-foreign;rport`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-x;rport`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>;tag=bob-tag`,
          `Call-ID: foreign@alice`,
          `CSeq: 1 INVITE`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* bob.send(okBuf, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()

      // Alice gets nothing — proxy refused to relay.
      expect(yield* alice.poll()).toBeNull()
    }).pipe(Effect.provide(layer))
  )
})
