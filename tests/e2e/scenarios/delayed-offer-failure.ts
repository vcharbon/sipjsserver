/**
 * Delayed-offer failure scenario — Alice deliberately misbehaves.
 *
 * In a delayed-offer model (no SDP in INVITE), the 200 OK carries the SDP
 * offer and the ACK MUST carry the SDP answer (RFC 3264 §4).
 *
 * This test verifies that when Alice sends ACK without SDP answer after
 * receiving a 200 OK with SDP offer, Bob detects the violation and tears
 * down the call with BYE.
 */

import { scenario } from "../framework/dsl.js"
import { sdpOffer } from "../helpers/sdp.js"

const BOB_PORT = 5695

const instruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB_PORT },
})

export const delayedOfferFailure = scenario("delayed-offer-failure", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

  // Alice sends INVITE WITHOUT SDP (delayed offer model)
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    headers: { "X-Api-Call": instruction },
  })

  aliceInviteTxn.expect(100)

  // Bob receives INVITE — should have no body (delayed offer)
  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite({
    predicate: (msg) => msg.type === "request" && msg.body.length === 0,
  })

  // Bob sends 200 OK WITH SDP offer (offerer in delayed-offer model).
  // Alice will deliberately ACK without answer — the tracker must not flag
  // this missing-answer on Bob's offer since that IS the scenario.
  bobInviteTxn.reply(200, { body: sdpOffer(), skipValidation: ["offerAnswer"] })

  // Alice receives 200 OK with SDP
  aliceInviteTxn.expect(200)

  // Alice sends ACK WITHOUT SDP answer — this is the deliberate misbehavior!
  // RFC 3264 §4 requires SDP answer in ACK when 200 OK contained offer
  aliceDialog.ack()

  // Bob receives ACK — validate it has NO body (detecting the violation)
  bobDialog.expect("ACK", {
    predicate: (msg) => msg.type === "request" && msg.body.length === 0,
  })

  // Bob detects missing SDP answer — tears down the call
  s.pause(100)
  const bobByeTxn = bobDialog.bye()
  const aliceByeTxn = aliceDialog.expect("BYE")
  aliceByeTxn.reply(200)
  bobByeTxn.expect(200)
})
