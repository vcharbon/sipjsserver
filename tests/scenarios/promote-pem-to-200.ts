/**
 * promote-pem-to-200 scenarios — `relayFirst18xTo180` strategy
 * `"promote-pem-to-200"`. The B2BUA promotes Bob's first
 * `183 + SDP + P-Early-Media` into a synthetic 200 OK toward Alice so a
 * constrained Alice (cannot send DTMF in early dialog) can interact with
 * Bob's already-running early-media stream.
 *
 * Scenarios:
 *   1. happy-no-resync           — Bob's eventual 200 OK SDP equals the 183
 *                                  SDP → silent bridge, Alice sees no resync.
 *   2. resync-sdp-changed        — Bob's 200 OK SDP differs → B2BUA emits a
 *                                  re-INVITE on the a-leg with Bob's SDP,
 *                                  Alice 200-OKs, ACK closes the window,
 *                                  in-dialog UPDATE then flows through.
 *   3a. b-fails-post-promote     — Bob 503s after promotion → BYE Alice with
 *                                  diagnostic Reason header.
 *   3b. resync-failed-by-a       — Alice 488s the resync re-INVITE → BYE
 *                                  both legs.
 *   3c. a-bye-during-window      — Alice BYEs before Bob's final response →
 *                                  CANCEL Bob, 200 to BYE.
 *   4.  no-policy-control        — without the strategy active, the same
 *                                  packet flow falls back to default
 *                                  provisional relay (regression guard).
 *   5.  forking-resync           — Bob's upstream forks: dialog-1 sends
 *                                  183+PEM (we promote with that SDP),
 *                                  dialog-2 sends the winning 200 OK with
 *                                  different SDP. B2BUA ACKs dialog-2 +
 *                                  re-INVITEs Alice with dialog-2's SDP.
 *   6.  in-dialog-rejection      — While the window is open, Alice's
 *                                  UPDATE/INVITE → 491; INFO → 488.
 */

import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../src/test-harness/framework/helpers/sdp.js"

const PEM_HEADER = "sendrecv"

// ── Ports ──────────────────────────────────────────────────────────────────

const BOB_PORT = 5870

// ── Instructions ───────────────────────────────────────────────────────────

const promoteInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB_PORT },
  relay_first_18x_to_180: "promote-pem-to-200",
})

const noPolicyInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: BOB_PORT },
})

// ── Scenario 1: happy path — SDP unchanged → no resync ────────────────────

export const promotePemHappyNoResync = scenario("promote-pem-happy-no-resync", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

  const aliceSdp = sdpOffer()
  const bobSdp = sdpAnswer(aliceSdp)

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15060",
    {
      body: aliceSdp,
      headers: { "X-Api-Call": promoteInstruction },
    },
  )

  aliceInviteTxn.expect(100)

  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  // Bob: 183 + SDP + P-Early-Media → promotion fires.
  bobInviteTxn.reply(183, {
    overrides: {
      headers: { "P-Early-Media": PEM_HEADER },
      body: bobSdp,
    },
  })

  // Alice sees a 200 OK carrying bob's 183 SDP, with P-Early-Media stripped
  // and explicit Allow + Supported (RFC 3261 §13.3.1 / §20.5 / §20.37).
  aliceInviteTxn.expect(200, {
    predicate: (msg) => {
      if (!msg.hasBody()) return false
      if (!msg.bodyEquals(bobSdp)) return false
      if (msg.hasHeader("p-early-media")) return false
      const allow = msg.getHeader("allow")[0] ?? ""
      if (!/\bINVITE\b/i.test(allow) || !/\bBYE\b/i.test(allow)) return false
      const supported = msg.getHeader("supported")[0] ?? ""
      // 100rel intentionally absent on the synthetic 200 OK — alice
      // never saw a reliable provisional from us.
      if (/\b100rel\b/i.test(supported)) return false
      return true
    },
  })

  // Alice ACKs — the B2BUA absorbs locally; bob receives nothing.
  aliceDialog.ack()

  // Bob now sends 200 OK with the SAME SDP. SDP matches → no resync.
  bobInviteTxn.reply(200, { body: bobSdp })

  // B2BUA generates the local ACK toward bob.
  bobDialog.expect("ACK")

  // Quiet period — alice should NOT see another INVITE.
  s.pause(1000)

  // Normal teardown.
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── Scenario 2: SDP changes → B2BUA re-INVITEs Alice + UPDATE flows ──────

export const promotePemResyncSdpChanged = scenario(
  "promote-pem-resync-sdp-changed",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

    const aliceSdp = sdpOffer()
    const earlySdp = sdpAnswer(aliceSdp)
    // Different port → different m= line → sdpMediaEquivalent returns false.
    const finalSdp = sdpAnswer(aliceSdp, { port: 30000 })

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      { body: aliceSdp, headers: { "X-Api-Call": promoteInstruction } },
    )
    aliceInviteTxn.expect(100)

    const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

    bobInviteTxn.reply(183, {
      overrides: {
        headers: { "P-Early-Media": PEM_HEADER },
        body: earlySdp,
      },
    })

    aliceInviteTxn.expect(200, {
      predicate: (msg) => msg.bodyEquals(earlySdp),
    })

    aliceDialog.ack()

    // Bob 200 OK with DIFFERENT SDP triggers a resync re-INVITE on the a-leg.
    // skipValidation:["offerAnswer"] — finalSdp uses a deliberate non-derived
    // port so sdpMediaEquivalent picks up the difference; the harness's
    // strict offer/answer port=offerPort+1 check would otherwise complain.
    bobInviteTxn.reply(200, { body: finalSdp, skipValidation: ["offerAnswer"] })
    bobDialog.expect("ACK")

    // Alice receives the resync re-INVITE carrying bob's new SDP, plus
    // Allow + Supported (RFC 3261 §13.3.1 / §20.5 / §20.37).
    const aliceResyncTxn = aliceDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
      predicate: (msg) => {
        if (msg.bodyText()?.includes("m=audio 30000") !== true) return false
        const allow = msg.getHeader("allow")[0] ?? ""
        if (!/\bINVITE\b/i.test(allow)) return false
        const supported = msg.getHeader("supported")[0] ?? ""
        return /\btimer\b/i.test(supported) || supported.length > 0
      },
    })
    aliceResyncTxn.reply(200, {
      overrides: { body: sdpAnswer(finalSdp) },
      skipValidation: ["offerAnswer"],
    })
    // B2BUA's ACK to alice's 200 OK closes the window.
    aliceDialog.expect("ACK")

    // After the window closes, in-dialog flows resume — alice's INFO is
    // relayed to bob (NOT 488'd) as proof.
    s.pause(100)
    const aliceInfoTxn = aliceDialog.send("INFO", {
      overrides: { headers: { "Content-Type": "application/dtmf-relay" } },
      body: new TextEncoder().encode("Signal=1\r\nDuration=160\r\n"),
    })
    const bobInfoTxn = bobDialog.expect("INFO")
    bobInfoTxn.reply(200)
    aliceInfoTxn.expect(200)

    s.pause(500)
    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

// ── Scenario 3a: B fails post-promote — BYE A with Reason ─────────────────

export const promotePemBFailsPostPromote = scenario(
  "promote-pem-b-fails-post-promote",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

    // Bob auto-ACKs the 503 (RFC 3261 §17.1.1.3).
    bob.allowExtra("ACK")

    const aliceSdp = sdpOffer()
    const earlySdp = sdpAnswer(aliceSdp)

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      { body: aliceSdp, headers: { "X-Api-Call": promoteInstruction } },
    )
    aliceInviteTxn.expect(100)

    const { transaction: bobInviteTxn } = bob.receiveInitialInvite()

    bobInviteTxn.reply(183, {
      overrides: {
        headers: { "P-Early-Media": PEM_HEADER },
        body: earlySdp,
      },
    })
    aliceInviteTxn.expect(200)
    aliceDialog.ack()

    // Bob fails — alice already saw 200 OK so the failure cannot be
    // relayed as a routing failure. begin-termination BYEs the
    // still-confirmed a-leg with `Reason: SIP;cause=503;…` so alice can
    // log the upstream cause.
    bobInviteTxn.reply(503)

    const aliceByeTxn = aliceDialog.expect("BYE", {
      predicate: (msg) => {
        const reason = msg.getHeader("reason")[0] ?? ""
        return /\bcause\s*=\s*503\b/i.test(reason)
      },
    })
    aliceByeTxn.reply(200)
  },
)

// ── Scenario 3b: A rejects resync re-INVITE → BYE both legs ──────────────

export const promotePemResyncFailedByA = scenario(
  "promote-pem-resync-failed-by-a",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

    // Auto-ACK the 488 emitted on alice's resync re-INVITE rejection
    // (RFC 3261 §17.1.1.3 — UAC must ACK every non-2xx final response).
    alice.allowExtra("ACK")

    const aliceSdp = sdpOffer()
    const earlySdp = sdpAnswer(aliceSdp)
    const finalSdp = sdpAnswer(aliceSdp, { port: 30000 })

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      { body: aliceSdp, headers: { "X-Api-Call": promoteInstruction } },
    )
    aliceInviteTxn.expect(100)

    const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

    bobInviteTxn.reply(183, {
      overrides: { headers: { "P-Early-Media": PEM_HEADER }, body: earlySdp },
    })
    aliceInviteTxn.expect(200)
    aliceDialog.ack()

    bobInviteTxn.reply(200, { body: finalSdp, skipValidation: ["offerAnswer"] })
    bobDialog.expect("ACK")

    // Resync re-INVITE arrives on alice — alice rejects.
    const aliceResyncTxn = aliceDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
    })
    aliceResyncTxn.reply(488, { reason: "Not Acceptable Here" })

    // begin-termination BYEs both legs with `Reason: SIP;cause=488;…`.
    const reasonHasCause488 = (reason: string): boolean =>
      /\bcause\s*=\s*488\b/i.test(reason)
    const aliceByeTxn = aliceDialog.expect("BYE", {
      predicate: (msg) => reasonHasCause488(msg.getHeader("reason")[0] ?? ""),
    })
    aliceByeTxn.reply(200)
    const bobByeTxn = bobDialog.expect("BYE", {
      predicate: (msg) => reasonHasCause488(msg.getHeader("reason")[0] ?? ""),
    })
    bobByeTxn.reply(200)
  },
)

// ── Scenario 3c: A BYEs during early window → CANCEL B + 200 ─────────────

export const promotePemABYEDuringWindow = scenario(
  "promote-pem-a-bye-during-window",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

    // Bob auto-ACKs the 487.
    bob.allowExtra("ACK")

    const aliceSdp = sdpOffer()
    const earlySdp = sdpAnswer(aliceSdp)

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      { body: aliceSdp, headers: { "X-Api-Call": promoteInstruction } },
    )
    aliceInviteTxn.expect(100)

    const { transaction: bobInviteTxn } = bob.receiveInitialInvite()

    bobInviteTxn.reply(183, {
      overrides: { headers: { "P-Early-Media": PEM_HEADER }, body: earlySdp },
    })
    aliceInviteTxn.expect(200)
    aliceDialog.ack()

    // Alice hangs up before bob's final response.
    const aliceByeTxn = aliceDialog.bye()
    aliceByeTxn.expect(200)

    // CANCEL targets bob's still-open INVITE transaction.
    const bobCancelTxn = bobInviteTxn.expectCancel()
    bobCancelTxn.reply(200)
    bobInviteTxn.reply(487)
  },
)

// ── Scenario 4: no policy control — default 18x relay ────────────────────

export const promotePemNoPolicyControl = scenario(
  "promote-pem-no-policy-control",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

    const aliceSdp = sdpOffer()
    const earlySdp = sdpAnswer(aliceSdp)

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      { body: aliceSdp, headers: { "X-Api-Call": noPolicyInstruction } },
    )
    aliceInviteTxn.expect(100)

    const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

    // Same packet shape as the promote case but the policy is OFF.
    bobInviteTxn.reply(183, {
      overrides: { headers: { "P-Early-Media": PEM_HEADER }, body: earlySdp },
    })

    // Default relay-provisional fires — alice sees a 183, NOT a 200 OK,
    // and the body / PEM header survive the relay.
    aliceInviteTxn.expect(183, {
      predicate: (msg) => msg.hasBody() && msg.hasHeader("p-early-media"),
    })

    bobInviteTxn.reply(200, { body: earlySdp })
    aliceInviteTxn.expect(200)
    aliceDialog.ack()
    bobDialog.expect("ACK")

    s.pause(500)
    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

// ── Scenario 5: forking — promoting fork ≠ winning fork ──────────────────
//
// Bob's upstream forks. The 183 + PEM is delivered with To-tag t1 (which
// the B2BUA uses to seed alice's a-facing identity). The eventual 200 OK
// is delivered with a DIFFERENT To-tag (t2) — modelling an upstream
// forking proxy that picked another downstream branch as the winner.
// The B2BUA's confirm-after-promote rule must:
//   - re-seed the (bLegId, t2) → aFacingTag mapping using the same
//     a-facing tag it pinned at promote time (so alice's dialog identity
//     stays stable across the fork swap),
//   - confirm dialog t2 (NOT t1) and emit a local ACK toward bob with t2
//     in the To header,
//   - re-INVITE alice with the SDP from the t2 200 OK,
//   - route subsequent in-dialog requests from alice via dialog t2.
//
// The harness's bob agent only tracks one local tag, so we override the
// To header on the 18x and the 200 OK to inject explicit fork tags and
// skip the tag-consistency check on those steps.

export const promotePemForkingResync = scenario(
  "promote-pem-forking-resync",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

    const aliceSdp = sdpOffer()
    const earlySdp = sdpAnswer(aliceSdp)
    const finalSdp = sdpAnswer(aliceSdp, { port: 30000 })

    const FORK_T1 = "fork-tag-promoting-1"
    const FORK_T2 = "fork-tag-winning-2"

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      { body: aliceSdp, headers: { "X-Api-Call": promoteInstruction } },
    )
    aliceInviteTxn.expect(100)

    const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

    // 183 + PEM with To-tag = FORK_T1.
    bobInviteTxn.reply(183, {
      overrides: { headers: { "P-Early-Media": PEM_HEADER } },
      body: earlySdp,
      build: (ctx) => ({ to: `${ctx.last.to};tag=${FORK_T1}` }),
      skipValidation: ["tagConsistency"],
    })

    aliceInviteTxn.expect(200, {
      predicate: (msg) => msg.bodyEquals(earlySdp),
    })
    aliceDialog.ack()

    // Winning fork: 200 OK with To-tag = FORK_T2 ≠ FORK_T1, different SDP.
    bobInviteTxn.reply(200, {
      body: finalSdp,
      build: (ctx) => ({ to: `${ctx.last.to};tag=${FORK_T2}` }),
      skipValidation: ["offerAnswer", "tagConsistency"],
    })

    // The B2BUA-emitted local ACK toward bob must carry the WINNING fork's
    // To-tag — proves confirm-after-promote re-seeded onto t2 rather than
    // sticking with t1.
    bobDialog.expect("ACK", {
      skipValidation: ["tagConsistency"],
      predicate: (msg) => msg.getHeader("to").tag === FORK_T2,
    })

    const aliceResyncTxn = aliceDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
      predicate: (msg) => msg.bodyText()?.includes("m=audio 30000") === true,
    })
    aliceResyncTxn.reply(200, {
      overrides: { body: sdpAnswer(finalSdp) },
      skipValidation: ["offerAnswer"],
    })
    aliceDialog.expect("ACK")

    // Alice's BYE routes via the WINNING dialog — bob sees To-tag = FORK_T2.
    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE", {
      skipValidation: ["tagConsistency"],
      predicate: (msg) => msg.getHeader("to").tag === FORK_T2,
    })
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

// ── Scenario 6: in-dialog rejection during the window ────────────────────

export const promotePemInDialogRejection = scenario(
  "promote-pem-in-dialog-rejection",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: BOB_PORT })

    const aliceSdp = sdpOffer()
    const earlySdp = sdpAnswer(aliceSdp)

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      { body: aliceSdp, headers: { "X-Api-Call": promoteInstruction } },
    )
    aliceInviteTxn.expect(100)

    const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

    bobInviteTxn.reply(183, {
      overrides: { headers: { "P-Early-Media": PEM_HEADER }, body: earlySdp },
    })
    aliceInviteTxn.expect(200)
    aliceDialog.ack()

    // While the window is open (bob has not 200-OK'd yet), alice's
    // in-dialog requests are refused. UPDATE here carries no SDP — the
    // body-less form (RFC 3311 §5.2) keeps the harness's offer/answer
    // tracker quiet, since 491 carries no answer.
    const aliceUpdateTxn = aliceDialog.send("UPDATE")
    aliceUpdateTxn.expect(491)

    const aliceInfoTxn = aliceDialog.send("INFO", {
      overrides: { headers: { "Content-Type": "application/dtmf-relay" } },
      body: new TextEncoder().encode("Signal=2\r\nDuration=160\r\n"),
    })
    aliceInfoTxn.expect(488)

    // Now bob answers; SDP unchanged → no resync, window closes.
    bobInviteTxn.reply(200, { body: earlySdp })
    bobDialog.expect("ACK")

    s.pause(200)
    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)
