/**
 * Media (RTP) across a REFER blind transfer through the real B2BUA (ADR-0017).
 *
 * A↔B call established (media), then B transfers A to C (REFER). The B2BUA
 * INVITEs C (held), realigns C with A's SDP, realigns A with C's SDP, and
 * merges A↔C. The media-truth assertion: after the merge, Alice and Charlie
 * genuinely hear each other. If the realign path mis-carries SDP (e.g. leaves
 * a side on hold / inactive, or misdirects c=), the `hears(...)` verdict fails
 * — surfacing a REFER call-flow bug the signaling-only checks cannot see.
 */
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpAnswer, sdpOffer } from "../../src/test-harness/framework/helpers/sdp.js"
import type { SipMessage } from "../../src/sip/types.js"
import { createSimulatedRunner } from "../support/harness.js"

const OUTPUT_DIR = "test-results/media"
const CHARLIE_PORT = 5667
const REFER_TO_CHARLIE = `<sip:charlie@127.0.0.1:${CHARLIE_PORT}>`

function contactHasLegTag(msg: SipMessage, legTag: string): boolean {
  return (msg.getHeader("contact")?.uri ?? "").includes(`leg=${legTag}`)
}

const xApiAllowC: Record<string, string> = {
  "X-Api-Call": JSON.stringify({
    refer_key: "refer-allow-c",
    destination: { host: "127.0.0.1", port: CHARLIE_PORT },
  }),
}

const referMedia = scenario("refer-transfer-media", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test", media: {} })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666 })
  const charlie = s.agent("charlie", { uri: "sip:charlie@test", port: CHARLIE_PORT, media: {} })

  // --- A↔B call (Alice media-driven; Bob a plain UAS) ---
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

  // --- B transfers A to C ---
  const bobReferTxn = bobDialog.send("REFER", {
    overrides: { headers: { "Refer-To": REFER_TO_CHARLIE, ...xApiAllowC } },
  })
  bobReferTxn.expect(202)

  const notifyTryingTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) => msg.bodyText()?.includes("SIP/2.0 100 Trying") === true,
  })
  notifyTryingTxn.reply(200)

  // C accepts the (held) initial INVITE — media-driven answer.
  const { dialog: charlieDialog, transaction: charlieInviteTxn } =
    charlie.receiveInitialInvite()
  charlieInviteTxn.reply(200, { body: sdpAnswer() })
  charlieInviteTxn.expectAck()

  const notifyTermTxn = bobDialog.expect("NOTIFY", {
    predicate: (msg) => msg.bodyText()?.includes("SIP/2.0 200") === true,
  })
  notifyTermTxn.reply(200)

  // c-realign: re-INVITE C with A's real SDP (engine-driven on both ends).
  const cRealignTxn = charlieDialog.expect("INVITE", {
    skipValidation: ["offerAnswer"],
    predicate: (msg) =>
      msg.hasBody() && msg.getHeader("cseq").method === "INVITE" && contactHasLegTag(msg, "b-2"),
  })
  cRealignTxn.reply(200, { body: sdpAnswer(), skipValidation: ["offerAnswer"] })
  charlieDialog.expect("ACK")

  // a-realign: re-INVITE A with C's SDP.
  const aRealignTxn = aliceDialog.expect("INVITE", {
    skipValidation: ["offerAnswer"],
    predicate: (msg) => msg.hasBody() && contactHasLegTag(msg, "a"),
  })
  aRealignTxn.reply(200, { body: sdpAnswer(), skipValidation: ["offerAnswer"] })
  aliceDialog.expect("ACK")

  // --- Audio over the merged A↔C path ---
  aliceDialog.media.plays("alice")
  charlieDialog.media.plays("charlie")
  s.pause(3000)
  charlieDialog.media.hears(aliceDialog.media)
  aliceDialog.media.hears(charlieDialog.media)

  // Teardown: A BYEs → B2BUA tears down C and B.
  const aliceByeTxn = aliceDialog.bye()
  const charlieByeTxn = charlieDialog.expect("BYE")
  charlieByeTxn.reply(200)
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
  s.pause(1000)
})

describe("media — REFER blind transfer through the real B2BUA", () => {
  it.effect("after merge, Alice and Charlie hear each other", () => {
    const run = createSimulatedRunner({ outputDir: OUTPUT_DIR })
    return Effect.gen(function* () {
      yield* run(referMedia.toScenario())
      const html = readFileSync(join(OUTPUT_DIR, "refer-transfer-media.html"), "utf-8")
      expect(html).toContain("Media (RTP)")
      expect(html).toContain(`<tr class="media-pass">`)
      expect(html).not.toContain(`<tr class="media-fail">`)
    }) as Effect.Effect<void>
  }, { timeout: 30_000 })
})
