/**
 * Call limiter rejection scenario (parallel).
 *
 * Three calls placed to the same destination with a limiter of 1:
 *   - alice1 → INVITE → established (limiter slot consumed)
 *   - alice2 → INVITE (1s later) → 486 Busy Here (limiter rejects) → ACK
 *   - alice1 hangs up (limiter slot freed)
 *   - alice3 → INVITE (after alice1 BYE completes) → established (limiter slot available)
 *
 * Uses the parallel() DSL to run call flows concurrently against
 * the same B2BUA instance sharing Redis limiter state.
 */

import { scenario, parallel } from "../fullcall/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../fullcall/helpers/sdp.js"

const limiterInstruction = JSON.stringify({
  action: "route",
  call_limiter: [{ id: "test-limiter", limit: 1 }]
})

/** alice3 routes to port 5667 (bob3) with the same limiter. */
const limiterInstruction3 = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: 5667 },
  call_limiter: [{ id: "test-limiter", limit: 1 }]
})

/**
 * Scenario A: alice1 calls, bob1 answers — limiter slot consumed.
 * After alice2 is rejected, alice1 hangs up to free the limiter slot.
 */
const acceptedCall = scenario("accepted-call", (s) => {
  const alice1 = s.agent("alice1", { uri: "sip:alice1@test" })
  const bob1 = s.agent("bob1", { uri: "sip:bob1@test", port: 5666 })

  // alice1 sends INVITE with limiter instruction.
  // Parallel scenarios share the offer-answer tracker; skip SDP correlation here
  // since the test is about limiter slots, not SDP semantics.
  const { dialog: alice1Dialog, transaction: alice1InviteTxn } = alice1.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: { "X-Api-Call": limiterInstruction },
    skipValidation: ["offerAnswer"],
  })

  // 100 Trying
  alice1InviteTxn.expect(100)

  // bob1 receives INVITE from B2BUA
  const { dialog: bob1Dialog, transaction: bob1InviteTxn } = bob1.receiveInitialInvite()

  // bob1 sends 180 Ringing
  bob1InviteTxn.reply(180)
  alice1InviteTxn.expect(180)

  // bob1 answers with 200 OK
  bob1InviteTxn.reply(200, { body: sdpAnswer() })
  alice1InviteTxn.expect(200)

  // ACK
  alice1Dialog.ack()
  bob1Dialog.expect("ACK")

  // Call stays up — wait for rejected call scenario to complete
  s.pause(3000)

  // alice1 hangs up — frees the limiter slot
  const alice1ByeTxn = alice1Dialog.bye()
  const bob1ByeTxn = bob1Dialog.expect("BYE")
  bob1ByeTxn.reply(200)
  alice1ByeTxn.expect(200)
})

/**
 * Scenario B: alice2 calls after 1s delay — gets 486 Busy Here.
 * The limiter "test-limiter" is already at count=1 (limit=1) from call A,
 * so checkAndIncrement returns -1 → handler sends 486.
 */
const rejectedCall = scenario("rejected-call", (s) => {
  const alice2 = s.agent("alice2", { uri: "sip:alice2@test" })

  // Wait for call A to establish
  s.pause(1000)

  // alice2 sends INVITE with same limiter instruction.
  // Rejected with 486 — offer never answered by design.
  const { dialog: alice2Dialog, transaction: alice2InviteTxn } = alice2.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: { "X-Api-Call": limiterInstruction },
    skipValidation: ["offerAnswer"],
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

  // ACK for non-2xx (completes the INVITE client transaction)
  alice2Dialog.ack()
})

/**
 * Scenario C: alice3 calls after alice1 hangs up — limiter slot is free.
 * Waits for alice1's BYE to complete (pause 5s covers call A's 3s hold + BYE),
 * then sends INVITE which should be accepted (limiter count back to 0).
 */
const postHangupCall = scenario("post-hangup-call", (s) => {
  const alice3 = s.agent("alice3", { uri: "sip:alice3@test" })
  const bob3 = s.agent("bob3", { uri: "sip:bob3@test", port: 5667 })

  // Wait for alice1 to hang up (3s hold + BYE exchange + margin)
  s.pause(5000)

  // alice3 sends INVITE with limiter instruction routing to bob3's port.
  // Parallel scenarios share the tracker; blind answer matching across parallel
  // calls is ambiguous, so skip SDP correlation here.
  const { dialog: alice3Dialog, transaction: alice3InviteTxn } = alice3.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: { "X-Api-Call": limiterInstruction3 },
    skipValidation: ["offerAnswer"],
  })

  // 100 Trying
  alice3InviteTxn.expect(100)

  // bob3 receives INVITE — limiter allowed it (slot was freed by alice1 BYE)
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
export const limiterRejection = parallel("limiter-rejection", acceptedCall, rejectedCall, postHangupCall)
