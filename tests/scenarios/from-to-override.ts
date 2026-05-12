/**
 * From / To URI override on the B-leg INVITE (Issue 6 of the
 * upstream-consumer plan).
 *
 * Verifies RFC 3261 §12.2.1.1: once a dialog is established with a
 * given local/remote URI, every subsequent in-dialog request from the
 * same UAC MUST carry the same From URI as the dialog's local URI and
 * the same To URI as the dialog's remote URI. Until this fix the
 * B2BUA stamped `leg.localUri`/`leg.remoteUri` from the **A-leg**
 * From/To *before* applying `update_headers`, so the B-leg INVITE
 * carried the override but the subsequent ACK and BYE silently
 * reverted to Alice's identity.
 *
 * Bob's harness validator (`validateDialogUri`) catches the
 * mismatched URI at receive time, so just driving a full
 * INVITE → 200 → ACK → BYE through is sufficient — a regression
 * surfaces as a failed scenario without an explicit assertion.
 */

import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../src/test-harness/framework/helpers/sdp.js"

const FROM_OVERRIDE = '"Service" <sip:service@10.0.0.7>'
const TO_OVERRIDE = '"Backend" <sip:backend@10.0.0.42>'

const fromOverrideInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: 5666 },
  update_headers: { From: FROM_OVERRIDE },
})

const toOverrideInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: 5666 },
  update_headers: { To: TO_OVERRIDE },
})

const bothOverrideInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: 5666 },
  update_headers: { From: FROM_OVERRIDE, To: TO_OVERRIDE },
})

// A consumer-supplied tag= on From / To is silently stripped by the
// helper (the B2BUA owns the From-tag and the dialog carries the
// remote To-tag from the 200 OK). We don't need to exercise the
// stripping per se — Bob's validator would explode if a stale tag
// reached the wire — but we do exercise the path via `_TAGGED`.
const FROM_OVERRIDE_TAGGED = `${FROM_OVERRIDE};tag=consumer-tag-must-be-stripped`

const fromOverrideTaggedInstruction = JSON.stringify({
  action: "route",
  destination: { host: "127.0.0.1", port: 5666 },
  update_headers: { From: FROM_OVERRIDE_TAGGED },
})

/**
 * Override From → run the call to BYE. Bob's `validateDialogUri`
 * catches any in-dialog request whose From URI differs from what was
 * captured at INVITE time.
 */
export const bLegFromOverridePersistsToBye = scenario(
  "b-leg-from-override-persists-to-bye",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      {
        body: sdpOffer(),
        headers: { "X-Api-Call": fromOverrideInstruction },
      },
    )
    aliceInviteTxn.expect(100)

    // Bob receives the B-leg INVITE — assert From URI was overridden.
    const { dialog: bobDialog, transaction: bobInviteTxn } =
      bob.receiveInitialInvite({
        predicate: (msg) => msg.getHeader("from").uri.includes("sip:service@10.0.0.7"),
      })

    bobInviteTxn.reply(180)
    aliceInviteTxn.expect(180)
    bobInviteTxn.reply(200, { body: sdpAnswer() })
    aliceInviteTxn.expect(200)

    aliceDialog.ack()
    bobDialog.expect("ACK")

    s.pause(500)

    // Bob hangs up — the B2BUA emits a BYE on Alice's leg.
    // The interesting in-dialog request for *this* test is the BYE
    // BobDialog.expect()s from the B2BUA: its From URI must equal the
    // override we set above (RFC 3261 §12.2.1.1). validateDialogUri
    // (`tests/.../validation.ts:453-473`) flags any drift.
    const aliceByeTxn = aliceDialog.bye()
    const bobByeTxn = bobDialog.expect("BYE")
    bobByeTxn.reply(200)
    aliceByeTxn.expect(200)
  },
)

/**
 * Override To. Same shape — Bob captures To URI at INVITE time
 * (it is *his* identity from his perspective, but the B2BUA uses it
 * as the dialog's remoteUri). The To-tag is added by Bob in the 200
 * OK and threaded through ACK / BYE; the override never touches it.
 */
export const bLegToOverridePersistsToBye = scenario(
  "b-leg-to-override-persists-to-bye",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      {
        body: sdpOffer(),
        headers: { "X-Api-Call": toOverrideInstruction },
      },
    )
    aliceInviteTxn.expect(100)

    const { dialog: bobDialog, transaction: bobInviteTxn } =
      bob.receiveInitialInvite({
        predicate: (msg) => msg.getHeader("to").uri.includes("sip:backend@10.0.0.42"),
      })

    bobInviteTxn.reply(180)
    aliceInviteTxn.expect(180)
    bobInviteTxn.reply(200, { body: sdpAnswer() })
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

/** Both From AND To overridden — full happy path through BYE. */
export const bLegBothOverridePersistsToBye = scenario(
  "b-leg-both-override-persists-to-bye",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      {
        body: sdpOffer(),
        headers: { "X-Api-Call": bothOverrideInstruction },
      },
    )
    aliceInviteTxn.expect(100)

    const { dialog: bobDialog, transaction: bobInviteTxn } =
      bob.receiveInitialInvite({
        predicate: (msg) =>
          msg.getHeader("from").uri.includes("sip:service@10.0.0.7") &&
          msg.getHeader("to").uri.includes("sip:backend@10.0.0.42"),
      })

    bobInviteTxn.reply(180)
    aliceInviteTxn.expect(180)
    bobInviteTxn.reply(200, { body: sdpAnswer() })
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

/**
 * Tag stripping — consumer-supplied `tag=` on the From override is
 * silently stripped by the helper. The B-leg INVITE / ACK / BYE all
 * carry the B2BUA's generated From-tag, NOT the consumer's. Bob's
 * validator catches any stale tag bleed-through.
 */
export const bLegFromOverrideTagStripped = scenario(
  "b-leg-from-override-tag-stripped",
  (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@test" })
    const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })

    const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
      "sip:+1234@127.0.0.1:15060",
      {
        body: sdpOffer(),
        headers: { "X-Api-Call": fromOverrideTaggedInstruction },
      },
    )
    aliceInviteTxn.expect(100)

    const { dialog: bobDialog, transaction: bobInviteTxn } =
      bob.receiveInitialInvite({
        // URI present, consumer tag is gone.
        predicate: (msg) =>
          msg.getHeader("from").uri.includes("sip:service@10.0.0.7") &&
          msg.getHeader("from").tag !== "consumer-tag-must-be-stripped",
      })

    bobInviteTxn.reply(180)
    aliceInviteTxn.expect(180)
    bobInviteTxn.reply(200, { body: sdpAnswer() })
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
