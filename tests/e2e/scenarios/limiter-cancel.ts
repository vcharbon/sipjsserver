/**
 * Call limiter with CANCEL scenario (parallel).
 *
 * Tests that limiter slots are freed when the call is cancelled (not connected):
 *   - alice1 → INVITE → 180 Ringing (early dialog, limiter slot consumed, NOT connected)
 *   - alice2 → INVITE (1s later) → 486 Busy Here (limiter rejects) → ACK
 *   - alice1 → CANCEL (hangs up before answer, limiter slot freed)
 *   - alice3 → INVITE (after cancel completes) → established (limiter slot available)
 */

import { scenario, parallel } from "../framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../helpers/sdp.js"

const limiterInstruction = JSON.stringify({
  action: "route",
  call_limiter: [{ id: "test-limiter-cancel", limit: 1 }]
})

/** alice3 routes to port 5667 (bob3) with the same limiter. */
const limiterInstruction3 = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: 5667 },
  call_limiter: [{ id: "test-limiter-cancel", limit: 1 }]
})

/**
 * Scenario A: alice1 calls, bob1 rings but never answers.
 * alice1 cancels during early dialog — limiter slot freed.
 */
const earlyDialogCancel = scenario("early-dialog-cancel", (s) => {
  const alice1 = s.agent("alice1", { uri: "sip:alice1@test" })
  const bob1 = s.agent("bob1", { uri: "sip:bob1@test", port: 5666 })

  // alice1 sends INVITE with limiter instruction
  const { transaction: alice1InviteTxn } = alice1.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: { "X-Api-Call": limiterInstruction },
  })

  // 100 Trying
  alice1InviteTxn.expect(100)

  // bob1 receives INVITE from B2BUA
  const { transaction: bob1InviteTxn } = bob1.receiveInitialInvite()

  // bob1 sends 180 Ringing (early dialog — NOT answering)
  bob1InviteTxn.reply(180)
  alice1InviteTxn.expect(180)

  // Wait for alice2's rejection to complete
  s.pause(2000)

  // alice1 cancels — frees the limiter slot
  const alice1CancelTxn = alice1InviteTxn.cancel()

  // alice1 receives 200 OK for CANCEL
  alice1CancelTxn.expect(200)

  // alice1 receives 487 Request Terminated for INVITE
  alice1InviteTxn.expect(487)

  // bob1 receives CANCEL from B2BUA
  const rcvCancel = bob1.expect("CANCEL")

  // bob1 sends 200 OK for CANCEL
  rcvCancel.reply(200)

  // bob1 sends 487 for the original INVITE
  bob1InviteTxn.reply(487)
})

/**
 * Scenario B: alice2 calls after 1s delay — gets 486 Busy Here.
 * The limiter "test-limiter-cancel" is at count=1 from alice1's early dialog.
 */
const rejectedCall = scenario("rejected-call-cancel", (s) => {
  const alice2 = s.agent("alice2", { uri: "sip:alice2@test" })

  // Wait for alice1's early dialog to establish
  s.pause(1000)

  // alice2 sends INVITE with same limiter instruction
  const { dialog: alice2Dialog, transaction: alice2InviteTxn } = alice2.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: { "X-Api-Call": limiterInstruction },
  })

  // 100 Trying
  alice2InviteTxn.expect(100)

  // 486 Busy Here — limiter rejected
  alice2InviteTxn.expect(486, {
    predicate: (msg) => {
      if (msg.type !== "response") return false
      return msg.reason === "Busy Here"
    },
  })

  // ACK for non-2xx
  alice2Dialog.ack()
})

/**
 * Scenario C: alice3 calls after alice1 cancels — limiter slot is free.
 * Waits for alice1's CANCEL to complete, then sends INVITE which should be accepted.
 */
const postCancelCall = scenario("post-cancel-call", (s) => {
  const alice3 = s.agent("alice3", { uri: "sip:alice3@test" })
  const bob3 = s.agent("bob3", { uri: "sip:bob3@test", port: 5667 })

  // Wait for alice1 to cancel (2s hold + CANCEL exchange + margin)
  s.pause(4000)

  // alice3 sends INVITE with limiter instruction routing to bob3's port
  const { dialog: alice3Dialog, transaction: alice3InviteTxn } = alice3.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: { "X-Api-Call": limiterInstruction3 },
  })

  // 100 Trying
  alice3InviteTxn.expect(100)

  // bob3 receives INVITE — limiter allowed it (slot was freed by alice1 CANCEL)
  const { dialog: bob3Dialog, transaction: bob3InviteTxn } = bob3.receiveInitialInvite()

  // bob3 sends 180 Ringing
  bob3InviteTxn.reply(180)
  alice3InviteTxn.expect(180)

  // bob3 answers with 200 OK
  bob3InviteTxn.reply(200, { body: sdpAnswer() })
  alice3InviteTxn.expect(200)

  // ACK
  alice3Dialog.ack()
  bob3Dialog.expect("ACK")

  // Short hold then hang up
  s.pause(500)
  const alice3ByeTxn = alice3Dialog.bye()
  const bob3ByeTxn = bob3Dialog.expect("BYE")
  bob3ByeTxn.reply(200)
  alice3ByeTxn.expect(200)
})

/** Combined parallel scenario. */
export const limiterCancel = parallel("limiter-cancel", earlyDialogCancel, rejectedCall, postCancelCall)
