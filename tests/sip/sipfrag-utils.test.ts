/**
 * Unit tests for SipFragUtils.
 */

import { describe, expect, test } from "vitest"
import { sipfragFromStatus } from "../../src/sip/SipFragUtils.js"

describe("sipfragFromStatus", () => {
  test("produces exact bytes for 180 Ringing", () => {
    const bytes = sipfragFromStatus(180, "Ringing")
    expect(new TextDecoder().decode(bytes)).toBe("SIP/2.0 180 Ringing\r\n")
  })

  test("produces exact bytes for 200 OK", () => {
    const bytes = sipfragFromStatus(200, "OK")
    expect(Buffer.from(bytes)).toEqual(Buffer.from("SIP/2.0 200 OK\r\n", "utf8"))
  })

  test("preserves multi-word reason", () => {
    const bytes = sipfragFromStatus(486, "Busy Here")
    expect(new TextDecoder().decode(bytes)).toBe("SIP/2.0 486 Busy Here\r\n")
  })

  test("CRLF-terminated", () => {
    const bytes = sipfragFromStatus(100, "Trying")
    expect(bytes[bytes.length - 2]).toBe(0x0d)
    expect(bytes[bytes.length - 1]).toBe(0x0a)
  })
})
