/**
 * Smoke test for the proxy's parallel ingress (`Stream.mapEffect` with
 * `concurrency > 1`).
 *
 * Spawns 4 concurrent INVITEs on distinct Call-IDs and verifies all get
 * forwarded to the backend through a proxy bound with
 * `ingressConcurrency: 4`. The detailed timing-based HOL-blocking test is
 * harder under TestClock (would need to inject latency mid-processPacket);
 * this smoke confirms the wiring + behavior at the right concurrency
 * setting.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { ProxyCore } from "../../src/sip-front-proxy/index.js"
import { proxyOnlyFakeStackLayer } from "../support/proxy-only-fakeStack.js"

const PROXY_ADDR = { host: "10.0.0.1", port: 5060 }
const ALICE_ADDR = { host: "10.0.0.2", port: 5060 }
const BACKEND_ADDR = { host: "10.0.0.3", port: 5060 }

const buildInvite = (callId: string): Buffer => {
  const lines = [
    `INVITE sip:bob@${PROXY_ADDR.host}:${PROXY_ADDR.port} SIP/2.0`,
    `Via: SIP/2.0/UDP ${ALICE_ADDR.host}:${ALICE_ADDR.port};branch=z9hG4bK-${callId};rport`,
    `Max-Forwards: 70`,
    `From: <sip:alice@example.test>;tag=alice-${callId}`,
    `To: <sip:bob@example.test>`,
    `Call-ID: ${callId}@alice.test`,
    `CSeq: 1 INVITE`,
    `Contact: <sip:alice@${ALICE_ADDR.host}:${ALICE_ADDR.port}>`,
    `Content-Length: 0`,
    ``,
    ``,
  ]
  return Buffer.from(lines.join("\r\n"), "ascii")
}

describe("proxy ingress — parallel mapEffect smoke", () => {
  it.effect("ingressConcurrency=4 still forwards every INVITE on distinct Call-IDs", () =>
    Effect.gen(function* () {
      const network = yield* SignalingNetwork
      yield* ProxyCore

      const alice = yield* network.bindUdp({ ip: ALICE_ADDR.host, port: ALICE_ADDR.port, queueMax: 64 })
      const backend = yield* network.bindUdp({ ip: BACKEND_ADDR.host, port: BACKEND_ADDR.port, queueMax: 64 })

      const received: Buffer[] = []
      const collector = yield* Effect.forkChild(
        backend.messages.pipe(
          Stream.tap((p) => Effect.sync(() => received.push(p.raw))),
          Stream.runDrain,
        ),
      )

      // Burst 4 INVITEs back-to-back. With sequential ingress they
      // process strictly one-at-a-time; with concurrency=4 they
      // interleave at scheduler boundaries. Either way, all 4 must
      // reach the backend.
      for (let i = 0; i < 4; i++) {
        yield* alice.send(buildInvite(`call-${i}`), PROXY_ADDR.port, PROXY_ADDR.host)
      }

      // Pump transit. 50ms is plenty for the 5ms-default delay fabric.
      for (let i = 0; i < 6; i++) {
        yield* TestClock.adjust("10 millis")
        yield* Effect.yieldNow
      }

      yield* Fiber.interrupt(collector)

      // All four arrive at the backend. Order across Call-IDs is not
      // guaranteed under parallel ingress — only the count matters.
      const callIds = new Set(
        received
          .map((b) => b.toString("ascii").match(/Call-ID:\s*(\S+)/)?.[1])
          .filter((id) => id !== undefined),
      )
      expect(callIds.size).toBe(4)
    }).pipe(
      Effect.provide(
        proxyOnlyFakeStackLayer({
          proxyAddr: PROXY_ADDR,
          forwardTarget: BACKEND_ADDR,
          ingressConcurrency: 4,
        }),
      ),
    ),
  )
})
