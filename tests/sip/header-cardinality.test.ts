/**
 * Header-cardinality enforcement (RFC 3261 §8.1.1 / §8.1.1.8 / §12.1.1).
 *
 * From, To, Call-ID and CSeq appear exactly once in every request and
 * response; a duplicate is rejected. Contact may repeat only where a list
 * is legal (3xx / 485 redirects, REGISTER and its responses); elsewhere a
 * second Contact — or the REGISTER-only `*` wildcard — is rejected.
 *
 * Absence of a Contact is NOT a parser error (it is a UA-level semantic):
 * RFC 4475 §3.1.1 carries valid Contact-less INVITEs, and the parser must
 * not drop them. That presence rule belongs at the handler, as a 400.
 */

import { describe, test, expect } from "vitest"
import { Result } from "effect"

import { customParser as customParserRaw } from "../../src/sip/parsers/custom/index.js"
import { sipMsg } from "./fixtures/rfc4475-valid.js"

const rejects = (b: Buffer) => Result.isFailure(customParserRaw.parse(b))
const accepts = (b: Buffer) => Result.isSuccess(customParserRaw.parse(b))

const dupFromRequest = sipMsg`INVITE sip:bob@example.test SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-dupfrom
Max-Forwards: 70
From: <sip:alice@example.test>;tag=a
From: <sip:eve@example.test>;tag=e
To: <sip:bob@example.test>
Call-ID: dup-from-req
CSeq: 1 INVITE
Contact: <sip:alice@10.0.0.1:5060>
Content-Length: 0

`

const dupToRequest = sipMsg`INVITE sip:bob@example.test SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-dupto
Max-Forwards: 70
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>
To: <sip:carol@example.test>
Call-ID: dup-to-req
CSeq: 1 INVITE
Contact: <sip:alice@10.0.0.1:5060>
Content-Length: 0

`

const dupCallIdRequest = sipMsg`INVITE sip:bob@example.test SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-dupcid
Max-Forwards: 70
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>
Call-ID: dup-cid-1
Call-ID: dup-cid-2
CSeq: 1 INVITE
Contact: <sip:alice@10.0.0.1:5060>
Content-Length: 0

`

const dupCseqRequest = sipMsg`INVITE sip:bob@example.test SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-dupcseq
Max-Forwards: 70
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>
Call-ID: dup-cseq-req
CSeq: 1 INVITE
CSeq: 2 INVITE
Contact: <sip:alice@10.0.0.1:5060>
Content-Length: 0

`

const dupFromResponse = sipMsg`SIP/2.0 200 OK
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-dupfromresp
From: <sip:alice@example.test>;tag=a
From: <sip:eve@example.test>;tag=e
To: <sip:bob@example.test>;tag=b
Call-ID: dup-from-resp
CSeq: 1 INVITE
Contact: <sip:bob@10.0.0.2:5060>
Content-Length: 0

`

const multiContactInvite = sipMsg`INVITE sip:bob@example.test SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-multic
Max-Forwards: 70
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>
Call-ID: multi-contact-invite
CSeq: 1 INVITE
Contact: <sip:alice@10.0.0.1:5060>
Contact: <sip:alice@10.0.0.9:5060>
Content-Length: 0

`

const multiContactOk = sipMsg`SIP/2.0 200 OK
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-multiok
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>;tag=b
Call-ID: multi-contact-ok
CSeq: 1 INVITE
Contact: <sip:bob@10.0.0.2:5060>
Contact: <sip:bob@10.0.0.3:5060>
Content-Length: 0

`

const wildcardInvite = sipMsg`INVITE sip:bob@example.test SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-wcinv
Max-Forwards: 70
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>
Call-ID: wildcard-invite
CSeq: 1 INVITE
Contact: *
Content-Length: 0

`

// Allowed: 302 may list redirect targets; REGISTER may list bindings.
const redirectMultiContact = sipMsg`SIP/2.0 302 Moved Temporarily
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-302list
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>;tag=b
Call-ID: redirect-list
CSeq: 1 INVITE
Contact: <sip:bob@10.0.0.2:5060>;q=0.8
Contact: <sip:bob@10.0.0.3:5060>;q=0.5
Content-Length: 0

`

const registerMultiContact = sipMsg`REGISTER sip:registrar.example.test SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-reglist
Max-Forwards: 70
From: <sip:alice@example.test>;tag=a
To: <sip:alice@example.test>
Call-ID: register-list
CSeq: 1 REGISTER
Contact: <sip:alice@10.0.0.1:5060>
Contact: <sip:alice@10.0.0.2:5060>
Content-Length: 0

`

// Regression: a single-everything INVITE and a contactless INVITE both parse.
const cleanInvite = sipMsg`INVITE sip:bob@example.test SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-clean
Max-Forwards: 70
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>
Call-ID: clean-invite
CSeq: 1 INVITE
Contact: <sip:alice@10.0.0.1:5060>
Content-Length: 0

`

const contactlessInvite = sipMsg`INVITE sip:bob@example.test SIP/2.0
Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-nocontact
Max-Forwards: 70
From: <sip:alice@example.test>;tag=a
To: <sip:bob@example.test>
Call-ID: contactless-invite
CSeq: 1 INVITE
Content-Length: 0

`

describe("Header cardinality — exactly-once headers", () => {
  test("duplicate From is rejected (request)", () => {
    expect(rejects(dupFromRequest)).toBe(true)
  })
  test("duplicate To is rejected (request)", () => {
    expect(rejects(dupToRequest)).toBe(true)
  })
  test("duplicate Call-ID is rejected (request)", () => {
    expect(rejects(dupCallIdRequest)).toBe(true)
  })
  test("duplicate CSeq is rejected (request)", () => {
    expect(rejects(dupCseqRequest)).toBe(true)
  })
  test("duplicate From is rejected in a response too", () => {
    expect(rejects(dupFromResponse)).toBe(true)
  })
})

describe("Header cardinality — Contact", () => {
  test("multiple Contact in an INVITE is rejected", () => {
    expect(rejects(multiContactInvite)).toBe(true)
  })
  test("multiple Contact in a 200-to-INVITE is rejected", () => {
    expect(rejects(multiContactOk)).toBe(true)
  })
  test("Contact: * in a non-REGISTER request is rejected", () => {
    expect(rejects(wildcardInvite)).toBe(true)
  })
  test("multiple Contact in a 302 redirect is allowed", () => {
    expect(accepts(redirectMultiContact)).toBe(true)
  })
  test("multiple Contact in a REGISTER is allowed", () => {
    expect(accepts(registerMultiContact)).toBe(true)
  })
})

describe("Header cardinality — regression", () => {
  test("a clean single-everything INVITE still parses", () => {
    expect(accepts(cleanInvite)).toBe(true)
  })
  test("a Contact-less INVITE is NOT rejected by the parser (presence is a handler concern)", () => {
    expect(accepts(contactlessInvite)).toBe(true)
  })
})
