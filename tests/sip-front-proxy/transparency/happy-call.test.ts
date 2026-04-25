/**
 * Transparency: happy call (INVITE / 200 / ACK / BYE / 200).
 *
 * Runs once per topology (`direct`, `withProxy`) and asserts the same
 * observable behaviour in both:
 *
 *   - Alice's INVITE elicits a 200 OK from Bob.
 *   - Alice ACKs the 200.
 *   - Alice BYEs Bob; Bob 200s the BYE.
 *   - No undeliverable packets remain at end of scenario.
 *
 * Topology-specific assertions (Via stacking, Record-Route insertion)
 * live inline guarded by `topology.kind === "withProxy"`.
 */

import { expect } from "@effect/vitest"
import { Effect } from "effect"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import { SignalingNetwork } from "../../../src/sip/SignalingNetwork.js"
import { topologyTest } from "../../support/topologies.js"

const ALICE = { host: "10.0.0.2", port: 5060 }
const BOB = { host: "10.0.0.3", port: 5060 }
const PROXY = { host: "10.0.0.1", port: 5060 }

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

const buildInvite = (target: { host: string; port: number }) =>
  Buffer.from(
    [
      `INVITE sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
      `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-1;rport`,
      `Max-Forwards: 70`,
      `From: "Alice" <sip:alice@${ALICE.host}>;tag=alice-tag-1`,
      `To: "Bob" <sip:bob@${BOB.host}>`,
      `Call-ID: hc-call-1@alice`,
      `CSeq: 1 INVITE`,
      `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join("\r\n"),
    "utf-8"
  ) // target argument is the destination Alice sends to (proxy or Bob)
  // — kept on the call site, returned unchanged here so the message
  // bytes are identical across topologies.

void buildInvite // (signature kept for documentation)

topologyTest(
  "happy-call",
  {
    defaults: {
      aliceAddr: ALICE,
      bobAddr: BOB,
      proxyAddr: PROXY,
    },
    description:
      "Alice → (proxy?) → Bob. Full INVITE/200/ACK/BYE round-trip.\n" +
      "Asserts dialog establishes, BYE terminates cleanly, no orphan packets.\n" +
      "Withproxy adds Via push/pop and Record-Route insertion (RFC 3261 §16.6.4 / §16.6.5 / §16.7.3).",
  },
  (topology) =>
    Effect.gen(function* () {
      const alice = yield* topology.bindUac("alice", ALICE)
      const bob = yield* topology.bindUas("bob", BOB)

      // ── 1. Alice → target: INVITE ────────────────────────────────
      const invite = Buffer.from(
        [
          `INVITE sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-1;rport`,
          `Max-Forwards: 70`,
          `From: "Alice" <sip:alice@${ALICE.host}>;tag=alice-tag-1`,
          `To: "Bob" <sip:bob@${BOB.host}>`,
          `Call-ID: hc-call-1@alice`,
          `CSeq: 1 INVITE`,
          `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(invite, topology.target.port, topology.target.host)
      yield* topology.pump(2)

      const inviteAtBob = yield* bob.poll()
      expect(inviteAtBob).not.toBeNull()
      const inviteParsed = parse(inviteAtBob!.raw)
      if (inviteParsed.type !== "request") throw new Error("expected request")
      expect(inviteParsed.method).toBe("INVITE")

      if (topology.kind === "withProxy") {
        // RFC 3261 §16.6.4: proxy pushed its Via on top.
        expect(inviteParsed.parsed.vias.length).toBe(2)
        expect(inviteParsed.parsed.vias[0]!.host).toBe(PROXY.host)
        expect(inviteParsed.parsed.vias[1]!.host).toBe(ALICE.host)
        // RFC 3261 §16.6.5: Record-Route inserted, points at proxy,
        // carries `;lr` and the LoadBalancer stickiness cookie.
        const rr = inviteParsed.headers.find(
          (h) => h.name.toLowerCase() === "record-route"
        )
        expect(rr).toBeDefined()
        expect(rr!.value).toContain(`${PROXY.host}:${PROXY.port}`)
        expect(rr!.value).toContain(";lr")
        expect(rr!.value).toContain(";w=") // load-balancer cookie
      } else {
        // Direct: only Alice's Via.
        expect(inviteParsed.parsed.vias.length).toBe(1)
        expect(inviteParsed.parsed.vias[0]!.host).toBe(ALICE.host)
        expect(
          inviteParsed.headers.find((h) => h.name.toLowerCase() === "record-route")
        ).toBeUndefined()
      }

      // ── 2. Bob → 200 OK ─────────────────────────────────────────
      const ok = Buffer.from(
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
          `Call-ID: hc-call-1@alice`,
          `CSeq: 1 INVITE`,
          `Contact: <sip:bob@${BOB.host}:${BOB.port}>`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      const okDest =
        topology.kind === "withProxy"
          ? topology.target // proxy sits between
          : { host: ALICE.host, port: ALICE.port }
      yield* bob.send(ok, okDest.port, okDest.host)
      yield* topology.pump(2)

      const okAtAlice = yield* alice.poll()
      expect(okAtAlice).not.toBeNull()
      const okParsed = parse(okAtAlice!.raw)
      if (okParsed.type !== "response") throw new Error("expected response")
      expect(okParsed.status).toBe(200)
      // Alice always sees only her own Via after pop.
      expect(okParsed.parsed.vias.length).toBe(1)
      expect(okParsed.parsed.vias[0]!.host).toBe(ALICE.host)

      // ── 3. Alice → ACK ──────────────────────────────────────────
      // Build the ACK; in withProxy include Route header per
      // Record-Route received.
      const aliceRouteHeader =
        topology.kind === "withProxy"
          ? okParsed.headers
              .filter((h) => h.name.toLowerCase() === "record-route")
              .map((h) => `Route: ${h.value}`)
          : []
      const ack = Buffer.from(
        [
          `ACK sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-ack;rport`,
          ...aliceRouteHeader,
          `Max-Forwards: 70`,
          `From: "Alice" <sip:alice@${ALICE.host}>;tag=alice-tag-1`,
          `To: "Bob" <sip:bob@${BOB.host}>;tag=bob-tag-1`,
          `Call-ID: hc-call-1@alice`,
          `CSeq: 1 ACK`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(ack, topology.target.port, topology.target.host)
      yield* topology.pump(2)

      const ackAtBob = yield* bob.poll()
      expect(ackAtBob).not.toBeNull()
      const ackParsed = parse(ackAtBob!.raw)
      if (ackParsed.type !== "request") throw new Error("expected ACK request")
      expect(ackParsed.method).toBe("ACK")

      // ── 4. Alice → BYE → Bob → 200 ──────────────────────────────
      const bye = Buffer.from(
        [
          `BYE sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-bye;rport`,
          ...aliceRouteHeader,
          `Max-Forwards: 70`,
          `From: "Alice" <sip:alice@${ALICE.host}>;tag=alice-tag-1`,
          `To: "Bob" <sip:bob@${BOB.host}>;tag=bob-tag-1`,
          `Call-ID: hc-call-1@alice`,
          `CSeq: 2 BYE`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(bye, topology.target.port, topology.target.host)
      yield* topology.pump(2)

      const byeAtBob = yield* bob.poll()
      expect(byeAtBob).not.toBeNull()
      const byeParsed = parse(byeAtBob!.raw)
      if (byeParsed.type !== "request") throw new Error("expected BYE request")
      expect(byeParsed.method).toBe("BYE")

      const byeOk = Buffer.from(
        [
          `SIP/2.0 200 OK`,
          ...byeParsed.headers
            .filter((h) => h.name.toLowerCase() === "via")
            .map((h) => `Via: ${h.value}`),
          `From: "Alice" <sip:alice@${ALICE.host}>;tag=alice-tag-1`,
          `To: "Bob" <sip:bob@${BOB.host}>;tag=bob-tag-1`,
          `Call-ID: hc-call-1@alice`,
          `CSeq: 2 BYE`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* bob.send(byeOk, okDest.port, okDest.host)
      yield* topology.pump(2)

      const byeOkAtAlice = yield* alice.poll()
      expect(byeOkAtAlice).not.toBeNull()
      const byeOkParsed = parse(byeOkAtAlice!.raw)
      if (byeOkParsed.type !== "response") throw new Error("expected response")
      expect(byeOkParsed.status).toBe(200)

      // No undelivered packets — both topologies must end clean.
      const net = yield* SignalingNetwork
      const undelivered = yield* net.drainUndeliverable()
      expect(undelivered.length).toBe(0)
    })
)
