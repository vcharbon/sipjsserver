/**
 * Slice 1 — play→record over REAL UDP + REAL wall-clock (it.live).
 *
 * The fake-clock twin lives in `rtp-media.test.ts`. This is the cross-check
 * the plan calls for: the same MediaEndpoint engine, swapped onto the dgram
 * SignalingNetwork and real `Effect.sleep` pacing, must still deliver the
 * played clip — proving the pacing/transport works on the wire, not just under
 * TestClock. Runs only in the live suite (TEST_MODE=live).
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { MediaEndpoint, type NetAddr, PCMA } from "../../src/media/MediaEndpoint.js"
import type { NegotiatedMedia } from "../../src/media/sdp/types.js"
import { MediaEndpointTs } from "../../src/media/ts/MediaEndpointTs.js"
import { classify } from "../../src/test-harness/media/audio/classify.js"
import { referenceClip } from "../../src/test-harness/media/audio/clips.js"
import { negotiateCall } from "./support-negotiate.js"

const stack = MediaEndpointTs.pipe(Layer.provide(SignalingNetwork.real))

const neg = (remote: NetAddr): NegotiatedMedia => ({
  remote,
  codec: PCMA,
  direction: "sendrecv",
  send: true,
  receive: true,
})

describe("play→record over real UDP + real clock", () => {
  it.live(
    "yields the played clip back, classified correctly",
    () =>
      Effect.gen(function* () {
        const me = yield* MediaEndpoint
        const alice = yield* me.open("127.0.0.1", 40140)
        const bob = yield* me.open("127.0.0.1", 40142)

        const aS = yield* alice.session("d1")
        yield* aS.configure(neg(bob.localAddr))
        yield* aS.commit("confirmed")
        const bS = yield* bob.session("d1")
        yield* bS.configure(neg(alice.localAddr))
        yield* bS.commit("confirmed")

        const clip = referenceClip("charlie")
        yield* aS.play({ kind: "pcm", pcm: clip })
        // 2 s clip @ 20 ms ptime; wait past send + real transit.
        yield* Effect.sleep("2700 millis")

        const rec = yield* bS.recorded()
        const verdict = classify(rec.pcm)
        expect(verdict.classification).toBe("matched")
        expect(verdict.matched).toBe("charlie")

        const inbound = (yield* bob.stats()).find((s) => s.direction === "inbound")
        expect(inbound, "bob has an inbound stream").toBeDefined()
        // Localhost UDP is lossless; allow a tiny margin anyway.
        expect(inbound!.packets).toBeGreaterThanOrEqual(Math.ceil(clip.length / 160) - 2)
      }).pipe(Effect.scoped, Effect.provide(stack)),
    { timeout: 10_000 },
  )

  it.live(
    "end-to-end O/A negotiation over real UDP → both sides hear each other",
    () =>
      Effect.gen(function* () {
        const me = yield* MediaEndpoint
        const alice = yield* me.open("127.0.0.1", 40160)
        const bob = yield* me.open("127.0.0.1", 40162)

        const { aliceSession, bobSession } = yield* negotiateCall(alice, bob)
        yield* aliceSession.play({ kind: "pcm", pcm: referenceClip("alice") })
        yield* bobSession.play({ kind: "pcm", pcm: referenceClip("bob") })
        yield* Effect.sleep("2700 millis")

        expect(classify((yield* aliceSession.recorded()).pcm).matched).toBe("bob")
        expect(classify((yield* bobSession.recorded()).pcm).matched).toBe("alice")
      }).pipe(Effect.scoped, Effect.provide(stack)),
    { timeout: 10_000 },
  )
})
