/**
 * Transparency: CANCEL during ringing.
 *
 *   1. Alice → INVITE
 *   2. Bob   → 180 Ringing
 *   3. Alice → CANCEL (reuses INVITE's branch — RFC 3261 §9.1)
 *   4. Bob   → 200 (CANCEL) and 487 (INVITE)
 *   5. Alice → ACK for 487 (RFC 3261 §17.1.1.3)
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
const CALL_ID = "cancel-call-1@alice"
const INVITE_BRANCH = "z9hG4bK-alice-inv-1"

const parse = (raw: Buffer) => {
  const r = customParser.parse(raw)
  if (r._tag !== "Success") throw new Error(`parse failure: ${r.failure.reason}`)
  return r.success
}

topologyTest(
  "cancel-during-ringing",
  {
    defaults: { aliceAddr: ALICE, bobAddr: BOB, proxyAddr: PROXY },
    description:
      "Alice INVITE → Bob 180 → Alice CANCEL → Bob 200(CANCEL)+487 → Alice ACK.\n" +
      "RFC 3261 §9.1 / §17.1.1.3.",
  },
  (topology) =>
    Effect.gen(function* () {
      const alice = yield* topology.bindUac("alice", ALICE)
      const bob = yield* topology.bindUas("bob", BOB)

      const invite = Buffer.from(
        [
          `INVITE sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=${INVITE_BRANCH};rport`,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-cancel`,
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

      // ── 2. Bob → 180 Ringing ──────────────────────────────────────
      const ringing = Buffer.from(
        [
          `SIP/2.0 180 Ringing`,
          ...inviteParsed.headers
            .filter((h) => h.name.toLowerCase() === "via")
            .map((h) => `Via: ${h.value}`),
          ...inviteParsed.headers
            .filter((h) => h.name.toLowerCase() === "record-route")
            .map((h) => `Record-Route: ${h.value}`),
          `From: <sip:alice@${ALICE.host}>;tag=alice-cancel`,
          `To: <sip:bob@${BOB.host}>;tag=bob-ringing`,
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
      yield* bob.send(ringing, aliceFacing.port, aliceFacing.host)
      yield* topology.pump(2)

      const ringingAtAlice = yield* alice.poll()
      expect(ringingAtAlice).not.toBeNull()
      const ringingParsed = parse(ringingAtAlice!.raw)
      if (ringingParsed.type !== "response") throw new Error("expected response")
      expect(ringingParsed.status).toBe(180)

      // ── 3. Alice → CANCEL (same Via branch as INVITE — §9.1) ─────
      const cancel = Buffer.from(
        [
          `CANCEL sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=${INVITE_BRANCH};rport`,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-cancel`,
          `To: <sip:bob@${BOB.host}>`,
          `Call-ID: ${CALL_ID}`,
          `CSeq: 1 CANCEL`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* alice.send(cancel, topology.target.port, topology.target.host)
      yield* topology.pump(2)

      const cancelAtBob = yield* bob.poll()
      expect(cancelAtBob).not.toBeNull()
      const cancelParsed = parse(cancelAtBob!.raw)
      if (cancelParsed.type !== "request") throw new Error("expected CANCEL")
      expect(cancelParsed.method).toBe("CANCEL")

      // ── 4. Bob → 200 (CANCEL) + 487 (INVITE) ─────────────────────
      const cancelOk = Buffer.from(
        [
          `SIP/2.0 200 OK`,
          ...cancelParsed.headers
            .filter((h) => h.name.toLowerCase() === "via")
            .map((h) => `Via: ${h.value}`),
          `From: <sip:alice@${ALICE.host}>;tag=alice-cancel`,
          `To: <sip:bob@${BOB.host}>;tag=bob-ringing`,
          `Call-ID: ${CALL_ID}`,
          `CSeq: 1 CANCEL`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* bob.send(cancelOk, aliceFacing.port, aliceFacing.host)

      const terminated = Buffer.from(
        [
          `SIP/2.0 487 Request Terminated`,
          ...inviteParsed.headers
            .filter((h) => h.name.toLowerCase() === "via")
            .map((h) => `Via: ${h.value}`),
          `From: <sip:alice@${ALICE.host}>;tag=alice-cancel`,
          `To: <sip:bob@${BOB.host}>;tag=bob-ringing`,
          `Call-ID: ${CALL_ID}`,
          `CSeq: 1 INVITE`,
          `Content-Length: 0`,
          ``,
          ``,
        ].join("\r\n"),
        "utf-8"
      )
      yield* bob.send(terminated, aliceFacing.port, aliceFacing.host)
      yield* topology.pump(3)

      // Drain Alice's queue and confirm both responses arrived.
      const seenStatuses: number[] = []
      for (let i = 0; i < 4; i++) {
        const pkt = yield* alice.poll()
        if (pkt === null) break
        const m = parse(pkt.raw)
        if (m.type === "response") seenStatuses.push(m.status)
      }
      expect(seenStatuses).toContain(200)
      expect(seenStatuses).toContain(487)

      // ── 5. Alice → ACK for 487 (§17.1.1.3, end-to-end ACK) ───────
      const ack = Buffer.from(
        [
          `ACK sip:bob@${BOB.host}:${BOB.port} SIP/2.0`,
          `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=${INVITE_BRANCH};rport`,
          `Max-Forwards: 70`,
          `From: <sip:alice@${ALICE.host}>;tag=alice-cancel`,
          `To: <sip:bob@${BOB.host}>;tag=bob-ringing`,
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

      // Final cleanliness — neither topology is allowed to leak undelivered packets.
      const net = yield* SignalingNetwork
      const undelivered = yield* net.drainUndeliverable()
      expect(undelivered.length).toBe(0)
    })
)
