/**
 * Transit-only PR2 — defensive validation per RFC 3261 §16.3.
 *
 *  1. Garbage UDP payload: parser fails, proxy drops silently. No reply,
 *     no crash.
 *  2. Max-Forwards: 0 INVITE: proxy synthesizes 483 Too Many Hops back to
 *     the source.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import { ProxyCore } from "../../../src/sip-front-proxy/index.js"
import { proxyOnlyFakeStackLayer } from "../../support/proxy-only-fakeStack.js"
import { bindNamedEndpoint, runProxyScenario } from "../_report/runner.js"

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

describe("sip-front-proxy/transit-only — malformed-message handling", () => {
  it.effect("garbage payload is dropped silently — no reply, no crash", () =>
    runProxyScenario(
      {
        name: "transit-only.malformed-message-rejected.garbage-payload-dropped",
        description:
          "Alice sends an unparseable UDP payload to the proxy; the parser fails\n" +
          "and the proxy drops silently per RFC 3261 §16.3 — no reply, no crash.",
      },
      Effect.gen(function* () {
      const proxy = yield* ProxyCore
      const alice = yield* bindNamedEndpoint("alice", ALICE)
      const bob = yield* bindNamedEndpoint("bob", BOB)

      yield* alice.send(
        Buffer.from("THIS IS NOT A SIP MESSAGE\r\n\r\n"),
        proxy.localAddress.port,
        proxy.localAddress.ip
      )
      yield* pump()

      // Neither side observed anything.
      expect(yield* alice.poll()).toBeNull()
      expect(yield* bob.poll()).toBeNull()
      })
    ).pipe(Effect.provide(layer))
  )

  it.effect("INVITE with Max-Forwards: 0 is rejected with 483 to the source", () =>
    runProxyScenario(
      {
        name: "transit-only.malformed-message-rejected.max-forwards-zero-rejected",
        description:
          "Alice sends an INVITE with Max-Forwards: 0; the proxy synthesizes a\n" +
          "483 Too Many Hops response back to the source per RFC 3261 §16.3.",
      },
      Effect.gen(function* () {
      const proxy = yield* ProxyCore
      const alice = yield* bindNamedEndpoint("alice", ALICE)
      const bob = yield* bindNamedEndpoint("bob", BOB)

      const invite = Buffer.from(
        [
          `INVITE sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-mf;rport`,
          `Max-Forwards: 0`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>`,
          `Call-ID: mf-call@alice`,
          `CSeq: 1 INVITE`,
          `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(invite, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()

      // Bob never sees it.
      expect(yield* bob.poll()).toBeNull()

      // Alice sees a 483 back from the proxy.
      const replyAtAlice = yield* alice.poll()
      expect(replyAtAlice).not.toBeNull()
      const reply = parse(replyAtAlice!.raw)
      if (reply.type !== "response") throw new Error("expected response")
      expect(reply.status).toBe(483)
      // Source got back her own Via.
      expect(reply.parsed.vias[0]!.host).toBe(ALICE.host)
      })
    ).pipe(Effect.provide(layer))
  )
})
