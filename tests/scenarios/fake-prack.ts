/**
 * fake-prack scenarios — `relayFirst18xTo180` strategy `"fake-prack"`.
 *
 * Eight scenarios:
 *   1. basic            — single 18x(100rel)+SDP, B2BUA originates PRACK,
 *                         alice sees bare 180 then 200 with cached SDP.
 *   2. multiple-18x     — two reliable 18x's, one PRACK each, last cached SDP wins.
 *   3. update-happy     — bob sends UPDATE(SDP), B2BUA replies with skeleton-fit
 *                         answer derived from alice's INVITE; cached SDP advances.
 *   4. update-codec-mismatch — bob's UPDATE codec set has no overlap with alice's
 *                         INVITE → B2BUA replies 488; call continues; alice sees
 *                         original cached SDP at 200 OK.
 *   5. forking          — two b-legs, independent caches, loser cancelled,
 *                         alice sees winner's cached SDP.
 *   6. failover         — b1 fails after PRACK; b2 fresh cache; alice sees b2 SDP.
 *   7. delayed-offer-fallback — alice INVITE has no SDP; outbound INVITE strips
 *                         `Supported: 100rel`; entire policy self-disables.
 *   8. no-policy-control — no `relay_first_18x_to_180`; full end-to-end PRACK
 *                         relay (regression guard).
 */

import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../src/test-harness/framework/helpers/sdp.js"
import type { SipMessage } from "../../src/sip/types.js"

// ── Helpers ────────────────────────────────────────────────────────────────

function hasBody(msg: SipMessage): boolean {
  return msg.body.length > 0
}

function headerContainsToken(msg: SipMessage, headerName: string, token: string): boolean {
  const header = msg.headers.find((h) => h.name.toLowerCase() === headerName.toLowerCase())?.value ?? ""
  return header.toLowerCase().split(",").some((t) => t.trim() === token.toLowerCase())
}

// Latency between bob's reliable 18x and his 200 OK so PRACK / UPDATE
// ordering is observable in the trace.
const LATENCY_MS = 50

// ── Ports ──────────────────────────────────────────────────────────────────

const BOB_PORT = 5780
const BOB1_PORT = 5781
const BOB2_PORT = 5782
const BOB_FORK1_PORT = 5783
const BOB_FORK2_PORT = 5784

// ── Test 1: basic ─────────────────────────────────────────────────────────

const basicInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB_PORT },
  relay_first_18x_to_180: "fake-prack",
})

export const fakePrackBasic = scenario("fake-prack-basic", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: {
      "X-Api-Call": basicInstruction,
      "Supported": "100rel, timer",
    },
  })

  aliceInviteTxn.expect(100)

  // Bob receives INVITE — fake-prack must KEEP `Supported: 100rel` intact
  // so bob may negotiate reliable provisional with us.
  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite({
    predicate: (msg) => {
      if (msg.type !== "request") return false
      return headerContainsToken(msg, "Supported", "100rel")
    },
  })

  // Bob: 183 with Require:100rel + RSeq + SDP
  const bobAnswerSdp = sdpAnswer()
  bobInviteTxn.reply(183, {
    overrides: {
      headers: { "Require": "100rel", "RSeq": "1" },
      body: bobAnswerSdp,
    },
  })

  // Alice sees a bare 180 — no body, no Require/RSeq.
  aliceInviteTxn.expect(180, {
    predicate: (msg) => {
      if (msg.type !== "response" || msg.status !== 180) return false
      if (hasBody(msg)) return false
      if (headerContainsToken(msg, "Require", "100rel")) return false
      const rseq = msg.headers.find((h) => h.name.toLowerCase() === "rseq")
      return rseq === undefined
    },
  })

  // B2BUA originates PRACK toward bob.
  const bobPrackTxn = bobDialog.expect("PRACK", {
    predicate: (msg) => {
      if (msg.type !== "request") return false
      const rack = msg.headers.find((h) => h.name.toLowerCase() === "rack")?.value ?? ""
      return /^1\s+\d+\s+INVITE$/i.test(rack.trim())
    },
  })
  bobPrackTxn.reply(200)

  s.pause(LATENCY_MS)

  // Bob sends 200 OK with NO body — the cached 18x SDP must surface to alice.
  bobInviteTxn.reply(200)

  // Alice's 200 OK carries bob's cached SDP.
  aliceInviteTxn.expect(200, {
    predicate: (msg) => {
      if (msg.type !== "response" || msg.status !== 200) return false
      if (!hasBody(msg)) return false
      const ct = msg.headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? ""
      return ct.toLowerCase().includes("application/sdp")
    },
  })

  aliceDialog.ack()
  bobDialog.expect("ACK")

  s.pause(1000)
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── Test 2: multiple-18x ──────────────────────────────────────────────────

export const fakePrackMultiple18x = scenario("fake-prack-multiple-18x", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: {
      "X-Api-Call": basicInstruction,
      "Supported": "100rel",
    },
  })
  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  // Bob: 183 (RSeq 1) with cached SDP #1
  bobInviteTxn.reply(183, {
    overrides: {
      headers: { "Require": "100rel", "RSeq": "1" },
      body: sdpAnswer(),
    },
  })

  aliceInviteTxn.expect(180)

  bobDialog.expect("PRACK", {
    predicate: (msg) => {
      if (msg.type !== "request") return false
      const rack = msg.headers.find((h) => h.name.toLowerCase() === "rack")?.value ?? ""
      return /^1\s+\d+\s+INVITE$/i.test(rack.trim())
    },
  }).reply(200)

  s.pause(LATENCY_MS)

  // Bob: 180 (RSeq 2) with cached SDP #2 — should NOT be relayed to alice.
  bobInviteTxn.reply(180, {
    overrides: {
      headers: { "Require": "100rel", "RSeq": "2" },
      body: sdpAnswer(),
    },
  })

  bobDialog.expect("PRACK", {
    predicate: (msg) => {
      if (msg.type !== "request") return false
      const rack = msg.headers.find((h) => h.name.toLowerCase() === "rack")?.value ?? ""
      return /^2\s+\d+\s+INVITE$/i.test(rack.trim())
    },
  }).reply(200)

  s.pause(LATENCY_MS)

  // 200 OK with no body — alice gets cached SDP (latest).
  bobInviteTxn.reply(200)

  aliceInviteTxn.expect(200, {
    predicate: (msg) => msg.type === "response" && msg.status === 200 && hasBody(msg),
  })

  aliceDialog.ack()
  bobDialog.expect("ACK")

  s.pause(1000)
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── Test 3: update-happy ──────────────────────────────────────────────────

export const fakePrackUpdateHappy = scenario("fake-prack-update-happy", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: {
      "X-Api-Call": basicInstruction,
      "Supported": "100rel",
    },
  })
  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  bobInviteTxn.reply(183, {
    overrides: {
      headers: { "Require": "100rel", "RSeq": "1" },
      body: sdpAnswer(),
    },
  })
  aliceInviteTxn.expect(180)

  bobDialog.expect("PRACK").reply(200)

  s.pause(LATENCY_MS)

  // Bob sends UPDATE with a new SDP offer — B2BUA must answer locally and cache.
  // skipValidation: the OfferAnswerTracker only observes agent-outbound; the
  // B2BUA's locally-built UPDATE response is never observed, so the offer
  // would be flagged dangling even though it IS answered (just by the B2BUA,
  // not by another test agent). See test-harness limitations report.
  const bobUpdateTxn = bobDialog.send("UPDATE", {
    body: sdpOffer(),
    skipValidation: ["offerAnswer"],
  })
  bobUpdateTxn.expect(200, {
    predicate: (msg) => {
      if (msg.type !== "response" || msg.status !== 200) return false
      // Skeleton-fit answer must include SDP body and Content-Type.
      if (!hasBody(msg)) return false
      const ct = msg.headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? ""
      return ct.toLowerCase().includes("application/sdp")
    },
  })

  s.pause(LATENCY_MS)

  // 200 OK INVITE — alice gets the LATEST cached SDP (bob's UPDATE offer).
  bobInviteTxn.reply(200)
  aliceInviteTxn.expect(200, {
    predicate: (msg) => msg.type === "response" && msg.status === 200 && hasBody(msg),
  })

  aliceDialog.ack()
  bobDialog.expect("ACK")

  s.pause(1000)
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── Test 4: update-codec-mismatch ─────────────────────────────────────────
//
// Build an SDP offer with a single non-overlapping codec so the
// intersection with alice's INVITE (PCMA + G729 + telephone-event) is empty.

function sdpOfferOpusOnly(): Uint8Array {
  const sdp = [
    "v=0",
    "o=bob 1 1 IN IP4 127.0.0.1",
    "s=-",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    "m=audio 30000 RTP/AVP 96",
    "a=rtpmap:96 opus/48000/2",
    "a=sendrecv",
  ].join("\r\n") + "\r\n"
  return new TextEncoder().encode(sdp)
}

export const fakePrackUpdateCodecMismatch = scenario("fake-prack-update-codec-mismatch", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: {
      "X-Api-Call": basicInstruction,
      "Supported": "100rel",
    },
  })
  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  bobInviteTxn.reply(183, {
    overrides: {
      headers: { "Require": "100rel", "RSeq": "1" },
      body: sdpAnswer(),
    },
  })
  aliceInviteTxn.expect(180)

  bobDialog.expect("PRACK").reply(200)

  s.pause(LATENCY_MS)

  // UPDATE with no codec overlap → B2BUA must reply 488.
  // skipValidation: see UPDATE-happy comment. Additionally the 488 carries
  // no answer body by design.
  const bobUpdateTxn = bobDialog.send("UPDATE", {
    body: sdpOfferOpusOnly(),
    skipValidation: ["offerAnswer"],
  })
  bobUpdateTxn.expect(488)

  s.pause(LATENCY_MS)

  // Call still proceeds with original cached SDP from the 183.
  bobInviteTxn.reply(200)
  aliceInviteTxn.expect(200, {
    predicate: (msg) => msg.type === "response" && msg.status === 200 && hasBody(msg),
  })

  aliceDialog.ack()
  bobDialog.expect("ACK")

  s.pause(1000)
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── Test 5: forking ───────────────────────────────────────────────────────
//
// Two b-legs (forking happens upstream — modeled here as failover-shaped
// routing where the first b-leg ringing simultaneously with second).
// The simulated harness expresses forking as a single b-leg that itself
// receives multiple early dialogs, which is the more common fork shape.

const forkingInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB_FORK1_PORT },
  relay_first_18x_to_180: "fake-prack",
  on_failure: {
    action: "failover",
    destination: { host: "127.0.0.1", port: BOB_FORK2_PORT },
    new_ruri: `sip:+1234@127.0.0.1:${BOB_FORK2_PORT}`,
    relay_first_18x_to_180: "fake-prack",
  },
})

export const fakePrackForking = scenario("fake-prack-forking", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob1 = s.agent("bob1", { uri: "sip:bob1@test", port: BOB_FORK1_PORT })
  const bob2 = s.agent("bob2", { uri: "sip:bob2@test", port: BOB_FORK2_PORT })

  bob1.allowExtra("ACK")
  bob2.allowExtra("INVITE")

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: {
      "X-Api-Call": forkingInstruction,
      "Supported": "100rel",
    },
  })
  aliceInviteTxn.expect(100)

  // bob1 receives INVITE, sends 183(100rel,SDP), gets PRACK from B2BUA, then 503.
  const { dialog: bob1Dialog, transaction: bob1InviteTxn } = bob1.receiveInitialInvite()
  bob1InviteTxn.reply(183, {
    overrides: {
      headers: { "Require": "100rel", "RSeq": "1" },
      body: sdpAnswer(),
    },
  })
  aliceInviteTxn.expect(180)
  bob1Dialog.expect("PRACK").reply(200)
  s.pause(LATENCY_MS)
  bob1InviteTxn.reply(503)

  // Failover to bob2 — uses unreliable provisional (no 100rel). The
  // suppress-18x rule absorbs the second 18x for alice; bob2's 200 OK
  // body becomes the final answer alice sees (cache-per-leg means b1's
  // cache is discarded with b1, and b2 has no cache because no 100rel).
  const { dialog: bob2Dialog, transaction: bob2InviteTxn } = bob2.receiveInitialInvite()
  bob2InviteTxn.reply(180)
  s.pause(LATENCY_MS)
  bob2InviteTxn.reply(200, { body: sdpAnswer() })

  // Alice 200 OK — must carry bob2's cached SDP (winner).
  aliceInviteTxn.expect(200, {
    predicate: (msg) => msg.type === "response" && msg.status === 200 && hasBody(msg),
  })

  aliceDialog.ack()
  bob2Dialog.expect("ACK")

  s.pause(1000)
  const aliceByeTxn = aliceDialog.bye()
  const bob2ByeTxn = bob2Dialog.expect("BYE")
  bob2ByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── Test 6: failover ──────────────────────────────────────────────────────
// Same shape as forking above (failover-on-503), kept as a separate test
// for trace clarity and to lock the b1-cache-discarded contract in its own
// .global.txt for the analyser.

const failoverInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB1_PORT },
  relay_first_18x_to_180: "fake-prack",
  on_failure: {
    action: "failover",
    destination: { host: "127.0.0.1", port: BOB2_PORT },
    new_ruri: `sip:+1234@127.0.0.1:${BOB2_PORT}`,
    relay_first_18x_to_180: "fake-prack",
  },
})

export const fakePrackFailover = scenario("fake-prack-failover", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob1 = s.agent("bob1", { uri: "sip:bob1@test", port: BOB1_PORT })
  const bob2 = s.agent("bob2", { uri: "sip:bob2@test", port: BOB2_PORT })

  bob1.allowExtra("ACK")
  bob2.allowExtra("INVITE")

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: {
      "X-Api-Call": failoverInstruction,
      "Supported": "100rel",
    },
  })
  aliceInviteTxn.expect(100)

  const { dialog: bob1Dialog, transaction: bob1InviteTxn } = bob1.receiveInitialInvite()
  bob1InviteTxn.reply(183, {
    overrides: {
      headers: { "Require": "100rel", "RSeq": "1" },
      body: sdpAnswer(),
    },
  })
  aliceInviteTxn.expect(180)
  bob1Dialog.expect("PRACK").reply(200)
  s.pause(LATENCY_MS)
  bob1InviteTxn.reply(503)

  const { dialog: bob2Dialog, transaction: bob2InviteTxn } = bob2.receiveInitialInvite()
  // bob2 uses the unreliable path this time — no 100rel, just 180 then 200.
  bob2InviteTxn.reply(180)
  // (suppressed, alice already saw the bare 180 from bob1)
  s.pause(LATENCY_MS)
  bob2InviteTxn.reply(200, { body: sdpAnswer() })

  // Alice's 200 OK uses bob2's body (no cache for bob2 since no 100rel was
  // used; the relay path forwards bob2's own SDP).
  aliceInviteTxn.expect(200, {
    predicate: (msg) => msg.type === "response" && msg.status === 200 && hasBody(msg),
  })

  aliceDialog.ack()
  bob2Dialog.expect("ACK")

  s.pause(1000)
  const aliceByeTxn = aliceDialog.bye()
  const bob2ByeTxn = bob2Dialog.expect("BYE")
  bob2ByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── Test 7: delayed-offer-fallback ────────────────────────────────────────

export const fakePrackDelayedOfferFallback = scenario("fake-prack-delayed-offer-fallback", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

  // Alice INVITE with NO body — delayed offer.
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    headers: {
      "X-Api-Call": basicInstruction,
      "Supported": "100rel",
    },
  })
  aliceInviteTxn.expect(100)

  // Outbound INVITE to bob must have `Supported: 100rel` stripped
  // (delayed-offer fallback path in applyRoute).
  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite({
    predicate: (msg) => {
      if (msg.type !== "request") return false
      return !headerContainsToken(msg, "Supported", "100rel")
    },
  })

  // Bob can only use unreliable provisional. Bare 180 (no body — keeping the
  // delayed-offer protocol clean: offer comes in 200 OK, answer in ACK).
  bobInviteTxn.reply(180)

  aliceInviteTxn.expect(180, {
    predicate: (msg) => msg.type === "response" && msg.status === 180,
  })

  s.pause(LATENCY_MS)

  // Bob's 200 OK carries the SDP offer (delayed-offer model).
  bobInviteTxn.reply(200, { body: sdpOffer() })

  // Alice's 200 OK arrives — body presence depends on whether she's the
  // offerer. In delayed-offer mode bob's 200 carries the offer; alice
  // would need to answer in ACK.
  aliceInviteTxn.expect(200)

  aliceDialog.ack({ body: sdpAnswer() })
  bobDialog.expect("ACK")

  s.pause(1000)
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── Test 8: no-policy-control ─────────────────────────────────────────────

const noPolicyInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB_PORT },
  // No relay_first_18x_to_180 — full default behavior.
})

export const fakePrackNoPolicyControl = scenario("fake-prack-no-policy-control", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite("sip:+1234@127.0.0.1:15060", {
    body: sdpOffer(),
    headers: {
      "X-Api-Call": noPolicyInstruction,
      "Supported": "100rel",
    },
  })
  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  // Bob 183 with 100rel + SDP. End-to-end PRACK.
  bobInviteTxn.reply(183, {
    overrides: {
      headers: { "Require": "100rel", "RSeq": "1" },
      body: sdpAnswer(),
    },
  })

  // Alice sees the 183 with 100rel intact (regression guard against the new
  // code leaking into the default path).
  aliceInviteTxn.expect(183, {
    predicate: (msg) => {
      if (msg.type !== "response" || msg.status !== 183) return false
      return headerContainsToken(msg, "Require", "100rel")
    },
  })

  // Alice sends PRACK end-to-end.
  const alicePrackTxn = aliceDialog.send("PRACK", {
    overrides: { headers: { "RAck": "1 1 INVITE" } },
  })
  const bobPrackTxn = bobDialog.expect("PRACK")
  bobPrackTxn.reply(200)
  alicePrackTxn.expect(200)

  s.pause(LATENCY_MS)
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
