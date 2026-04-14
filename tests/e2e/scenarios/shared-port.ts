/**
 * X-Api-Call routing scenarios — verifies explicit routing with X-Api-Call
 * header and the Call-ID demuxer in simulated transport.
 *
 * Test 1: Explicit routing via X-Api-Call (not relying on default route).
 *
 * Test 2: Two Bobs with failover on 486 Busy — bob1 rejects, B2BUA
 *         reroutes to bob2 via /call/failure with update_headers.
 */

import { scenario } from "../framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../helpers/sdp.js"

// ---------------------------------------------------------------------------
// Test 1: Explicit routing with X-Api-Call + X-Test-Agent
// ---------------------------------------------------------------------------

// TODO NOT FULLY IMPLMENTED WORK IN PROGRESSS

const BOB_PORT = 5680

const routeToBob = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB_PORT },
  update_headers: { "X-Test-Agent": "bob" },
})

export const explicitRouteCall = scenario("explicit-route-call", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: { "X-Api-Call": routeToBob },
  })

  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)

  aliceDialog.ack()
  bobDialog.expect("ACK")

  s.pause(1000)

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ---------------------------------------------------------------------------
// Test 2: Two Bobs with failover on 486 Busy (distinct ports)
// ---------------------------------------------------------------------------

const BOB1_PORT = 5681
const BOB2_PORT = 5682

const routeWithFailover = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB1_PORT },
  update_headers: { "X-Test-Agent": "bob1" },
  on_failure: {
    action: "failover",
    destination: { host: "127.0.0.1", port: BOB2_PORT },
    new_ruri: `sip:+1234@127.0.0.1:${BOB2_PORT}`,
    update_headers: { "X-Test-Agent": "bob2" },
  },
})

export const failoverWithHeaders = scenario("failover-with-headers", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob1 = s.agent("bob1", { uri: "sip:bob1@test", port: BOB1_PORT })
  const bob2 = s.agent("bob2", { uri: "sip:bob2@test", port: BOB2_PORT })

  // Bob1 will receive ACK for the 486 (RFC 3261 §17.1.1.3 — auto-ACK for non-2xx)
  bob1.allowExtra("ACK")

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: { "X-Api-Call": routeWithFailover },
  })

  aliceInviteTxn.expect(100)

  // bob1 receives initial INVITE, rejects with 486 Busy
  const { transaction: bob1InviteTxn } = bob1.receiveInitialInvite()
  bob1InviteTxn.reply(486)

  // B2BUA failover → bob2 receives new INVITE
  const { dialog: bob2Dialog, transaction: bob2InviteTxn } = bob2.receiveInitialInvite()

  bob2InviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  bob2InviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)

  aliceDialog.ack()
  bob2Dialog.expect("ACK")

  s.pause(1000)

  const aliceByeTxn = aliceDialog.bye()
  const bob2ByeTxn = bob2Dialog.expect("BYE")
  bob2ByeTxn.reply(200)
  aliceByeTxn.expect(200)
})
