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

  // Bob receives PRACK — verify it targets fork1 (B2BUA maps a-facing tag back to fork1)
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
      body: sdpAnswer(),
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
      headers: { "RAck": "200 1 INVITE" },
    },
    build: (ctx) => ({
      to: ctx.last.to,
    }),
  })

  // Bob receives PRACK — verify it targets fork2
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
    overrides: { body: sdpAnswer() },
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
