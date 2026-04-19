/**
 * In-dialog request with unknown dialog identifiers → 481 rejection.
 *
 * Per RFC 3261 §12.2.2, a UAS that receives an in-dialog request
 * which does not match any existing dialog MUST respond with 481
 * "Call/Transaction Does Not Exist".
 *
 * This scenario verifies that the B2BUA sends 481 (not silently drops)
 * when it receives BYE, INVITE (re-INVITE), and OPTIONS with dialog
 * identifiers that don't match any active call.
 */

import { scenario } from "../e2e/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../e2e/helpers/sdp.js"

/**
 * A stranger sends BYE, INVITE (re-INVITE), and OPTIONS to the B2BUA
 * with completely unknown dialog identifiers (unknown Call-ID + bogus
 * To-tag). The B2BUA must respond 481 to each. An existing call
 * between alice and bob is running to prove the rejection is specific
 * to the unknown dialog — the real call is not affected.
 */
export const unknownDialogReject = scenario("indialog-unknown-reject", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
  const stranger = s.agent("stranger", { uri: "sip:stranger@test" })

  // The INVITE triggers an automatic 100 Trying from TransactionLayer
  // before SipRouter can reject with 481 — allow it as expected noise.
  stranger.allowExtra(100)

  // ── Set up a normal call ──────────────────────────────────────────
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", { body: sdpOffer() })
  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)
  aliceDialog.ack()
  bobDialog.expect("ACK")

  s.pause(500)

  // ── Stranger sends BYE with unknown dialog ───────────────────────
  // Forge a dialog on the stranger agent via raw overrides: unknown Call-ID
  // is generated automatically, bogus To-tag is set explicitly.
  const strangerByeTxn = stranger.dialog.send("BYE", {
    uri: "sip:someone@127.0.0.1:15060",
    overrides: {
      to: "<sip:someone@test>;tag=bogus-tag-xyz",
    },
  })
  strangerByeTxn.expect(481)

  // ── Stranger sends INVITE (re-INVITE) with unknown dialog ────────
  // An INVITE with a To-tag is a re-INVITE per RFC 3261 §12.2.2.
  // The B2BUA must NOT treat it as a new initial INVITE.
  const strangerReInvTxn = stranger.dialog.send("INVITE", {
    uri: "sip:someone@127.0.0.1:15060",
    overrides: {
      to: "<sip:someone@test>;tag=bogus-tag-reinvite",
    },
  })
  strangerReInvTxn.expect(481)

  // ── Stranger sends OPTIONS with unknown dialog ───────────────────
  const strangerOptionsTxn = stranger.dialog.send("OPTIONS", {
    uri: "sip:someone@127.0.0.1:15060",
    overrides: {
      to: "<sip:someone@test>;tag=bogus-tag-options",
    },
  })
  strangerOptionsTxn.expect(481)

  s.pause(500)

  // ── Normal call teardown (proves the real call is unaffected) ────
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})
