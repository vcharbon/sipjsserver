/**
 * Serializer unit tests — Content-Length safety net.
 *
 * Verifies that the serializer auto-corrects Content-Length mismatches
 * and adds missing Content-Length when a body is present.
 *
 * Uses plain vitest (no @effect/vitest) since the serializer is a pure function.
 */

import { describe, test, expect, vi } from "vitest"
import { serialize } from "../../src/sip/Serializer.js"
import type { SipHeader, SipRequest, SipResponse } from "../../src/sip/types.js"
import { hydrateRequest, hydrateResponse } from "../../src/sip/parsers/extract-fields.js"

const h = (name: string, value: string): SipHeader => ({ name, value })
const emptyBody = new Uint8Array(0)
const sdpBody = new TextEncoder().encode("v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n")

const MANDATORY_HEADERS: ReadonlyArray<SipHeader> = [
  h("From", "<sip:alice@example.com>;tag=tagA"),
  h("To", "<sip:bob@example.com>"),
  h("Call-ID", "serializer-test-call"),
  h("CSeq", "1 INVITE"),
]

function makeResponse(
  status: number,
  headers: SipHeader[],
  body: Uint8Array = emptyBody
): SipResponse {
  return hydrateResponse({
    status,
    reason: "OK",
    headers: [...headers, ...MANDATORY_HEADERS],
    body,
    raw: Buffer.alloc(0),
  })
}

function makeRequest(
  method: string,
  headers: SipHeader[],
  body: Uint8Array = emptyBody
): SipRequest {
  return hydrateRequest({
    method,
    uri: "sip:bob@example.com",
    headers: [...headers, ...MANDATORY_HEADERS.map((m) =>
      m.name === "CSeq" ? h("CSeq", `1 ${method}`) : m
    )],
    body,
    raw: Buffer.alloc(0),
  })
}

/** Extract a header value from the serialized buffer. */
function extractHeader(buf: Buffer, name: string): string | undefined {
  const lines = buf.toString("utf-8").split("\r\n")
  const lower = name.toLowerCase()
  for (const line of lines) {
    const colon = line.indexOf(":")
    if (colon > 0 && line.substring(0, colon).trim().toLowerCase() === lower) {
      return line.substring(colon + 1).trim()
    }
  }
  return undefined
}

describe("Serializer Content-Length safety net", () => {
  test("correct Content-Length passes through without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const msg = makeResponse(200, [
      h("Via", "SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-1"),
      h("Content-Length", String(sdpBody.byteLength)),
    ], sdpBody)

    const buf = serialize(msg)
    expect(extractHeader(buf, "Content-Length")).toBe(String(sdpBody.byteLength))
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  test("Content-Length mismatch is auto-corrected with warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const msg = makeResponse(200, [
      h("Via", "SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-1"),
      h("Content-Length", "999"),
    ], sdpBody)

    const buf = serialize(msg)
    expect(extractHeader(buf, "Content-Length")).toBe(String(sdpBody.byteLength))
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]![0]).toContain("Content-Length mismatch")
    warnSpy.mockRestore()
  })

  test("missing Content-Length with non-empty body adds the header", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const msg = makeRequest("INVITE", [
      h("Via", "SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-1"),
    ], sdpBody)

    const buf = serialize(msg)
    expect(extractHeader(buf, "Content-Length")).toBe(String(sdpBody.byteLength))
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  test("empty body without Content-Length does not add the header", () => {
    const msg = makeRequest("OPTIONS", [
      h("Via", "SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-1"),
    ], emptyBody)

    const buf = serialize(msg)
    expect(extractHeader(buf, "Content-Length")).toBeUndefined()
  })

  test("empty body with Content-Length: 0 passes through", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const msg = makeResponse(200, [
      h("Via", "SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-1"),
      h("Content-Length", "0"),
    ], emptyBody)

    const buf = serialize(msg)
    expect(extractHeader(buf, "Content-Length")).toBe("0")
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  test("Content-Length: 0 with non-empty body is corrected", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const msg = makeRequest("INVITE", [
      h("Via", "SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-1"),
      h("Content-Length", "0"),
    ], sdpBody)

    const buf = serialize(msg)
    expect(extractHeader(buf, "Content-Length")).toBe(String(sdpBody.byteLength))
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })
})
