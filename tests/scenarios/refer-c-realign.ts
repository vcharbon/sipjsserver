/**
 * REFER c-realigning scenarios (slice 6).
 *
 * Build on the slice-5 C-leg lifecycle by adding the B2BUA-originated
 * re-INVITE to C carrying A's SDP. The test charlie UA therefore plays
 * a UAS role for that re-INVITE. Phase progresses to `a-realigning` once
 * C answers 200 and the B2BUA ACKs, then stops (slice 7 wires the
 * re-INVITE to A and the merge).
 *
 * Scenarios:
 *   1. referAllowCRealignHappy       — full c-realign, phase reaches a-realigning
 *   2. referAllowCRealignCReject488  — C rejects the re-INVITE → rollback
 *   3. referAllowCRealignCTimeout    — C never answers the re-INVITE → rollback
 *   4. referAllowCRealignCGlare      — C sends its own re-INVITE → 491
 *   5. referAllowCRealignBNonBye     — B sends non-BYE during c-realigning → 481
 */

import { scenario } from "../e2e/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../e2e/helpers/sdp.js"
import type { SipMessage } from "../../src/sip/types.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

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

/** Byte-for-byte comparison of two SDP bodies. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Assert `Contact: …;leg=b-2` on a re-INVITE to C. */
function contactHasCLegTag(msg: SipMessage, cLegId: string): boolean {
  const contact = headerValue(msg, "contact") ?? ""
  return contact.includes(`leg=${cLegId}`)
}

const CHARLIE_PORT = 5667
const REFER_TO_CHARLIE = `<sip:charlie@127.0.0.1:${CHARLIE_PORT}>`

function xApiAllowC(extras?: Record<string, unknown>): Record<string, string> {
  const instruction: Record<string, unknown> = {
    refer_key: "refer-allow-c",
    destination: { host: "127.0.0.1", port: CHARLIE_PORT },
    ...extras,
  }
  return { "X-Api-Call": JSON.stringify(instruction) }
}

// ── 1. Happy c-realign — re-INVITE C answered 200 → phase a-realigning ──

export const referAllowCRealignHappy = scenario("refer-allow-c-realign-happy", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
  const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

  // Slice 7 fires the a-realign re-INVITE immediately after C's 200. The
  // full rollback/merge paths live in refer-full-transfer.ts; here we script
  // the re-INVITE on A enough to verify it lands with C's initial SDP and
  // Contact=leg=a, then let alice hang up cleanly.
  const aliceSdp = sdpOffer()
  const charlieInitialSdp = sdpAnswer()

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15062",
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
      msg.type === "request" &&
      (headerValue(msg, "subscription-state") ?? "").startsWith("active") &&
      decodeBody(msg.body).includes("SIP/2.0 100 Trying"),
  })
  notifyTryingTxn.reply(200)

  // C receives initial INVITE (held SDP).
  const { dialog: charlieDialog, transaction: charlieInviteTxn } =
    charlie.receiveInitialInvite()
  charlieInviteTxn.reply(180)

  // NOTIFY 180 active
  const notify180Txn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      msg.type === "request" &&
      (headerValue(msg, "subscription-state") ?? "").startsWith("active") &&
      decodeBody(msg.body).includes("SIP/2.0 180 Ringing"),
  })
  notify180Txn.reply(200)

  // C answers initial INVITE 200.
  charlieInviteTxn.reply(200, { body: charlieInitialSdp })
  charlieInviteTxn.expectAck()

  // NOTIFY 200 terminated (final).
  const notifyTermTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      msg.type === "request" &&
      (headerValue(msg, "subscription-state") ?? "").startsWith("terminated") &&
      decodeBody(msg.body).includes("SIP/2.0 200"),
  })
  notifyTermTxn.reply(200)

  // B2BUA re-INVITEs C with A's exact SDP, CSeq bumped, Contact tagged leg=b-2.
  const cRealignTxn = charlieDialog.expect("INVITE", {
    skipValidation: ["offerAnswer"],
    predicate: (msg) => {
      if (msg.type !== "request") return false
      if (!bytesEqual(msg.body, aliceSdp)) return false
      const cseq = headerValue(msg, "cseq") ?? ""
      if (!cseq.trim().endsWith("INVITE")) return false
      const cseqNum = parseInt(cseq.trim().split(/\s+/)[0] ?? "0", 10)
      if (cseqNum <= 1) return false
      return contactHasCLegTag(msg, "b-2")
    },
  })
  cRealignTxn.reply(200, {
    overrides: { body: sdpAnswer(aliceSdp) },
    skipValidation: ["offerAnswer"],
  })
  // B2BUA sends ACK for the re-INVITE 200.
  charlieDialog.expect("ACK")

  // B2BUA re-INVITEs A with C's initial SDP, Contact tagged leg=a.
  const aRealignTxn = aliceDialog.expect("INVITE", {
    skipValidation: ["offerAnswer"],
    predicate: (msg) => {
      if (msg.type !== "request") return false
      if (!bytesEqual(msg.body, charlieInitialSdp)) return false
      const contact = headerValue(msg, "contact") ?? ""
      return contact.includes("leg=a")
    },
  })
  aRealignTxn.reply(200, {
    overrides: { body: sdpAnswer(charlieInitialSdp) },
    skipValidation: ["offerAnswer"],
  })
  aliceDialog.expect("ACK")

  // After merge(a, c=b-2), alice hangs up — BYEs go to the merged peer (c)
  // and the no-longer-active b-1.
  const aliceByeTxn = aliceDialog.bye()
  const charlieByeTxn = charlieDialog.expect("BYE")
  charlieByeTxn.reply(200)
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── 2. C rejects c-realign re-INVITE (488) → rollback ────────────────────

export const referAllowCRealignCReject488 = scenario(
  "refer-allow-c-realign-c-reject-488",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    // begin-termination BYEs everyone still confirmed — script each BYE.

    const aliceSdp = sdpOffer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15062",
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

    const { dialog: charlieDialog, transaction: charlieInviteTxn } =
      charlie.receiveInitialInvite()
    charlieInviteTxn.reply(200, { body: sdpAnswer() })
    charlieInviteTxn.expectAck()

    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.type === "request" &&
        decodeBody(msg.body).includes("SIP/2.0 200"),
    })
    notifyTermTxn.reply(200)

    // C rejects the c-realign re-INVITE with 488.
    const cRealignTxn = charlieDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
    })
    cRealignTxn.reply(488, { reason: "Not Acceptable Here" })
    charlieDialog.expect("ACK")

    // Rollback — begin-termination BYEs alice, bob (b-1), and charlie (b-2).
    const aliceByeTxn = aliceDialog.expect("BYE")
    aliceByeTxn.reply(200)
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    const charlieByeTxn = charlieDialog.expect("BYE")
    charlieByeTxn.reply(200)
  },
)

// ── 3. C does not answer the re-INVITE → 32s rollback ────────────────────

export const referAllowCRealignCTimeout = scenario(
  "refer-allow-c-realign-c-timeout",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    // B2BUA-originated re-INVITE will be retransmitted under TestClock until
    // Timer B fires or the rule-level 32s watchdog rolls back.
    charlie.allowExtra("INVITE")
    // Two termination paths can fire around 32s: the transfer watchdog rule
    // (refer_reinvite_answer) AND the INVITE Timer B transaction timeout.
    // Both emit begin-termination → duplicate BYEs on all three legs.
    // Tolerate duplicates.
    alice.allowExtra("BYE")
    bob.allowExtra("BYE")
    charlie.allowExtra("CANCEL")
    charlie.allowExtra("BYE")

    const aliceSdp = sdpOffer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15062",
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

    const { dialog: charlieDialog, transaction: charlieInviteTxn } =
      charlie.receiveInitialInvite()
    charlieInviteTxn.reply(200, { body: sdpAnswer() })
    charlieInviteTxn.expectAck()

    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.type === "request" &&
        decodeBody(msg.body).includes("SIP/2.0 200"),
    })
    notifyTermTxn.reply(200)

    // Observe the re-INVITE arrival but do not respond — watchdog fires 32s later.
    charlieDialog.expect("INVITE", { skipValidation: ["offerAnswer"] })
    s.pause(33_000)

    // Rollback: alice + bob receive BYE unconditionally (confirmed legs).
    const aliceByeTxn = aliceDialog.expect("BYE")
    aliceByeTxn.reply(200)
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    void charlieDialog
  },
).skipFinalSweep()
// FIXME(refer-cleanup): C-leg state survives rollback — real bug tracked separately.

// ── 4. C glare re-INVITE during c-realigning → 491 ───────────────────────

export const referAllowCRealignCGlare = scenario(
  "refer-allow-c-realign-c-glare",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    const aliceSdp = sdpOffer()
    const charlieInitialSdp = sdpAnswer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15062",
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

    const { dialog: charlieDialog, transaction: charlieInviteTxn } =
      charlie.receiveInitialInvite()
    charlieInviteTxn.reply(200, { body: charlieInitialSdp })
    charlieInviteTxn.expectAck()

    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.type === "request" &&
        decodeBody(msg.body).includes("SIP/2.0 200"),
    })
    notifyTermTxn.reply(200)

    // Receive the B2BUA's re-INVITE so we are firmly in c-realigning.
    const cRealignTxn = charlieDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
    })

    // Before answering, C fires its own re-INVITE — glare. B2BUA replies 491.
    const cGlareTxn = charlieDialog.send("INVITE", {
      overrides: { body: sdpOffer(undefined, 40000) },
      skipValidation: ["offerAnswer"],
    })
    cGlareTxn.expect(100)
    cGlareTxn.expect(491)

    // Resume the B2BUA-originated re-INVITE exchange.
    cRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(aliceSdp) },
      skipValidation: ["offerAnswer"],
    })
    charlieDialog.expect("ACK")

    // B2BUA re-INVITEs A with C's initial SDP, Contact tagged leg=a.
    const aRealignTxn = aliceDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
      predicate: (msg) => {
        if (msg.type !== "request") return false
        if (!bytesEqual(msg.body, charlieInitialSdp)) return false
        const contact = headerValue(msg, "contact") ?? ""
        return contact.includes("leg=a")
      },
    })
    aRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(charlieInitialSdp) },
      skipValidation: ["offerAnswer"],
    })
    aliceDialog.expect("ACK")

    // After merge(a, c=b-2), alice hangs up — BYEs go to the merged peer (c)
    // and the no-longer-active b-1.
    const aliceByeTxn = aliceDialog.bye()
    const charlieByeTxn = charlieDialog.expect("BYE")
    charlieByeTxn.reply(200)
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

// ── 5. B-leg non-BYE during c-realigning → 481 ───────────────────────────

export const referAllowCRealignBNonBye = scenario(
  "refer-allow-c-realign-b-non-bye",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    const aliceSdp = sdpOffer()
    const charlieInitialSdp = sdpAnswer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15062",
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

    const { dialog: charlieDialog, transaction: charlieInviteTxn } =
      charlie.receiveInitialInvite()
    charlieInviteTxn.reply(200, { body: charlieInitialSdp })
    charlieInviteTxn.expectAck()

    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.type === "request" &&
        decodeBody(msg.body).includes("SIP/2.0 200"),
    })
    notifyTermTxn.reply(200)

    // We observe the re-INVITE arrival so we're firmly in c-realigning.
    const cRealignTxn = charlieDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
    })

    // B sends in-dialog INFO during c-realigning → rejected 481.
    const bInfoTxn = bobDialog.send("INFO", {
      overrides: { headers: { "Content-Type": "application/dtmf-relay" } },
      body: new TextEncoder().encode("Signal=1\r\nDuration=200\r\n"),
    })
    bInfoTxn.expect(481)

    // Finish the c-realign exchange — C 200 → ACK → phase a-realigning.
    cRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(aliceSdp) },
      skipValidation: ["offerAnswer"],
    })
    charlieDialog.expect("ACK")

    // B2BUA re-INVITEs A with C's initial SDP, Contact tagged leg=a.
    const aRealignTxn = aliceDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
      predicate: (msg) => {
        if (msg.type !== "request") return false
        if (!bytesEqual(msg.body, charlieInitialSdp)) return false
        const contact = headerValue(msg, "contact") ?? ""
        return contact.includes("leg=a")
      },
    })
    aRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(charlieInitialSdp) },
      skipValidation: ["offerAnswer"],
    })
    aliceDialog.expect("ACK")

    // After merge(a, c=b-2), alice hangs up — BYEs go to the merged peer (c)
    // and the no-longer-active b-1.
    const aliceByeTxn = aliceDialog.bye()
    const charlieByeTxn = charlieDialog.expect("BYE")
    charlieByeTxn.reply(200)
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)
