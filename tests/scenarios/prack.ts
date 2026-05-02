/**
 * PRACK scenario: INVITE → 100 → 183(100rel) → PRACK → 200(PRACK) → 200(INVITE) → ACK
 *
 * Tests reliable provisional response handling:
 * 1. Bob sends 183 with Require: 100rel and RSeq
 * 2. Alice sends PRACK
 * 3. Bob sends 200 OK for PRACK
 * 4. Bob sends 200 OK for INVITE
 * 5. Alice sends ACK
 */

import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../src/test-harness/framework/helpers/sdp.js"
import type { SipMessage } from "../../src/sip/types.js"

export const prackCall = scenario("prack", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  // Alice sends INVITE
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    headers: {
      // MockCallControlServer routes to 127.0.0.1:5666 (bob's port)
      "Supported": "100rel",
    },
    body: sdpOffer(),
  })

  // Alice receives 100 Trying
  aliceInviteTxn.expect(100)

  // Bob receives INVITE
  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  // Bob sends 183 Session Progress with 100rel
  bobInviteTxn.reply(183, {
    overrides: {
      headers: {
        "Require": "100rel",
        "RSeq": "1",
      },
      body: sdpAnswer(),
    },
  })

  // Alice receives 183 with 100rel
  aliceInviteTxn.expect(183, {
    predicate: (msg: SipMessage) => {
      if (msg.type !== "response") return false
      const require = msg.headers.find((h) => h.name.toLowerCase() === "require")
      return require?.value === "100rel"
    },
  })

  // Alice sends PRACK
  const alicePrackTxn = aliceDialog.send("PRACK", {
    overrides: {
      headers: { "RAck": "1 1 INVITE" },
    },
  })

  // Bob receives PRACK
  const bobPrackTxn = bobDialog.expect("PRACK")

  // Bob sends 200 OK for PRACK
  bobPrackTxn.reply(200)

  // Alice receives 200 OK for PRACK
  alicePrackTxn.expect(200)

  // Bob sends 200 OK for INVITE
  bobInviteTxn.reply(200, { body: sdpAnswer() })

  // Alice receives 200 OK for INVITE
  aliceInviteTxn.expect(200)

  // Alice sends ACK (relayed end-to-end, may carry SDP)
  aliceDialog.ack()

  // Bob receives relayed ACK
  bobDialog.expect("ACK")

  // Alice hangs up so the sweep finds a clean CallState
  s.pause(1000)
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})
