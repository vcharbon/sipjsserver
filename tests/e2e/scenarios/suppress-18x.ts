/**
 * suppress-18x scenarios — relay_first_18x_to_180 policy tests.
 *
 * Test 1: Basic — first 183 transformed to 180, subsequent 180 suppressed, 200 OK relayed
 * Test 2: Failover — Bob1 sends 180 then timeout, Bob2 answers, To-tag consistent
 * Test 3: Failover on reject — Bob1 sends 180 then 503, Bob2 answers, To-tag consistent
 * Test 4: No policy — normal behavior (180s all relayed)
 * Test 5: 100rel stripped — verify outbound INVITE has no 100rel in Supported
 */

import { scenario } from "../framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../helpers/sdp.js"
import type { SipMessage } from "../../../src/sip/types.js"

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract To-tag from a SIP message. */
function extractToTag(msg: SipMessage): string {
  const to = msg.headers.find((h) => h.name.toLowerCase() === "to")?.value ?? ""
  const tagMatch = /;tag=([^;>\s]+)/.exec(to)
  return tagMatch?.[1] ?? ""
}

/** Check if a SIP message has a body. */
function hasBody(msg: SipMessage): boolean {
  return msg.body.length > 0
}

/** Check if a header contains a specific token (case-insensitive). */
function headerContainsToken(msg: SipMessage, headerName: string, token: string): boolean {
  const header = msg.headers.find((h) => h.name.toLowerCase() === headerName.toLowerCase())?.value ?? ""
  return header.toLowerCase().split(",").some((t) => t.trim() === token.toLowerCase())
}

// ── Ports ──────────────────────────────────────────────────────────────────

const BOB_PORT = 5690
const BOB1_PORT = 5691
const BOB2_PORT = 5692

// ── Test 1: Basic — first 183→180, subsequent suppressed ─────────────────

const basicInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB_PORT },
  relay_first_18x_to_180: true,
})

export const suppress18xBasic = scenario("suppress-18x-basic", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

  // Alice sends INVITE with policy flag
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: {
      "X-Api-Call": basicInstruction,
      "Supported": "100rel, timer",
    },
  })

  aliceInviteTxn.expect(100)

  // Bob receives INVITE — verify no 100rel in Supported
  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite({
    predicate: (msg) => {
      if (msg.type !== "request") return false
      // 100rel should be stripped from Supported
      return !headerContainsToken(msg, "Supported", "100rel")
    },
  })

  // Bob sends 183 with SDP and 100rel headers (simulating a UAS that offered 100rel)
  bobInviteTxn.reply(183, {
    overrides: {
      headers: {
        "Require": "100rel",
        "RSeq": "1",
      },
      body: sdpAnswer(),
    },
  })

  // Alice should receive a bare 180 (not 183) — no body, no Require, no RSeq
  aliceInviteTxn.expect(180, {
    predicate: (msg) => {
      if (msg.type !== "response") return false
      if (msg.status !== 180) return false
      // Must have no body (SDP stripped)
      if (hasBody(msg)) return false
      // Must not have Require: 100rel
      if (headerContainsToken(msg, "Require", "100rel")) return false
      return true
    },
  })

  // B2BUA must PRACK bob (RFC 3262 §3-4) since alice never sees the reliable
  // provisional and will not generate her own PRACK.
  const bobPrackTxn = bobDialog.expect("PRACK", {
    predicate: (msg) => {
      if (msg.type !== "request") return false
      const rack = msg.headers.find((h) => h.name.toLowerCase() === "rack")?.value ?? ""
      return /^1\s+\d+\s+INVITE$/i.test(rack.trim())
    },
  })
  bobPrackTxn.reply(200)

  // Bob sends another 180 — this should be suppressed (Alice receives nothing)
  bobInviteTxn.reply(180)

  // Bob sends 200 OK with SDP
  bobInviteTxn.reply(200, { body: sdpAnswer() })

  // Alice receives 200 OK — To-tag should match the one from the 180
  aliceInviteTxn.expect(200)

  // ACK + teardown
  aliceDialog.ack()
  bobDialog.expect("ACK")

  s.pause(1000)

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── Test 2: Failover — Bob1 180, no-answer timeout, Bob2 answers ─────────

const failoverNoAnswerInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB1_PORT },
  relay_first_18x_to_180: true,
  on_failure: {
    action: "failover",
    destination: { host: "127.0.0.1", port: BOB2_PORT },
    new_ruri: `sip:+1234@127.0.0.1:${BOB2_PORT}`,
    relay_first_18x_to_180: true,
  },
})

export const suppress18xFailoverNoAnswer = scenario("suppress-18x-failover-no-answer", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob1 = s.agent("bob1", { uri: "sip:bob1@test", port: BOB1_PORT })
  const bob2 = s.agent("bob2", { uri: "sip:bob2@test", port: BOB2_PORT })

  // Delayed offer: no SDP in INVITE — offer will come in Bob2's 200 OK
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    headers: { "X-Api-Call": failoverNoAnswerInstruction },
  })

  aliceInviteTxn.expect(100)

  // Bob1 receives INVITE
  const { transaction: bob1InviteTxn } = bob1.receiveInitialInvite()

  // Bob1 sends 180 — first 18x, relayed as 180 to Alice
  bob1InviteTxn.reply(180)

  // Alice gets 180 — capture the To-tag for later comparison
  let firstToTag: string = ""
  aliceInviteTxn.expect(180, {
    predicate: (msg) => {
      if (msg.type !== "response" || msg.status !== 180) return false
      firstToTag = extractToTag(msg)
      return true
    },
  })

  // Timer A retransmissions for the INVITE to bob2 may leak during the final
  // pause under TestClock. CANCEL to bob1 is fire-and-forget in the B2BUA
  // (no Timer E) so no allowance is needed there.
  bob2.allowExtra("INVITE")

  // No-answer timeout triggers — B2BUA sends CANCEL to Bob1 and failover to Bob2
  // Default no-answer timeout is 30s
  s.pause(31_000)

  // Bob1 receives CANCEL from B2BUA (tied to the INVITE server transaction)
  const bob1CancelTxn = bob1InviteTxn.expectCancel()

  // Bob1 replies 200 OK for CANCEL, then 487 for the original INVITE
  bob1CancelTxn.reply(200)
  bob1InviteTxn.reply(487)

  // B2BUA must send ACK for the 487 (RFC 3261 §17.1.1.3)
  bob1.allowExtra("ACK")

  // Bob2 receives new INVITE — verify Request-URI is the failover new_ruri
  const { dialog: bob2Dialog, transaction: bob2InviteTxn } = bob2.receiveInitialInvite({
    predicate: (msg) => {
      if (msg.type !== "request") return false
      // RFC 3261 §8.1.1.1: Request-URI must be the configured new_ruri
      return msg.uri === `sip:+1234@127.0.0.1:${BOB2_PORT}`
    },
  })

  // Bob2 sends 180 — should be suppressed (first 18x already sent)
  bob2InviteTxn.reply(180)

  // Bob2 sends 200 OK WITH SDP offer (delayed-offer: Bob2 is the offerer)
  bob2InviteTxn.reply(200, { body: sdpOffer() })

  // Alice receives 200 OK — To-tag must match the first 180
  aliceInviteTxn.expect(200, {
    predicate: (msg) => {
      if (msg.type !== "response" || msg.status !== 200) return false
      const okToTag = extractToTag(msg)
      // The To-tag on 200 OK must match the To-tag from the first 180
      return firstToTag !== "" && okToTag === firstToTag
    },
  })

  // Alice's ACK MUST include SDP answer (RFC 3264 §4: delayed-offer answer in ACK)
  aliceDialog.ack({ body: sdpAnswer() })

  // Bob2 validates ACK contains SDP answer for its offer
  bob2Dialog.expect("ACK", {
    predicate: (msg) => {
      if (msg.type !== "request") return false
      // RFC 3264 §4: ACK must contain SDP answer when 200 OK contained offer
      return msg.body.length > 0
    },
  })

  s.pause(15_000)

  const aliceByeTxn = aliceDialog.bye()
  const bob2ByeTxn = bob2Dialog.expect("BYE")
  bob2ByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── Test 3: Failover on reject — Bob1 180 then 503, Bob2 answers ─────────

const failoverRejectInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB1_PORT },
  relay_first_18x_to_180: true,
  on_failure: {
    action: "failover",
    destination: { host: "127.0.0.1", port: BOB2_PORT },
    new_ruri: `sip:+1234@127.0.0.1:${BOB2_PORT}`,
    relay_first_18x_to_180: true,
  },
})

export const suppress18xFailoverReject = scenario("suppress-18x-failover-reject", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob1 = s.agent("bob1", { uri: "sip:bob1@test", port: BOB1_PORT })
  const bob2 = s.agent("bob2", { uri: "sip:bob2@test", port: BOB2_PORT })

  // Bob1 will receive ACK for the 503 (RFC 3261 §17.1.1.3 — auto-ACK for non-2xx)
  bob1.allowExtra("ACK")

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: { "X-Api-Call": failoverRejectInstruction },
  })

  aliceInviteTxn.expect(100)

  // Bob1 receives INVITE
  const { transaction: bob1InviteTxn } = bob1.receiveInitialInvite()

  // Bob1 sends 180 — first 18x, relayed as bare 180
  bob1InviteTxn.reply(180)

  let firstToTag: string = ""
  aliceInviteTxn.expect(180, {
    predicate: (msg) => {
      if (msg.type !== "response" || msg.status !== 180) return false
      firstToTag = extractToTag(msg)
      return true
    },
  })

  // Bob1 rejects with 503
  bob1InviteTxn.reply(503)

  // B2BUA failover to Bob2
  const { dialog: bob2Dialog, transaction: bob2InviteTxn } = bob2.receiveInitialInvite()

  // Bob2 sends 180 — should be suppressed
  bob2InviteTxn.reply(180)

  // Bob2 sends another 180 — also suppressed
  bob2InviteTxn.reply(180)

  // Bob2 answers with 200 OK
  bob2InviteTxn.reply(200, { body: sdpAnswer() })

  // Alice receives 200 OK — To-tag must match the first 180 (from Bob1!)
  aliceInviteTxn.expect(200, {
    predicate: (msg) => {
      if (msg.type !== "response" || msg.status !== 200) return false
      const okToTag = extractToTag(msg)
      return firstToTag !== "" && okToTag === firstToTag
    },
  })

  aliceDialog.ack()
  bob2Dialog.expect("ACK")

  s.pause(1000)

  const aliceByeTxn = aliceDialog.bye()
  const bob2ByeTxn = bob2Dialog.expect("BYE")
  bob2ByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── Test 4: No policy — normal behavior ──────────────────────────────────

const noPolicyInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB_PORT },
  // No relay_first_18x_to_180 — normal behavior
})

export const suppress18xDisabled = scenario("suppress-18x-disabled", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: { "X-Api-Call": noPolicyInstruction },
  })

  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  // Bob sends 180 — relayed normally
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  // Bob sends another 180 — also relayed normally (no suppression)
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  // Bob answers
  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)

  aliceDialog.ack()
  bobDialog.expect("ACK")

  s.pause(1000)

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})
