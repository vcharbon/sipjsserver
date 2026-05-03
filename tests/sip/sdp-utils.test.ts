/**
 * Unit tests for SdpUtils (codec profile extraction + held SDP construction).
 */

import { describe, expect, test } from "vitest"
import {
  buildHeldSdpFromProfile,
  extractCodecProfile,
  type CodecProfile,
} from "../../src/sip/SdpUtils.js"

const sampleSdp = [
  "v=0",
  "o=alice 2890844526 2890844526 IN IP4 192.0.2.10",
  "s=-",
  "c=IN IP4 192.0.2.10",
  "t=0 0",
  "m=audio 20000 RTP/AVP 8 18 101",
  "a=rtpmap:8 PCMA/8000",
  "a=rtpmap:18 G729/8000",
  "a=rtpmap:101 telephone-event/8000",
  "a=fmtp:18 annexb=no",
  "a=fmtp:101 0-15",
  "a=ptime:20",
  "a=sendrecv",
].join("\r\n") + "\r\n"

describe("extractCodecProfile", () => {
  test("parses m=audio with payload types and rtpmaps", () => {
    const profile = extractCodecProfile(sampleSdp)
    expect(profile).toBeDefined()
    expect(profile!.media).toBe("audio")
    expect(profile!.payloadTypes).toEqual([8, 18, 101])
    expect(profile!.rtpmaps).toEqual([
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:18 G729/8000",
      "a=rtpmap:101 telephone-event/8000",
    ])
    expect(profile!.fmtp).toEqual([
      "a=fmtp:18 annexb=no",
      "a=fmtp:101 0-15",
    ])
    expect(profile!.ptime).toBe("a=ptime:20")
    expect(profile!.maxptime).toBeUndefined()
  })

  test("accepts a Uint8Array body", () => {
    const bytes = new TextEncoder().encode(sampleSdp)
    const profile = extractCodecProfile(bytes)
    expect(profile?.payloadTypes).toEqual([8, 18, 101])
  })

  test("accepts LF-only line endings", () => {
    const lfOnly = sampleSdp.replace(/\r\n/g, "\n")
    const profile = extractCodecProfile(lfOnly)
    expect(profile?.payloadTypes).toEqual([8, 18, 101])
    expect(profile?.rtpmaps.length).toBe(3)
  })

  test("ignores video m-sections, returns first audio", () => {
    const sdp = [
      "v=0",
      "o=- 0 0 IN IP4 0.0.0.0",
      "s=-",
      "t=0 0",
      "m=video 30000 RTP/AVP 96",
      "a=rtpmap:96 H264/90000",
      "m=audio 40000 RTP/AVP 0 8",
      "a=rtpmap:0 PCMU/8000",
      "a=rtpmap:8 PCMA/8000",
    ].join("\r\n")
    const profile = extractCodecProfile(sdp)
    expect(profile?.media).toBe("audio")
    expect(profile?.payloadTypes).toEqual([0, 8])
  })

  test("stops rtpmap accumulation at next m-section", () => {
    const sdp = [
      "v=0",
      "o=- 0 0 IN IP4 0.0.0.0",
      "s=-",
      "t=0 0",
      "m=audio 20000 RTP/AVP 0",
      "a=rtpmap:0 PCMU/8000",
      "m=video 30000 RTP/AVP 96",
      "a=rtpmap:96 H264/90000",
    ].join("\r\n")
    const profile = extractCodecProfile(sdp)
    expect(profile?.rtpmaps).toEqual(["a=rtpmap:0 PCMU/8000"])
  })

  test("drops rtpmap/fmtp lines for payload types not in the m-line", () => {
    const sdp = [
      "v=0",
      "o=- 0 0 IN IP4 0.0.0.0",
      "s=-",
      "t=0 0",
      "m=audio 20000 RTP/AVP 8",
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:9 G722/8000",
      "a=fmtp:9 mode=lowrate",
    ].join("\r\n")
    const profile = extractCodecProfile(sdp)
    expect(profile?.payloadTypes).toEqual([8])
    expect(profile?.rtpmaps).toEqual(["a=rtpmap:8 PCMA/8000"])
    expect(profile?.fmtp).toEqual([])
  })

  test("returns undefined when no audio m-line is present", () => {
    const sdp = [
      "v=0",
      "o=- 0 0 IN IP4 0.0.0.0",
      "s=-",
      "t=0 0",
      "m=video 30000 RTP/AVP 96",
    ].join("\r\n")
    expect(extractCodecProfile(sdp)).toBeUndefined()
  })

  test("returns undefined on empty body", () => {
    expect(extractCodecProfile("")).toBeUndefined()
    expect(extractCodecProfile(new Uint8Array(0))).toBeUndefined()
  })
})

describe("buildHeldSdpFromProfile", () => {
  const heldOpts = { localIp: "192.0.2.20", nowMs: 1_700_000_000_000 } as const

  test("produces a held SDP with port 0, a=inactive, and the supplied codecs", () => {
    const profile: CodecProfile = {
      media: "audio",
      payloadTypes: [8, 18, 101],
      rtpmaps: [
        "a=rtpmap:8 PCMA/8000",
        "a=rtpmap:18 G729/8000",
        "a=rtpmap:101 telephone-event/8000",
      ],
      fmtp: ["a=fmtp:101 0-15"],
      ptime: "a=ptime:20",
      maxptime: undefined,
    }
    const body = new TextDecoder().decode(buildHeldSdpFromProfile(profile, heldOpts))
    expect(body).toContain("m=audio 0 RTP/AVP 8 18 101")
    expect(body).toContain("a=rtpmap:8 PCMA/8000")
    expect(body).toContain("a=rtpmap:18 G729/8000")
    expect(body).toContain("a=rtpmap:101 telephone-event/8000")
    expect(body).toContain("a=fmtp:101 0-15")
    expect(body).toContain("a=ptime:20")
    expect(body).toContain("a=inactive")
    expect(body).toContain("c=IN IP4 192.0.2.20")
    expect(body).not.toContain("0.0.0.0")
    expect(body).not.toMatch(/o=b2bua 0 0 /)
  })

  test("substitutes 127.0.0.1 when localIp is the bind-all-interfaces placeholder", () => {
    const profile: CodecProfile = {
      media: "audio",
      payloadTypes: [0],
      rtpmaps: ["a=rtpmap:0 PCMU/8000"],
      fmtp: [],
      ptime: undefined,
      maxptime: undefined,
    }
    const body = new TextDecoder().decode(
      buildHeldSdpFromProfile(profile, { localIp: "0.0.0.0", nowMs: 1_700_000_000_000 })
    )
    expect(body).toContain("c=IN IP4 127.0.0.1")
    expect(body).toContain("o=b2bua 1700000000 1700000000 IN IP4 127.0.0.1")
  })

  test("roundtrips through extractCodecProfile (codec set preserved)", () => {
    const original = extractCodecProfile(sampleSdp)!
    const held = buildHeldSdpFromProfile(original, heldOpts)
    const extracted = extractCodecProfile(held)!
    expect(extracted.payloadTypes).toEqual(original.payloadTypes)
    expect(extracted.rtpmaps).toEqual(original.rtpmaps)
    expect(extracted.fmtp).toEqual(original.fmtp)
    expect(extracted.ptime).toBe(original.ptime)
  })

  test("omits ptime/maxptime when absent", () => {
    const profile: CodecProfile = {
      media: "audio",
      payloadTypes: [0],
      rtpmaps: ["a=rtpmap:0 PCMU/8000"],
      fmtp: [],
      ptime: undefined,
      maxptime: undefined,
    }
    const body = new TextDecoder().decode(buildHeldSdpFromProfile(profile, heldOpts))
    expect(body).not.toContain("a=ptime")
    expect(body).not.toContain("a=maxptime")
  })
})
