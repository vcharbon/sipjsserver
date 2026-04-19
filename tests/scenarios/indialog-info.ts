/**
 * In-dialog INFO end-to-end relay scenario.
 *
 * RFC 6086: INFO carries mid-dialog application data (DTMF,
 * application/dtmf-relay, etc.) and must be forwarded end-to-end by a
 * transparent B2BUA. Payload (body + Content-Type) is preserved, with
 * only dialog identifiers and Via rewritten per hop.
 */

import { scenario } from "../fullcall/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../fullcall/helpers/sdp.js"

const dtmfFromAlice = new TextEncoder().encode("Signal=5\r\nDuration=160\r\n")
const dtmfFromBob = new TextEncoder().encode("Signal=9\r\nDuration=160\r\n")

export const indialogInfo = scenario("indialog-info", (s) => {
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

  // ── Alice → B2BUA → Bob INFO (DTMF payload) ─────────────────────────────

  const aliceInfoTxn = aliceDialog.send("INFO", {
    body: dtmfFromAlice,
    overrides: { headers: { "Content-Type": "application/dtmf-relay" } },
  })

  bobDialog
    .expect("INFO", {
      predicate: (msg) => {
        if (msg.type !== "request") return false
        const ct = msg.headers.find((h) => h.name.toLowerCase() === "content-type")?.value
        return ct === "application/dtmf-relay" &&
          new TextDecoder().decode(msg.body) === new TextDecoder().decode(dtmfFromAlice)
      },
    })
    .reply(200)

  aliceInfoTxn.expect(200)

  // ── Bob → B2BUA → Alice INFO (reverse direction) ────────────────────────

  const bobInfoTxn = bobDialog.send("INFO", {
    body: dtmfFromBob,
    overrides: { headers: { "Content-Type": "application/dtmf-relay" } },
  })

  aliceDialog
    .expect("INFO", {
      predicate: (msg) => {
        if (msg.type !== "request") return false
        const ct = msg.headers.find((h) => h.name.toLowerCase() === "content-type")?.value
        return ct === "application/dtmf-relay" &&
          new TextDecoder().decode(msg.body) === new TextDecoder().decode(dtmfFromBob)
      },
    })
    .reply(200)

  bobInfoTxn.expect(200)

  // ── Teardown ─────────────────────────────────────────────────────────────

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})
