/**
 * CANCEL scenario: INVITE → 100 → 180 → CANCEL → 200(CANCEL) → 487
 *
 * Tests the TransactionLayer CANCEL handling — the B2BUA should:
 * 1. Forward the INVITE to Bob
 * 2. Forward 180 to Alice
 * 3. On CANCEL from Alice: send 200 OK for CANCEL, send 487 for INVITE
 * 4. CANCEL the B-leg INVITE to Bob
 */

import { scenario } from "../framework/dsl.js"
import { sdpOffer } from "../helpers/sdp.js"

export const cancelCall = scenario("cancel", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  // Bob will receive ACK for the 487 (RFC 3261 §17.1.1.3 — auto-ACK for non-2xx)
  bob.allowExtra("ACK")

  // Alice sends INVITE
  const { transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    // MockCallControlServer routes to 127.0.0.1:5666 (bob's port)
    body: sdpOffer(),
  })

  // Alice receives 100 Trying
  aliceInviteTxn.expect(100)

  // Bob receives INVITE from B2BUA
  const { transaction: bobInviteTxn } = bob.receiveInitialInvite()

  // Bob sends 180 Ringing
  bobInviteTxn.reply(180)

  // Alice receives 180
  aliceInviteTxn.expect(180)

  // Alice sends CANCEL
  const aliceCancelTxn = aliceInviteTxn.cancel()

  // Alice receives 200 OK for CANCEL
  aliceCancelTxn.expect(200)

  // Alice receives 487 Request Terminated for the INVITE
  aliceInviteTxn.expect(487)

  // Bob receives CANCEL from B2BUA
  const rcvCancel = bob.expect("CANCEL")

  // Bob sends 200 OK for CANCEL
  rcvCancel.reply(200)

  // Bob sends 487 for the original INVITE
  bobInviteTxn.reply(487)
})
