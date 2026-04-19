/**
 * Failover/reroute scenario.
 *
 * Tests that when the first b-leg rejects, the B2BUA calls /call/failure
 * and — based on the X-Api-Call instruction — creates a new b-leg to
 * a backup destination.
 *
 * Flow:
 *   alice → INVITE (with on_failure = failover to bob2's port)
 *   B2BUA → INVITE to bob1 (primary)
 *   bob1 → 503 Service Unavailable
 *   B2BUA → POST /call/failure → gets failover instruction
 *   B2BUA → INVITE to bob2 (backup)
 *   bob2 → 180 → 200 OK
 *   alice → 200 OK → ACK (relayed to bob2)
 *   pause → alice BYE → bob2 BYE → 200
 */

import { scenario } from "../e2e/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../e2e/helpers/sdp.js"

const failoverInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: 5666 },
  on_failure: {
    action: "failover",
    destination: { host: "127.0.0.1", port: 5667 },
    new_ruri: "sip:+1234@127.0.0.1:5667",
  }
})

export const failoverReroute = scenario("failover-reroute", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob1 = s.agent("bob1", { uri: "sip:bob1@test", port: 5666 })
  const bob2 = s.agent("bob2", { uri: "sip:bob2@test", port: 5667 })

  // Bob1 will receive ACK for the 503 (RFC 3261 §17.1.1.3 — auto-ACK for non-2xx)
  bob1.allowExtra("ACK")

  // alice sends INVITE with failover instruction
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: { "X-Api-Call": failoverInstruction },
  })

  // 100 Trying
  aliceInviteTxn.expect(100)

  // bob1 (primary) receives INVITE from B2BUA
  const { transaction: bob1InviteTxn } = bob1.receiveInitialInvite()

  // bob1 rejects with 503 Service Unavailable
  bob1InviteTxn.reply(503)

  // B2BUA calls /call/failure → gets failover to bob2
  // B2BUA creates new b-leg INVITE to bob2

  // bob2 (backup) receives INVITE from B2BUA
  const { dialog: bob2Dialog, transaction: bob2InviteTxn } = bob2.receiveInitialInvite()

  // bob2 sends 180 Ringing
  bob2InviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  // bob2 answers with 200 OK
  bob2InviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)

  // ACK (relayed to bob2)
  aliceDialog.ack()
  bob2Dialog.expect("ACK")

  // Call is established — short hold
  s.pause(1000)

  // alice hangs up
  const aliceByeTxn = aliceDialog.bye()
  const bob2ByeTxn = bob2Dialog.expect("BYE")
  bob2ByeTxn.reply(200)
  aliceByeTxn.expect(200)
}).skipFinalSweep()
// FIXME(failover-cleanup): same leak shape as suppress18xFailoverReject and
// shared-port failoverWithHeaders — after bob1 rejects (503) and bob2 wins,
// CallState/TimerService leaks survive a complete BYE flow. Tracked as a
// single B2BUA cleanup bug; remove `.skipFinalSweep()` once fixed.
