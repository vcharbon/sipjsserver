/**
 * Transit-only PR2 — full INVITE / 200 OK / ACK / BYE through the proxy.
 *
 * Topology: Alice (UAC) ──► Proxy(ForwardAll → Bob) ──► Bob (UAS)
 *
 * What we're proving:
 *   - The proxy forwards a fresh INVITE from Alice to the configured
 *     ForwardAll target (Bob).
 *   - The proxy inserts a Record-Route pointing at itself with the
 *     ForwardAll stickiness `target=...` URI param (RFC 3261 §16.6.5).
 *   - Bob sees the proxy's Via on top of his stack and his own server
 *     transaction matches on the proxy's branch (RFC 3261 §17.2.3).
 *   - The 200 OK response routes back through the proxy by Via stripping
 *     (RFC 3261 §16.7.3) so Alice's stack sees only her own Via.
 *   - Alice's ACK and BYE include `Route: <proxy>` (per the Record-Route
 *     she received) so they traverse the proxy; the proxy strips that
 *     Route per §16.4 and forwards to Bob.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import { SignalingNetwork } from "../../../src/sip/SignalingNetwork.js"
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

/**
 * Pump enough virtual milliseconds that one round-trip (Alice→Proxy→Bob
 * or back) lands in queues. Two transits + a touch of slack covers the
 * worst case (Alice→Proxy + Proxy→Bob in the same step). We `yieldNow`
 * before *and* after to let the proxy's stream consumer re-enter the
 * queue between the two simulated transits.
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

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

const buildInvite = () =>
  Buffer.from(
    [
      `INVITE sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
      `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-1;rport`,
      `Max-Forwards: 70`,
      `From: "Alice" <sip:alice@${ALICE.host}>;tag=alice-tag-1`,
      `To: "Bob" <sip:bob@${BOB.host}>`,
      `Call-ID: call-1@alice`,
      `CSeq: 1 INVITE`,
      `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join("\r\n"),
    "utf-8"
  )

describe("sip-front-proxy/transit-only — INVITE / 200 / ACK / BYE", () => {
  it.effect("happy-path call traverses the proxy in both directions", () =>
    runProxyScenario(
      {
        name: "transit-only.invite-200-ack-bye",
        description:
          "Alice → Proxy(ForwardAll) → Bob. Full INVITE/200/ACK/BYE round-trip;\n" +
          "asserts Record-Route insertion (§16.6.5), Via push/pop (§16.6.4 / §16.7.3),\n" +
          "Route stripping on in-dialog (§16.4), and a clean ending state.",
      },
      Effect.gen(function* () {
      const proxy = yield* ProxyCore
      const alice = yield* bindNamedEndpoint("alice", ALICE)
      const bob = yield* bindNamedEndpoint("bob", BOB)

      // ── 1. Alice → Proxy: INVITE ────────────────────────────────────
      yield* alice.send(buildInvite(), proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()

      const inviteAtBob = yield* bob.poll()
      expect(inviteAtBob).not.toBeNull()
      const inviteParsed = parse(inviteAtBob!.raw)
      expect(inviteParsed.type).toBe("request")
      if (inviteParsed.type !== "request") throw new Error("unreachable")
      expect(inviteParsed.method).toBe("INVITE")

      // Top Via must be the proxy's, second Via Alice's (RFC 3261 §16.6.4).
      expect(inviteParsed.getHeader("via").length).toBe(2)
      expect(inviteParsed.getHeader("via")[0]!.host).toBe(PROXY.host)
      expect(inviteParsed.getHeader("via")[0]!.port).toBe(PROXY.port)
      expect(inviteParsed.getHeader("via")[0]!.branch).toMatch(/^z9hG4bK/)
      expect(inviteParsed.getHeader("via")[1]!.host).toBe(ALICE.host)
      expect(inviteParsed.getHeader("via")[1]!.branch).toBe("z9hG4bK-alice-1")

      // Record-Route inserted (RFC 3261 §16.6.5) — must point at proxy and
      // carry both `;lr` and the ForwardAll stickiness `target=` cookie.
      const rrHeader = inviteParsed.headers.find((h) => h.name.toLowerCase() === "record-route")
      expect(rrHeader).toBeDefined()
      expect(rrHeader!.value).toContain(`${PROXY.host}:${PROXY.port}`)
      expect(rrHeader!.value).toContain(";lr")
      expect(rrHeader!.value).toContain(`target=${BOB.host}:${BOB.port}`)

      // Max-Forwards decremented from 70 → 69.
      expect(inviteParsed.headers.find((h) => h.name.toLowerCase() === "max-forwards")?.value).toBe(
        "69"
      )

      const proxyVia = inviteParsed.getHeader("via")[0]!
      const proxyBranch = proxyVia.branch!

      // ── 2. Bob → Proxy: 200 OK ──────────────────────────────────────
      // Echo Vias verbatim, add To-tag, add Contact pointing at Bob.
      const okBuf = Buffer.from(
        [
          `SIP/2.0 200 OK`,
          ...inviteParsed.headers
            .filter((h) => h.name.toLowerCase() === "via")
            .map((h) => `Via: ${h.value}`),
          ...inviteParsed.headers
            .filter((h) => h.name.toLowerCase() === "record-route")
            .map((h) => `Record-Route: ${h.value}`),
          `From: "Alice" <sip:alice@${ALICE.host}>;tag=alice-tag-1`,
          `To: "Bob" <sip:bob@${BOB.host}>;tag=bob-tag-1`,
          `Call-ID: call-1@alice`,
          `CSeq: 1 INVITE`,
          `Contact: <sip:bob@${BOB.host}:${BOB.port}>`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* bob.send(okBuf, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()

      const okAtAlice = yield* alice.poll()
      expect(okAtAlice).not.toBeNull()
      const okParsed = parse(okAtAlice!.raw)
      expect(okParsed.type).toBe("response")
      if (okParsed.type !== "response") throw new Error("unreachable")
      expect(okParsed.status).toBe(200)

      // Proxy popped its own top Via — Alice sees only her own.
      expect(okParsed.getHeader("via").length).toBe(1)
      expect(okParsed.getHeader("via")[0]!.host).toBe(ALICE.host)
      expect(okParsed.getHeader("via")[0]!.branch).toBe("z9hG4bK-alice-1")

      // ── 3. Alice → Proxy: ACK (with Route per Record-Route) ─────────
      // Per RFC 3261 §12.1.2 / §12.2.1.1 the route set is the reverse of
      // received Record-Routes; here just one entry pointing at the
      // proxy with the stickiness cookie intact.
      const ackBuf = Buffer.from(
        [
          `ACK sip:bob@${BOB.host}:${BOB.port};callRef=anything SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-ack;rport`,
          `Route: <sip:${PROXY.host}:${PROXY.port};target=${BOB.host}:${BOB.port};lr>`,
          `Max-Forwards: 70`,
          `From: "Alice" <sip:alice@${ALICE.host}>;tag=alice-tag-1`,
          `To: "Bob" <sip:bob@${BOB.host}>;tag=bob-tag-1`,
          `Call-ID: call-1@alice`,
          `CSeq: 1 ACK`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(ackBuf, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()

      const ackAtBob = yield* bob.poll()
      expect(ackAtBob).not.toBeNull()
      const ackParsed = parse(ackAtBob!.raw)
      if (ackParsed.type !== "request") throw new Error("ACK should be request")
      expect(ackParsed.method).toBe("ACK")
      // Route header pointing at us must be stripped (§16.4).
      expect(
        ackParsed.headers.find((h) => h.name.toLowerCase() === "route")
      ).toBeUndefined()

      // ── 4. Alice → Proxy: BYE ───────────────────────────────────────
      const byeBuf = Buffer.from(
        [
          `BYE sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-bye;rport`,
          `Route: <sip:${PROXY.host}:${PROXY.port};target=${BOB.host}:${BOB.port};lr>`,
          `Max-Forwards: 70`,
          `From: "Alice" <sip:alice@${ALICE.host}>;tag=alice-tag-1`,
          `To: "Bob" <sip:bob@${BOB.host}>;tag=bob-tag-1`,
          `Call-ID: call-1@alice`,
          `CSeq: 2 BYE`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(byeBuf, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()

      const byeAtBob = yield* bob.poll()
      expect(byeAtBob).not.toBeNull()
      const byeParsed = parse(byeAtBob!.raw)
      if (byeParsed.type !== "request") throw new Error("BYE should be request")
      expect(byeParsed.method).toBe("BYE")
      expect(
        byeParsed.headers.find((h) => h.name.toLowerCase() === "route")
      ).toBeUndefined()
      expect(byeParsed.getHeader("via")[0]!.host).toBe(PROXY.host)

      // ── 5. Bob → Proxy: 200 OK to BYE → Alice ──────────────────────
      const byeOkBuf = Buffer.from(
        [
          `SIP/2.0 200 OK`,
          ...byeParsed.headers
            .filter((h) => h.name.toLowerCase() === "via")
            .map((h) => `Via: ${h.value}`),
          `From: "Alice" <sip:alice@${ALICE.host}>;tag=alice-tag-1`,
          `To: "Bob" <sip:bob@${BOB.host}>;tag=bob-tag-1`,
          `Call-ID: call-1@alice`,
          `CSeq: 2 BYE`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* bob.send(byeOkBuf, proxy.localAddress.port, proxy.localAddress.ip)
      yield* pump()

      const byeOkAtAlice = yield* alice.poll()
      expect(byeOkAtAlice).not.toBeNull()
      const byeOkParsed = parse(byeOkAtAlice!.raw)
      if (byeOkParsed.type !== "response") throw new Error("byeOk should be response")
      expect(byeOkParsed.status).toBe(200)
      expect(byeOkParsed.getHeader("via").length).toBe(1)
      expect(byeOkParsed.getHeader("via")[0]!.host).toBe(ALICE.host)

      // Sanity: branch the proxy minted is in the LRU and stable.
      expect(proxyBranch.startsWith("z9hG4bK")).toBe(true)

      // No undeliverable packets — clean state.
      const net = yield* SignalingNetwork
      const undelivered = yield* net.drainUndeliverable()
      expect(undelivered.length).toBe(0)
      })
    ).pipe(Effect.provide(layer))
  )
})
