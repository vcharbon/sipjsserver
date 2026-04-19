/**
 * REFER reject-path scenarios (slice 4).
 *
 * Every scenario brings an A↔B call to confirmed state, then exercises one
 * reject path of the TransferRules chain:
 *   - HTTP reject with a specific status
 *   - HTTP that never responds (subscription-expiry timer fires)
 *   - Refer-To carrying a Replaces= URI parameter (attended transfer)
 *   - REFER with an unknown Call-ID (out of dialog)
 *   - A second REFER while the first is still in refer-authorizing
 */

import { scenario } from "../fullcall/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../fullcall/helpers/sdp.js"

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

const REFER_TO_CHARLIE = "<sip:charlie@example.com>"

// Build a REFER send call with a given X-Api-Call key encoded into sip_headers.
function xApiCall(key: string): Record<string, string> {
  return { "X-Api-Call": JSON.stringify({ refer_key: key }) }
}

// ── 1. REFER → X-Api-Call refer-reject-403 → NOTIFY 100 active, NOTIFY 403 term ─

export const referRejectHttp403 = scenario("refer-reject-http-403", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15060",
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

  // Bob sends REFER; mock /call/refer replies action=reject, reject_code=403.
  const bobReferTxn = bobDialog.send("REFER", {
    overrides: {
      headers: {
        "Refer-To": REFER_TO_CHARLIE,
        ...xApiCall("refer-reject-403"),
      },
    },
  })
  bobReferTxn.expect(202)

  // NOTIFY 100 Trying (implicit subscription active).
  const notifyActiveTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) => {
      if (msg.type !== "request") return false
      const subState = headerValue(msg, "subscription-state") ?? ""
      const event = headerValue(msg, "event") ?? ""
      return event === "refer" &&
        subState.startsWith("active") &&
        decodeBody(msg.body).includes("SIP/2.0 100 Trying")
    },
  })
  notifyActiveTxn.reply(200)

  // NOTIFY terminated — status matches HTTP reject_code (403).
  const notifyTermTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) => {
      if (msg.type !== "request") return false
      const subState = headerValue(msg, "subscription-state") ?? ""
      return subState.startsWith("terminated") &&
        decodeBody(msg.body).includes("SIP/2.0 403 Forbidden")
    },
  })
  notifyTermTxn.reply(200)

  // Underlying A↔B call is undisturbed — tear it down normally.
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── 2. REFER → X-Api-Call refer-http-timeout → 60s later NOTIFY 500 terminated ─

export const referHttpTimeout = scenario("refer-http-timeout", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  // Under TestClock the 61s pause accumulates Timer E retransmits of the
  // initial NOTIFY 100 active — tolerate any stray NOTIFY that arrives after
  // bob's 200 OK was accepted by the transaction layer.
  bob.allowExtra("NOTIFY")

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15060",
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

  // HTTP mock hangs indefinitely (Effect.never) on this X-Api-Call key.
  const bobReferTxn = bobDialog.send("REFER", {
    overrides: {
      headers: {
        "Refer-To": REFER_TO_CHARLIE,
        ...xApiCall("refer-http-timeout"),
      },
    },
  })
  bobReferTxn.expect(202)

  const notifyActiveTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) => {
      if (msg.type !== "request") return false
      const subState = headerValue(msg, "subscription-state") ?? ""
      return subState.startsWith("active") &&
        decodeBody(msg.body).includes("SIP/2.0 100 Trying")
    },
  })
  notifyActiveTxn.reply(200)

  // Advance past the 60s subscription-expiry timer (TestClock). The rule
  // emits NOTIFY 500 terminated and clears the transfer.
  s.pause(61_000)

  const notifyTermTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) => {
      if (msg.type !== "request") return false
      const subState = headerValue(msg, "subscription-state") ?? ""
      return subState.startsWith("terminated") &&
        decodeBody(msg.body).includes("SIP/2.0 500")
    },
  })
  notifyTermTxn.reply(200)

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── 3. REFER with Replaces= in Refer-To → 501 Not Implemented ─────────────

export const referReplacesRejected = scenario("refer-replaces-rejected", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15060",
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

  // Attended-transfer REFER (RFC 3891). Not supported in v1 — expect 501.
  const bobReferTxn = bobDialog.send("REFER", {
    overrides: {
      headers: {
        "Refer-To":
          "<sip:charlie@example.com?Replaces=abc%3Bto-tag%3Dx%3Bfrom-tag%3Dy>",
      },
    },
  })
  bobReferTxn.expect(501)

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── 4. Out-of-dialog REFER (unknown Call-ID) → 481 ────────────────────────

export const referOutOfDialog = scenario("refer-out-of-dialog", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
  const stranger = s.agent("stranger", { uri: "sip:stranger@test" })

  // Keep a real call alive so the B2BUA has routing state around.
  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    "sip:+1234@127.0.0.1:15060",
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

  s.pause(200)

  // Stranger sends REFER with a bogus dialog — resolution fails, 481 returned
  // by SipRouter before any transfer rule runs.
  const strangerReferTxn = stranger.dialog.send("REFER", {
    uri: "sip:unknown@127.0.0.1:15060",
    overrides: {
      to: "<sip:unknown@test>;tag=bogus-refer-tag",
      headers: { "Refer-To": REFER_TO_CHARLIE },
    },
  })
  strangerReferTxn.expect(481)

  // Active call teardown proves unrelated dialogs are unaffected.
  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// ── 5. Second REFER during refer-authorizing → 491 ────────────────────────

export const referSecondDuringAuthorizing = scenario(
  "refer-second-during-authorizing",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

    // 61s pause under TestClock may surface Timer E retransmits of the
    // initial NOTIFY 100 active — tolerate any stray NOTIFY.
    bob.allowExtra("NOTIFY")

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
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

    // First REFER — HTTP hangs so the transfer stays in refer-authorizing.
    const firstReferTxn = bobDialog.send("REFER", {
      overrides: {
        headers: {
          "Refer-To": REFER_TO_CHARLIE,
          ...xApiCall("refer-http-timeout"),
        },
      },
    })
    firstReferTxn.expect(202)

    const notifyActiveTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.type === "request" &&
        (headerValue(msg, "subscription-state") ?? "").startsWith("active"),
    })
    notifyActiveTxn.reply(200)

    // Second REFER while in refer-authorizing — rejected 491.
    const secondReferTxn = bobDialog.send("REFER", {
      overrides: { headers: { "Refer-To": REFER_TO_CHARLIE } },
    })
    secondReferTxn.expect(491)

    // Advance the subscription-expiry timer so the first REFER is resolved
    // cleanly before the call ends — avoids a dangling state for the harness.
    s.pause(61_000)
    const notifyTermTxn = bobDialog.expect("NOTIFY", {
      predicate: (msg) =>
        msg.type === "request" &&
        (headerValue(msg, "subscription-state") ?? "").startsWith("terminated"),
    })
    notifyTermTxn.reply(200)

    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)
