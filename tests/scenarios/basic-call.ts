/**
 * Basic call scenario: INVITE → 100 → 180 → 200 → ACK → pause → BYE → 200
 */

import { scenario } from "../fullcall/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../fullcall/helpers/sdp.js"
import type { SipHeader } from "../../src/sip/types.js"

function getHeaderValue(headers: ReadonlyArray<SipHeader>, name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
}

export const basicCall = scenario("basic-call", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  // Alice sends INVITE to B2BUA, which routes to Bob
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    // MockCallControlServer routes to 127.0.0.1:5666 (bob's port)
    body: sdpOffer(),
  })

  // Alice receives 100 Trying from B2BUA
  aliceInviteTxn.expect(100)

  // Bob receives the INVITE from B2BUA — verify Max-Forwards decremented to 69
  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite({
    predicate: (msg) => getHeaderValue(msg.headers, "max-forwards") === "69",
  })

  // Bob sends 180 Ringing
  bobInviteTxn.reply(180)

  // Alice receives 180
  aliceInviteTxn.expect(180)

  // Bob answers with 200 OK
  bobInviteTxn.reply(200, { body: sdpAnswer() })

  // Alice receives 200 OK
  aliceInviteTxn.expect(200)

  // Alice sends ACK (relayed end-to-end, may carry SDP)
  aliceDialog.ack()

  // Bob receives relayed ACK
  bobDialog.expect("ACK")

  // Call is established — pause for 1 second
  s.pause(1000)

  // Alice hangs up
  const aliceByeTxn = aliceDialog.bye()

  // Bob receives BYE
  const bobByeTxn = bobDialog.expect("BYE")

  // Bob sends 200 OK for BYE
  bobByeTxn.reply(200)

  // Alice receives 200 OK for BYE
  aliceByeTxn.expect(200)
})
