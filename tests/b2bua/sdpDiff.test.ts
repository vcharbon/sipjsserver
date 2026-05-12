/**
 * Unit tests for sdpMediaEquivalent — the SDP diff used by the
 * `promote-pem-to-200` policy module to decide whether a re-INVITE
 * is needed when bob's 200 OK arrives.
 */

import { describe, expect, test } from "vitest"
import { sdpMediaEquivalent } from "../../src/b2bua/rules/custom/_shared/sdpDiff.js"

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

const SDP_V1 = enc(
  "v=0\r\n" +
  "o=- 1 1 IN IP4 192.0.2.1\r\n" +
  "s=-\r\n" +
  "c=IN IP4 192.0.2.1\r\n" +
  "t=0 0\r\n" +
  "m=audio 49170 RTP/AVP 0 8\r\n" +
  "c=IN IP4 192.0.2.1\r\n" +
  "a=rtpmap:0 PCMU/8000\r\n" +
  "a=rtpmap:8 PCMA/8000\r\n" +
  "a=sendrecv\r\n",
)

describe("sdpMediaEquivalent", () => {
  test("identical bodies are equal", () => {
    expect(sdpMediaEquivalent(SDP_V1, SDP_V1)).toBe(true)
  })

  test("o= session-version bump is ignored", () => {
    const v2 = enc(
      "v=0\r\n" +
      "o=- 1 999 IN IP4 192.0.2.1\r\n" + // version bumped
      "s=-\r\n" +
      "c=IN IP4 192.0.2.1\r\n" +
      "t=0 0\r\n" +
      "m=audio 49170 RTP/AVP 0 8\r\n" +
      "c=IN IP4 192.0.2.1\r\n" +
      "a=rtpmap:0 PCMU/8000\r\n" +
      "a=rtpmap:8 PCMA/8000\r\n" +
      "a=sendrecv\r\n",
    )
    expect(sdpMediaEquivalent(SDP_V1, v2)).toBe(true)
  })

  test("attribute reorder within media block is ignored", () => {
    const reordered = enc(
      "v=0\r\n" +
      "o=- 1 1 IN IP4 192.0.2.1\r\n" +
      "s=-\r\n" +
      "c=IN IP4 192.0.2.1\r\n" +
      "t=0 0\r\n" +
      "m=audio 49170 RTP/AVP 0 8\r\n" +
      "a=sendrecv\r\n" +
      "a=rtpmap:8 PCMA/8000\r\n" +
      "c=IN IP4 192.0.2.1\r\n" +
      "a=rtpmap:0 PCMU/8000\r\n",
    )
    expect(sdpMediaEquivalent(SDP_V1, reordered)).toBe(true)
  })

  test("CRLF vs LF is ignored", () => {
    const lfOnly = enc(
      "v=0\n" +
      "o=- 1 1 IN IP4 192.0.2.1\n" +
      "s=-\n" +
      "c=IN IP4 192.0.2.1\n" +
      "t=0 0\n" +
      "m=audio 49170 RTP/AVP 0 8\n" +
      "c=IN IP4 192.0.2.1\n" +
      "a=rtpmap:0 PCMU/8000\n" +
      "a=rtpmap:8 PCMA/8000\n" +
      "a=sendrecv\n",
    )
    expect(sdpMediaEquivalent(SDP_V1, lfOnly)).toBe(true)
  })

  test("differing media port triggers difference", () => {
    const portChanged = enc(
      "v=0\r\n" +
      "o=- 1 1 IN IP4 192.0.2.1\r\n" +
      "s=-\r\n" +
      "c=IN IP4 192.0.2.1\r\n" +
      "t=0 0\r\n" +
      "m=audio 49180 RTP/AVP 0 8\r\n" + // port changed
      "c=IN IP4 192.0.2.1\r\n" +
      "a=rtpmap:0 PCMU/8000\r\n" +
      "a=rtpmap:8 PCMA/8000\r\n" +
      "a=sendrecv\r\n",
    )
    expect(sdpMediaEquivalent(SDP_V1, portChanged)).toBe(false)
  })

  test("differing connection IP triggers difference", () => {
    const ipChanged = enc(
      "v=0\r\n" +
      "o=- 1 1 IN IP4 192.0.2.1\r\n" +
      "s=-\r\n" +
      "c=IN IP4 192.0.2.1\r\n" +
      "t=0 0\r\n" +
      "m=audio 49170 RTP/AVP 0 8\r\n" +
      "c=IN IP4 192.0.2.99\r\n" + // different IP
      "a=rtpmap:0 PCMU/8000\r\n" +
      "a=rtpmap:8 PCMA/8000\r\n" +
      "a=sendrecv\r\n",
    )
    expect(sdpMediaEquivalent(SDP_V1, ipChanged)).toBe(false)
  })

  test("dropping a codec triggers difference", () => {
    const droppedCodec = enc(
      "v=0\r\n" +
      "o=- 1 1 IN IP4 192.0.2.1\r\n" +
      "s=-\r\n" +
      "c=IN IP4 192.0.2.1\r\n" +
      "t=0 0\r\n" +
      "m=audio 49170 RTP/AVP 0\r\n" + // PCMA gone from m=
      "c=IN IP4 192.0.2.1\r\n" +
      "a=rtpmap:0 PCMU/8000\r\n" +
      "a=sendrecv\r\n",
    )
    expect(sdpMediaEquivalent(SDP_V1, droppedCodec)).toBe(false)
  })

  test("two empty bodies are equal", () => {
    expect(sdpMediaEquivalent(new Uint8Array(0), new Uint8Array(0))).toBe(true)
  })

  test("empty vs populated bodies differ", () => {
    expect(sdpMediaEquivalent(new Uint8Array(0), SDP_V1)).toBe(false)
    expect(sdpMediaEquivalent(SDP_V1, new Uint8Array(0))).toBe(false)
  })
})
