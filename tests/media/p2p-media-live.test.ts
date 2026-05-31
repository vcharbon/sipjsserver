/**
 * Declarative media (RTP) over REAL UDP + REAL wall-clock (it.live), driven
 * through the scenario DSL (ADR-0017).
 *
 * The fake-clock twin is `basic-call-media.test.ts`. This proves the
 * interpreter's media SDP-driving + paced senders + final-sweep verdicts work
 * on the wire (dgram `SignalingNetwork.real`, real `Effect.sleep` pacing), not
 * just under TestClock. Peer-to-peer (no B2BUA) so it needs no external server
 * — it runs in the live self-test suite (TEST_MODE=live).
 */
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { scenario } from "../../src/test-harness/framework/dsl.js"
import { sdpAnswer, sdpOffer } from "../../src/test-harness/framework/helpers/sdp.js"
import { createPeerToPeerRunner } from "../support/harness.js"

const OUTPUT_DIR = "test-results/media"
const ALICE_PORT = 25160
const BOB_PORT = 25161

const p2pMedia = scenario("p2p-media-live", (s) => {
  const alice = s.agent("alice", {
    uri: "sip:alice@127.0.0.1",
    port: ALICE_PORT,
    media: { port: 40160 },
  })
  const bob = s.agent("bob", {
    uri: "sip:bob@127.0.0.1",
    port: BOB_PORT,
    media: { port: 40162 },
  })

  const { dialog: aliceDialog, transaction: aliceInviteTxn } = alice.invite(
    `sip:bob@127.0.0.1:${BOB_PORT}`,
    { body: sdpOffer() },
  )
  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()
  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)
  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)
  aliceDialog.ack()
  bobDialog.expect("ACK")

  aliceDialog.media.plays("alice")
  bobDialog.media.plays("bob")
  s.pause(3000)
  bobDialog.media.hears(aliceDialog.media)
  aliceDialog.media.hears(bobDialog.media)

  const aliceByeTxn = aliceDialog.bye()
  const bobByeTxn = bobDialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

describe("media — p2p over real UDP + real clock", () => {
  const run = createPeerToPeerRunner({
    peers: {
      alice: { host: "127.0.0.1", port: BOB_PORT },
      bob: { host: "127.0.0.1", port: ALICE_PORT },
    },
    outputDir: OUTPUT_DIR,
  })

  it.live("Alice and Bob hear each other over the wire", () =>
    Effect.gen(function* () {
      yield* run(p2pMedia.toScenario())
      const html = readFileSync(join(OUTPUT_DIR, "p2p-media-live.html"), "utf-8")
      expect(html).toContain("Media (RTP)")
      expect(html).toContain(`<tr class="media-pass">`)
      expect(html).not.toContain(`<tr class="media-fail">`)
    }) as Effect.Effect<void>,
    { timeout: 30_000 },
  )
})
