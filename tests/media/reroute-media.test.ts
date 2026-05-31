/**
 * Media (RTP) across a re-routed (re-INVITE re-negotiated) call through the
 * real B2BUA (ADR-0017).
 *
 * After establishing a media call, Alice sends an in-dialog re-INVITE that
 * re-offers media (engine re-offer); Bob answers and the session re-points.
 * The plays + `hears(...)` verdicts run AFTER the re-route, so a passing
 * verdict proves the re-negotiated SDP path carries audio end-to-end — the
 * same re-offer machinery REFER's c-realign depends on.
 */
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpAnswer, sdpOffer } from "../../src/test-harness/framework/helpers/sdp.js"
import { createSimulatedRunner } from "../support/harness.js"

const OUTPUT_DIR = "test-results/media"

const rerouteMedia = scenario("reroute-media", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test", media: {} })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666, media: {} })

  // --- Establish the media call ---
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
  s.pause(500)

  // --- Re-route: in-dialog re-INVITE re-offers media (target refresh) ---
  const aliceReInvTxn = aliceDialog.send("INVITE", { body: sdpOffer() })
  aliceReInvTxn.expect(100)
  const bobReInvTxn = bobDialog.expect("INVITE", { predicate: (msg) => msg.hasBody() })
  bobReInvTxn.reply(200, { body: sdpAnswer() })
  aliceReInvTxn.expect(200, { predicate: (msg) => msg.hasBody() })
  aliceDialog.ack()
  bobDialog.expect("ACK")

  // --- Audio over the re-negotiated path ---
  aliceDialog.media.plays("alice")
  bobDialog.media.plays("bob")
  s.pause(3000)
  bobDialog.media.hears(aliceDialog.media)
  aliceDialog.media.hears(bobDialog.media)

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
  s.pause(1000)
})

describe("media — re-routed (re-INVITE) call through the real B2BUA", () => {
  it.effect("audio survives the re-negotiation; both sides hear each other", () => {
    const run = createSimulatedRunner({ outputDir: OUTPUT_DIR })
    return Effect.gen(function* () {
      yield* run(rerouteMedia.toScenario())
      const html = readFileSync(join(OUTPUT_DIR, "reroute-media.html"), "utf-8")
      expect(html).toContain("Media (RTP)")
      expect(html).toContain(`<tr class="media-pass">`)
      expect(html).not.toContain(`<tr class="media-fail">`)
    }) as Effect.Effect<void>
  }, { timeout: 30_000 })
})
