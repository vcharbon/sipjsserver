/**
 * handle-481 during keepalive scenario:
 *
 * Long call; after 15 minutes the keepalive timer fires and OPTIONS is sent
 * to both legs. Alice replies 200 OK; Bob replies 481 "Call/Transaction Does
 * Not Exist". The B2BUA's [handle-481](src/b2bua/rules/defaults/LifecycleRules.ts)
 * rule matches on the 481 and emits:
 *   - terminate-leg(bob, bye_timeout)  — marks bob dead, suppresses BYE to bob
 *   - add-cdr-event(bye, "481 Dialog Does Not Exist")
 *   - begin-termination                — BYEs the responsive peer (alice)
 */

import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../src/test-harness/framework/helpers/sdp.js"

const KEEPALIVE_INTERVAL_MS = 900_000

export const keepalive481 = scenario("keepalive-481", (s) => {
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

  // ── Keepalive fires, bob answers 481 ─────────────────────────────────────

  s.pause(KEEPALIVE_INTERVAL_MS)

  aliceDialog.expect("OPTIONS").reply(200)
  bobDialog.expect("OPTIONS").reply(481)

  // ── handle-481 → begin-termination → BYE to the responsive peer (alice) ─
  // No BYE is sent to bob (terminate-leg with bye_timeout disposition).

  aliceDialog.expect("BYE").reply(200)
})
