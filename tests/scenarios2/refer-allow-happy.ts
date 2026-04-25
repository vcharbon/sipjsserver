/**
 * REFER allow happy-path (drive-only port for the new harness).
 *
 * Same SIP flow as [tests/scenarios/refer-allow.ts] referAllowHappy:
 * A↔B established → B issues REFER → B2BUA authorises → C answers →
 * NOTIFY 100/180/200 sequence → A tears down.
 *
 * Receives a ServiceCase with one alice and three legs (bob, charlie,
 * and the leg whose `name` is `bob` issues the REFER). Inline checks
 * are gone; rule packs assert post-hoc.
 */

import { scenario } from "../fullcall/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../fullcall/helpers/sdp.js"
import { LabelRegistry, type ScenarioBuildResult, type ScenarioScript } from "../harness/runner.js"

const CHARLIE_PORT = 5667
const REFER_TO_CHARLIE = `<sip:charlie@127.0.0.1:${CHARLIE_PORT}>`

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

function xApiAllowC(): Record<string, string> {
  const instruction = {
    refer_key: "refer-allow-c",
    destination: { host: "127.0.0.1", port: CHARLIE_PORT },
  }
  return { "X-Api-Call": JSON.stringify(instruction) }
}

export const referAllowHappy: ScenarioScript = (sc) => {
  const labels = new LabelRegistry()
  const alice = sc.alices[0]!
  const bob = sc.legs.find((l) => l.name === "bob")
  const charlie = sc.legs.find((l) => l.name === "charlie")
  if (!bob || !charlie) {
    throw new Error("refer-allow-happy: ServiceCase needs legs named 'bob' and 'charlie'")
  }

  const composable = scenario("refer-allow-happy", (s) => {
    const a = s.agent(alice.name, { uri: alice.content.fromUri })
    const b = s.agent(bob.name, { uri: `sip:${bob.name}@test`, port: 5666 })
    const c = s.agent(charlie.name, { uri: `sip:${charlie.name}@test`, port: CHARLIE_PORT })

    // Begin-termination at call end BYEs any still-confirmed leg; tolerate.
    a.allowExtra("BYE")
    b.allowExtra("BYE")
    c.allowExtra("BYE")
    // The B2BUA emits a c-realigning re-INVITE to C after C's 200; not
    // scripted here.
    c.allowExtra("INVITE")

    const { dialog: aDialog, transaction: aInviteTxn } = a.invite(alice.content.requestUri, {
      body: sdpOffer(),
    })
    labels.set(aInviteTxn.expect(100).id, "alice.expect100")

    const { dialog: bDialog, transaction: bInviteTxn } = b.receiveInitialInvite()
    const ringRef = bInviteTxn.reply(180)
    labels.set(ringRef.id, "bob.send180")

    labels.set(aInviteTxn.expect(180).id, "alice.expect180")

    const okRef = bInviteTxn.reply(200, { body: sdpAnswer() })
    labels.set(okRef.id, "bob.send200")

    labels.set(aInviteTxn.expect(200).id, "alice.expect200")

    aDialog.ack()
    bDialog.expect("ACK")

    // REFER → 202
    const bobReferTxn = bDialog.send("REFER", {
      overrides: {
        headers: {
          "Refer-To": REFER_TO_CHARLIE,
          ...xApiAllowC(),
        },
      },
    })
    labels.set(bobReferTxn.expect(202).id, "bob.expectRefer202")

    // NOTIFY 100 active
    const notifyTryingTxn = bDialog.expect("NOTIFY", {
      predicate: (msg) => {
        if (msg.type !== "request") return false
        const subState = headerValue(msg, "subscription-state") ?? ""
        return subState.startsWith("active") &&
          decodeBody(msg.body).includes("SIP/2.0 100 Trying")
      },
    })
    notifyTryingTxn.reply(200)

    // Charlie receives initial INVITE from B2BUA (held SDP).
    const { transaction: cInviteTxn } = c.receiveInitialInvite()
    cInviteTxn.reply(180)

    // NOTIFY 180 active
    const notify180Txn = bDialog.expect("NOTIFY", {
      predicate: (msg) => {
        if (msg.type !== "request") return false
        const subState = headerValue(msg, "subscription-state") ?? ""
        return subState.startsWith("active") &&
          decodeBody(msg.body).includes("SIP/2.0 180 Ringing")
      },
    })
    notify180Txn.reply(200)

    // Charlie answers 200.
    cInviteTxn.reply(200, { body: sdpAnswer() })
    cInviteTxn.expectAck()

    // NOTIFY 200 terminated — final sipfrag, subscription closes.
    const notifyTermTxn = bDialog.expect("NOTIFY", {
      predicate: (msg) => {
        if (msg.type !== "request") return false
        const subState = headerValue(msg, "subscription-state") ?? ""
        return subState.startsWith("terminated") &&
          decodeBody(msg.body).includes("SIP/2.0 200")
      },
    })
    notifyTermTxn.reply(200)

    // A↔B still bridged. Tear down via A BYE.
    const aByeTxn = aDialog.bye()
    const bByeTxn = bDialog.expect("BYE")
    bByeTxn.reply(200)
    aByeTxn.expect(200)
  })

  const out: ScenarioBuildResult = { scenario: composable, labels }
  return out
}
