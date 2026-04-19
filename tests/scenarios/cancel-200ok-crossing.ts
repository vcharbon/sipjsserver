/**
 * CANCEL ↔ 200 OK crossing scenario:
 *
 *   INVITE → 100 → 180 → CANCEL (Alice) / 200 OK (Bob) simultaneously
 *
 * Tests the race condition where Alice CANCELs while Bob answers at the
 * same time. The B2BUA processes Alice's CANCEL first (sending 200 CANCEL
 * + 487 to Alice, CANCEL to Bob, marking b-leg as "cancelling"). Then
 * Bob's 200 OK arrives — the B2BUA must:
 *   1. ACK the 200 OK (to stop Bob's retransmissions)
 *   2. BYE Bob (to tear down the answered-but-cancelled leg)
 *
 * This exercises the cancel-200-crossing rule in CornerCaseRules.ts.
 */

import { scenario } from "../fullcall/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../fullcall/helpers/sdp.js"

export const cancelCrossing200Ok = scenario("cancel-200ok-crossing", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  // Alice sends INVITE
  const { transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
  })

  // Alice receives 100 Trying
  aliceInviteTxn.expect(100)

  // Bob receives INVITE from B2BUA
  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  // Bob sends 180 Ringing
  bobInviteTxn.reply(180)

  // Alice receives 180
  aliceInviteTxn.expect(180)

  // ── Race condition: Alice CANCELs, Bob answers simultaneously ──

  // Alice sends CANCEL (processed first by B2BUA)
  const aliceCancelTxn = aliceInviteTxn.cancel()

  // Bob sends 200 OK for INVITE (crossing — arrives after CANCEL is processed)
  bobInviteTxn.reply(200, { body: sdpAnswer() })

  // Alice receives 200 OK for CANCEL
  aliceCancelTxn.expect(200)

  // Alice receives 487 Request Terminated for the INVITE
  aliceInviteTxn.expect(487)

  // Bob receives CANCEL from B2BUA (sent during CANCEL processing)
  const bobCancelTxn = bobInviteTxn.expectCancel()

  // Bob receives ACK from B2BUA (end-to-end ACK for the crossed 2xx, in-dialog)
  bobDialog.expect("ACK")

  // Bob receives BYE from B2BUA (tears down the answered-but-cancelled leg)
  const bobByeTxn = bobDialog.expect("BYE")

  // Bob sends 200 OK for the CANCEL
  bobCancelTxn.reply(200)

  // Bob sends 200 OK for the BYE
  bobByeTxn.reply(200)
})
