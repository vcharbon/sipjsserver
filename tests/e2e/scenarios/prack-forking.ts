/**
 * PRACK forking scenario (delayed offer): Bob sends two 183s with different
 * To-tags, simulating a forking proxy. Alice sends INVITE without SDP, so
 * each 183 carries an SDP offer and Alice answers on each PRACK (RFC 3264
 * §4 — one offer/answer per early dialog).
 *
 * When Bob's 200 OK INVITE also carries SDP, RFC 3261 §14 / RFC 3264 §8
 * treats it as a new offer within the confirmed dialog, so Alice's ACK
 * must carry the corresponding SDP answer.
 *
 * Flow:
 *   INVITE(no SDP) → 100 → 183(fork1, offer) → PRACK(fork1, answer) → 200(PRACK)
 *   → 183(fork2, offer) → PRACK(fork2, answer) → 200(PRACK)
 *   → 200(INVITE, fork1 answers, new offer) → ACK(answer)
 *   → BYE → 200(BYE)
 *
 * Alice PRACKs each 183 immediately so ctx.last.to carries the correct
 * a-facing tag from the B2BUA (mapped from Bob's fork1/fork2 tags).
 *
 * Per-dialog CSeq monotonicity (RFC 3261 §12.2.1.1) is enforced by the
 * framework's default CSeq validator — no per-test predicate needed.
 */

import { scenario } from "../framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../helpers/sdp.js"
import type { SipMessage } from "../../../src/sip/types.js"

/** Extract the To URI (without tag) from a To header value. */
function toUri(toHeader: string): string {
  const match = /<([^>]+)>/.exec(toHeader)
  return match?.[1] ?? toHeader.split(";")[0]!
}

export const prackForkingCall = scenario("prack-forking", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  // Alice sends INVITE without SDP (delayed-offer model)
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    headers: { "Supported": "100rel" },
  })

  // Alice receives 100 Trying
  aliceInviteTxn.expect(100)

  // Bob receives INVITE
  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  // ── Fork 1 ──────────────────────────────────────────────────────────────

  // Bob sends 183 with first fork tag — carries SDP offer (delayed-offer: 18x offers)
  bobInviteTxn.reply(183, {
    overrides: {
      headers: {
        "Require": "100rel",
        "RSeq": "1",
      },
      body: sdpOffer(),
    },
    build: (ctx) => ({
      to: `<${toUri(ctx.last.to)}>;tag=fork1`,
    }),
  })

  // Alice receives first 183 — To-tag is B2BUA's a-facing tag for fork1
  aliceInviteTxn.expect(183)

  // Alice sends PRACK for fork1 — carries SDP answer for the 183's offer
  // (uses the a-facing tag from the 183 she just received)
  const alicePrack1Txn = aliceDialog.send("PRACK", {
    overrides: {
      body: sdpAnswer(),
      headers: { "RAck": "1 1 INVITE" },
    },
    build: (ctx) => ({
      to: ctx.last.to,
    }),
  })

  // Bob receives PRACK for fork1 — targeting check only; per-dialog CSeq is
  // enforced automatically by the framework (dialog key = callId|fromTag|fork1
  // has no prior, so it uses INVITE baseline + 1).
  const bobPrack1Txn = bobDialog.expect("PRACK", {
    predicate: (msg: SipMessage) => {
      if (msg.type !== "request") return false
      const to = msg.headers.find((h) => h.name.toLowerCase() === "to")?.value ?? ""
      return to.includes("fork1")
    },
  })

  // Bob sends 200 OK for PRACK (fork1)
  bobPrack1Txn.reply(200)

  // Alice receives 200 OK for PRACK
  alicePrack1Txn.expect(200)

  // ── Fork 2 ──────────────────────────────────────────────────────────────

  // Bob sends 183 with second fork tag
  bobInviteTxn.reply(183, {
    overrides: {
      headers: {
        "Require": "100rel",
        "RSeq": "200",
      },
      body: sdpOffer(),
    },
    build: (ctx) => ({
      to: `<${toUri(ctx.last.to)}>;tag=fork2`,
    }),
  })

  // Alice receives second 183 — To-tag is B2BUA's a-facing tag for fork2
  aliceInviteTxn.expect(183)

  // Alice sends PRACK for fork2 (uses the a-facing tag from the 183 she just received)
  const alicePrack2Txn = aliceDialog.send("PRACK", {
    overrides: {
      body: sdpAnswer(),
      headers: { "RAck": "200 1 INVITE" },
      cseq: 2,
    },
    build: (ctx) => ({
      to: ctx.last.to,
    }),
  })

  // Bob receives PRACK for fork2 — per-dialog CSeq monotonicity is enforced
  // by the framework. fork2 is a distinct early dialog from fork1, so its
  // CSeq sequence starts independently from the shared INVITE baseline; any
  // leakage of fork1's counter into fork2 is flagged by validateCSeq.
  const bobPrack2Txn = bobDialog.expect("PRACK", {
    predicate: (msg: SipMessage) => {
      if (msg.type !== "request") return false
      const to = msg.headers.find((h) => h.name.toLowerCase() === "to")?.value ?? ""
      return to.includes("fork2")
    },
  })

  // Bob sends 200 OK for PRACK (fork2)
  bobPrack2Txn.reply(200)

  // Alice receives 200 OK for PRACK
  alicePrack2Txn.expect(200)

  // ── Call answered ───────────────────────────────────────────────────────

  // Bob answers with 200 OK for INVITE (fork1 wins) and repeats SDP.
  // Per RFC 3261 §14 / RFC 3264 §8, SDP in the 2xx after a completed 18x/PRACK
  // offer-answer is treated as a new offer within the confirmed dialog.
  bobInviteTxn.reply(200, {
    overrides: {
      body: sdpOffer(),
    },
    build: (ctx) => ({
      to: `<${toUri(ctx.last.to)}>;tag=fork1`,
    }),
  })

  // Alice receives 200 OK for INVITE
  aliceInviteTxn.expect(200)

  // Alice sends ACK with SDP answer for the new offer in the 200 OK
  aliceDialog.ack({ body: sdpAnswer() })

  // Bob receives relayed ACK (carries Alice's answer)
  bobDialog.expect("ACK")

  // ── Hangup ──────────────────────────────────────────────────────────────

  // Alice hangs up
  const aliceByeTxn = aliceDialog.bye()

  // Bob receives BYE
  const bobByeTxn = bobDialog.expect("BYE")

  // Bob sends 200 OK for BYE
  bobByeTxn.reply(200)

  // Alice receives 200 OK for BYE
  aliceByeTxn.expect(200)
})
