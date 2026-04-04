/**
 * BYE from either direction — composed scenario using andThen().
 *
 * Demonstrates scenario composition:
 *   callSetup.andThen(callerBye)
 *   callSetup.andThen(calleeBye)
 */

import { sequence } from "../framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../helpers/sdp.js"

/** Reusable: call setup through ACK. */
export const callSetup = sequence("call-setup", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    // MockCallControlServer routes to 127.0.0.1:5666 (bob's port)
    body: sdpOffer(),
  })
  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)

  // Alice sends ACK (relayed end-to-end, may carry SDP)
  aliceDialog.ack()

  // Bob receives relayed ACK
  bobDialog.expect("ACK")
})

/** Reusable: caller (alice) initiates BYE. */
export const callerBye = sequence("caller-bye", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  const aliceByeTxn = alice.dialog.bye()
  const bobByeTxn = bob.dialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

/** Reusable: callee (bob) initiates BYE. */
export const calleeBye = sequence("callee-bye", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  const bobByeTxn = bob.dialog.bye()
  const aliceByeTxn = alice.dialog.expect("BYE")
  aliceByeTxn.reply(200)
  bobByeTxn.expect(200)
})

/** Full scenario: setup + caller hangs up. */
export const callerHangup = callSetup.andThen(callerBye)

/** Full scenario: setup + callee hangs up. */
export const calleeHangup = callSetup.andThen(calleeBye)
