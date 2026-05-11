/**
 * Transit-only PR2 — re-INVITE with a Route header pointing at the proxy.
 *
 * RFC 3261 §16.4 Route preprocessing: if the topmost Route URI's
 * `host:port` equals the proxy's, the proxy strips that Route header
 * before forwarding. The Route's URI params are handed to the
 * `RoutingStrategy.decodeStickiness` hook so the proxy can recover
 * which downstream the dialog originally went to.
 *
 * This test sends a re-INVITE with `Route: <sip:proxy;target=bob:5060;lr>`.
 * We assert: (a) the Route header is gone in the message Bob receives,
 * (b) the request still reaches Bob (because `decodeStickiness` parsed
 * the `target` cookie back into Bob's address), (c) the proxy's Via and
 * a fresh Record-Route ride along.
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
// A different "target" host — used to prove decodeStickiness actually
// drives where the request goes (vs. always-Bob fallback).
const BOB_ALT = { host: "10.0.0.3", port: 5060 } // same Bob — ForwardAll only knows one
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

describe("sip-front-proxy/transit-only — in-dialog re-INVITE Route stripping", () => {
  it.effect("re-INVITE with Route pointing at proxy: Route stripped, forwarded to decoded target", () =>
    runProxyScenario(
      {
        name: "transit-only.reinvite-in-dialog",
        description:
          "Mid-dialog re-INVITE from Alice carrying Route: <proxy;target=bob;lr>;\n" +
          "asserts Route stripping (§16.4), Via push, fresh Record-Route insertion,\n" +
          "and that decodeStickiness drives the request to Bob.",
      },
      Effect.gen(function* () {
      const proxy = yield* ProxyCore
      const alice = yield* bindNamedEndpoint("alice", ALICE)
      const bob = yield* bindNamedEndpoint("bob", BOB)

      // Simulated mid-dialog re-INVITE. The dialog's existing route set
      // (built from the proxy's earlier Record-Route on the original
      // INVITE) is materialized here as a single Route header.
      const reInvite = Buffer.from(
        [
          `INVITE sip:bob@${BOB_ALT.host}:${BOB_ALT.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-reinv;rport`,
          `Route: <sip:${PROXY.host}:${PROXY.port};target=${BOB_ALT.host}:${BOB_ALT.port};lr>`,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>;tag=bob-tag`,
          `Call-ID: reinv-call@alice`,
          `CSeq: 5 INVITE`,
          `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
          `Content-Type: application/sdp`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(reInvite, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()

      const atBob = yield* bob.poll()
      expect(atBob).not.toBeNull()
      const parsed = parse(atBob!.raw)
      if (parsed.type !== "request") throw new Error("expected request")
      expect(parsed.method).toBe("INVITE")

      // §16.4 — Route header pointing at us is gone.
      expect(parsed.headers.find((h) => h.name.toLowerCase() === "route")).toBeUndefined()

      // Proxy's Via still on top.
      expect(parsed.getHeader("via")[0]!.host).toBe(PROXY.host)
      expect(parsed.getHeader("via")[1]!.branch).toBe("z9hG4bK-alice-reinv")

      // re-INVITE is still dialog-creating per §16.6.5 list, so the proxy
      // inserts another Record-Route. Verify the cookie carries the
      // ForwardAll-encoded target.
      const rrHeader = parsed.headers.find((h) => h.name.toLowerCase() === "record-route")
      expect(rrHeader).toBeDefined()
      expect(rrHeader!.value).toContain(`target=${BOB.host}:${BOB.port}`)
      })
    ).pipe(Effect.provide(layer))
  )
})
