/**
 * Unit tests for the rule-action ADT layer (Slice A of the rule-framework
 * refactor): factories, readers, and the apply helpers that translate
 * ADTs into SipMessage mutations.
 */

import { describe, test, expect } from "vitest"
import {
  H,
  custom,
  removeH,
  replaceH,
  SipUriSyntaxError,
  tagsOf,
  toBareUri,
  toNameAddr,
} from "../../src/b2bua/rules/framework/actions/factories.js"
import { readBody, readHeaders } from "../../src/b2bua/rules/framework/actions/readers.js"
import {
  applyBodyUpdate,
  applyHeaderUpdates,
  applyRuriOp,
} from "../../src/b2bua/rules/framework/actions/apply.js"
import type {
  BareSipUri,
  HeaderUpdates,
  NameAddr,
} from "../../src/b2bua/rules/framework/actions/types.js"
import type { SipHeader, SipRequest, SipResponse } from "../../src/sip/types.js"
import { hydrateRequest, hydrateResponse } from "../../src/sip/parsers/extract-fields.js"

const h = (name: string, value: string): SipHeader => ({ name, value })

// Mandatory headers backfilled when the test caller doesn't supply them — keeps
// fixture noise out of every `makeRequest([...])` site while still satisfying
// the parser's "every SIP message MUST carry From/To/Call-ID/CSeq/Via" rule.
const MANDATORY: ReadonlyArray<SipHeader> = [
  { name: "Via", value: "SIP/2.0/UDP test.invalid:5060;branch=z9hG4bK-test" },
  { name: "From", value: "<sip:test@invalid>;tag=test-from" },
  { name: "To", value: "<sip:test@invalid>" },
  { name: "Call-ID", value: "test-call-id" },
  { name: "CSeq", value: "1 INVITE" },
]

function backfillMandatory(headers: ReadonlyArray<SipHeader>): SipHeader[] {
  const present = new Set(headers.map((h) => h.name.toLowerCase()))
  const filled: SipHeader[] = [...headers]
  for (const m of MANDATORY) {
    if (!present.has(m.name.toLowerCase())) filled.push(m)
  }
  return filled
}

function makeRequest(headers: ReadonlyArray<SipHeader>, body: Uint8Array = new Uint8Array(0)): SipRequest {
  return hydrateRequest({
    method: "INVITE",
    uri: "sip:orig@example.com",
    headers: backfillMandatory(headers),
    body,
    raw: Buffer.alloc(0),
  })
}

function makeResponse(headers: ReadonlyArray<SipHeader>, body: Uint8Array = new Uint8Array(0)): SipResponse {
  return hydrateResponse({
    status: 200,
    reason: "OK",
    headers: backfillMandatory(headers),
    body,
    raw: Buffer.alloc(0),
  })
}

describe("toBareUri", () => {
  test("passes through a plain sip: URI", () => {
    const u = toBareUri("sip:bob@10.0.0.1:5060;transport=udp")
    expect(u as string).toBe("sip:bob@10.0.0.1:5060;transport=udp")
  })

  test("accepts sips: scheme", () => {
    expect(toBareUri("sips:alice@secure.example") as string).toBe("sips:alice@secure.example")
  })

  test("strips angle brackets from a <uri> form", () => {
    expect(toBareUri("<sip:charlie@127.0.0.1:5667>") as string).toBe("sip:charlie@127.0.0.1:5667")
  })

  test("strips display name + header params from a name-addr input", () => {
    const out = toBareUri(`"Charlie" <sip:charlie@127.0.0.1:5667>;tag=abc123;expires=300`)
    expect(out as string).toBe("sip:charlie@127.0.0.1:5667")
  })

  test("rejects empty input", () => {
    expect(() => toBareUri("")).toThrow(SipUriSyntaxError)
  })

  test("rejects non-SIP scheme", () => {
    expect(() => toBareUri("tel:+15555550100")).toThrow(SipUriSyntaxError)
  })

  test("rejects whitespace-only input", () => {
    expect(() => toBareUri("   ")).toThrow(SipUriSyntaxError)
  })

  test("round-trips through toNameAddr", () => {
    const bare = toBareUri("sip:charlie@127.0.0.1:5667")
    const wrapped = toNameAddr(bare, "Charlie")
    expect(wrapped as string).toBe(`"Charlie" <sip:charlie@127.0.0.1:5667>`)
    const back = toBareUri(wrapped)
    expect(back as string).toBe("sip:charlie@127.0.0.1:5667")
  })
})

describe("toNameAddr", () => {
  test("wraps without a display name", () => {
    const bare = toBareUri("sip:bob@example.com")
    expect(toNameAddr(bare) as string).toBe("<sip:bob@example.com>")
  })

  test("wraps with a display name (quoted)", () => {
    const bare = toBareUri("sip:bob@example.com")
    expect(toNameAddr(bare, "Bob") as string).toBe(`"Bob" <sip:bob@example.com>`)
  })
})

describe("tagsOf", () => {
  test("extracts tag and other header params from a name-addr", () => {
    const addr = `"Alice" <sip:alice@example.com>;tag=xyz;expires=60` as NameAddr
    const tags = tagsOf(addr)
    expect(tags.get("tag")).toBe("xyz")
    expect(tags.get("expires")).toBe("60")
  })

  test("returns an empty map when no header params present", () => {
    const addr = `<sip:alice@example.com>` as NameAddr
    expect(tagsOf(addr).size).toBe(0)
  })
})

describe("custom() / H factory", () => {
  test("H.From / H.Contact are well-known", () => {
    expect(H.From.kind).toBe("well-known")
    expect(H.From.name).toBe("From")
    expect(H.Contact.name).toBe("Contact")
  })

  test("custom() lowercases proprietary names", () => {
    const xfoo = custom("X-Foo-Bar")
    expect(xfoo.kind).toBe("proprietary")
    expect(xfoo.name).toBe("x-foo-bar")
  })

  test("custom() throws on a well-known name", () => {
    expect(() => custom("From")).toThrow(/well-known/i)
    expect(() => custom("cseq")).toThrow(/well-known/i)
  })

  test("custom() throws on empty input", () => {
    expect(() => custom("")).toThrow(/non-empty/i)
  })
})

describe("replaceH / removeH factories", () => {
  test("replaceH requires at least one value at the type level", () => {
    const u = replaceH("a", "b")
    expect(u.kind).toBe("replace")
    if (u.kind === "replace") {
      expect(u.values).toEqual(["a", "b"])
    }
  })

  test("removeH emits kind=remove", () => {
    expect(removeH().kind).toBe("remove")
  })
})

describe("readHeaders / readBody", () => {
  test("readHeaders returns multi-valued headers in order (case-insensitive)", () => {
    const req = makeRequest([
      h("Diversion", "<sip:divert1@example.com>"),
      h("Via", "SIP/2.0/UDP 10.0.0.1"),
      h("diversion", "<sip:divert2@example.com>"),
    ])
    const out = readHeaders(req, H.Diversion)
    expect(out).toEqual([
      "<sip:divert1@example.com>",
      "<sip:divert2@example.com>",
    ])
  })

  test("readHeaders finds proprietary headers via custom()", () => {
    const req = makeRequest([
      h("X-Custom", "hello"),
      h("X-Custom", "world"),
    ])
    expect(readHeaders(req, custom("X-Custom"))).toEqual(["hello", "world"])
  })

  test("readHeaders returns empty when header absent", () => {
    expect(readHeaders(makeRequest([]), H.Diversion)).toEqual([])
  })

  test("readBody returns undefined for zero-length body", () => {
    expect(readBody(makeRequest([]))).toBeUndefined()
  })

  test("readBody returns the bytes when non-empty", () => {
    const body = new TextEncoder().encode("hello")
    expect(readBody(makeRequest([], body))).toBe(body)
  })
})

describe("applyHeaderUpdates", () => {
  test("replace erases every prior occurrence and appends new values in order", () => {
    const req = makeRequest([
      h("Via", "via-1"),
      h("Via", "via-2"),
      h("From", "<sip:a@example.com>"),
      h("Diversion", "div-1"),
    ])
    const updates: HeaderUpdates = new Map([
      [H.Diversion, replaceH("div-A", "div-B")],
    ])
    const out = applyHeaderUpdates(req, updates)
    expect(readHeaders(out, H.Diversion)).toEqual(["div-A", "div-B"])
    // Unrelated headers preserved and in original order.
    expect(readHeaders(out, H.Via)).toEqual(["via-1", "via-2"])
    expect(readHeaders(out, H.From)).toEqual(["<sip:a@example.com>"])
  })

  test("remove erases every occurrence of the named header", () => {
    const req = makeRequest([
      h("Via", "via-1"),
      h("Supported", "100rel"),
      h("Supported", "timer"),
      h("Via", "via-2"),
    ])
    const updates: HeaderUpdates = new Map([[H.Supported, removeH()]])
    const out = applyHeaderUpdates(req, updates)
    expect(readHeaders(out, H.Supported)).toEqual([])
    expect(readHeaders(out, H.Via)).toEqual(["via-1", "via-2"])
  })

  test("mixes replace + remove + proprietary in one call", () => {
    const req = makeRequest([
      h("X-Foo", "old"),
      h("From", "<sip:a@example.com>;tag=1"),
      h("Subject", "drop me"),
    ])
    const updates: HeaderUpdates = new Map([
      [custom("X-Foo"), replaceH("new")],
      [H.Subject, removeH()],
    ])
    const out = applyHeaderUpdates(req, updates)
    expect(readHeaders(out, custom("X-Foo"))).toEqual(["new"])
    expect(readHeaders(out, H.Subject)).toEqual([])
    expect(readHeaders(out, H.From)).toEqual(["<sip:a@example.com>;tag=1"])
  })

  test("empty update map is a no-op (reference-equal)", () => {
    const req = makeRequest([h("Via", "via-1")])
    expect(applyHeaderUpdates(req, new Map())).toBe(req)
  })
})

describe("applyBodyUpdate", () => {
  test("inherit is a no-op (reference-equal)", () => {
    const body = new TextEncoder().encode("v=0")
    const req = makeRequest([h("Content-Length", String(body.byteLength))], body)
    expect(applyBodyUpdate(req, { kind: "inherit" })).toBe(req)
  })

  test("drop replaces body with 0 bytes and sets Content-Length: 0", () => {
    const body = new TextEncoder().encode("v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n")
    const req = makeRequest([h("Content-Length", String(body.byteLength))], body)
    const out = applyBodyUpdate(req, { kind: "drop" })
    expect(out.body.byteLength).toBe(0)
    expect(readHeaders(out, H["Content-Length"])).toEqual(["0"])
  })

  test("set replaces body and updates Content-Length to new length", () => {
    const original = new TextEncoder().encode("old")
    const replacement = new TextEncoder().encode("replacement-body-here")
    const resp = makeResponse([h("Content-Length", String(original.byteLength))], original)
    const out = applyBodyUpdate(resp, { kind: "set", value: replacement })
    expect(out.body).toBe(replacement)
    expect(readHeaders(out, H["Content-Length"])).toEqual([String(replacement.byteLength)])
  })

  test("appends Content-Length when source had none", () => {
    const req = makeRequest([h("Via", "v")])
    const out = applyBodyUpdate(req, { kind: "set", value: new TextEncoder().encode("hi") })
    expect(readHeaders(out, H["Content-Length"])).toEqual(["2"])
  })
})

describe("applyRuriOp", () => {
  test("inherit is a no-op", () => {
    const req = makeRequest([])
    expect(applyRuriOp(req, { kind: "inherit" })).toBe(req)
  })

  test("set overwrites the Request-URI with the bare URI brand value", () => {
    const req = makeRequest([])
    const bare = toBareUri("sip:charlie@10.1.2.3:5060")
    const out = applyRuriOp(req, { kind: "set", value: bare })
    expect(out.uri).toBe("sip:charlie@10.1.2.3:5060")
  })

  test("set with a name-addr-origin URI uses only the stripped bare form", () => {
    // Rules that fetch Refer-To values route through toBareUri; verify the
    // end-to-end flow yields a Request-URI without angle brackets / tags.
    const fromHeader = `"Charlie" <sip:charlie@10.0.0.1:5060>;tag=deadbeef`
    const bare: BareSipUri = toBareUri(fromHeader)
    const out = applyRuriOp(makeRequest([]), { kind: "set", value: bare })
    expect(out.uri).toBe("sip:charlie@10.0.0.1:5060")
    expect(out.uri).not.toContain("<")
    expect(out.uri).not.toContain("tag=")
  })
})
