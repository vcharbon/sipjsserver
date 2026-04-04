/**
 * Direct peer-to-peer call: alice <-> bob, NO B2BUA in between.
 *
 * Both agents bind to fixed ports and send directly to each other.
 * Used to validate the test framework itself in isolation from the SUT.
 *
 * Flow: INVITE -> 180 -> 200 -> ACK -> BYE -> 200
 */

import { scenario } from "../framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../helpers/sdp.js"

export const ALICE_PORT = 25060
export const BOB_PORT = 25061

export const p2pDirectCall = scenario("p2p-direct-call", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@127.0.0.1", port: ALICE_PORT })
  const bob = s.agent("bob", { uri: "sip:bob@127.0.0.1", port: BOB_PORT })

  // Alice INVITEs bob directly at his bound port
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(`sip:bob@127.0.0.1:${BOB_PORT}`, { body: sdpOffer() })

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)

  aliceDialog.ack()
  bobDialog.expect("ACK")

  s.pause(200)

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})
