/**
 * Unit tests for MessageFactory.buildOriginatedInvite.
 */

import { describe, expect, test } from "vitest"
import {
  buildOriginatedInvite,
  getHeader,
} from "../../src/sip/MessageFactory.js"

const sdpBody = new TextEncoder().encode(
  [
    "v=0",
    "o=- 0 0 IN IP4 10.0.0.1",
    "s=-",
    "c=IN IP4 10.0.0.1",
    "t=0 0",
    "m=audio 20000 RTP/AVP 8",
    "a=rtpmap:8 PCMA/8000",
    "a=sendrecv",
  ].join("\r\n") + "\r\n",
)

describe("buildOriginatedInvite", () => {
  test("produces an in-dialog INVITE with correct CSeq, placeholders, and body", () => {
    const req = buildOriginatedInvite({
      callId: "call-c-1",
      fromTag: "b2bua-local-tag",
      toTag: "c-remote-tag",
      requestUri: "sip:charlie@192.0.2.30:5060",
      cseq: 1001,
      fromUri: "sip:b2bua@10.0.0.1:5060",
      dialogToUri: "sip:charlie@192.0.2.30:5060",
      body: sdpBody,
    })

    expect(req.type).toBe("request")
    expect(req.method).toBe("INVITE")
    expect(req.uri).toBe("sip:charlie@192.0.2.30:5060")

    expect(getHeader(req.headers, "Via")).toBe("__PLACEHOLDER__")
    expect(getHeader(req.headers, "Contact")).toBe("__PLACEHOLDER__")
    expect(getHeader(req.headers, "From")).toBe(
      "<sip:b2bua@10.0.0.1:5060>;tag=b2bua-local-tag",
    )
    expect(getHeader(req.headers, "To")).toBe(
      "<sip:charlie@192.0.2.30:5060>;tag=c-remote-tag",
    )
    expect(getHeader(req.headers, "Call-ID")).toBe("call-c-1")
    expect(getHeader(req.headers, "CSeq")).toBe("1001 INVITE")
    expect(getHeader(req.headers, "Content-Type")).toBe("application/sdp")
    expect(getHeader(req.headers, "Content-Length")).toBe(String(sdpBody.byteLength))
    expect(req.body).toEqual(sdpBody)
  })

  test("CSeq reflects the caller-supplied dialog.localCSeq + 1 convention", () => {
    const localCSeq = 500
    const req = buildOriginatedInvite({
      callId: "call-c-1",
      fromTag: "ft",
      toTag: "tt",
      requestUri: "sip:peer@host",
      cseq: localCSeq + 1,
      body: sdpBody,
    })
    expect(getHeader(req.headers, "CSeq")).toBe(`${localCSeq + 1} INVITE`)
  })

  test("appends extraHeaders and does not override structural ones", () => {
    const req = buildOriginatedInvite({
      callId: "call-c-1",
      fromTag: "ft",
      toTag: "tt",
      requestUri: "sip:peer@host",
      cseq: 42,
      body: sdpBody,
      extraHeaders: [
        { name: "X-Transfer-Call-Ref", value: "abc" },
        { name: "Require", value: "timer" },
      ],
    })
    expect(getHeader(req.headers, "X-Transfer-Call-Ref")).toBe("abc")
    expect(getHeader(req.headers, "Require")).toBe("timer")
    // Structural headers still intact.
    expect(getHeader(req.headers, "Call-ID")).toBe("call-c-1")
    expect(getHeader(req.headers, "CSeq")).toBe("42 INVITE")
  })

  test("empty body sets Content-Length:0 and skips Content-Type", () => {
    const req = buildOriginatedInvite({
      callId: "call-c-1",
      fromTag: "ft",
      toTag: "tt",
      requestUri: "sip:peer@host",
      cseq: 1,
      body: new Uint8Array(0),
    })
    expect(getHeader(req.headers, "Content-Type")).toBeUndefined()
    expect(getHeader(req.headers, "Content-Length")).toBe("0")
    expect(req.body.byteLength).toBe(0)
  })

  test("respects caller-provided Content-Type extra header", () => {
    const body = new TextEncoder().encode("<sdp/>")
    const req = buildOriginatedInvite({
      callId: "call-1",
      fromTag: "ft",
      toTag: "tt",
      requestUri: "sip:peer@host",
      cseq: 1,
      body,
      extraHeaders: [{ name: "Content-Type", value: "application/custom+xml" }],
    })
    expect(getHeader(req.headers, "Content-Type")).toBe("application/custom+xml")
    expect(getHeader(req.headers, "Content-Length")).toBe(String(body.byteLength))
  })

  test("falls back to requestUri when fromUri/dialogToUri omitted", () => {
    const req = buildOriginatedInvite({
      callId: "call-1",
      fromTag: "ft",
      toTag: "tt",
      requestUri: "sip:peer@host",
      cseq: 1,
      body: sdpBody,
    })
    expect(getHeader(req.headers, "From")).toBe("<sip:peer@host>;tag=ft")
    expect(getHeader(req.headers, "To")).toBe("<sip:peer@host>;tag=tt")
  })
})
