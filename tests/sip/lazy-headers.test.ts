/**
 * Lazy header tests — verifies the LazyHeaders accessor on parsed
 * SipMessages: lazy parsing, memoization, absent-header handling, and
 * malformed-value error reporting.
 */

import { describe, test, expect } from "vitest"
import { Result } from "effect"
import { customParser } from "../../src/sip/parsers/custom/index.js"
import { sipMsg } from "./fixtures/rfc4475-valid.js"

function parse(buf: Buffer) {
  return Result.getOrThrow(customParser.parse(buf))
}

const baseHeaders = `Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-test
From: <sip:alice@example.com>;tag=tagA
To: <sip:bob@example.com>
Call-ID: lazy-test
CSeq: 1 INVITE`

describe("LazyHeaders — P-Asserted-Identity (RFC 3325)", () => {
  test("absent → empty list", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Content-Length: 0

`)
    const r = msg.lazy.pAssertedIdentity()
    expect(Result.isSuccess(r)).toBe(true)
    expect(Result.getOrThrow(r)).toEqual([])
  })

  test("single value", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
P-Asserted-Identity: "Cullen Jennings" <sip:fluffy@cisco.com>
Content-Length: 0

`)
    const r = msg.lazy.pAssertedIdentity()
    const list = Result.getOrThrow(r)
    expect(list.length).toBe(1)
    expect(list[0]!.displayName).toBe("Cullen Jennings")
    expect(list[0]!.uri).toBe("sip:fluffy@cisco.com")
  })

  test("two values comma-separated (sip + tel)", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
P-Asserted-Identity: <sip:fluffy@cisco.com>, <tel:+14085551212>
Content-Length: 0

`)
    const list = Result.getOrThrow(msg.lazy.pAssertedIdentity())
    expect(list.length).toBe(2)
    expect(list[0]!.uri).toBe("sip:fluffy@cisco.com")
    expect(list[1]!.uri).toBe("tel:+14085551212")
  })

  test("two header instances combine into one list", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
P-Asserted-Identity: <sip:fluffy@cisco.com>
P-Asserted-Identity: <tel:+14085551212>
Content-Length: 0

`)
    const list = Result.getOrThrow(msg.lazy.pAssertedIdentity())
    expect(list.length).toBe(2)
  })

  test("memoization — second call returns same Result reference", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
P-Asserted-Identity: <sip:fluffy@cisco.com>
Content-Length: 0

`)
    const a = msg.lazy.pAssertedIdentity()
    const b = msg.lazy.pAssertedIdentity()
    expect(a).toBe(b)
  })

  test("comma-aware splitter ignores commas inside quoted display names", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
P-Asserted-Identity: "Smith, John" <sip:js@example.com>, <sip:jane@example.com>
Content-Length: 0

`)
    const list = Result.getOrThrow(msg.lazy.pAssertedIdentity())
    expect(list.length).toBe(2)
    expect(list[0]!.displayName).toBe("Smith, John")
    expect(list[0]!.uri).toBe("sip:js@example.com")
    expect(list[1]!.uri).toBe("sip:jane@example.com")
  })
})

describe("LazyHeaders — Diversion (RFC 5806)", () => {
  test("entry params are exposed", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Diversion: <sip:divert@example.com>;reason=user-busy;counter=2;privacy=full
Content-Length: 0

`)
    const list = Result.getOrThrow(msg.lazy.diversion())
    expect(list.length).toBe(1)
    expect(list[0]!.uri).toBe("sip:divert@example.com")
    expect(list[0]!.params["reason"]).toBe("user-busy")
    expect(list[0]!.params["counter"]).toBe("2")
    expect(list[0]!.params["privacy"]).toBe("full")
  })
})

describe("LazyHeaders — History-Info (RFC 7044)", () => {
  test("indexed entries", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
History-Info: <sip:alice@example.com>;index=1
History-Info: <sip:redirect@example.com>;index=1.1
Content-Length: 0

`)
    const list = Result.getOrThrow(msg.lazy.historyInfo())
    expect(list.length).toBe(2)
    expect(list[0]!.params["index"]).toBe("1")
    expect(list[1]!.params["index"]).toBe("1.1")
  })
})

describe("LazyHeaders — Geolocation / Geolocation-Routing / Geolocation-Error (RFC 6442 / 7378)", () => {
  test("Geolocation list", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Geolocation: <https://ls.example.com/loc1>, <https://ls.example.com/loc2>
Content-Length: 0

`)
    const list = Result.getOrThrow(msg.lazy.geolocation())
    expect(list.length).toBe(2)
    expect(list[0]!.uri).toBe("https://ls.example.com/loc1")
    expect(list[1]!.uri).toBe("https://ls.example.com/loc2")
  })

  test("Geolocation-Routing yes", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Geolocation-Routing: yes
Content-Length: 0

`)
    expect(Result.getOrThrow(msg.lazy.geolocationRouting())).toBe(true)
  })

  test("Geolocation-Routing no (case-insensitive)", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Geolocation-Routing: NO
Content-Length: 0

`)
    expect(Result.getOrThrow(msg.lazy.geolocationRouting())).toBe(false)
  })

  test("Geolocation-Routing absent → undefined", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Content-Length: 0

`)
    expect(Result.getOrThrow(msg.lazy.geolocationRouting())).toBeUndefined()
  })

  test("Geolocation-Routing invalid value → failure", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Geolocation-Routing: maybe
Content-Length: 0

`)
    const r = msg.lazy.geolocationRouting()
    expect(Result.isFailure(r)).toBe(true)
  })

  test("Geolocation-Error parses with code param", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Geolocation-Error: <sip:locinfo@example.com>;code=200
Content-Length: 0

`)
    const list = Result.getOrThrow(msg.lazy.geolocationError())
    expect(list.length).toBe(1)
    expect(list[0]!.params["code"]).toBe("200")
  })
})

describe("LazyHeaders — Remote-Party-ID, P-Preferred-Identity", () => {
  test("Remote-Party-ID with id-type / privacy params", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Remote-Party-ID: "Alice" <sip:alice@example.com>;party=calling;id-type=subscriber;privacy=off
Content-Length: 0

`)
    const list = Result.getOrThrow(msg.lazy.remotePartyId())
    expect(list.length).toBe(1)
    expect(list[0]!.params["party"]).toBe("calling")
    expect(list[0]!.params["id-type"]).toBe("subscriber")
    expect(list[0]!.params["privacy"]).toBe("off")
  })

  test("P-Preferred-Identity present", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
P-Preferred-Identity: <sip:alice@example.com>
Content-Length: 0

`)
    const list = Result.getOrThrow(msg.lazy.pPreferredIdentity())
    expect(list.length).toBe(1)
    expect(list[0]!.uri).toBe("sip:alice@example.com")
  })
})
