/**
 * Parser extraction tests — verifies that downstream header helpers
 * (extractTag, parseViaParams, extractContactUri, parseSipUri, CSeq parsing)
 * work correctly on the custom parser's output.
 *
 * This validates the full pipeline: raw bytes → parse → extract structured data.
 * It also cross-checks custom parser output against JsSIP parser output.
 */

import { describe, test, expect } from "vitest"
import { Result } from "effect"

import { jssipParser as jssipParserRaw } from "../../src/sip/parsers/jssip-adapter.js"
import { customParser as customParserRaw } from "../../src/sip/parsers/custom/index.js"
import type { SipMessage } from "../../src/sip/types.js"

/** Test-only helpers that unwrap the parser Result, throwing on failure. */
const customParser = { parse: (b: Buffer) => Result.getOrThrow(customParserRaw.parse(b)) }
const jssipParser = { parse: (b: Buffer) => Result.getOrThrow(jssipParserRaw.parse(b)) }
import {
  getHeader,
  getHeaders,
  extractTag,
  stripTag,
  extractContactUri,
  parseViaParams,
  parseSipUri,
  parseUriParams,
} from "../../src/sip/MessageHelpers.js"
import { sipMsg } from "./fixtures/rfc4475-valid.js"

// ---------------------------------------------------------------------------
// Test messages with known structured header values
// ---------------------------------------------------------------------------

const basicInvite = sipMsg`INVITE sip:bob@example.com;transport=udp SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-abc123;rport;cr=call-ref-1;lg=a
Via: SIP/2.0/UDP 192.168.1.1:5060;branch=z9hG4bK-prev;received=10.0.0.1
Max-Forwards: 70
From: "Alice Smith" <sip:alice@example.com>;tag=from-tag-xyz
To: <sip:bob@example.com>
Call-ID: unique-call-id@10.0.0.1
CSeq: 42 INVITE
Contact: <sip:alice@10.0.0.1:5060;callRef=call-ref-1;leg=a>
Content-Type: application/sdp
Content-Length: 0

`

const responseWithTags = sipMsg`SIP/2.0 200 OK
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-abc123;rport;received=10.0.0.1;cr=ref-1;lg=b-1
From: "Alice" <sip:alice@example.com>;tag=from-tag-1
To: <sip:bob@example.com>;tag=to-tag-2
Call-ID: test-call-id@10.0.0.1
CSeq: 1 INVITE
Contact: <sip:bob@10.0.0.2:5060>
Content-Length: 0

`

const compactFormMsg = sipMsg`INVITE sip:bob@example.com SIP/2.0
v: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-compact
f: <sip:alice@example.com>;tag=compact-tag
t: <sip:bob@example.com>
i: compact-call-id
CSeq: 1 INVITE
m: <sip:alice@10.0.0.1:5060>
l: 0

`

const multiVia = sipMsg`INVITE sip:bob@example.com SIP/2.0
Via: SIP/2.0/UDP hop3.example.com;branch=z9hG4bK-hop3;cr=ref;lg=b-1
Via: SIP/2.0/UDP hop2.example.com;branch=z9hG4bK-hop2
Via: SIP/2.0/TCP hop1.example.com;branch=z9hG4bK-hop1
From: <sip:alice@example.com>;tag=multi-via
To: <sip:bob@example.com>
Call-ID: multi-via-call@example.com
CSeq: 100 INVITE
Content-Length: 0

`

// Folded headers — tests that header folding preserves extraction
const foldedHeaders = sipMsg`INVITE sip:bob@example.com SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-fold
 ;cr=folded-ref;lg=a
From: "Long Display Name"
 <sip:alice@example.com>
 ;tag=folded-from-tag
To: <sip:bob@example.com>
Call-ID: folded-call-id@example.com
CSeq: 1 INVITE
Contact:
 <sip:alice@10.0.0.1:5060;callRef=fold-ref;leg=a>
Content-Length: 0

`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCSeq(msg: SipMessage): { seq: number; method: string } | undefined {
  const cseq = getHeader(msg.headers, "CSeq")
  if (!cseq) return undefined
  // Manual parse — no regex, same as handler code
  const spaceIdx = cseq.indexOf(" ")
  if (spaceIdx === -1) return undefined
  return {
    seq: parseInt(cseq.slice(0, spaceIdx), 10),
    method: cseq.slice(spaceIdx + 1).trim(),
  }
}

// ---------------------------------------------------------------------------
// Tests: custom parser extraction
// ---------------------------------------------------------------------------

describe("Custom parser — structured header extraction", () => {
  test("From tag extraction", () => {
    const msg = customParser.parse(basicInvite)
    const from = getHeader(msg.headers, "From")!
    expect(from).toBeDefined()
    expect(extractTag(from)).toBe("from-tag-xyz")
  })

  test("From tag stripping", () => {
    const msg = customParser.parse(basicInvite)
    const from = getHeader(msg.headers, "From")!
    const stripped = stripTag(from)
    expect(stripped).not.toContain("tag=")
    expect(stripped).toContain("sip:alice@example.com")
  })

  test("To tag extraction — no tag", () => {
    const msg = customParser.parse(basicInvite)
    const to = getHeader(msg.headers, "To")!
    expect(extractTag(to)).toBeUndefined()
  })

  test("To tag extraction — with tag", () => {
    const msg = customParser.parse(responseWithTags)
    const to = getHeader(msg.headers, "To")!
    expect(extractTag(to)).toBe("to-tag-2")
  })

  test("Via branch/cr/lg extraction", () => {
    const msg = customParser.parse(basicInvite)
    const topVia = getHeaders(msg.headers, "Via")[0]!
    const params = parseViaParams(topVia)
    expect(params.branch).toBe("z9hG4bK-abc123")
    expect(params.cr).toBe("call-ref-1")
    expect(params.lg).toBe("a")
  })

  test("Multiple Via headers — order preserved", () => {
    const msg = customParser.parse(multiVia)
    const vias = getHeaders(msg.headers, "Via")
    expect(vias).toHaveLength(3)
    // Top Via should be hop3 (first in message)
    expect(parseViaParams(vias[0]!).branch).toBe("z9hG4bK-hop3")
    expect(parseViaParams(vias[1]!).branch).toBe("z9hG4bK-hop2")
    expect(parseViaParams(vias[2]!).branch).toBe("z9hG4bK-hop1")
  })

  test("Contact URI extraction", () => {
    const msg = customParser.parse(basicInvite)
    const contact = getHeader(msg.headers, "Contact")!
    const uri = extractContactUri(contact)
    expect(uri).toBe("sip:alice@10.0.0.1:5060;callRef=call-ref-1;leg=a")
  })

  test("Contact URI param extraction", () => {
    const msg = customParser.parse(basicInvite)
    const contact = getHeader(msg.headers, "Contact")!
    const uri = extractContactUri(contact)
    const params = parseSipUri(uri)
    expect(params).toBeDefined()
    expect(params!.host).toBe("10.0.0.1")
    expect(params!.port).toBe(5060)
    expect(params!.user).toBe("alice")
    // JsSIP Grammar lowercases URI parameter names
    expect(params!.params["callref"]).toBe("call-ref-1")
    expect(params!.params["leg"]).toBe("a")
  })

  test("Request-URI parsing", () => {
    const msg = customParser.parse(basicInvite)
    expect(msg.type).toBe("request")
    if (msg.type !== "request") return
    const parsed = parseSipUri(msg.uri)
    expect(parsed).toBeDefined()
    expect(parsed!.user).toBe("bob")
    expect(parsed!.host).toBe("example.com")
    expect(parsed!.params["transport"]).toBe("udp")
  })

  test("Request-URI param extraction via parseUriParams", () => {
    const msg = customParser.parse(basicInvite)
    if (msg.type !== "request") return
    const params = parseUriParams(msg.uri)
    expect(params["transport"]).toBe("udp")
  })

  test("Call-ID extraction", () => {
    const msg = customParser.parse(basicInvite)
    expect(getHeader(msg.headers, "Call-ID")).toBe("unique-call-id@10.0.0.1")
  })

  test("CSeq parsing", () => {
    const msg = customParser.parse(basicInvite)
    const cseq = parseCSeq(msg)
    expect(cseq).toBeDefined()
    expect(cseq!.seq).toBe(42)
    expect(cseq!.method).toBe("INVITE")
  })

  test("Max-Forwards extraction", () => {
    const msg = customParser.parse(basicInvite)
    const mf = getHeader(msg.headers, "Max-Forwards")
    expect(parseInt(mf!, 10)).toBe(70)
  })

  test("Content-Type extraction", () => {
    const msg = customParser.parse(basicInvite)
    expect(getHeader(msg.headers, "Content-Type")).toBe("application/sdp")
  })
})

describe("Custom parser — compact form expansion", () => {
  test("Compact v → Via", () => {
    const msg = customParser.parse(compactFormMsg)
    const via = getHeader(msg.headers, "Via")
    expect(via).toBeDefined()
    expect(parseViaParams(via!).branch).toBe("z9hG4bK-compact")
  })

  test("Compact f → From with tag", () => {
    const msg = customParser.parse(compactFormMsg)
    const from = getHeader(msg.headers, "From")
    expect(from).toBeDefined()
    expect(extractTag(from!)).toBe("compact-tag")
  })

  test("Compact t → To", () => {
    const msg = customParser.parse(compactFormMsg)
    expect(getHeader(msg.headers, "To")).toBeDefined()
  })

  test("Compact i → Call-ID", () => {
    const msg = customParser.parse(compactFormMsg)
    expect(getHeader(msg.headers, "Call-ID")).toBe("compact-call-id")
  })

  test("Compact m → Contact", () => {
    const msg = customParser.parse(compactFormMsg)
    const contact = getHeader(msg.headers, "Contact")
    expect(contact).toBeDefined()
    expect(extractContactUri(contact!)).toBe("sip:alice@10.0.0.1:5060")
  })

  test("Compact l → Content-Length", () => {
    const msg = customParser.parse(compactFormMsg)
    expect(getHeader(msg.headers, "Content-Length")).toBe("0")
  })
})

describe("Custom parser — header folding with extraction", () => {
  test("Folded Via with cr/lg params", () => {
    const msg = customParser.parse(foldedHeaders)
    const via = getHeader(msg.headers, "Via")!
    const params = parseViaParams(via)
    expect(params.branch).toBe("z9hG4bK-fold")
    expect(params.cr).toBe("folded-ref")
    expect(params.lg).toBe("a")
  })

  test("Folded From with tag", () => {
    const msg = customParser.parse(foldedHeaders)
    const from = getHeader(msg.headers, "From")!
    expect(extractTag(from)).toBe("folded-from-tag")
  })

  test("Folded Contact with URI params", () => {
    const msg = customParser.parse(foldedHeaders)
    const contact = getHeader(msg.headers, "Contact")!
    const uri = extractContactUri(contact)
    expect(uri).toBe("sip:alice@10.0.0.1:5060;callRef=fold-ref;leg=a")
    const parsed = parseSipUri(uri)
    // JsSIP Grammar lowercases URI parameter names
    expect(parsed!.params["callref"]).toBe("fold-ref")
    expect(parsed!.params["leg"]).toBe("a")
  })
})

// ---------------------------------------------------------------------------
// Cross-parser equivalence: custom vs JsSIP on extraction
// ---------------------------------------------------------------------------

describe("Cross-parser extraction equivalence — custom vs JsSIP", () => {
  // Only include messages where JsSIP and custom produce equivalent raw header values.
  // Folded headers produce different raw values (custom correctly unfolds, JsSIP may not).
  const messages: Array<[string, Buffer]> = [
    ["basic INVITE", basicInvite],
    ["200 OK with tags", responseWithTags],
    ["compact forms", compactFormMsg],
    ["multi-Via", multiVia],
  ]

  for (const [name, buf] of messages) {
    test(`${name} — same From tag`, () => {
      const custom = customParser.parse(buf)
      const jssip = jssipParser.parse(buf)
      const customTag = extractTag(getHeader(custom.headers, "From") ?? "")
      const jssipTag = extractTag(getHeader(jssip.headers, "From") ?? "")
      expect(customTag).toBe(jssipTag)
    })

    test(`${name} — same To tag`, () => {
      const custom = customParser.parse(buf)
      const jssip = jssipParser.parse(buf)
      const customTag = extractTag(getHeader(custom.headers, "To") ?? "")
      const jssipTag = extractTag(getHeader(jssip.headers, "To") ?? "")
      expect(customTag).toBe(jssipTag)
    })

    test(`${name} — same Call-ID`, () => {
      const custom = customParser.parse(buf)
      const jssip = jssipParser.parse(buf)
      expect(getHeader(custom.headers, "Call-ID")).toBe(getHeader(jssip.headers, "Call-ID"))
    })

    test(`${name} — same Via branch`, () => {
      const custom = customParser.parse(buf)
      const jssip = jssipParser.parse(buf)
      const customVia = getHeaders(custom.headers, "Via")[0]
      const jssipVia = getHeaders(jssip.headers, "Via")[0]
      if (customVia && jssipVia) {
        expect(parseViaParams(customVia).branch).toBe(parseViaParams(jssipVia).branch)
      }
    })

    test(`${name} — same Via cr/lg`, () => {
      const custom = customParser.parse(buf)
      const jssip = jssipParser.parse(buf)
      const customVia = getHeaders(custom.headers, "Via")[0]
      const jssipVia = getHeaders(jssip.headers, "Via")[0]
      if (customVia && jssipVia) {
        expect(parseViaParams(customVia).cr).toBe(parseViaParams(jssipVia).cr)
        expect(parseViaParams(customVia).lg).toBe(parseViaParams(jssipVia).lg)
      }
    })

    test(`${name} — same CSeq`, () => {
      const custom = customParser.parse(buf)
      const jssip = jssipParser.parse(buf)
      expect(getHeader(custom.headers, "CSeq")).toBe(getHeader(jssip.headers, "CSeq"))
    })

    test(`${name} — same Via count`, () => {
      const custom = customParser.parse(buf)
      const jssip = jssipParser.parse(buf)
      expect(getHeaders(custom.headers, "Via").length).toBe(getHeaders(jssip.headers, "Via").length)
    })
  }
})

// ---------------------------------------------------------------------------
// Tag injection attack resistance — parsed fields vs regex
// ---------------------------------------------------------------------------

describe("Tag injection resistance — parsed.from/to vs extractTag regex", () => {
  const injectionCases: Array<[string, Buffer, string | undefined, string | undefined]> = [
    [
      "fake tag in quoted display name",
      sipMsg`INVITE sip:bob@example.com SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-inj1
From: "Vincent ;tag=IamAhacker" <sip:alice@example.com>;tag=real-tag
To: <sip:bob@example.com>
Call-ID: injection-1@example.com
CSeq: 1 INVITE
Content-Length: 0

`,
      "real-tag",
      undefined,
    ],
    [
      "fake tag with angle brackets in display name",
      sipMsg`INVITE sip:bob@example.com SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-inj2
From: "Vincent <;tag=IamAhacker>" <sip:alice@example.com>;tag=real-tag
To: <sip:bob@example.com>
Call-ID: injection-2@example.com
CSeq: 1 INVITE
Content-Length: 0

`,
      "real-tag",
      undefined,
    ],
    [
      "only fake tag in display name (no real tag)",
      sipMsg`INVITE sip:bob@example.com SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-inj3
From: "Vincent ;tag=IamAhacker" <sip:alice@example.com>
To: <sip:bob@example.com>
Call-ID: injection-3@example.com
CSeq: 1 INVITE
Content-Length: 0

`,
      undefined,  // no real tag — parsed should return undefined
      undefined,
    ],
  ]

  for (const [name, buf, expectedFromTag, expectedToTag] of injectionCases) {
    test(`${name} — parsed.from.tag is correct`, () => {
      const msg = customParser.parse(buf)
      expect(msg.getHeader("from").tag).toBe(expectedFromTag)
    })

    test(`${name} — parsed.to.tag is correct`, () => {
      const msg = customParser.parse(buf)
      expect(msg.getHeader("to").tag).toBe(expectedToTag)
    })

    test(`${name} — extractTag is now quote-aware (fixed)`, () => {
      const msg = customParser.parse(buf)
      const fromHeader = getHeader(msg.headers, "From")!
      const tag = extractTag(fromHeader)
      // extractTag now uses the structured parser — immune to injection
      expect(tag).toBe(expectedFromTag)
    })
  }
})

// ---------------------------------------------------------------------------
// Parsed fields — eager extraction via custom parser
// ---------------------------------------------------------------------------

describe("Custom parser — parsed fields (eager extraction)", () => {
  test("parsed.from — basic INVITE", () => {
    const msg = customParser.parse(basicInvite)
    expect(msg.getHeader("from").displayName).toBe("Alice Smith")
    expect(msg.getHeader("from").uri).toBe("sip:alice@example.com")
    expect(msg.getHeader("from").tag).toBe("from-tag-xyz")
  })

  test("parsed.to — no tag", () => {
    const msg = customParser.parse(basicInvite)
    expect(msg.getHeader("to").uri).toBe("sip:bob@example.com")
    expect(msg.getHeader("to").tag).toBeUndefined()
  })

  test("parsed.to — with tag (response)", () => {
    const msg = customParser.parse(responseWithTags)
    expect(msg.getHeader("to").tag).toBe("to-tag-2")
  })

  test("parsed.callId", () => {
    const msg = customParser.parse(basicInvite)
    expect(msg.getHeader("call-id")).toBe("unique-call-id@10.0.0.1")
  })

  test("parsed.cseq", () => {
    const msg = customParser.parse(basicInvite)
    expect(msg.getHeader("cseq").seq).toBe(42)
    expect(msg.getHeader("cseq").method).toBe("INVITE")
  })

  test("parsed.via — top via", () => {
    const msg = customParser.parse(basicInvite)
    expect(msg.getHeader("via")[0].transport).toBe("UDP")
    expect(msg.getHeader("via")[0].host).toBe("10.0.0.1")
    expect(msg.getHeader("via")[0].port).toBe(5060)
    expect(msg.getHeader("via")[0].branch).toBe("z9hG4bK-abc123")
    expect(msg.getHeader("via")[0].params["cr"]).toBe("call-ref-1")
    expect(msg.getHeader("via")[0].params["lg"]).toBe("a")
  })

  test("parsed.vias — all vias", () => {
    const msg = customParser.parse(multiVia)
    expect(msg.getHeader("via")).toHaveLength(3)
    expect(msg.getHeader("via")[0]!.branch).toBe("z9hG4bK-hop3")
    expect(msg.getHeader("via")[1]!.branch).toBe("z9hG4bK-hop2")
    expect(msg.getHeader("via")[2]!.branch).toBe("z9hG4bK-hop1")
    expect(msg.getHeader("via")[0]!.params["cr"]).toBe("ref")
    expect(msg.getHeader("via")[0]!.params["lg"]).toBe("b-1")
  })

  test("parsed.contact", () => {
    const msg = customParser.parse(basicInvite)
    expect(msg.getHeader("contact")?.uri).toBe("sip:alice@10.0.0.1:5060;callRef=call-ref-1;leg=a")
  })

  test("parsed.requestUri", () => {
    const msg = customParser.parse(basicInvite)
    if (msg.type !== "request") throw new Error("expected request")
    expect(msg.requestUri.scheme).toBe("sip")
    expect(msg.requestUri.user).toBe("bob")
    expect(msg.requestUri.host).toBe("example.com")
    expect(msg.requestUri.params["transport"]).toBe("udp")
  })

  test("parsed has no requestUri for responses", () => {
    const msg = customParser.parse(responseWithTags)
    expect(msg.type).toBe("response")
  })

  test("parsed fields work with compact forms", () => {
    const msg = customParser.parse(compactFormMsg)
    expect(msg.getHeader("from").tag).toBe("compact-tag")
    expect(msg.getHeader("call-id")).toBe("compact-call-id")
    expect(msg.getHeader("via")[0].branch).toBe("z9hG4bK-compact")
    expect(msg.getHeader("contact")?.uri).toBe("sip:alice@10.0.0.1:5060")
  })

  test("parsed fields work with folded headers", () => {
    const msg = customParser.parse(foldedHeaders)
    expect(msg.getHeader("from").tag).toBe("folded-from-tag")
    expect(msg.getHeader("via")[0].branch).toBe("z9hG4bK-fold")
    expect(msg.getHeader("via")[0].params["cr"]).toBe("folded-ref")
    expect(msg.getHeader("via")[0].params["lg"]).toBe("a")
    expect(msg.getHeader("contact")?.uri).toBe("sip:alice@10.0.0.1:5060;callRef=fold-ref;leg=a")
  })

  // RFC 3261 §25.1: `user-unreserved = "&" / "=" / "+" / "$" / "," / ";" / "?" / "/"`
  // — `;` and `?` are legal inside the user portion, so the strict URI
  // validator must scan past them to locate the userinfo `@` separator.
  // Regression: the `@` look-ahead used to break at the first `;`/`?`,
  // misidentifying the user as the host and rejecting it because `+` is
  // not a valid host-label start character.
  test("From/To with `;` parameter inside user portion is accepted", () => {
    const buf = sipMsg`INVITE sip:bob@example.com SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-user-semi
From: "toto" <sip:+33123456789;titi=tat@foo.bar>;tag=from-tag-1
To: "tutu" <sip:+33198765432;npi=e164@bar.baz>
Call-ID: user-semi-1@example.com
CSeq: 1 INVITE
Content-Length: 0

`
    const msg = customParser.parse(buf)
    expect(msg.getHeader("from").uri).toBe("sip:+33123456789;titi=tat@foo.bar")
    expect(msg.getHeader("from").displayName).toBe("toto")
    expect(msg.getHeader("from").tag).toBe("from-tag-1")
    expect(msg.getHeader("to").uri).toBe("sip:+33198765432;npi=e164@bar.baz")
    expect(msg.getHeader("to").displayName).toBe("tutu")
  })
})

// RFC 3261 §19.1.1 embedded URI-headers — `?` is also valid in the user
// portion (§25.1 user-unreserved). The Refer-To embedded-headers boundary
// must be the `?` that follows hostport, not the first `?` in the URI.
// Regression: parseReferTo and parseReferToHeader used to split at the
// first `?`, misparsing the URI head as `sip:<user-prefix>` and rejecting
// it because the partial user wasn't a valid hostname.
describe("parseReferTo — `?` in userinfo vs embedded-headers boundary", () => {
  test("URI with `?` in user AND embedded Replaces parses both parts", () => {
    const referValue = "<sips:+33?param=v@host.example;lr?Replaces=abc%40d%3Bfrom-tag%3D1%3Bto-tag%3D2>"
    const buf = sipMsg`REFER sip:bob@example.com SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-refer-q
From: <sip:alice@example.com>;tag=t1
To: <sip:bob@example.com>;tag=t2
Call-ID: refer-q-1@example.com
CSeq: 1 REFER
Refer-To: ${referValue}
Content-Length: 0

`
    const msg = customParser.parse(buf)
    const referToResult = msg.getHeader("refer-to")
    if (!Result.isSuccess(referToResult)) throw new Error("Refer-To parse failed")
    const referTo = referToResult.success
    if (referTo === undefined) throw new Error("Refer-To missing")
    // URI is preserved intact, including both `?` occurrences.
    expect(referTo.uri).toBe("sips:+33?param=v@host.example;lr?Replaces=abc%40d%3Bfrom-tag%3D1%3Bto-tag%3D2")
    // Embedded headers are split on the post-hostport `?`, so the only
    // header is Replaces — `param=v@host…` lives in userinfo, not in
    // the embedded-header section.
    expect(Object.keys(referTo.embeddedHeaders)).toEqual(["Replaces"])
    expect(referTo.replaces?.callId).toBe("abc@d")
    expect(referTo.replaces?.fromTag).toBe("1")
    expect(referTo.replaces?.toTag).toBe("2")
  })
})
