/**
 * In-dialog OPTIONS end-to-end relay scenario.
 *
 * RFC 3261 §11: OPTIONS queries capability of the far end. In a B2BUA
 * operating transparently on in-dialog traffic, OPTIONS must be forwarded
 * to the peer leg with its payload intact, and the peer's response relayed
 * back to the originator.
 *
 * The scenario exercises both directions (a→b and b→a) with a custom body
 * to verify payload transparency.
 */

import { scenario } from "../fullcall/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../fullcall/helpers/sdp.js"

const aliceBody = new TextEncoder().encode("alice-options-payload\r\n")
const bobBody = new TextEncoder().encode("bob-options-payload\r\n")

export const indialogOptions = scenario("indialog-options", (s) => {
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

  // ── Alice → B2BUA → Bob OPTIONS (payload preserved) ─────────────────────

  const aliceOptionsTxn = aliceDialog.send("OPTIONS", {
    body: aliceBody,
    overrides: { headers: { "Content-Type": "application/x-test-a" } },
  })

  bobDialog
    .expect("OPTIONS", {
      predicate: (msg) => {
        if (msg.type !== "request") return false
        const ct = msg.headers.find((h) => h.name.toLowerCase() === "content-type")?.value
        return ct === "application/x-test-a" &&
          new TextDecoder().decode(msg.body) === new TextDecoder().decode(aliceBody)
      },
    })
    .reply(200)

  aliceOptionsTxn.expect(200)

  // ── Bob → B2BUA → Alice OPTIONS (reverse direction, distinct payload) ───

  const bobOptionsTxn = bobDialog.send("OPTIONS", {
    body: bobBody,
    overrides: { headers: { "Content-Type": "application/x-test-b" } },
  })

  aliceDialog
    .expect("OPTIONS", {
      predicate: (msg) => {
        if (msg.type !== "request") return false
        const ct = msg.headers.find((h) => h.name.toLowerCase() === "content-type")?.value
        return ct === "application/x-test-b" &&
          new TextDecoder().decode(msg.body) === new TextDecoder().decode(bobBody)
      },
    })
    .reply(200)

  bobOptionsTxn.expect(200)

  // ── Teardown ─────────────────────────────────────────────────────────────

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})
