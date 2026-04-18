/**
 * REFER safety-timer scenarios (slice 8).
 *
 * This suite exists to exercise the transfer-specific timers:
 *
 *   - `refer_subscription_expiry` (60s default) — HTTP hangs, subscription
 *     times out. Covered by `referHttpTimeout` in refer-reject.ts; not
 *     duplicated here.
 *   - `no_answer_timeout` during c-ringing — C never answers initial INVITE.
 *     Covered by `referAllowCNoAnswer` in refer-allow.ts.
 *   - `refer_reinvite_answer` (32s default) — a-realign re-INVITE never
 *     answered. Covered by `referAllowFullATimeout` in refer-full-transfer.ts.
 *   - `refer_overall_safety` (120s default) — end-to-end safety net, fires
 *     only when no other per-phase timer caught the stuck state. Tested
 *     below with `referReinviteAnswerSec` pushed out so the overall-safety
 *     timer expires first while the call is stalled in `c-realigning`.
 */

import { scenario } from "../framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../helpers/sdp.js"

function decodeBody(body: Uint8Array | undefined): string {
  if (body === undefined || body.byteLength === 0) return ""
  return new TextDecoder().decode(body)
}

function headerValue(
  msg: { headers: ReadonlyArray<{ name: string; value: string }> },
  name: string,
): string | undefined {
  const target = name.toLowerCase()
  return msg.headers.find((h) => h.name.toLowerCase() === target)?.value
}

const CHARLIE_PORT = 5667
const REFER_TO_CHARLIE = `<sip:charlie@127.0.0.1:${CHARLIE_PORT}>`

function xApiAllowC(): Record<string, string> {
  const instruction = {
    refer_key: "refer-allow-c",
    destination: { host: "127.0.0.1", port: CHARLIE_PORT },
  }
  return { "X-Api-Call": JSON.stringify(instruction) }
}

// ── Overall-safety timer fires while stuck in c-realigning → rollback ────

export const referOverallSafetyFires = scenario(
  "refer-overall-safety-fires",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    // Per-scenario config override pushes refer_reinvite_answer past
    // refer_overall_safety so the overall watchdog trips first.
    // Stalled re-INVITE C is retransmitted by the INVITE client
    // transaction until Timer B — absorb those retransmits.
    // Post-rollback BYEs can also be retransmitted once (Timer E at
    // 500ms) under TestClock's 100ms-chunk advancement before the 200
    // reply gets delivered. Tolerate those duplicate BYEs.
    charlie.allowExtra("INVITE")
    alice.allowExtra("BYE")
    bob.allowExtra("BYE")
    charlie.allowExtra("BYE")

    const aliceSdp = sdpOffer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15065",
      { body: aliceSdp },
    )
    aliceInviteTxn.expect(100)
    const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()
    bobInviteTxn.reply(180)
    aliceInviteTxn.expect(180)
    bobInviteTxn.reply(200, { body: sdpAnswer(aliceSdp) })
    aliceInviteTxn.expect(200)
    aliceDialog.ack()
    bobDialog.expect("ACK")

    const bobReferTxn = bobDialog.send("REFER", {
      overrides: {
        headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiAllowC() },
      },
    })
    bobReferTxn.expect(202)

    const notifyTryingTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.type === "request" &&
        decodeBody(msg.body).includes("SIP/2.0 100 Trying"),
    })
    notifyTryingTxn.reply(200)

    // C answers initial INVITE → phase becomes c-realigning, re-INVITE C fires.
    const { dialog: charlieDialog, transaction: charlieInviteTxn } =
      charlie.receiveInitialInvite()
    charlieInviteTxn.reply(200, { body: sdpAnswer() })
    charlieInviteTxn.expectAck()

    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.type === "request" &&
        (headerValue(msg, "subscription-state") ?? "").startsWith("terminated") &&
        decodeBody(msg.body).includes("SIP/2.0 200"),
    })
    notifyTermTxn.reply(200)

    // Observe the c-realigning re-INVITE but do NOT answer it. With the
    // per-scenario config override below, refer_reinvite_answer is 600s and
    // refer_overall_safety is 10s — the overall watchdog trips first and
    // begin-termination BYEs all three legs.
    charlieDialog.expect("INVITE", { skipValidation: ["offerAnswer"] })

    // Advance just past the overall-safety timer (10s via configOverrides).
    // Keep this as tight as possible so no other timers (Timer B on the
    // pending re-INVITE client transaction at ~32s) fire during the
    // window.
    s.pause(10_500)

    const aliceByeTxn = aliceDialog.expect("BYE")
    aliceByeTxn.reply(200)
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    const charlieByeTxn = charlieDialog.expect("BYE")
    charlieByeTxn.reply(200)
  },
)
