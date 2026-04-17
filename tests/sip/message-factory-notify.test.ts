/**
 * Unit tests for MessageFactory.buildNotify.
 */

import { describe, expect, test } from "vitest"
import {
  buildNotify,
  getHeader,
} from "../../src/sip/MessageFactory.js"
import { sipfragFromStatus } from "../../src/sip/SipFragUtils.js"

describe("buildNotify", () => {
  test("builds an in-dialog NOTIFY with REFER event + sipfrag body", () => {
    const body = sipfragFromStatus(180, "Ringing")
    const req = buildNotify({
      callId: "call-bleg-1",
      fromTag: "b2bua-tag",
      toTag: "b-remote-tag",
      requestUri: "sip:bob@192.0.2.20:5060",
      cseq: 101,
      fromUri: "sip:b2bua@10.0.0.1:5060",
      dialogToUri: "sip:bob@192.0.2.20:5060",
      event: "refer",
      subscriptionState: "active;expires=60",
      body,
    })

    expect(req.type).toBe("request")
    expect(req.method).toBe("NOTIFY")
    expect(req.uri).toBe("sip:bob@192.0.2.20:5060")
    expect(getHeader(req.headers, "Via")).toBe("__PLACEHOLDER__")
    expect(getHeader(req.headers, "Contact")).toBe("__PLACEHOLDER__")
    expect(getHeader(req.headers, "From")).toBe("<sip:b2bua@10.0.0.1:5060>;tag=b2bua-tag")
    expect(getHeader(req.headers, "To")).toBe("<sip:bob@192.0.2.20:5060>;tag=b-remote-tag")
    expect(getHeader(req.headers, "Call-ID")).toBe("call-bleg-1")
    expect(getHeader(req.headers, "CSeq")).toBe("101 NOTIFY")
    expect(getHeader(req.headers, "Event")).toBe("refer")
    expect(getHeader(req.headers, "Subscription-State")).toBe("active;expires=60")
    expect(getHeader(req.headers, "Content-Type")).toBe("message/sipfrag;version=2.0")
    expect(getHeader(req.headers, "Content-Length")).toBe(String(body.byteLength))
    expect(req.body).toEqual(body)
  })

  test("omits Content-Type and sets Content-Length:0 when body is absent", () => {
    const req = buildNotify({
      callId: "call-1",
      fromTag: "ft",
      toTag: "tt",
      requestUri: "sip:peer@host",
      cseq: 42,
      event: "refer",
      subscriptionState: "terminated;reason=timeout",
    })
    expect(getHeader(req.headers, "Content-Type")).toBeUndefined()
    expect(getHeader(req.headers, "Content-Length")).toBe("0")
    expect(req.body.byteLength).toBe(0)
  })

  test("honours custom contentType override", () => {
    const body = new TextEncoder().encode("<xml/>")
    const req = buildNotify({
      callId: "call-1",
      fromTag: "ft",
      toTag: "tt",
      requestUri: "sip:peer@host",
      cseq: 42,
      event: "dialog",
      subscriptionState: "active",
      body,
      contentType: "application/dialog-info+xml",
    })
    expect(getHeader(req.headers, "Content-Type")).toBe("application/dialog-info+xml")
    expect(getHeader(req.headers, "Content-Length")).toBe(String(body.byteLength))
  })

  test("falls back to requestUri when fromUri/dialogToUri omitted", () => {
    const req = buildNotify({
      callId: "call-1",
      fromTag: "ft",
      toTag: "tt",
      requestUri: "sip:peer@host",
      cseq: 1,
      event: "refer",
      subscriptionState: "active;expires=60",
    })
    expect(getHeader(req.headers, "From")).toBe("<sip:peer@host>;tag=ft")
    expect(getHeader(req.headers, "To")).toBe("<sip:peer@host>;tag=tt")
  })
})
