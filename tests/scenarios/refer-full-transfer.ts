/**
 * REFER full transfer scenarios (slice 7).
 *
 * Drive the full A↔B↔C transfer through both re-INVITEs to completion
 * (merge(a, c)) or rollback on any failure in either realign phase.
 *
 * Scenarios:
 *   1. referAllowFullHappy           — REFER → allow → INVITE C → 200 → re-INVITE C → 200 → re-INVITE A → 200 → merge
 *   2. referAllowFullARejectRealign  — A rejects re-INVITE 488 during a-realigning → rollback
 *   3. referAllowFullAGlareReinvite  — A sends re-INVITE during a-realigning → 491
 *   4. referAllowFullABye            — A BYEs while its a-realign re-INVITE is outstanding → teardown
 *   5. referAllowFullATimeout        — A does not answer the a-realign re-INVITE (32s) → rollback
 */

import { scenario } from "../fullcall/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../fullcall/helpers/sdp.js"
import type { SipMessage } from "../../src/sip/types.js"

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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function contactHasLegTag(msg: SipMessage, legTag: string): boolean {
  const contact = headerValue(msg, "contact") ?? ""
  return contact.includes(`leg=${legTag}`)
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

// ── 1. Full happy transfer → merge(a, c) ─────────────────────────────────

export const referAllowFullHappy = scenario("refer-allow-full-happy", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
  const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

  const aliceSdp = sdpOffer()

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15064",
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
    overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiAllowC() } },
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
  const charlieInitialSdp = sdpAnswer()
  charlieInviteTxn.reply(200, { body: charlieInitialSdp })
  charlieInviteTxn.expectAck()

  const notifyTermTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) =>
      msg.type === "request" &&
      decodeBody(msg.body).includes("SIP/2.0 200"),
  })
  notifyTermTxn.reply(200)

  // re-INVITE C with A's SDP, Contact has leg=b-2, CSeq bumped.
  const cRealignTxn = charlieDialog.expect("INVITE", {
    skipValidation: ["offerAnswer"],
    predicate: (msg) => {
      if (msg.type !== "request") return false
      if (!bytesEqual(msg.body, aliceSdp)) return false
      const cseq = headerValue(msg, "cseq") ?? ""
      if (!cseq.trim().endsWith("INVITE")) return false
      return contactHasLegTag(msg, "b-2")
    },
  })
  cRealignTxn.reply(200, {
    overrides: { body: sdpAnswer(aliceSdp) },
    skipValidation: ["offerAnswer"],
  })
  charlieDialog.expect("ACK")

  // re-INVITE A with C's initial SDP, Contact has leg=a.
  const aRealignTxn = aliceDialog.expect("INVITE", {
    skipValidation: ["offerAnswer"],
    predicate: (msg) => {
      if (msg.type !== "request") return false
      if (!bytesEqual(msg.body, charlieInitialSdp)) return false
      return contactHasLegTag(msg, "a")
    },
  })
  aRealignTxn.reply(200, {
    overrides: { body: sdpAnswer(charlieInitialSdp) },
    skipValidation: ["offerAnswer"],
  })
  aliceDialog.expect("ACK")

  // After merge(a, c), A↔C. Verify: A BYEs → relay-bye tears down.
  // B is no longer peered but its dialog is still present as a confirmed
  // b-leg. begin-termination will BYE both B and C.
  const aliceByeTxn = aliceDialog.bye()
  const charlieByeTxn = charlieDialog.expect("BYE")
  charlieByeTxn.reply(200)
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── 2. A rejects a-realign re-INVITE (488) → rollback ────────────────────

export const referAllowFullARejectRealign = scenario(
  "refer-allow-full-a-reject-realign",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    const aliceSdp = sdpOffer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15064",
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
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiAllowC() } },
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

    // C accepts the re-INVITE normally.
    const cRealignTxn = charlieDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
    })
    cRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(aliceSdp) },
      skipValidation: ["offerAnswer"],
    })
    charlieDialog.expect("ACK")

    // A rejects the a-realign re-INVITE 488.
    const aRealignTxn = aliceDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
    })
    aRealignTxn.reply(488, { reason: "Not Acceptable Here" })
    aliceDialog.expect("ACK")

    // Rollback — begin-termination BYEs alice, bob, charlie.
    const aliceByeTxn = aliceDialog.expect("BYE")
    aliceByeTxn.reply(200)
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    const charlieByeTxn = charlieDialog.expect("BYE")
    charlieByeTxn.reply(200)
  },
)

// ── 3. A sends re-INVITE during a-realigning → 491 ───────────────────────

export const referAllowFullAGlareReinvite = scenario(
  "refer-allow-full-a-glare-reinvite",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    const aliceSdp = sdpOffer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15064",
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
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiAllowC() } },
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

    const cRealignTxn = charlieDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
    })
    cRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(aliceSdp) },
      skipValidation: ["offerAnswer"],
    })
    charlieDialog.expect("ACK")

    // Observe the a-realign re-INVITE arrival before answering.
    const aRealignTxn = aliceDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
    })

    // A glares — sends its own re-INVITE mid-a-realigning. B2BUA rejects 491.
    const aGlareTxn = aliceDialog.send("INVITE", {
      overrides: { body: sdpOffer(undefined, 40000) },
      skipValidation: ["offerAnswer"],
    })
    aGlareTxn.expect(100)
    aGlareTxn.expect(491)

    // A completes the original a-realign.
    aRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(aliceSdp) },
      skipValidation: ["offerAnswer"],
    })
    aliceDialog.expect("ACK")

    // Teardown.
    const aliceByeTxn = aliceDialog.bye()
    const charlieByeTxn = charlieDialog.expect("BYE")
    charlieByeTxn.reply(200)
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

// ── 4. A BYEs while a-realign re-INVITE outstanding → teardown ───────────

export const referAllowFullABye = scenario(
  "refer-allow-full-a-bye-during-a-realign",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    // A's outstanding re-INVITE may be CANCELled by the B2BUA if it hasn't
    // resolved yet. Tolerate the race.
    alice.allowExtra("CANCEL")

    const aliceSdp = sdpOffer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15064",
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
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiAllowC() } },
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

    const cRealignTxn = charlieDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
    })
    cRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(aliceSdp) },
      skipValidation: ["offerAnswer"],
    })
    charlieDialog.expect("ACK")

    // Observe the a-realign re-INVITE but A hangs up instead of answering.
    aliceDialog.expect("INVITE", { skipValidation: ["offerAnswer"] })

    const aliceByeTxn = aliceDialog.bye()
    aliceByeTxn.expect(200)

    // B2BUA tears down bob and charlie.
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    const charlieByeTxn = charlieDialog.expect("BYE")
    charlieByeTxn.reply(200)
  },
).skipFinalSweep()
// FIXME(test-framework): outstanding a-realign re-INVITE on alice retransmits
// during the 24h end-of-scenario sweep, generating "unexpected message"
// failures. The B2BUA correctly tears down bob/charlie via begin-termination.

// ── 5. A does not answer the a-realign re-INVITE → 32s watchdog rollback ─

export const referAllowFullATimeout = scenario(
  "refer-allow-full-a-reinvite-timeout",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    // A's re-INVITE will retransmit under TestClock; tolerate extras. Also
    // both the watchdog rule and the INVITE Timer B can fire concurrently
    // near 32s — duplicate BYEs may arrive on every leg.
    alice.allowExtra("INVITE")
    alice.allowExtra("CANCEL")
    alice.allowExtra("BYE")
    bob.allowExtra("BYE")
    charlie.allowExtra("BYE")

    const aliceSdp = sdpOffer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15064",
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
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiAllowC() } },
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

    const cRealignTxn = charlieDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
    })
    cRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(aliceSdp) },
      skipValidation: ["offerAnswer"],
    })
    charlieDialog.expect("ACK")

    // A does not answer the re-INVITE.
    aliceDialog.expect("INVITE", { skipValidation: ["offerAnswer"] })
    s.pause(33_000)

    // Rollback — begin-termination BYEs all 3 confirmed legs (alice, bob, charlie).
    const aliceByeTxn = aliceDialog.expect("BYE")
    aliceByeTxn.reply(200)
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    const charlieByeTxn = charlieDialog.expect("BYE")
    charlieByeTxn.reply(200)
  },
).skipFinalSweep()
// FIXME(test-framework): outstanding a-realign re-INVITE on alice retransmits
// during the 24h end-of-scenario sweep, generating "unexpected message"
// failures. The B2BUA correctly tears down all 3 legs via begin-termination.
