/**
 * Slice 3a (contained) — end-to-end media over the shared fabric, driven by
 * the production O/A engine, with the B2BUA's SDP rewriting modelled as a
 * pluggable transform.
 *
 * This is the slice's core thesis under test: when the relayed SDP is correct
 * (transparent rewrite), Alice and Bob hear each other; when an SDP-rewrite bug
 * misdirects the connection address, `hears(...)` catches it (the receiver gets
 * no audio). Runs over the simulated fabric under TestClock; the rtp.js engine
 * is cross-checked end to end. The real-B2BUA + declarative DSL wiring is the
 * follow-up (Slice 3b).
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { MediaEndpoint } from "../../src/media/MediaEndpoint.js"
import { MediaEndpointTs } from "../../src/media/ts/MediaEndpointTs.js"
import { MediaEndpointRtpJs } from "../../src/media/native/MediaEndpointRtpJs.js"
import { classify } from "../../src/test-harness/media/audio/classify.js"
import { referenceClip } from "../../src/test-harness/media/audio/clips.js"
import { corruptConnectionAddr, negotiateCall } from "./support-negotiate.js"

const simNet = SignalingNetwork.simulated({ transitDelayMs: 1 })

function e2eSuite(name: string, layer: typeof MediaEndpointTs) {
  const stack = layer.pipe(Layer.provide(simNet))

  describe(`basic-call media end-to-end (${name})`, () => {
    it.effect("transparent relay → Alice and Bob hear each other", () =>
      Effect.gen(function* () {
        const me = yield* MediaEndpoint
        const alice = yield* me.open("10.10.0.1", 40000)
        const bob = yield* me.open("10.20.0.1", 40002)

        const { aliceSession, bobSession } = yield* negotiateCall(alice, bob)

        yield* aliceSession.play({ kind: "pcm", pcm: referenceClip("alice") })
        yield* bobSession.play({ kind: "pcm", pcm: referenceClip("bob") })
        yield* TestClock.adjust("3 seconds")

        // alice hears bob; bob hears alice.
        expect(classify((yield* aliceSession.recorded()).pcm).matched).toBe("bob")
        expect(classify((yield* bobSession.recorded()).pcm).matched).toBe("alice")
      }).pipe(Effect.scoped, Effect.provide(stack)),
    )

    it.effect("SDP-rewrite bug misdirects media → hears(...) catches it", () =>
      Effect.gen(function* () {
        const me = yield* MediaEndpoint
        const alice = yield* me.open("10.10.0.1", 41000)
        const bob = yield* me.open("10.20.0.1", 41002)

        // The B2BUA corrupts the connection address in the relayed ANSWER:
        // Alice is now pointed at a bogus address, so her media never reaches
        // Bob — a real B2BUA SDP bug.
        const { aliceSession, bobSession } = yield* negotiateCall(alice, bob, {
          rewriteAnswer: corruptConnectionAddr(),
        })

        yield* aliceSession.play({ kind: "pcm", pcm: referenceClip("alice") })
        yield* bobSession.play({ kind: "pcm", pcm: referenceClip("bob") })
        yield* TestClock.adjust("3 seconds")

        // Bob does NOT hear Alice: her RTP went to the bogus address the
        // corrupted answer pointed her at, so nothing reached Bob's port.
        const bobVerdict = classify((yield* bobSession.recorded()).pcm)
        expect(bobVerdict.matched).not.toBe("alice")
        expect(["silence", "no-audio"]).toContain(bobVerdict.classification)
        expect((yield* bob.sources()).length).toBe(0)

        // The fabric is alive and the misdirection is targeted: Bob's media
        // *physically* arrived at Alice's port (a real source bucket), even
        // though her corrupted session mis-attributes it.
        expect((yield* alice.sources()).length).toBeGreaterThan(0)
      }).pipe(Effect.scoped, Effect.provide(stack)),
    )
  })
}

e2eSuite("TS", MediaEndpointTs)
e2eSuite("rtp.js", MediaEndpointRtpJs)
