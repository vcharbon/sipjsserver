/**
 * Record-Route compliance scenarios.
 *
 * A B2BUA is a UA, not a proxy — it MUST NOT insert Record-Route headers
 * (RFC 3261 §16.6). These tests verify:
 *
 * 1. Basic: No Record-Route headers appear in relayed responses or requests.
 *
 * 2. Fake RR: The UAS (bob) injects a Record-Route in its responses.
 *    The B2BUA strips it (record-route is a structural header) and does
 *    not add its own — alice should see no Record-Route at all.
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
// 1. Basic — B2BUA must NOT insert Record-Route
// ---------------------------------------------------------------------------

export const recordRouteBasic = scenario("record-route-basic", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  // Alice calls Bob through the B2BUA
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", { body: sdpOffer() })

  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  // Bob sends 180
  bobInviteTxn.reply(180)

  // Alice receives 180 — must NOT contain any Record-Route (B2BUA is a UA)
  aliceInviteTxn.expect(180, {
    predicate: (msg) => {
      const rr = getHeaders(msg.headers, "record-route")
      return rr.length === 0
    },
  })

  // Bob answers 200 OK
  bobInviteTxn.reply(200, { body: sdpAnswer() })

  // Alice receives 200 OK — must NOT contain any Record-Route
  aliceInviteTxn.expect(200, {
    predicate: (msg) => {
      const rr = getHeaders(msg.headers, "record-route")
      return rr.length === 0
    },
  })

  // Alice ACKs — should use Contact URI from 200 as Request-URI
  aliceDialog.ack()
  bobDialog.expect("ACK")

  s.pause(500)

  // Alice BYEs
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ---------------------------------------------------------------------------
// 2. Fake Record-Route from UAS — B2BUA must strip it
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

  // Alice receives 180 — must NOT contain any Record-Route
  // (B2BUA strips b-leg structural headers and does not add its own)
  aliceInviteTxn.expect(180, {
    predicate: (msg) => {
      const rr = getHeaders(msg.headers, "record-route")
      return rr.length === 0
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

  // Alice receives 200 OK — no Record-Route at all
  aliceInviteTxn.expect(200, {
    predicate: (msg) => {
      const rr = getHeaders(msg.headers, "record-route")
      return rr.length === 0
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
