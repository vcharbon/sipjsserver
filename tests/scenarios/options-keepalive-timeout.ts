/**
 * OPTIONS keepalive timeout scenario:
 *
 * Call is established. B2BUA sends OPTIONS keepalive to both legs.
 * Alice does NOT respond to OPTIONS. Bob responds 200 OK.
 * After the keepalive timeout, B2BUA sends BYE to bob (alice is unresponsive).
 *
 * Requires short keepalive config (keepaliveIntervalSec: 2, keepaliveTimeoutSec: 3).
 */

import { scenario } from "../e2e/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../e2e/helpers/sdp.js"

export const optionsKeepaliveTimeout = scenario("options-keepalive-timeout", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  // ── Call setup ───────────────────────────────────────────────────────────

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", { body: sdpOffer() })
  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)
  aliceDialog.ack()
  bobDialog.expect("ACK")

  // ── Wait for keepalive OPTIONS ───────────────────────────────────────────
  // B2BUA sends OPTIONS after keepaliveIntervalSec (3s in test config).

  // Alice receives OPTIONS but does NOT respond (no send step).
  // allowReemission: transaction layer retransmits OPTIONS (Timer E) — silently ignore them.
  aliceDialog.expect("OPTIONS", { timeout: 10_000, allowReemission: true })

  // Bob receives OPTIONS and responds 200 OK.
  const bobOptionsTxn = bobDialog.expect("OPTIONS", { timeout: 10_000 })
  bobOptionsTxn.reply(200)

  // ── Keepalive timeout → BYE ──────────────────────────────────────────────
  // After keepaliveTimeoutSec (2s), B2BUA detects alice is unresponsive
  // and sends BYE to bob.

  const bobByeTxn = bobDialog.expect("BYE", { timeout: 10_000 })
  bobByeTxn.reply(200)
})
