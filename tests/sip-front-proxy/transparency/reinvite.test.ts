/**
 * Transparency: re-INVITE in established dialog.
 *
 *   1. Establish dialog (INVITE / 200 / ACK).
 *   2. Alice → re-INVITE with a new CSeq, Route header set per
 *      Record-Route (withProxy).
 *   3. Bob → 200 with To-tag preserved.
 *   4. Alice → ACK.
 *
 * Both topologies must end with no undelivered packets.
 */

import { expect } from "@effect/vitest"
import { Effect } from "effect"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import { SignalingNetwork } from "../../../src/sip/SignalingNetwork.js"
import { topologyTest } from "../../support/topologies.js"

const ALICE = { host: "10.0.0.2", port: 5060 }
const BOB = { host: "10.0.0.3", port: 5060 }
const PROXY = { host: "10.0.0.1", port: 5060 }
const CALL_ID = "reinvite-call-1@alice"

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

topologyTest(
  "reinvite",
  {
    defaults: { aliceAddr: ALICE, bobAddr: BOB, proxyAddr: PROXY },
    description:
      "Establish dialog, then send re-INVITE with bumped CSeq.\n" +
      "withProxy carries Route header per received Record-Route.",
  },
  (topology) =>
    Effect.gen(function* () {
      const alice = yield* topology.bindUac("alice", ALICE)
      const bob = yield* topology.bindUas("bob", BOB)

      // ── 1. Establish dialog ──────────────────────────────────────
      const invite = Buffer.from(
        [
          `INVITE sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-inv;rport`,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>`,
          `Call-ID: ${CALL_ID}`,
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
      if (inviteParsed.type !== "request") throw new Error("expected INVITE")

      const ok = Buffer.from(
        [
          `SIP/2.0 200 OK`,
          ...inviteParsed.headers
            .filter((h) => h.name.toLowerCase() === "via")
            .map((h) => `Via: ${h.value}`),
          ...inviteParsed.headers
            .filter((h) => h.name.toLowerCase() === "record-route")
            .map((h) => `Record-Route: ${h.value}`),
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>;tag=bob-tag`,
          `Call-ID: ${CALL_ID}`,
          `CSeq: 1 INVITE`,
          `Contact: <sip:bob@${BOB.host}:${BOB.port}>`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      const aliceFacing =
        topology.kind === "withProxy"
          ? topology.target
          : { host: ALICE.host, port: ALICE.port }
      yield* bob.send(ok, aliceFacing.port, aliceFacing.host)
      yield* topology.pump(2)
      const okAtAlice = yield* alice.poll()
      expect(okAtAlice).not.toBeNull()
      const okParsed = parse(okAtAlice!.raw)
      if (okParsed.type !== "response") throw new Error("expected response")

      const aliceRouteHeaders =
        topology.kind === "withProxy"
          ? okParsed.headers
              .filter((h) => h.name.toLowerCase() === "record-route")
              .map((h) => `Route: ${h.value}`)
          : []

      const ack = Buffer.from(
        [
          `ACK sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-ack;rport`,
          ...aliceRouteHeaders,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>;tag=bob-tag`,
          `Call-ID: ${CALL_ID}`,
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

      // ── 2. Alice → re-INVITE (CSeq=2) ────────────────────────────
      const reinvite = Buffer.from(
        [
          `INVITE sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-reinv;rport`,
          ...aliceRouteHeaders,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>;tag=bob-tag`,
          `Call-ID: ${CALL_ID}`,
          `CSeq: 2 INVITE`,
          `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(reinvite, topology.target.port, topology.target.host)
      yield* topology.pump(2)
      const reinviteAtBob = yield* bob.poll()
      expect(reinviteAtBob).not.toBeNull()
      const reinviteParsed = parse(reinviteAtBob!.raw)
      if (reinviteParsed.type !== "request") throw new Error("expected re-INVITE")
      expect(reinviteParsed.method).toBe("INVITE")
      // To-tag preserved end-to-end.
      expect(reinviteParsed.parsed.to.tag).toBe("bob-tag")

      // ── 3. Bob → 200 OK ─────────────────────────────────────────
      const reok = Buffer.from(
        [
          `SIP/2.0 200 OK`,
          ...reinviteParsed.headers
            .filter((h) => h.name.toLowerCase() === "via")
            .map((h) => `Via: ${h.value}`),
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>;tag=bob-tag`,
          `Call-ID: ${CALL_ID}`,
          `CSeq: 2 INVITE`,
          `Contact: <sip:bob@${BOB.host}:${BOB.port}>`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* bob.send(reok, aliceFacing.port, aliceFacing.host)
      yield* topology.pump(2)
      const reokAtAlice = yield* alice.poll()
      expect(reokAtAlice).not.toBeNull()
      const reokParsed = parse(reokAtAlice!.raw)
      if (reokParsed.type !== "response") throw new Error("expected response")
      expect(reokParsed.status).toBe(200)

      // ── 4. ACK for re-INVITE ─────────────────────────────────────
      const reack = Buffer.from(
        [
          `ACK sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-alice-reack;rport`,
          ...aliceRouteHeaders,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-tag`,
          `To: <sip:bob@${BOB.host}>;tag=bob-tag`,
          `Call-ID: ${CALL_ID}`,
          `CSeq: 2 ACK`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(reack, topology.target.port, topology.target.host)
      yield* topology.pump(2)

      const net = yield* SignalingNetwork
      const undelivered = yield* net.drainUndeliverable()
      expect(undelivered.length).toBe(0)
    })
)
