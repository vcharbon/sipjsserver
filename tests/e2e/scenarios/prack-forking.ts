/**
 * PRACK forking scenario: Bob sends two 183s with different To-tags,
 * simulating a forking proxy. Alice PRACKs each distinct early dialog.
 *
 * Flow:
 *   INVITE → 100 → 183(fork1) → PRACK(fork1) → 200(PRACK)
 *   → 183(fork2) → PRACK(fork2) → 200(PRACK)
 *   → 200(INVITE, fork1 answers) → ACK → ACK(relayed)
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

  // Alice sends INVITE
  alice.invite("sip:+1234@127.0.0.1:15060", {
    headers: { "Supported": "100rel" },
    body: sdpOffer(),
  })

  // Alice receives 100 Trying
  alice.expect(100)

  // Bob receives INVITE
  const rcvInvite = bob.expect("INVITE")

  // ── Fork 1 ──────────────────────────────────────────────────────────────

  // Bob sends 183 with first fork tag
  rcvInvite.reply(183, {
    overrides: {
      headers: {
        "Require": "100rel",
        "RSeq": "1",
      },
      body: sdpAnswer(),
    },
    build: (ctx) => ({
      to: `<${toUri(ctx.last.to)}>;tag=fork1`,
    }),
  })

  // Alice receives first 183 — To-tag is B2BUA's a-facing tag for fork1
  alice.expect(183)

  // Alice sends PRACK for fork1 (uses the a-facing tag from the 183 she just received)
  alice.send("PRACK", {
    overrides: {
      headers: { "RAck": "1 1 INVITE" },
    },
    build: (ctx) => ({
      to: ctx.last.to,
    }),
  })

  // Bob receives PRACK for fork1 — targeting check only; per-dialog CSeq is
  // enforced automatically by the framework (dialog key = callId|fromTag|fork1
  // has no prior, so it uses INVITE baseline + 1).
  const rcvPrack1 = bob.expect("PRACK", {
    predicate: (msg: SipMessage) => {
      if (msg.type !== "request") return false
      const to = msg.headers.find((h) => h.name.toLowerCase() === "to")?.value ?? ""
      return to.includes("fork1")
    },
  })

  // Bob sends 200 OK for PRACK (fork1)
  rcvPrack1.reply(200)

  // Alice receives 200 OK for PRACK
  alice.expect(200)

  // ── Fork 2 ──────────────────────────────────────────────────────────────

  // Bob sends 183 with second fork tag
  rcvInvite.reply(183, {
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
  alice.expect(183)

  // Alice sends PRACK for fork2 (uses the a-facing tag from the 183 she just received)
  alice.send("PRACK", {
    overrides: {
      body: sdpAnswer() ,
      headers: { "RAck": "200 1 INVITE" },
      cseq: 2
    },
    build: (ctx) => ({
      to: ctx.last.to,
    }),
  })

  // Bob receives PRACK for fork2 — per-dialog CSeq monotonicity is enforced
  // by the framework. fork2 is a distinct early dialog from fork1, so its
  // CSeq sequence starts independently from the shared INVITE baseline; any
  // leakage of fork1's counter into fork2 is flagged by validateCSeq.
  const rcvPrack2 = bob.expect("PRACK", {
    predicate: (msg: SipMessage) => {
      if (msg.type !== "request") return false
      const to = msg.headers.find((h) => h.name.toLowerCase() === "to")?.value ?? ""
      return to.includes("fork2")
    },
  })

  // Bob sends 200 OK for PRACK (fork2)
  rcvPrack2.reply(200)

  // Alice receives 200 OK for PRACK
  alice.expect(200)

  // ── Call answered ───────────────────────────────────────────────────────

  // Bob answers with 200 OK for INVITE (fork1 wins)
  rcvInvite.reply(200, {
    build: (ctx) => ({
      to: `<${toUri(ctx.last.to)}>;tag=fork1`,
    }),
  })

  // Alice receives 200 OK for INVITE
  alice.expect(200)

  // Alice sends ACK (relayed end-to-end, may carry SDP)
  alice.send("ACK")

  // Bob receives relayed ACK
  bob.expect("ACK")
})
