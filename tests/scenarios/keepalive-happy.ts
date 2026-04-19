/**
 * keepalive happy-path scenario:
 *
 * After a call is established, advance TestClock past the keepalive interval.
 * The B2BUA fires the keepalive timer and sends OPTIONS to both legs; each
 * replies 200 OK. The timer is then rescheduled — we advance a second cycle
 * to confirm re-firing, then tear the call down with BYE.
 *
 * Exercises:
 *   - [keepalive](src/b2bua/rules/defaults/TimerRules.ts) — the keepalive
 *     timer handler that sends OPTIONS to all peered legs.
 *   - [absorb-options-200](src/b2bua/rules/defaults/DialogRules.ts) — the
 *     200 OK for each OPTIONS is absorbed (not relayed).
 *
 * Default simulated-backend config: keepaliveIntervalSec = 900 (15 min),
 * keepaliveTimeoutSec = 10. TestClock advances instantly.
 */

import { scenario } from "../e2e/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../e2e/helpers/sdp.js"

const KEEPALIVE_INTERVAL_MS = 900_000

export const keepaliveHappy = scenario("keepalive-happy", (s) => {
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

  // ── First keepalive cycle (15 min) ───────────────────────────────────────

  s.pause(KEEPALIVE_INTERVAL_MS)

  aliceDialog.expect("OPTIONS").reply(200)
  bobDialog.expect("OPTIONS").reply(200)

  // ── Second keepalive cycle — confirms the timer was rescheduled ──────────

  s.pause(KEEPALIVE_INTERVAL_MS)

  aliceDialog.expect("OPTIONS").reply(200)
  bobDialog.expect("OPTIONS").reply(200)

  // ── Teardown ─────────────────────────────────────────────────────────────

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})
