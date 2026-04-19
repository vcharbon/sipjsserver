/**
 * retransmit-200 scenario:
 *
 * After a call is fully established (ACK exchanged end-to-end), Bob retransmits
 * 200 OK for the INVITE as if he never saw the ACK. The B2BUA must:
 *   1. ACK Bob again (to stop further retransmissions)
 *   2. NOT relay the duplicate 200 OK back to Alice
 *
 * Exercises [retransmit-200](src/b2bua/rules/defaults/CornerCaseRules.ts)
 * which matches on a 200 OK from the b-leg when the leg state is already
 * "confirmed".
 */

import { scenario } from "../fullcall/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../fullcall/helpers/sdp.js"

export const retransmit200 = scenario("retransmit-200", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  // ── Call setup ───────────────────────────────────────────────────────────

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15060",
    { body: sdpOffer() },
  )
  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)

  aliceDialog.ack()
  bobDialog.expect("ACK")

  // ── Bob retransmits 200 OK as if the end-to-end ACK was lost ─────────────
  // Second .reply(200) emits an independent send step — same Via branch and
  // CSeq as the first 200 OK (both built from the same inResponseTo INVITE).
  // The B2BUA's INVITE client transaction has already terminated on the first
  // 2xx (RFC 3261 §17.1.1.2), so the duplicate surfaces to the rule engine.

  bobInviteTxn.reply(200, { body: sdpAnswer() })

  // B2BUA re-ACKs Bob without relaying a second 200 to Alice.
  bobDialog.expect("ACK")

  // ── Teardown ─────────────────────────────────────────────────────────────

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})
