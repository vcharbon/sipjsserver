/**
 * Slice 1 — RTP/codec layer + two impls, fake-clock cross-check.
 *
 * Wire framing: TS-encode ↔ rtp.js-parse and rtp.js-encode ↔ TS-parse must
 * agree (each an independent witness). End to end: a full play→record loop over
 * the simulated fabric under TestClock yields the played clip back (classified
 * by the Slice 0 comparator), and getStats() counts match what was sent. The
 * real-UDP + real-clock variant lives in `rtp-media-live.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { MediaEndpoint, type NetAddr, PCMA } from "../../src/media/MediaEndpoint.js"
import type { NegotiatedMedia } from "../../src/media/sdp/types.js"
import { MediaEndpointTs, tsFraming } from "../../src/media/ts/MediaEndpointTs.js"
import { MediaEndpointRtpJs, rtpJsFraming } from "../../src/media/native/MediaEndpointRtpJs.js"
import type { RtpFraming, RtpHeader } from "../../src/media/rtp/packet.js"
import { classify } from "../../src/test-harness/media/audio/classify.js"
import { referenceClip } from "../../src/test-harness/media/audio/clips.js"

const HEADER: RtpHeader = {
  version: 2,
  padding: false,
  extension: false,
  marker: true,
  payloadType: 8,
  sequenceNumber: 0x04d2,
  timestamp: 0x000a_b1c2,
  ssrc: 0xdead_beef,
}

function expectHeaderRoundTrip(enc: RtpFraming, dec: RtpFraming) {
  const payload = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80])
  const wire = enc.encodeRtp(HEADER, payload)
  const parsed = dec.parseRtp(wire)
  expect(parsed, `${enc.name} → ${dec.name}`).not.toBeNull()
  if (!parsed) return
  expect(parsed.header.payloadType).toBe(HEADER.payloadType)
  expect(parsed.header.sequenceNumber).toBe(HEADER.sequenceNumber)
  expect(parsed.header.timestamp).toBe(HEADER.timestamp)
  expect(parsed.header.ssrc).toBe(HEADER.ssrc >>> 0)
  expect(parsed.header.marker).toBe(true)
  expect([...parsed.payload]).toEqual([...payload])
}

describe("RTP wire framing — independent witness cross-check", () => {
  it("TS-encode ↔ TS-parse round-trips header + payload", () => {
    expectHeaderRoundTrip(tsFraming, tsFraming)
  })
  it("TS-encode ↔ rtp.js-parse agree on the wire", () => {
    expectHeaderRoundTrip(tsFraming, rtpJsFraming)
  })
  it("rtp.js-encode ↔ TS-parse agree on the wire", () => {
    expectHeaderRoundTrip(rtpJsFraming, tsFraming)
  })
  it("rtp.js-encode ↔ rtp.js-parse round-trips", () => {
    expectHeaderRoundTrip(rtpJsFraming, rtpJsFraming)
  })
})

const simNet = SignalingNetwork.simulated({ transitDelayMs: 1 })

const neg = (remote: NetAddr): NegotiatedMedia => ({
  remote,
  codec: PCMA,
  direction: "sendrecv",
  send: true,
  receive: true,
})

function playRecordSuite(name: string, layer: typeof MediaEndpointTs) {
  const stack = layer.pipe(Layer.provide(simNet))
  describe(`play→record over simulated fabric (${name})`, () => {
    it.effect("yields the played clip back, classified correctly", () =>
      Effect.gen(function* () {
        const me = yield* MediaEndpoint
        const alice = yield* me.open("10.10.0.1", 40000)
        const bob = yield* me.open("10.20.0.1", 40002)

        const aS = yield* alice.session("d1")
        yield* aS.configure(neg(bob.localAddr))
        yield* aS.commit("confirmed")
        const bS = yield* bob.session("d1")
        yield* bS.configure(neg(alice.localAddr))
        yield* bS.commit("confirmed")

        const clip = referenceClip("alice")
        yield* aS.play({ kind: "pcm", pcm: clip })

        // 2 s clip @ 20 ms ptime = 100 frames; advance past send + transit.
        yield* TestClock.adjust("3 seconds")

        const rec = yield* bS.recorded()
        expect(rec.sampleRate).toBe(8000)
        const verdict = classify(rec.pcm)
        expect(verdict.classification).toBe("matched")
        expect(verdict.matched).toBe("alice")

        const expectedFrames = Math.ceil(clip.length / 160)
        const inbound = (yield* bob.stats()).find((s) => s.direction === "inbound")
        expect(inbound, "bob has an inbound stream").toBeDefined()
        expect(inbound!.packets).toBe(expectedFrames)
        expect(inbound!.payloadType).toBe(PCMA.payloadType)

        const outbound = (yield* alice.stats()).find((s) => s.direction === "outbound")
        expect(outbound!.packets).toBe(expectedFrames)
        // Each inbound datagram = 12-byte RTP header + 160-byte A-law frame.
        expect(inbound!.bytes).toBe(expectedFrames * (12 + 160))
      }).pipe(Effect.scoped, Effect.provide(stack)),
    )

    it.effect("RTCP reports flow on the standard interval (counts only)", () =>
      Effect.gen(function* () {
        const me = yield* MediaEndpoint
        const alice = yield* me.open("10.10.0.1", 41000, { rtcpIntervalMs: 1000 })
        const bob = yield* me.open("10.20.0.1", 41002, { rtcpIntervalMs: 1000 })

        const aS = yield* alice.session("d1")
        yield* aS.configure(neg(bob.localAddr))
        yield* aS.commit("confirmed")
        const bS = yield* bob.session("d1")
        yield* bS.configure(neg(alice.localAddr))
        yield* bS.commit("confirmed")

        yield* aS.play({ kind: "pcm", pcm: referenceClip("bob") })
        // Past several RTCP intervals so SR fires from the sender.
        yield* TestClock.adjust("4 seconds")

        const aliceOut = (yield* alice.stats()).find((s) => s.direction === "outbound")
        expect(aliceOut!.rtcpPacketsSent).toBeGreaterThan(0)
        const bobIn = (yield* bob.stats()).find((s) => s.direction === "inbound")
        expect(bobIn!.rtcpPacketsReceived).toBeGreaterThan(0)
      }).pipe(Effect.scoped, Effect.provide(stack)),
    )
  })
}

playRecordSuite("TS", MediaEndpointTs)
playRecordSuite("rtp.js", MediaEndpointRtpJs)
