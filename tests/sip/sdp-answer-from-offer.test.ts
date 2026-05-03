/**
 * Unit tests for SdpAnswerFromOffer.
 *
 * Covers the algorithmic shape consumed by the fake-PRACK UPDATE handler:
 *   - codec intersection by name+rate (PT numbers may differ)
 *   - skeleton-fit ports/c= from Alice
 *   - per-m-line empty intersection ⇒ no-common-codec
 *   - missing Alice m-section ⇒ disabled (port 0, a=inactive) placeholder
 *   - static-PT (no rtpmap) recognition for common audio codecs
 *   - delayed-offer guard (no Alice SDP)
 */

import { describe, expect, test } from "vitest"
import { buildAnswerFromOffer } from "../../src/sip/SdpAnswerFromOffer.js"

const sdp = (lines: readonly string[]): string => lines.join("\r\n") + "\r\n"

const buildOpts = { localIp: "192.0.2.10", nowMs: 1_700_000_000_000 } as const

const aliceBasic = sdp([
  "v=0",
  "o=alice 1 1 IN IP4 192.0.2.1",
  "s=-",
  "c=IN IP4 192.0.2.1",
  "t=0 0",
  "m=audio 6000 RTP/AVP 8 18 101",
  "a=rtpmap:8 PCMA/8000",
  "a=rtpmap:18 G729/8000",
  "a=rtpmap:101 telephone-event/8000",
  "a=sendrecv",
])

const decode = (b: Uint8Array): string => new TextDecoder().decode(b)

describe("buildAnswerFromOffer — happy path", () => {
  test("intersects codecs by name+rate, keeps Bob's PT numbering", () => {
    const bob = sdp([
      "v=0",
      "o=bob 2 2 IN IP4 192.0.2.2",
      "s=-",
      "c=IN IP4 192.0.2.2",
      "t=0 0",
      "m=audio 5004 RTP/AVP 0 8 96",
      "a=rtpmap:0 PCMU/8000",
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:96 opus/48000/2",
      "a=sendrecv",
    ])
    const result = buildAnswerFromOffer(bob, aliceBasic, buildOpts)
    expect(result._tag).toBe("ok")
    if (result._tag !== "ok") return
    const body = decode(result.body)
    // Only PCMA/8000 is in both → Bob's PT 8 only.
    expect(body).toContain("m=audio 6000 RTP/AVP 8")
    expect(body).toContain("a=rtpmap:8 PCMA/8000")
    expect(body).not.toContain("a=rtpmap:0 PCMU/8000")
    expect(body).not.toContain("a=rtpmap:96 opus")
    expect(body).toContain("c=IN IP4 192.0.2.1")
    expect(body).toContain("a=sendrecv")
  })

  test("matches by codec name when PT numbers differ between offer and answer basis", () => {
    const bob = sdp([
      "v=0",
      "o=bob 2 2 IN IP4 192.0.2.2",
      "s=-",
      "c=IN IP4 192.0.2.2",
      "t=0 0",
      "m=audio 5004 RTP/AVP 96",
      "a=rtpmap:96 opus/48000/2",
      "a=sendrecv",
    ])
    const alice = sdp([
      "v=0",
      "o=alice 1 1 IN IP4 192.0.2.1",
      "s=-",
      "c=IN IP4 192.0.2.1",
      "t=0 0",
      "m=audio 7000 RTP/AVP 111",
      "a=rtpmap:111 opus/48000/2",
      "a=sendrecv",
    ])
    const result = buildAnswerFromOffer(bob, alice, buildOpts)
    expect(result._tag).toBe("ok")
    if (result._tag !== "ok") return
    const body = decode(result.body)
    // Bob's PT 96 is preserved; rtpmap reuses Bob's mapping.
    expect(body).toContain("m=audio 7000 RTP/AVP 96")
    expect(body).toContain("a=rtpmap:96 opus/48000/2")
    expect(body).not.toContain("a=rtpmap:111")
  })

  test("recognises static PTs without rtpmap", () => {
    const bob = sdp([
      "v=0",
      "o=bob 2 2 IN IP4 192.0.2.2",
      "s=-",
      "c=IN IP4 192.0.2.2",
      "t=0 0",
      "m=audio 5004 RTP/AVP 0 8",
      "a=sendrecv",
    ])
    const alice = sdp([
      "v=0",
      "o=alice 1 1 IN IP4 192.0.2.1",
      "s=-",
      "c=IN IP4 192.0.2.1",
      "t=0 0",
      "m=audio 7000 RTP/AVP 0 8",
      "a=sendrecv",
    ])
    const result = buildAnswerFromOffer(bob, alice, buildOpts)
    expect(result._tag).toBe("ok")
    if (result._tag !== "ok") return
    const body = decode(result.body)
    expect(body).toContain("m=audio 7000 RTP/AVP 0 8")
    // No rtpmaps emitted (none in offer).
    expect(body).not.toContain("a=rtpmap:")
  })

  test("preserves Bob's fmtp lines for matched PTs", () => {
    const bob = sdp([
      "v=0",
      "o=bob 2 2 IN IP4 192.0.2.2",
      "s=-",
      "c=IN IP4 192.0.2.2",
      "t=0 0",
      "m=audio 5004 RTP/AVP 8 101",
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:101 telephone-event/8000",
      "a=fmtp:101 0-15",
      "a=sendrecv",
    ])
    const result = buildAnswerFromOffer(bob, aliceBasic, buildOpts)
    expect(result._tag).toBe("ok")
    if (result._tag !== "ok") return
    const body = decode(result.body)
    expect(body).toContain("a=fmtp:101 0-15")
  })

  test("inherits Bob's direction attribute", () => {
    const bob = sdp([
      "v=0",
      "o=bob 2 2 IN IP4 192.0.2.2",
      "s=-",
      "c=IN IP4 192.0.2.2",
      "t=0 0",
      "m=audio 5004 RTP/AVP 8",
      "a=rtpmap:8 PCMA/8000",
      "a=sendonly",
    ])
    const result = buildAnswerFromOffer(bob, aliceBasic, buildOpts)
    expect(result._tag).toBe("ok")
    if (result._tag !== "ok") return
    expect(decode(result.body)).toContain("a=sendonly")
  })

  test("uses session-level c= when m-line has no explicit c=", () => {
    const aliceSessionOnly = sdp([
      "v=0",
      "o=alice 1 1 IN IP4 192.0.2.1",
      "s=-",
      "c=IN IP4 192.0.2.99",
      "t=0 0",
      "m=audio 6000 RTP/AVP 8",
      "a=rtpmap:8 PCMA/8000",
      "a=sendrecv",
    ])
    const bob = sdp([
      "v=0",
      "o=bob 2 2 IN IP4 192.0.2.2",
      "s=-",
      "c=IN IP4 192.0.2.2",
      "t=0 0",
      "m=audio 5004 RTP/AVP 8",
      "a=rtpmap:8 PCMA/8000",
      "a=sendrecv",
    ])
    const result = buildAnswerFromOffer(bob, aliceSessionOnly, buildOpts)
    expect(result._tag).toBe("ok")
    if (result._tag !== "ok") return
    expect(decode(result.body)).toContain("c=IN IP4 192.0.2.99")
  })
})

describe("buildAnswerFromOffer — multi-m-line skeleton fit", () => {
  test("Alice missing a Bob m-section becomes port 0 / a=inactive", () => {
    const bob = sdp([
      "v=0",
      "o=bob 2 2 IN IP4 192.0.2.2",
      "s=-",
      "c=IN IP4 192.0.2.2",
      "t=0 0",
      "m=audio 5004 RTP/AVP 8",
      "a=rtpmap:8 PCMA/8000",
      "a=sendrecv",
      "m=video 5006 RTP/AVP 96",
      "a=rtpmap:96 H264/90000",
      "a=sendrecv",
    ])
    const result = buildAnswerFromOffer(bob, aliceBasic, buildOpts)
    expect(result._tag).toBe("ok")
    if (result._tag !== "ok") return
    const body = decode(result.body)
    // Audio matched: PCMA/8000 (Bob PT 8) at Alice's port.
    expect(body).toContain("m=audio 6000 RTP/AVP 8")
    // Video missing in Alice: disabled placeholder using Bob's first PT.
    expect(body).toContain("m=video 0 RTP/AVP 96")
    expect(body).toContain("a=rtpmap:96 H264/90000")
    expect(body).toContain("a=inactive")
  })
})

describe("buildAnswerFromOffer — failure tags", () => {
  test("no common codec returns the offending m-line index", () => {
    const bob = sdp([
      "v=0",
      "o=bob 2 2 IN IP4 192.0.2.2",
      "s=-",
      "c=IN IP4 192.0.2.2",
      "t=0 0",
      "m=audio 5004 RTP/AVP 96",
      "a=rtpmap:96 opus/48000/2",
      "a=sendrecv",
    ])
    const result = buildAnswerFromOffer(bob, aliceBasic, buildOpts)
    expect(result._tag).toBe("no-common-codec")
    if (result._tag !== "no-common-codec") return
    expect(result.mLineIndex).toBe(0)
  })

  test("no common codec on the second m-line is reported with index 1", () => {
    const bob = sdp([
      "v=0",
      "o=bob 2 2 IN IP4 192.0.2.2",
      "s=-",
      "c=IN IP4 192.0.2.2",
      "t=0 0",
      "m=audio 5004 RTP/AVP 8",
      "a=rtpmap:8 PCMA/8000",
      "a=sendrecv",
      "m=audio 5006 RTP/AVP 96",
      "a=rtpmap:96 opus/48000/2",
      "a=sendrecv",
    ])
    const aliceTwoAudio = sdp([
      "v=0",
      "o=alice 1 1 IN IP4 192.0.2.1",
      "s=-",
      "c=IN IP4 192.0.2.1",
      "t=0 0",
      "m=audio 6000 RTP/AVP 8",
      "a=rtpmap:8 PCMA/8000",
      "a=sendrecv",
      "m=audio 6002 RTP/AVP 0",
      "a=rtpmap:0 PCMU/8000",
      "a=sendrecv",
    ])
    const result = buildAnswerFromOffer(bob, aliceTwoAudio, buildOpts)
    expect(result._tag).toBe("no-common-codec")
    if (result._tag !== "no-common-codec") return
    expect(result.mLineIndex).toBe(1)
  })

  test("null Alice SDP returns no-alice-sdp", () => {
    const bob = sdp([
      "v=0",
      "o=bob 2 2 IN IP4 192.0.2.2",
      "s=-",
      "c=IN IP4 192.0.2.2",
      "t=0 0",
      "m=audio 5004 RTP/AVP 8",
      "a=rtpmap:8 PCMA/8000",
      "a=sendrecv",
    ])
    expect(buildAnswerFromOffer(bob, null, buildOpts)._tag).toBe("no-alice-sdp")
  })

  test("empty Alice body returns no-alice-sdp", () => {
    const bob = sdp([
      "v=0",
      "o=bob 2 2 IN IP4 192.0.2.2",
      "s=-",
      "c=IN IP4 192.0.2.2",
      "t=0 0",
      "m=audio 5004 RTP/AVP 8",
      "a=rtpmap:8 PCMA/8000",
      "a=sendrecv",
    ])
    expect(buildAnswerFromOffer(bob, "", buildOpts)._tag).toBe("no-alice-sdp")
    expect(buildAnswerFromOffer(bob, new Uint8Array(0), buildOpts)._tag).toBe("no-alice-sdp")
  })
})

describe("buildAnswerFromOffer — input flexibility", () => {
  test("accepts Uint8Array for both inputs", () => {
    const bob = new TextEncoder().encode(
      sdp([
        "v=0",
        "o=bob 2 2 IN IP4 192.0.2.2",
        "s=-",
        "c=IN IP4 192.0.2.2",
        "t=0 0",
        "m=audio 5004 RTP/AVP 8",
        "a=rtpmap:8 PCMA/8000",
        "a=sendrecv",
      ])
    )
    const alice = new TextEncoder().encode(aliceBasic)
    const result = buildAnswerFromOffer(bob, alice, buildOpts)
    expect(result._tag).toBe("ok")
  })

  test("accepts LF-only line endings", () => {
    const bob = sdp([
      "v=0",
      "o=bob 2 2 IN IP4 192.0.2.2",
      "s=-",
      "c=IN IP4 192.0.2.2",
      "t=0 0",
      "m=audio 5004 RTP/AVP 8",
      "a=rtpmap:8 PCMA/8000",
      "a=sendrecv",
    ]).replace(/\r\n/g, "\n")
    const result = buildAnswerFromOffer(bob, aliceBasic.replace(/\r\n/g, "\n"), buildOpts)
    expect(result._tag).toBe("ok")
    if (result._tag !== "ok") return
    expect(decode(result.body)).toContain("m=audio 6000 RTP/AVP 8")
  })
})
