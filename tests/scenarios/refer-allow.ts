/**
 * REFER allow-path scenarios (slice 5).
 *
 * Each scenario establishes an A↔B call and issues a REFER from B that the
 * mock /call/refer authorises (X-Api-Call `refer-allow-c`). The B2BUA builds
 * a C leg with held SDP and drives it through initial INVITE/200 OK/ACK —
 * stopping **before** any re-INVITEs (slices 6+ wire those).
 */

import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../src/test-harness/framework/helpers/sdp.js"

const CHARLIE_PORT = 5667
const REFER_TO_CHARLIE = `<sip:charlie@127.0.0.1:${CHARLIE_PORT}>`

// Build a REFER X-Api-Call value for refer-allow-c (optionally with extras).
function xApiAllowC(extras?: Record<string, unknown>): Record<string, string> {
  const instruction: Record<string, unknown> = {
    refer_key: "refer-allow-c",
    destination: { host: "127.0.0.1", port: CHARLIE_PORT },
    ...extras,
  }
  return { "X-Api-Call": JSON.stringify(instruction) }
}

// ── 1. Happy path up to final NOTIFY (no re-INVITEs) ──────────────────────

export const referAllowHappy = scenario("refer-allow-happy", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
  const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

  // Slice 6: after C's 200, the B2BUA emits the c-realigning re-INVITE to C.
  // This scenario does not script the re-INVITE exchange — tolerate it here.
  charlie.allowExtra("INVITE")

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15062",
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

  // REFER → 202
  const bobReferTxn = bobDialog.send("REFER", {
    overrides: {
      headers: {
        "Refer-To": REFER_TO_CHARLIE,
        ...xApiAllowC(),
      },
    },
  })
  bobReferTxn.expect(202)

  // NOTIFY 100 active
  const notifyTryingTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      (msg.getHeader("subscription-state")[0] ?? "").startsWith("active") &&
      msg.bodyText()?.includes("SIP/2.0 100 Trying") === true,
  })
  notifyTryingTxn.reply(200)

  // Charlie receives initial INVITE from B2BUA (held SDP).
  const { dialog: charlieDialog, transaction: charlieInviteTxn } =
    charlie.receiveInitialInvite()
  charlieInviteTxn.reply(180)

  // NOTIFY 180 active
  const notify180Txn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      (msg.getHeader("subscription-state")[0] ?? "").startsWith("active") &&
      msg.bodyText()?.includes("SIP/2.0 180 Ringing") === true,
  })
  notify180Txn.reply(200)

  // Charlie answers 200.
  charlieInviteTxn.reply(200, { body: sdpAnswer() })
  charlieInviteTxn.expectAck()

  // NOTIFY 200 terminated — final sipfrag, subscription closes.
  const notifyTermTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      (msg.getHeader("subscription-state")[0] ?? "").startsWith("terminated") &&
      msg.bodyText()?.includes("SIP/2.0 200") === true,
  })
  notifyTermTxn.reply(200)

  // c-realigning re-INVITE arrives on charlie — receive it (don't reply) so
  // the dialog CSeq tracker stays in sync for the subsequent BYE.
  charlieDialog.expect("INVITE", { skipValidation: ["offerAnswer"] })

  // A↔B still bridged (no merge happened in slice 5). Tear down via A BYE.
  // begin-termination BYEs every still-confirmed leg — alice's BYE → bob,
  // and the still-bridged c-leg gets BYE'd too (post-REFER call has 3 legs).
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  const charlieByeTxn = charlieDialog.expect("BYE")
  charlieByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── 2. C rejects 486 Busy Here → NOTIFY 486 terminated ────────────────────

export const referAllowC486 = scenario("refer-allow-c-rejects-486", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
  const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15062",
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

  const bobReferTxn = bobDialog.send("REFER", {
    overrides: {
      headers: {
        "Refer-To": REFER_TO_CHARLIE,
        ...xApiAllowC(),
      },
    },
  })
  bobReferTxn.expect(202)

  const notifyTryingTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      (msg.getHeader("subscription-state")[0] ?? "").startsWith("active") &&
      msg.bodyText()?.includes("SIP/2.0 100 Trying") === true,
  })
  notifyTryingTxn.reply(200)

  const { transaction: charlieInviteTxn } = charlie.receiveInitialInvite()
  // Charlie rejects 486. TransactionLayer (as UAC on the C leg) generates
  // the hop-by-hop ACK automatically — charlie receives it.
  charlieInviteTxn.reply(486, { reason: "Busy Here" })
  charlieInviteTxn.expectAck()

  const notifyTermTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      (msg.getHeader("subscription-state")[0] ?? "").startsWith("terminated") &&
      msg.bodyText()?.includes("SIP/2.0 486") === true,
  })
  notifyTermTxn.reply(200)

  // A↔B remains alive — tear down normally.
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── 3. C rejects 603 Declined → NOTIFY 603 terminated ─────────────────────

export const referAllowC603 = scenario("refer-allow-c-rejects-603", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
  const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15062",
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

  const bobReferTxn = bobDialog.send("REFER", {
    overrides: {
      headers: {
        "Refer-To": REFER_TO_CHARLIE,
        ...xApiAllowC(),
      },
    },
  })
  bobReferTxn.expect(202)

  const notifyTryingTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      (msg.getHeader("subscription-state")[0] ?? "").startsWith("active") &&
      msg.bodyText()?.includes("SIP/2.0 100 Trying") === true,
  })
  notifyTryingTxn.reply(200)

  const { transaction: charlieInviteTxn } = charlie.receiveInitialInvite()
  charlieInviteTxn.reply(603, { reason: "Declined" })
  charlieInviteTxn.expectAck()

  const notifyTermTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      (msg.getHeader("subscription-state")[0] ?? "").startsWith("terminated") &&
      msg.bodyText()?.includes("SIP/2.0 603") === true,
  })
  notifyTermTxn.reply(200)

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── 4. C no-answer → NOTIFY 408 terminated after the no-answer timer ──────

export const referAllowCNoAnswer = scenario("refer-allow-c-no-answer", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
  const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

  // 6s TestClock advance may surface timer retransmits of the initial NOTIFY
  // 100 active — tolerate any extra NOTIFY beyond the ones we assert.
  bob.allowExtra("NOTIFY")
  // destroy-leg on C deletes the call-leg record without BYEing (no confirmed
  // dialog). Tolerate any stray CANCEL if the framework decides to issue one.
  charlie.allowExtra("CANCEL")

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15062",
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

  // Very short no-answer timeout so the test runs fast under TestClock.
  const bobReferTxn = bobDialog.send("REFER", {
    overrides: {
      headers: {
        "Refer-To": REFER_TO_CHARLIE,
        ...xApiAllowC({ no_answer_timeout_sec: 5 }),
      },
    },
  })
  bobReferTxn.expect(202)

  const notifyTryingTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      (msg.getHeader("subscription-state")[0] ?? "").startsWith("active") &&
      msg.bodyText()?.includes("SIP/2.0 100 Trying") === true,
  })
  notifyTryingTxn.reply(200)

  const { transaction: charlieInviteTxn } = charlie.receiveInitialInvite()
  charlieInviteTxn.reply(180)

  // Assert the 180 NOTIFY so the 5s window starts only after the B2BUA has
  // observed charlie ringing.
  const notify180Txn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      (msg.getHeader("subscription-state")[0] ?? "").startsWith("active") &&
      msg.bodyText()?.includes("SIP/2.0 180 Ringing") === true,
  })
  notify180Txn.reply(200)

  // Advance past the no-answer timer.
  s.pause(6_000)

  const notifyTermTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      (msg.getHeader("subscription-state")[0] ?? "").startsWith("terminated") &&
      msg.bodyText()?.includes("SIP/2.0 408") === true,
  })
  notifyTermTxn.reply(200)

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── 5. Multiple 18x dedup: 180 → 183 → 180 → exactly 2 NOTIFYs ────────────

export const referAllowCMultiple18x = scenario(
  "refer-allow-c-multiple-18x",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    // Slice 6: after C's 200, the B2BUA emits the c-realigning re-INVITE to C.
    charlie.allowExtra("INVITE")

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15062",
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

    const bobReferTxn = bobDialog.send("REFER", {
      overrides: {
        headers: {
          "Refer-To": REFER_TO_CHARLIE,
          ...xApiAllowC(),
        },
      },
    })
    bobReferTxn.expect(202)

    const notifyTryingTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("active") &&
        msg.bodyText()?.includes("SIP/2.0 100 Trying") === true,
    })
    notifyTryingTxn.reply(200)

    const { dialog: charlieDialog, transaction: charlieInviteTxn } =
      charlie.receiveInitialInvite()

    // 180 #1 → NOTIFY 180
    charlieInviteTxn.reply(180)
    const notify180aTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("active") &&
        msg.bodyText()?.includes("SIP/2.0 180") === true,
    })
    notify180aTxn.reply(200)

    // 183 #1 → NOTIFY 183
    charlieInviteTxn.reply(183, { reason: "Session Progress" })
    const notify183Txn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("active") &&
        msg.bodyText()?.includes("SIP/2.0 183") === true,
    })
    notify183Txn.reply(200)

    // 180 #2 (same code, different sequence) → NOTIFY 180 again (dedup only
    // against the last-sent status; 183 cleared 180's dedup).
    charlieInviteTxn.reply(180)
    const notify180bTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("active") &&
        msg.bodyText()?.includes("SIP/2.0 180") === true,
    })
    notify180bTxn.reply(200)

    // Identical 180 once more — should be deduped, no NOTIFY emitted.
    charlieInviteTxn.reply(180)

    // Finalise with 200 to end the INVITE transaction cleanly.
    charlieInviteTxn.reply(200, { body: sdpAnswer() })
    charlieInviteTxn.expectAck()

    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("terminated") &&
        msg.bodyText()?.includes("SIP/2.0 200") === true,
    })
    notifyTermTxn.reply(200)

    // c-realigning re-INVITE arrives on charlie — receive it (don't reply) so
    // the dialog CSeq tracker stays in sync for the subsequent BYE.
    charlieDialog.expect("INVITE", { skipValidation: ["offerAnswer"] })

    // begin-termination BYEs every still-confirmed leg — alice's BYE → bob,
    // and the still-bridged c-leg gets BYE'd too (post-REFER call has 3 legs).
    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    const charlieByeTxn = charlieDialog.expect("BYE")
    charlieByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)
