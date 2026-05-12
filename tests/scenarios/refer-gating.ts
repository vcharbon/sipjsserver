/**
 * REFER Regime-1 transparency + Regime-2 gating scenarios (slice 9).
 *
 * Verification slice. Each scenario pins the transfer to a specific phase
 * and injects a foreign message; the rule framework should either:
 *   - Regime 1 (refer-authorizing, c-ringing): relay transparently through
 *     the normal relay-* rules (re-INVITE/INFO in either direction).
 *   - Regime 2 (c-realigning, a-realigning): reject 491/481 via the
 *     transfer-*-glare-reinvite / transfer-b-in-cre-are-reject rules.
 *   - Second REFER in any phase: 491 via transfer-reject-second-refer.
 *
 * Gating matrix rows already covered elsewhere and skipped here:
 *   - A re-INVITE during a-realigning → 491         (refer-full-transfer.ts)
 *   - B non-BYE during c-realigning → 481           (refer-c-realign.ts)
 *   - Second REFER during refer-authorizing → 491   (refer-reject.ts)
 */

import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../src/test-harness/framework/helpers/sdp.js"
import type { SipMessage } from "../../src/sip/types.js"

/**
 * Body-equality modulo the SDP `o=` line. The framework rewrites the
 * `o=` line on outbound SDP to honour RFC 3264 §8 / RFC 4566 §5.2
 * origin continuity (see `applyOutgoingSdpOriginRewrite` in
 * [tests/fullcall/framework/message-builder.ts](../fullcall/framework/message-builder.ts)),
 * so a precomputed `sdpOffer(...)` body no longer matches what the
 * agent actually puts on the wire byte-for-byte once the agent has
 * already emitted SDP earlier in the dialog. Comparing modulo the
 * origin line preserves the original "proxy is body-transparent"
 * intent of these predicates.
 */
function sdpBodyEqualIgnoringOrigin(actual: Uint8Array, expected: Uint8Array): boolean {
  const stripOriginLine = (bytes: Uint8Array): string => {
    const text = new TextDecoder().decode(bytes)
    return text.split(/\r?\n/).filter((line) => !line.startsWith("o=")).join("\n")
  }
  return stripOriginLine(actual) === stripOriginLine(expected)
}

function contactHasLegTag(msg: SipMessage, legTag: string): boolean {
  return (msg.getHeader("contact")?.uri ?? "").includes(`leg=${legTag}`)
}

const CHARLIE_PORT = 5667
const REFER_TO_CHARLIE = `<sip:charlie@127.0.0.1:${CHARLIE_PORT}>`
const DTMF_PAYLOAD = new TextEncoder().encode("Signal=5\r\nDuration=160\r\n")

function xApiAllowC(extras?: Record<string, unknown>): Record<string, string> {
  const instruction: Record<string, unknown> = {
    refer_key: "refer-allow-c",
    destination: { host: "127.0.0.1", port: CHARLIE_PORT },
    ...extras,
  }
  return { "X-Api-Call": JSON.stringify(instruction) }
}

function xApiHttpTimeout(): Record<string, string> {
  return { "X-Api-Call": JSON.stringify({ refer_key: "refer-http-timeout" }) }
}

// ── 1. A re-INVITE during refer-authorizing → transparent relay to B ──────

export const referGatingAReinviteRefAuthorizing = scenario(
  "refer-gating-a-reinvite-refer-authorizing",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

    // 61s TestClock advance surfaces Timer E retransmits of the 100 active NOTIFY.
    bob.allowExtra("NOTIFY")

    const aliceSdp = sdpOffer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15066",
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

    // REFER with HTTP that hangs → phase pinned to refer-authorizing for ≤60s.
    const bobReferTxn = bobDialog.send("REFER", {
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiHttpTimeout() } },
    })
    bobReferTxn.expect(202)

    const notifyTryingTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("active") &&
        msg.bodyText()?.includes("SIP/2.0 100 Trying") === true,
    })
    notifyTryingTxn.reply(200)

    // A sends re-INVITE mid-authorising — must relay transparently to B.
    const aliceReinviteSdp = sdpOffer(undefined, 30000)
    const aliceReinviteTxn = aliceDialog.send("INVITE", {
      overrides: { body: aliceReinviteSdp },
      skipValidation: ["offerAnswer"],
    })
    aliceReinviteTxn.expect(100)

    const bobReinviteTxn = bobDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
      predicate: (msg) =>
        sdpBodyEqualIgnoringOrigin(msg.body, aliceReinviteSdp),
    })
    bobReinviteTxn.reply(200, {
      overrides: { body: sdpAnswer(aliceReinviteSdp) },
      skipValidation: ["offerAnswer"],
    })
    aliceReinviteTxn.expect(200)
    aliceDialog.ack()
    bobDialog.expect("ACK")

    // Advance past the 60s subscription-expiry to resolve the transfer cleanly.
    s.pause(61_000)
    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("terminated") &&
        msg.bodyText()?.includes("SIP/2.0 500") === true,
    })
    notifyTermTxn.reply(200)

    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

// ── 2. A re-INVITE during c-ringing → transparent relay to B ──────────────

export const referGatingAReinviteCRinging = scenario(
  "refer-gating-a-reinvite-c-ringing",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    const aliceSdp = sdpOffer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15066",
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

    // REFER with allow → HTTP responds → INVITE C → 180. Phase c-ringing.
    const bobReferTxn = bobDialog.send("REFER", {
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiAllowC() } },
    })
    bobReferTxn.expect(202)

    const notifyTryingTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.bodyText()?.includes("SIP/2.0 100 Trying") === true,
    })
    notifyTryingTxn.reply(200)

    const { transaction: charlieInviteTxn } = charlie.receiveInitialInvite()
    charlieInviteTxn.reply(180)
    const notify180Txn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.bodyText()?.includes("SIP/2.0 180") === true,
    })
    notify180Txn.reply(200)

    // A re-INVITE mid c-ringing — must still relay to B transparently.
    const aliceReinviteSdp = sdpOffer(undefined, 30000)
    const aliceReinviteTxn = aliceDialog.send("INVITE", {
      overrides: { body: aliceReinviteSdp },
      skipValidation: ["offerAnswer"],
    })
    aliceReinviteTxn.expect(100)

    const bobReinviteTxn = bobDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
      predicate: (msg) =>
        sdpBodyEqualIgnoringOrigin(msg.body, aliceReinviteSdp),
    })
    bobReinviteTxn.reply(200, {
      overrides: { body: sdpAnswer(aliceReinviteSdp) },
      skipValidation: ["offerAnswer"],
    })
    aliceReinviteTxn.expect(200)
    aliceDialog.ack()
    bobDialog.expect("ACK")

    // C rejects → NOTIFY 486 terminated → transfer cleared, A↔B alive.
    charlieInviteTxn.reply(486, { reason: "Busy Here" })
    charlieInviteTxn.expectAck()

    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("terminated") &&
        msg.bodyText()?.includes("SIP/2.0 486") === true,
    })
    notifyTermTxn.reply(200)

    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

// ── 3. A re-INVITE during c-realigning → 491 Request Pending ──────────────

export const referGatingAReinviteCRealigning = scenario(
  "refer-gating-a-reinvite-c-realigning",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    const aliceSdp = sdpOffer()
    const charlieInitialSdp = sdpAnswer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15066",
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
        msg.bodyText()?.includes("SIP/2.0 100 Trying") === true,
    })
    notifyTryingTxn.reply(200)

    const { dialog: charlieDialog, transaction: charlieInviteTxn } =
      charlie.receiveInitialInvite()
    charlieInviteTxn.reply(200, { body: charlieInitialSdp })
    charlieInviteTxn.expectAck()

    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.bodyText()?.includes("SIP/2.0 200") === true,
    })
    notifyTermTxn.reply(200)

    // Observe c-realign re-INVITE so we are pinned in c-realigning.
    const cRealignTxn = charlieDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
    })

    // A glares during c-realigning — rule transfer-a-glare-reinvite returns 491.
    const aGlareTxn = aliceDialog.send("INVITE", {
      overrides: { body: sdpOffer(undefined, 30000) },
      skipValidation: ["offerAnswer"],
    })
    aGlareTxn.expect(100)
    aGlareTxn.expect(491)

    // Resume normal transfer completion.
    cRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(aliceSdp) },
      skipValidation: ["offerAnswer"],
    })
    charlieDialog.expect("ACK")

    const aRealignTxn = aliceDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
      predicate: (msg) => contactHasLegTag(msg, "a"),
    })
    aRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(charlieInitialSdp) },
      skipValidation: ["offerAnswer"],
    })
    aliceDialog.expect("ACK")

    // Merge complete — alice BYE tears down both peers.
    const aliceByeTxn = aliceDialog.bye()
    const charlieByeTxn = charlieDialog.expect("BYE")
    charlieByeTxn.reply(200)
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

// ── 4. A INFO during refer-authorizing → transparent relay to B ──────────

export const referGatingAInfoRefAuthorizing = scenario(
  "refer-gating-a-info-refer-authorizing",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

    bob.allowExtra("NOTIFY")

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15066",
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
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiHttpTimeout() } },
    })
    bobReferTxn.expect(202)

    const notifyTryingTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("active"),
    })
    notifyTryingTxn.reply(200)

    // A INFO during refer-authorizing → relays to B.
    const aliceInfoTxn = aliceDialog.send("INFO", {
      body: DTMF_PAYLOAD,
      overrides: { headers: { "Content-Type": "application/dtmf-relay" } },
    })
    bobDialog
      .expect("INFO", {
        predicate: (msg) =>
          msg.getHeader("content-type")[0] === "application/dtmf-relay" &&
          msg.bodyEquals(DTMF_PAYLOAD),
      })
      .reply(200)
    aliceInfoTxn.expect(200)

    s.pause(61_000)
    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("terminated"),
    })
    notifyTermTxn.reply(200)

    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

// ── 5. A INFO during c-ringing → transparent relay to B ───────────────────

export const referGatingAInfoCRinging = scenario(
  "refer-gating-a-info-c-ringing",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15066",
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
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiAllowC() } },
    })
    bobReferTxn.expect(202)

    const notifyTryingTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.bodyText()?.includes("SIP/2.0 100 Trying") === true,
    })
    notifyTryingTxn.reply(200)

    const { transaction: charlieInviteTxn } = charlie.receiveInitialInvite()
    charlieInviteTxn.reply(180)
    const notify180Txn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.bodyText()?.includes("SIP/2.0 180") === true,
    })
    notify180Txn.reply(200)

    // A INFO during c-ringing → relays to B.
    const aliceInfoTxn = aliceDialog.send("INFO", {
      body: DTMF_PAYLOAD,
      overrides: { headers: { "Content-Type": "application/dtmf-relay" } },
    })
    bobDialog
      .expect("INFO", {
        predicate: (msg) =>
          msg.bodyEquals(DTMF_PAYLOAD),
      })
      .reply(200)
    aliceInfoTxn.expect(200)

    charlieInviteTxn.reply(486, { reason: "Busy Here" })
    charlieInviteTxn.expectAck()

    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("terminated") &&
        msg.bodyText()?.includes("SIP/2.0 486") === true,
    })
    notifyTermTxn.reply(200)

    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

// ── 6. B INFO during refer-authorizing → transparent relay to A ──────────

export const referGatingBInfoRefAuthorizing = scenario(
  "refer-gating-b-info-refer-authorizing",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

    bob.allowExtra("NOTIFY")

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15066",
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
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiHttpTimeout() } },
    })
    bobReferTxn.expect(202)

    const notifyTryingTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("active"),
    })
    notifyTryingTxn.reply(200)

    // B INFO during refer-authorizing → relays to A (no transfer rule gates it).
    const bobInfoTxn = bobDialog.send("INFO", {
      body: DTMF_PAYLOAD,
      overrides: { headers: { "Content-Type": "application/dtmf-relay" } },
    })
    aliceDialog
      .expect("INFO", {
        predicate: (msg) =>
          msg.bodyEquals(DTMF_PAYLOAD),
      })
      .reply(200)
    bobInfoTxn.expect(200)

    s.pause(61_000)
    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("terminated"),
    })
    notifyTermTxn.reply(200)

    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

// ── 7. Second REFER during c-ringing → 491 ────────────────────────────────

export const referGatingSecondReferCRinging = scenario(
  "refer-gating-second-refer-c-ringing",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15066",
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

    const firstReferTxn = bobDialog.send("REFER", {
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiAllowC() } },
    })
    firstReferTxn.expect(202)

    const notifyTryingTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.bodyText()?.includes("SIP/2.0 100 Trying") === true,
    })
    notifyTryingTxn.reply(200)

    const { transaction: charlieInviteTxn } = charlie.receiveInitialInvite()
    charlieInviteTxn.reply(180)
    const notify180Txn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.bodyText()?.includes("SIP/2.0 180") === true,
    })
    notify180Txn.reply(200)

    // Second REFER while c-ringing → 491 (transfer-reject-second-refer).
    const secondReferTxn = bobDialog.send("REFER", {
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE } },
    })
    secondReferTxn.expect(491)

    // Resolve the first REFER cleanly.
    charlieInviteTxn.reply(486, { reason: "Busy Here" })
    charlieInviteTxn.expectAck()
    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        (msg.getHeader("subscription-state")[0] ?? "").startsWith("terminated") &&
        msg.bodyText()?.includes("SIP/2.0 486") === true,
    })
    notifyTermTxn.reply(200)

    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

// ── 8. Second REFER during c-realigning → 491 ─────────────────────────────

export const referGatingSecondReferCRealigning = scenario(
  "refer-gating-second-refer-c-realigning",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
    const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT })

    const aliceSdp = sdpOffer()
    const charlieInitialSdp = sdpAnswer()

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15066",
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

    const firstReferTxn = bobDialog.send("REFER", {
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiAllowC() } },
    })
    firstReferTxn.expect(202)

    const notifyTryingTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.bodyText()?.includes("SIP/2.0 100 Trying") === true,
    })
    notifyTryingTxn.reply(200)

    const { dialog: charlieDialog, transaction: charlieInviteTxn } =
      charlie.receiveInitialInvite()
    charlieInviteTxn.reply(200, { body: charlieInitialSdp })
    charlieInviteTxn.expectAck()

    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.bodyText()?.includes("SIP/2.0 200") === true,
    })
    notifyTermTxn.reply(200)

    // Observe c-realign re-INVITE so we are pinned in c-realigning.
    const cRealignTxn = charlieDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
    })

    // Second REFER mid c-realigning → 491 (transfer-reject-second-refer).
    const secondReferTxn = bobDialog.send("REFER", {
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE } },
    })
    secondReferTxn.expect(491)

    // Resume and complete the transfer.
    cRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(aliceSdp) },
      skipValidation: ["offerAnswer"],
    })
    charlieDialog.expect("ACK")

    const aRealignTxn = aliceDialog.expect("INVITE", {
      skipValidation: ["offerAnswer"],
      predicate: (msg) => contactHasLegTag(msg, "a"),
    })
    aRealignTxn.reply(200, {
      overrides: { body: sdpAnswer(charlieInitialSdp) },
      skipValidation: ["offerAnswer"],
    })
    aliceDialog.expect("ACK")

    const aliceByeTxn = aliceDialog.bye()
    const charlieByeTxn = charlieDialog.expect("BYE")
    charlieByeTxn.reply(200)
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)
