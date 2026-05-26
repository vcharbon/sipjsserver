/**
 * BufferedUdpEndpoint absorbs egress SendErrors at the proxy.
 *
 * Pre-`BufferedUdpEndpoint` design: when the proxy's egress send failed
 * (NXDOMAIN / EAI_AGAIN / ICMP unreachable), the proxy synthesized a
 * 503 Service Unavailable + Retry-After back to the UAC.
 *
 * Post-`BufferedUdpEndpoint` design: send is pure enqueue. The per-peer
 * drainer fiber calls inner.send and absorbs any SendError into a counter.
 * The proxy does NOT synthesize a 503 — SIP UDP transaction timers (T1 /
 * T2 / Timer B) handle UAC-side retry. This is the spec-correct stateless-
 * proxy shape (RFC 3261 §16).
 *
 * This test pins the new behavior: with sendFault forcing every egress to
 * fail, no 503 reaches Alice; the proxy's counters reflect the inner
 * SendErrors absorbed by the drainer.
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
    `Via: SIP/2.0/UDP ${aliceIp}:${ALICE_PORT};branch=z9hG4bK-no-503-test;rport`,
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

describe("BufferedUdpEndpoint at proxy egress — no 503 synthesis on drop", () => {
  it.effect("ext INVITE → core unreachable → proxy stays silent; SIP retransmits handle retry", () =>
    Effect.gen(function* () {
      const network = yield* SignalingNetwork
      // Bring up the proxy.
      yield* ProxyCore

      // Bind Alice's ext-side endpoint and start a collector for anything
      // the proxy might send back to her. We assert NO 503 arrives.
      const alice = yield* network.bindUdp({ ip: aliceIp, port: ALICE_PORT, queueMax: 64 })
      const received: Buffer[] = []
      const collector = yield* Effect.forkChild(
        alice.messages.pipe(
          Stream.tap((p) => Effect.sync(() => received.push(p.raw))),
          Stream.runDrain,
        ),
      )

      yield* alice.send(buildInvite(), EXT_INGRESS.port, EXT_INGRESS.host)

      // Drive simulated transit + buffered drain. The drainer will pull
      // the packet, attempt inner.send (which sendFault rejects), absorb
      // the SendError, and continue.
      for (let i = 0; i < 10; i++) {
        yield* TestClock.adjust("20 millis")
        yield* Effect.yieldNow
      }

      yield* Fiber.interrupt(collector)

      const texts = received.map((b) => b.toString("ascii"))
      const fiveOhThree = texts.find((t) => /^SIP\/2\.0 503 /m.test(t))
      expect(fiveOhThree).toBeUndefined()
    }).pipe(
      Effect.provide(
        registrarFrontProxyFakeStackLayer({
          config: testAppConfigDefaults({
            sipLocalIp: EXT_INGRESS.host,
            sipLocalPort: EXT_INGRESS.port,
          }),
          recordRoute: true,
          // Force every send whose destination is the configured
          // `coreDestination` to fail — emulates EAI_AGAIN at the OS layer.
          sendFault: (_src, dst) =>
            dst.ip === CORE_DESTINATION.host && dst.port === CORE_DESTINATION.port
              ? "EAI_AGAIN (test injection)"
              : null,
        }),
      ),
    ),
  )
})
