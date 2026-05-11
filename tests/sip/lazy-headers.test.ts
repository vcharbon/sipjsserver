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
    const r = msg.getHeader("p-asserted-identity")
    expect(Result.isSuccess(r)).toBe(true)
    expect(Result.getOrThrow(r)).toEqual([])
  })

  test("single value", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
P-Asserted-Identity: "Cullen Jennings" <sip:fluffy@cisco.com>
Content-Length: 0

`)
    const r = msg.getHeader("p-asserted-identity")
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
    const list = Result.getOrThrow(msg.getHeader("p-asserted-identity"))
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
    const list = Result.getOrThrow(msg.getHeader("p-asserted-identity"))
    expect(list.length).toBe(2)
  })

  test("memoization — second call returns same Result reference", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
P-Asserted-Identity: <sip:fluffy@cisco.com>
Content-Length: 0

`)
    const a = msg.getHeader("p-asserted-identity")
    const b = msg.getHeader("p-asserted-identity")
    expect(a).toBe(b)
  })

  test("comma-aware splitter ignores commas inside quoted display names", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
P-Asserted-Identity: "Smith, John" <sip:js@example.com>, <sip:jane@example.com>
Content-Length: 0

`)
    const list = Result.getOrThrow(msg.getHeader("p-asserted-identity"))
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
    const list = Result.getOrThrow(msg.getHeader("diversion"))
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
    const list = Result.getOrThrow(msg.getHeader("history-info"))
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
    const list = Result.getOrThrow(msg.getHeader("geolocation"))
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
    expect(Result.getOrThrow(msg.getHeader("geolocation-routing"))).toBe(true)
  })

  test("Geolocation-Routing no (case-insensitive)", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Geolocation-Routing: NO
Content-Length: 0

`)
    expect(Result.getOrThrow(msg.getHeader("geolocation-routing"))).toBe(false)
  })

  test("Geolocation-Routing absent → undefined", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Content-Length: 0

`)
    expect(Result.getOrThrow(msg.getHeader("geolocation-routing"))).toBeUndefined()
  })

  test("Geolocation-Routing invalid value → failure", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Geolocation-Routing: maybe
Content-Length: 0

`)
    const r = msg.getHeader("geolocation-routing")
    expect(Result.isFailure(r)).toBe(true)
  })

  test("Geolocation-Error parses with code param", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Geolocation-Error: <sip:locinfo@example.com>;code=200
Content-Length: 0

`)
    const list = Result.getOrThrow(msg.getHeader("geolocation-error"))
    expect(list.length).toBe(1)
    expect(list[0]!.params["code"]).toBe("200")
  })
})

const prackHeaders = `Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-test
From: <sip:alice@example.com>;tag=tagA
To: <sip:bob@example.com>;tag=tagB
Call-ID: lazy-test
CSeq: 2 PRACK`

const referHeaders = `Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-test
From: <sip:alice@example.com>;tag=tagA
To: <sip:bob@example.com>;tag=tagB
Call-ID: lazy-test
CSeq: 3 REFER`

describe("LazyHeaders — RAck (RFC 3262)", () => {
  test("absent → undefined", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Content-Length: 0

`)
    expect(Result.getOrThrow(msg.getHeader("rack"))).toBeUndefined()
  })

  test("well-formed PRACK RAck", () => {
    const msg = parse(sipMsg`PRACK sip:bob@example.com SIP/2.0
${prackHeaders}
RAck: 776656 1 INVITE
Content-Length: 0

`)
    const rack = Result.getOrThrow(msg.getHeader("rack"))
    expect(rack).toBeDefined()
    expect(rack!.rseq).toBe(776656)
    expect(rack!.seq).toBe(1)
    expect(rack!.method).toBe("INVITE")
  })

  test("extra whitespace tolerated", () => {
    const msg = parse(sipMsg`PRACK sip:bob@example.com SIP/2.0
${prackHeaders}
RAck:    42   7   INVITE
Content-Length: 0

`)
    const rack = Result.getOrThrow(msg.getHeader("rack"))
    expect(rack!.rseq).toBe(42)
    expect(rack!.seq).toBe(7)
    expect(rack!.method).toBe("INVITE")
  })

  test("missing method → failure", () => {
    const msg = parse(sipMsg`PRACK sip:bob@example.com SIP/2.0
${prackHeaders}
RAck: 1 2
Content-Length: 0

`)
    expect(Result.isFailure(msg.getHeader("rack"))).toBe(true)
  })

  test("non-numeric rseq → failure", () => {
    const msg = parse(sipMsg`PRACK sip:bob@example.com SIP/2.0
${prackHeaders}
RAck: foo 2 INVITE
Content-Length: 0

`)
    expect(Result.isFailure(msg.getHeader("rack"))).toBe(true)
  })

  test("memoization — second call returns same Result reference", () => {
    const msg = parse(sipMsg`PRACK sip:bob@example.com SIP/2.0
${prackHeaders}
RAck: 1 1 INVITE
Content-Length: 0

`)
    const a = msg.getHeader("rack")
    const b = msg.getHeader("rack")
    expect(a).toBe(b)
  })
})

describe("LazyHeaders — Refer-To (RFC 3515 + RFC 3891)", () => {
  test("absent → undefined", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Content-Length: 0

`)
    expect(Result.getOrThrow(msg.getHeader("refer-to"))).toBeUndefined()
  })

  test("blind transfer (no Replaces)", () => {
    const msg = parse(sipMsg`REFER sip:bob@example.com SIP/2.0
${referHeaders}
Refer-To: <sip:carol@example.com>
Content-Length: 0

`)
    const refer = Result.getOrThrow(msg.getHeader("refer-to"))!
    expect(refer.uri).toBe("sip:carol@example.com")
    expect(refer.replaces).toBeUndefined()
    expect(refer.embeddedHeaders).toEqual({})
    expect(refer.parsedUri?.user).toBe("carol")
    expect(refer.parsedUri?.host).toBe("example.com")
  })

  test("attended transfer with Replaces (percent-encoded)", () => {
    // RFC 3891: Replaces=callid;to-tag=t1;from-tag=t2 — semicolons percent-encoded as %3B inside URI
    const msg = parse(sipMsg`REFER sip:bob@example.com SIP/2.0
${referHeaders}
Refer-To: <sip:carol@example.com?Replaces=abc-call-id%3Bto-tag%3Dt1%3Bfrom-tag%3Dt2>
Content-Length: 0

`)
    const refer = Result.getOrThrow(msg.getHeader("refer-to"))!
    expect(refer.parsedUri?.user).toBe("carol")
    expect(refer.replaces).toBeDefined()
    expect(refer.replaces!.callId).toBe("abc-call-id")
    expect(refer.replaces!.toTag).toBe("t1")
    expect(refer.replaces!.fromTag).toBe("t2")
    expect(refer.replaces!.earlyOnly).toBe(false)
  })

  test("early-only attended transfer", () => {
    const msg = parse(sipMsg`REFER sip:bob@example.com SIP/2.0
${referHeaders}
Refer-To: <sip:carol@example.com?Replaces=cid%3Bto-tag%3Dx%3Bfrom-tag%3Dy%3Bearly-only>
Content-Length: 0

`)
    const refer = Result.getOrThrow(msg.getHeader("refer-to"))!
    expect(refer.replaces!.earlyOnly).toBe(true)
  })

  test("display-name containing literal '?replaces=' must NOT false-match", () => {
    // The B2BUA's old regex /[?&]replaces=/i.test(rawHeader) would false-match
    // on this header. The structured parser only inspects the URI portion.
    const msg = parse(sipMsg`REFER sip:bob@example.com SIP/2.0
${referHeaders}
Refer-To: "Replaces?replaces=foo" <sip:carol@example.com>
Content-Length: 0

`)
    const refer = Result.getOrThrow(msg.getHeader("refer-to"))!
    expect(refer.displayName).toBe("Replaces?replaces=foo")
    expect(refer.replaces).toBeUndefined()
    expect(refer.embeddedHeaders).toEqual({})
  })

  test("Replaces missing mandatory tags → replaces undefined (header still parses)", () => {
    const msg = parse(sipMsg`REFER sip:bob@example.com SIP/2.0
${referHeaders}
Refer-To: <sip:carol@example.com?Replaces=just-callid>
Content-Length: 0

`)
    const refer = Result.getOrThrow(msg.getHeader("refer-to"))!
    // Refer-To itself parses; the embedded Replaces is malformed (no to-tag/from-tag),
    // so refer.replaces is undefined while embeddedHeaders.Replaces still holds the raw value.
    expect(refer.replaces).toBeUndefined()
    expect(refer.embeddedHeaders["Replaces"]).toBe("just-callid")
  })

  test("Refer-To with header-level params (e.g. method=INVITE)", () => {
    const msg = parse(sipMsg`REFER sip:bob@example.com SIP/2.0
${referHeaders}
Refer-To: <sip:carol@example.com>;method=INVITE
Content-Length: 0

`)
    const refer = Result.getOrThrow(msg.getHeader("refer-to"))!
    expect(refer.params["method"]).toBe("INVITE")
    expect(refer.replaces).toBeUndefined()
  })

  test("memoization — second call returns same Result reference", () => {
    const msg = parse(sipMsg`REFER sip:bob@example.com SIP/2.0
${referHeaders}
Refer-To: <sip:carol@example.com>
Content-Length: 0

`)
    const a = msg.getHeader("refer-to")
    const b = msg.getHeader("refer-to")
    expect(a).toBe(b)
  })
})

describe("LazyHeaders — Remote-Party-ID, P-Preferred-Identity", () => {
  test("Remote-Party-ID with id-type / privacy params", () => {
    const msg = parse(sipMsg`INVITE sip:bob@example.com SIP/2.0
${baseHeaders}
Remote-Party-ID: "Alice" <sip:alice@example.com>;party=calling;id-type=subscriber;privacy=off
Content-Length: 0

`)
    const list = Result.getOrThrow(msg.getHeader("remote-party-id"))
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
    const list = Result.getOrThrow(msg.getHeader("p-preferred-identity"))
    expect(list.length).toBe(1)
    expect(list[0]!.uri).toBe("sip:alice@example.com")
  })
})
