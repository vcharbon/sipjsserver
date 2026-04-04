/**
 * Record-Route / Route compliance scenarios.
 *
 * 1. Basic RR: Verifies the B2BUA's Record-Route headers are echoed in
 *    responses and that in-dialog requests (ACK, BYE) use the Contact URI
 *    from the 200 OK as Request-URI with Route headers derived from RR.
 *
 * 2. Fake RR: The UAS (bob) injects its own extra Record-Route header in
 *    its responses. The B2BUA must strip the b-leg RR and insert its own
 *    a-leg RR when relaying to alice — alice should never see bob's fake RR.
 */

import { scenario } from "../framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../helpers/sdp.js"
import type { SipHeader } from "../../../src/sip/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHeaders(headers: ReadonlyArray<SipHeader>, name: string): string[] {
  const lower = name.toLowerCase()
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value)
}

// ---------------------------------------------------------------------------
// 1. Basic Record-Route compliance
// ---------------------------------------------------------------------------

export const recordRouteBasic = scenario("record-route-basic", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  // Alice calls Bob through the B2BUA
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", { body: sdpOffer() })

  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  // Bob sends 180 — should echo Record-Route from the INVITE
  bobInviteTxn.reply(180)

  // Alice receives 180 — should contain B2BUA's Record-Route
  aliceInviteTxn.expect(180, {
    predicate: (msg) => {
      const rr = getHeaders(msg.headers, "record-route")
      return rr.length > 0 && rr.some((v) => v.includes("callRef="))
    },
  })

  // Bob answers 200 OK — should also echo Record-Route
  bobInviteTxn.reply(200, { body: sdpAnswer() })

  // Alice receives 200 OK — should contain B2BUA's Record-Route
  aliceInviteTxn.expect(200, {
    predicate: (msg) => {
      const rr = getHeaders(msg.headers, "record-route")
      return rr.length > 0 && rr.some((v) => v.includes("callRef="))
    },
  })

  // Alice ACKs — should use Contact URI from 200 as Request-URI
  aliceDialog.ack()
  bobDialog.expect("ACK")

  s.pause(500)

  // Alice BYEs — should also use Contact URI + Route headers
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ---------------------------------------------------------------------------
// 2. Fake Record-Route from UAS — B2BUA must not leak it to alice
// ---------------------------------------------------------------------------

export const recordRouteFakeRR = scenario("record-route-fake-rr", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", { body: sdpOffer() })

  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  // Bob sends 180 with an extra fake Record-Route header
  bobInviteTxn.reply(180, {
    overrides: {
      extraHeaders: [
        { name: "Record-Route", value: "<sip:fake-proxy@10.0.0.99:5060;lr>" },
      ],
    },
  })

  // Alice receives 180 — B2BUA should NOT include bob's fake RR,
  // only the B2BUA's own a-leg Record-Route
  aliceInviteTxn.expect(180, {
    predicate: (msg) => {
      const rr = getHeaders(msg.headers, "record-route")
      // Must not contain the fake proxy
      if (rr.some((v) => v.includes("fake-proxy"))) return false
      // Should contain B2BUA's own RR
      return rr.some((v) => v.includes("callRef="))
    },
  })

  // Bob answers 200 OK with the same fake RR
  bobInviteTxn.reply(200, {
    body: sdpAnswer(),
    overrides: {
      extraHeaders: [
        { name: "Record-Route", value: "<sip:fake-proxy@10.0.0.99:5060;lr>" },
      ],
    },
  })

  // Alice receives 200 OK — fake RR must be stripped
  aliceInviteTxn.expect(200, {
    predicate: (msg) => {
      const rr = getHeaders(msg.headers, "record-route")
      if (rr.some((v) => v.includes("fake-proxy"))) return false
      return rr.some((v) => v.includes("callRef="))
    },
  })

  aliceDialog.ack()
  bobDialog.expect("ACK")

  s.pause(500)

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})
