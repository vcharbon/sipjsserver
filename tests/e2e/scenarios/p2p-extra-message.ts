/**
 * Negative test: bob sends an extra unsolicited message after the call
 * is fully torn down. The framework MUST flag this as an unexpected
 * message at drain time and fail the scenario.
 *
 * This scenario is expected to FAIL — the runner asserts that.
 */

import { scenario } from "../framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../helpers/sdp.js"

export const ALICE_PORT = 25062
export const BOB_PORT = 25063

export const p2pExtraMessage = scenario("p2p-extra-message", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@127.0.0.1", port: ALICE_PORT })
  const bob = s.agent("bob", { uri: "sip:bob@127.0.0.1", port: BOB_PORT })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(`sip:bob@127.0.0.1:${BOB_PORT}`, { body: sdpOffer() })
  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)
  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)
  aliceDialog.ack()
  bobDialog.expect("ACK")

  // Bob now sends an extra, unsolicited INFO that alice never expects.
  // The interpreter's drain phase should pick this up at alice and flag
  // it as an unexpected message — causing the scenario to fail.
  bob.send("INFO")
})
