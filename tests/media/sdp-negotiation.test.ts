/**
 * Slice 2 — RFC 3264 / 3262 / 5009 offer-answer engine conformance.
 *
 * One positive + one negative per RFC clause. Each negative asserts on the
 * typed `SdpNegotiationError.rule` so the mapping to a named RFC MUST is part
 * of the contract. Provisional reliability transitions (early → committed,
 * supersede, hold/resume re-point) and the P-Early-Media (RFC 5009) gate are
 * covered too. Pure engine — no network, no B2BUA.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { PCMA, PCMU } from "../../src/media/MediaEndpoint.js"
import { createOfferAnswerEngine, isEarlyMediaAuthorized } from "../../src/media/sdp/negotiator.js"
import type { MediaDirection, Sdp } from "../../src/media/sdp/types.js"

const ALICE = { ip: "10.10.0.1", port: 40000 }
const BOB = { ip: "10.20.0.1", port: 40002 }

const run = <A, E>(eff: Effect.Effect<A, E>): A => Effect.runSync(eff)
const runErr = <A, E>(eff: Effect.Effect<A, E>): E => Effect.runSync(Effect.flip(eff))

function audioSdp(
  ip: string,
  port: number,
  codecs: ReadonlyArray<{ pt: number; name: string }>,
  direction: MediaDirection = "sendrecv",
  extraVideo = false,
): Sdp {
  const media = [
    {
      type: "audio",
      port,
      protocol: "RTP/AVP",
      formats: codecs.map((c) => c.pt),
      rtpmap: codecs.map((c) => ({ payloadType: c.pt, encodingName: c.name, clockRate: 8000 })),
      direction,
    },
  ]
  if (extraVideo) {
    media.push({
      type: "video",
      port: port + 2,
      protocol: "RTP/AVP",
      formats: [96],
      rtpmap: [{ payloadType: 96, encodingName: "VP8", clockRate: 90000 }],
      direction,
    })
  }
  return { origin: { username: "t", sessionId: "1", version: "1", address: ip }, connectionAddr: ip, media }
}

describe("offer→answer (positive)", () => {
  it("answerer picks a common codec, honouring the offerer's preference", () => {
    const offerer = createOfferAnswerEngine({ localAddr: ALICE, codecs: [PCMA, PCMU] })
    const offer = offerer.localOffer()
    expect(offer.media[0]!.formats).toEqual([PCMA.payloadType, PCMU.payloadType])

    // Answerer prefers PCMU but must honour the offer's PCMA-first order.
    const answerer = createOfferAnswerEngine({ localAddr: BOB, codecs: [PCMU, PCMA] })
    const answer = run(answerer.answerTo(offer))
    expect(answer.media[0]!.formats).toEqual([PCMA.payloadType])
    expect(answerer.negotiated()!.codec).toEqual(PCMA)
  })

  it("answerTo configures the answerer's remote = the offered addr/port", () => {
    const answerer = createOfferAnswerEngine({ localAddr: BOB, codecs: [PCMA] })
    run(answerer.answerTo(audioSdp(ALICE.ip, ALICE.port, [{ pt: 8, name: "PCMA" }])))
    expect(answerer.negotiated()!.remote).toEqual(ALICE)
    expect(answerer.negotiated()!.send).toBe(true)
  })

  it("applyRemote configures the offerer's remote = the answer addr/port", () => {
    const offerer = createOfferAnswerEngine({ localAddr: ALICE, codecs: [PCMA] })
    offerer.localOffer()
    const neg = run(
      offerer.applyRemote(audioSdp(BOB.ip, BOB.port, [{ pt: 8, name: "PCMA" }]), { reliable: true }),
    )
    expect(neg.remote).toEqual(BOB)
    expect(neg.send).toBe(true)
    expect(offerer.state()).toBe("committed")
  })
})

describe("offer→answer (negative — each maps to an RFC MUST)", () => {
  it("RFC 3264 §6 — answer codec not in offer is rejected", () => {
    const offerer = createOfferAnswerEngine({ localAddr: ALICE, codecs: [PCMA] })
    offerer.localOffer()
    const e = runErr(
      offerer.applyRemote(audioSdp(BOB.ip, BOB.port, [{ pt: 0, name: "PCMU" }]), { reliable: true }),
    )
    expect(e.rule).toBe("answer-codec-not-in-offer")
  })

  it("RFC 3264 §6 — empty codec intersection is rejected", () => {
    const answerer = createOfferAnswerEngine({ localAddr: BOB, codecs: [PCMU] })
    const e = runErr(answerer.answerTo(audioSdp(ALICE.ip, ALICE.port, [{ pt: 8, name: "PCMA" }])))
    expect(e.rule).toBe("empty-codec-intersection")
  })

  it("RFC 3264 §6 — m-line count mismatch is rejected", () => {
    const offerer = createOfferAnswerEngine({ localAddr: ALICE, codecs: [PCMA] })
    offerer.localOffer() // 1 m-line
    const answerWith2 = audioSdp(BOB.ip, BOB.port, [{ pt: 8, name: "PCMA" }], "sendrecv", true)
    const e = runErr(offerer.applyRemote(answerWith2, { reliable: true }))
    expect(e.rule).toBe("m-line-count-mismatch")
  })

  it("RFC 3264 §5 — answer without an outstanding offer is rejected", () => {
    const offerer = createOfferAnswerEngine({ localAddr: ALICE, codecs: [PCMA] })
    const e = runErr(
      offerer.applyRemote(audioSdp(BOB.ip, BOB.port, [{ pt: 8, name: "PCMA" }]), { reliable: true }),
    )
    expect(e.rule).toBe("answer-without-offer")
  })

  it("RFC 3264 §4 / RFC 3261 §14.2 — second offer while ours is outstanding → glare", () => {
    const eng = createOfferAnswerEngine({ localAddr: ALICE, codecs: [PCMA] })
    eng.localOffer() // offer-sent
    const e = runErr(eng.answerTo(audioSdp(BOB.ip, BOB.port, [{ pt: 8, name: "PCMA" }])))
    expect(e.rule).toBe("glare-second-offer")
  })
})

describe("direction / hold (port 0, inactive, sendonly)", () => {
  it("answer with port 0 stops the send direction (not an error)", () => {
    const offerer = createOfferAnswerEngine({ localAddr: ALICE, codecs: [PCMA] })
    offerer.localOffer()
    const neg = run(offerer.applyRemote(audioSdp(BOB.ip, 0, [{ pt: 8, name: "PCMA" }]), { reliable: true }))
    expect(neg.send).toBe(false)
  })

  it("answer a=inactive stops both directions", () => {
    const offerer = createOfferAnswerEngine({ localAddr: ALICE, codecs: [PCMA] })
    offerer.localOffer()
    const neg = run(
      offerer.applyRemote(audioSdp(BOB.ip, BOB.port, [{ pt: 8, name: "PCMA" }], "inactive"), {
        reliable: true,
      }),
    )
    expect(neg.send).toBe(false)
    expect(neg.receive).toBe(false)
    expect(offerer.state()).toBe("held")
  })

  it("a sendonly (hold) offer yields a recvonly answer that does not send", () => {
    const answerer = createOfferAnswerEngine({ localAddr: BOB, codecs: [PCMA] })
    const answer = run(
      answerer.answerTo(audioSdp(ALICE.ip, ALICE.port, [{ pt: 8, name: "PCMA" }], "sendonly")),
    )
    expect(answer.media[0]!.direction).toBe("recvonly")
    expect(answerer.negotiated()!.send).toBe(false)
    expect(answerer.state()).toBe("held")
  })
})

describe("provisional reliability transitions", () => {
  it("unreliable provisional → early; reliable final → committed and re-points", () => {
    const offerer = createOfferAnswerEngine({ localAddr: ALICE, codecs: [PCMA] })
    offerer.localOffer()

    // Early (unreliable 18x with SDP) from one branch.
    const early = run(
      offerer.applyRemote(audioSdp(BOB.ip, BOB.port, [{ pt: 8, name: "PCMA" }]), { reliable: false }),
    )
    expect(offerer.state()).toBe("early")
    expect(early.remote).toEqual(BOB)

    // A different 200 supersedes and re-points to the confirmed branch.
    const confirmed = { ip: "10.30.0.1", port: 40044 }
    const final = run(
      offerer.applyRemote(audioSdp(confirmed.ip, confirmed.port, [{ pt: 8, name: "PCMA" }]), {
        reliable: true,
      }),
    )
    expect(offerer.state()).toBe("committed")
    expect(final.remote).toEqual(confirmed)
  })
})

describe("RFC 5009 — P-Early-Media early-media gate", () => {
  it("authorizes only SDP + sendrecv/sendonly", () => {
    expect(isEarlyMediaAuthorized({ hasSdp: true, pEarlyMedia: "sendrecv", reliable: true })).toBe(true)
    expect(isEarlyMediaAuthorized({ hasSdp: true, pEarlyMedia: "sendonly", reliable: true })).toBe(true)
    expect(isEarlyMediaAuthorized({ hasSdp: true, pEarlyMedia: "recvonly", reliable: true })).toBe(false)
    expect(isEarlyMediaAuthorized({ hasSdp: true, pEarlyMedia: "inactive", reliable: true })).toBe(false)
    expect(isEarlyMediaAuthorized({ hasSdp: true, reliable: true })).toBe(false) // header absent
    expect(isEarlyMediaAuthorized({ hasSdp: false, pEarlyMedia: "sendrecv", reliable: true })).toBe(false)
  })
})

describe("SDP parse/build round-trip", () => {
  it("round-trips an offer through build→parse", async () => {
    const { parseSdp, buildSdp } = await import("../../src/media/sdp/parse.js")
    const offer = createOfferAnswerEngine({ localAddr: ALICE, codecs: [PCMA, PCMU] }).localOffer()
    const reparsed = parseSdp(buildSdp(offer))
    expect(reparsed.media[0]!.formats).toEqual([PCMA.payloadType, PCMU.payloadType])
    expect(reparsed.media[0]!.connectionAddr ?? reparsed.connectionAddr).toBe(ALICE.ip)
    expect(reparsed.media[0]!.direction).toBe("sendrecv")
  })
})
