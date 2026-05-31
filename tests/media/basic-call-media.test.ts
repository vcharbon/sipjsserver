/**
 * Media (RTP) over a basic call through the REAL in-process B2BUA (ADR-0017).
 *
 * Alice and Bob are media agents: the interpreter drives their SIP SDP from
 * bound RTP transports (engine offer/answer), they play reference clips, and
 * the final-sweep `hears(...)` verdict classifies each side's recording. The
 * B2BUA is signaling-only and relays c=/m= transparently, so a working call
 * means both sides genuinely hear each other — and the generated HTML report
 * surfaces the RTP/RTCP rollup + verdicts.
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

const basicCallMedia = scenario("basic-call-media", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test", media: {} })
  const bob = s.agent("bob", { uri: "sip:bob@test", port: 5666, media: {} })

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

  // Both sides emit RTP; the window must advance enough virtual time for
  // the paced senders to fill a classifiable recording.
  aliceDialog.media.plays("alice")
  bobDialog.media.plays("bob")
  s.pause(3000)

  // Verdicts (resolved at the final sweep): each side hears the other.
  bobDialog.media.hears(aliceDialog.media)
  aliceDialog.media.hears(bobDialog.media)

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
  s.pause(1000)
})

describe("media — basic call through the real B2BUA", () => {
  it.effect("Alice and Bob hear each other; HTML shows the RTP flow", () => {
    const run = createSimulatedRunner({ outputDir: OUTPUT_DIR })
    return Effect.gen(function* () {
      yield* run(basicCallMedia.toScenario())

      // The generated HTML report must surface the media panel + PASS verdicts.
      const html = readFileSync(join(OUTPUT_DIR, "basic-call-media.html"), "utf-8")
      expect(html).toContain("Media (RTP)")
      // Two verdict rows, both PASS (no failing verdict row).
      expect(html).toContain(`<tr class="media-pass">`)
      expect(html).not.toContain(`<tr class="media-fail">`)
      // Stream rollup mentions the G.711 PCMA codec the engine negotiated.
      expect(html).toContain("PCMA")
    }) as Effect.Effect<void>
  }, { timeout: 30_000 })
})
