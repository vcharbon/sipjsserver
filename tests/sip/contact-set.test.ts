/**
 * Contact-set extraction — the eager, validate-all Contact model.
 *
 * `getHeader("contacts")` returns every contact (folded across repeated
 * header lines and comma-separated values, RFC 3261 §7.3.1), or the `*`
 * wildcard variant (§10.2.2). `getHeader("contact")` stays the single
 * first-contact accessor for the dialog hot path. Every contact URI is
 * validated at parse time, so a malformed entry anywhere rejects the
 * whole message.
 *
 * Exercised against the production custom parser; the slot is produced by
 * the shared extract-fields pipeline, so every adapter gets it.
 */

import { describe, test, expect } from "vitest"
import { Result } from "effect"

import { customParser as customParserRaw } from "../../src/sip/parsers/custom/index.js"
import type { ContactSet, SipMessage } from "../../src/sip/types.js"
import { sipMsg } from "./fixtures/rfc4475-valid.js"

const parse = (b: Buffer) => Result.getOrThrow(customParserRaw.parse(b))

// getHeader's union overload resolves to the raw-string fallback; narrowing
// the receiver first restores the typed `SipHeaderTypes[K]` return.
function contactsOf(msg: SipMessage): ContactSet {
  if (msg.type === "request") return msg.getHeader("contacts")
  return msg.getHeader("contacts")
}
function firstContactUri(msg: SipMessage): string | undefined {
  if (msg.type === "request") return msg.getHeader("contact")?.uri
  return msg.getHeader("contact")?.uri
}

const singleInvite = sipMsg`INVITE sip:bob@example.test SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-single
Max-Forwards: 70
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>
Call-ID: contacts-single
CSeq: 1 INVITE
Contact: <sip:alice@10.0.0.1:5060>
Content-Length: 0

`

const redirectMultiLine = sipMsg`SIP/2.0 302 Moved Temporarily
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-multi
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>;tag=b
Call-ID: contacts-multi
CSeq: 1 INVITE
Contact: <sip:bob@10.0.0.2:5060>;q=0.8
Contact: <sip:bob@10.0.0.3:5060>;q=0.5
Content-Length: 0

`

const redirectCommaList = sipMsg`SIP/2.0 302 Moved Temporarily
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-comma
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>;tag=b
Call-ID: contacts-comma
CSeq: 1 INVITE
Contact: <sip:bob@10.0.0.2:5060>;q=0.8, <sip:bob@10.0.0.3:5060>;q=0.5
Content-Length: 0

`

const registerWildcard = sipMsg`REGISTER sip:registrar.example.test SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-star
Max-Forwards: 70
From: <sip:alice@example.test>;tag=a
To: <sip:alice@example.test>
Call-ID: contacts-star
CSeq: 1 REGISTER
Contact: *
Expires: 0
Content-Length: 0

`

const redirectBadSecondContact = sipMsg`SIP/2.0 302 Moved Temporarily
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-bad
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>;tag=b
Call-ID: contacts-bad
CSeq: 1 INVITE
Contact: <sip:bob@10.0.0.2:5060>
Contact: <sip:@>
Content-Length: 0

`

const registerWildcardMixed = sipMsg`REGISTER sip:registrar.example.test SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-mixed
Max-Forwards: 70
From: <sip:alice@example.test>;tag=a
To: <sip:alice@example.test>
Call-ID: contacts-mixed
CSeq: 1 REGISTER
Contact: *
Contact: <sip:alice@10.0.0.1:5060>
Expires: 0
Content-Length: 0

`

describe("Contact set extraction", () => {
  test("single Contact: list holds one, single accessor matches (back-compat)", () => {
    const msg = parse(singleInvite)
    const cs = contactsOf(msg)
    expect(cs.wildcard).toBe(false)
    if (cs.wildcard) throw new Error("unreachable")
    expect(cs.contacts.map((c) => c.uri)).toEqual(["sip:alice@10.0.0.1:5060"])
    expect(firstContactUri(msg)).toBe("sip:alice@10.0.0.1:5060")
  })

  test("multiple Contact lines fold into one ordered list with per-contact params", () => {
    const msg = parse(redirectMultiLine)
    const cs = contactsOf(msg)
    if (cs.wildcard) throw new Error("expected non-wildcard")
    expect(cs.contacts.map((c) => c.uri)).toEqual([
      "sip:bob@10.0.0.2:5060",
      "sip:bob@10.0.0.3:5060",
    ])
    expect(cs.contacts[0]!.params.q).toBe("0.8")
    expect(cs.contacts[1]!.params.q).toBe("0.5")
    // Single accessor still returns the first.
    expect(firstContactUri(msg)).toBe("sip:bob@10.0.0.2:5060")
  })

  test("comma-separated Contact values fold identically to repeated lines", () => {
    const msg = parse(redirectCommaList)
    const cs = contactsOf(msg)
    if (cs.wildcard) throw new Error("expected non-wildcard")
    expect(cs.contacts.map((c) => c.uri)).toEqual([
      "sip:bob@10.0.0.2:5060",
      "sip:bob@10.0.0.3:5060",
    ])
  })

  test("Contact: * is the wildcard variant; single accessor is undefined", () => {
    const msg = parse(registerWildcard)
    const cs = contactsOf(msg)
    expect(cs.wildcard).toBe(true)
    expect(firstContactUri(msg)).toBeUndefined()
  })

  test("a malformed contact anywhere in the list rejects the message", () => {
    expect(Result.isFailure(customParserRaw.parse(redirectBadSecondContact))).toBe(true)
  })

  test("Contact: * mixed with a real contact is rejected (must stand alone)", () => {
    expect(Result.isFailure(customParserRaw.parse(registerWildcardMixed))).toBe(true)
  })
})
