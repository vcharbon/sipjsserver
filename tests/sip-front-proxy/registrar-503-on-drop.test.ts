/**
 * Issue 2 (T6) — when the registrar-mode forwarder's egress `sendOn`
 * returns `false` (NXDOMAIN / EAI_AGAIN / ICMP unreachable on the wire),
 * the proxy must synthesize a 503 Service Unavailable + Retry-After back
 * to the UAC so it stops T1/T2 retransmitting at the transaction layer,
 * mirroring the LB-mode parity fix already landed at
 * `handleRequestImpl`.
 *
 * The simulated `SignalingNetwork.sendFault` hook is the test-only path
 * for forcing `UdpEndpoint.send` to fail with `SendError`. Default-off,
 * production code never sees it.
 *
 * RFC anchors: 3261 §16.6.10 / §16.6 (stateful proxy "downstream
 * unreachable" → 503 + Retry-After).
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  CORE_DESTINATION,
  EXT_INGRESS,
  extIp,
  registrarFrontProxyFakeStackLayer,
} from "../support/registrarFrontProxyFakeStack.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { ProxyCore } from "../../src/sip-front-proxy/index.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

const aliceIp = extIp(1)
const ALICE_PORT = 16060

const buildInvite = (): Buffer => {
  const lines = [
    `INVITE sip:bob@${EXT_INGRESS.host}:${EXT_INGRESS.port} SIP/2.0`,
    `Via: SIP/2.0/UDP ${aliceIp}:${ALICE_PORT};branch=z9hG4bK-503-drop-test;rport`,
    `Max-Forwards: 70`,
    `From: <sip:alice@example.test>;tag=alice-tag-1`,
    `To: <sip:bob@example.test>`,
    `Call-ID: drop-test-1@alice.example.test`,
    `CSeq: 1 INVITE`,
    `Contact: <sip:alice@${aliceIp}:${ALICE_PORT}>`,
    `Content-Length: 0`,
    ``,
    ``,
  ]
  return Buffer.from(lines.join("\r\n"), "ascii")
}

describe("registrar-mode forwarder — 503 + Retry-After on dropped egress send", () => {
  it.effect("ext INVITE → core unreachable → proxy returns 503 to ingress with Retry-After", () =>
    Effect.gen(function* () {
      const network = yield* SignalingNetwork
      // Force the proxy's `ProxyCore` to build (binds ext/core ingresses,
      // starts the recv stream) before we send anything in.
      yield* ProxyCore

      // Bind Alice's ext-side endpoint and start a collector for any
      // packet the proxy sends back to her.
      const alice = yield* network.bindUdp({ ip: aliceIp, port: ALICE_PORT, queueMax: 64 })
      const received: Buffer[] = []
      const collector = yield* Effect.forkChild(
        alice.messages.pipe(
          Stream.tap((p) => Effect.sync(() => received.push(p.raw))),
          Stream.runDrain,
        ),
      )

      yield* alice.send(buildInvite(), EXT_INGRESS.port, EXT_INGRESS.host)

      // Pump simulated transit (forward + reverse). 100 ms is plenty for
      // a 15 ms-default delay fabric.
      for (let i = 0; i < 6; i++) {
        yield* TestClock.adjust("20 millis")
        yield* Effect.yieldNow
      }

      yield* Fiber.interrupt(collector)

      expect(received.length).toBeGreaterThanOrEqual(1)
      const texts = received.map((b) => b.toString("ascii"))
      const fiveOhThree = texts.find((t) => /^SIP\/2\.0 503 Service Unavailable/m.test(t))
      expect(fiveOhThree).toBeDefined()
      // RFC 3261 §16.6 — the proxy MUST signal `Retry-After` so the UAC
      // backs off; without it nothing throttles the next attempt.
      expect(/Retry-After:\s*\d+/i.test(fiveOhThree!)).toBe(true)
    }).pipe(
      Effect.provide(
        registrarFrontProxyFakeStackLayer({
          config: testAppConfigDefaults({
            sipLocalIp: EXT_INGRESS.host,
            sipLocalPort: EXT_INGRESS.port,
          }),
          // Fail any send whose destination is the configured
          // `coreDestination` — emulates EAI_AGAIN at the OS layer.
          sendFault: (_src, dst) =>
            dst.ip === CORE_DESTINATION.host && dst.port === CORE_DESTINATION.port
              ? "EAI_AGAIN (test injection)"
              : null,
        }),
      ),
    ),
  )
})
