/**
 * Well-formed RFC 3261 header fixtures used to assert that the strict lazy
 * parsers ACCEPT canonical inputs. Pairs with the strict re-parse path in
 * parser-compliance.test.ts — when these fixtures regress, the strict
 * parsers have drifted into "reject everything".
 */

import { sipMsg } from "./rfc4475-valid.js"

// RFC 3261 §20.17 Date: RFC 1123 form, GMT timezone (the only one RFC 3261 allows).
export const dateGmt = sipMsg`OPTIONS sip:user@example.com SIP/2.0
Via: SIP/2.0/UDP host.example.com;branch=z9hG4bKgoodDate
Max-Forwards: 70
From: <sip:caller@example.com>;tag=11
To: <sip:user@example.com>
Call-ID: gooddate.123@example.com
CSeq: 1 OPTIONS
Date: Fri, 01 Jan 2010 16:00:00 GMT
Content-Length: 0

`

// RFC 3261 §20.20 From with quoted display name + name-addr.
export const fromQuotedDisplay = sipMsg`OPTIONS sip:user@example.com SIP/2.0
Via: SIP/2.0/UDP host.example.com;branch=z9hG4bKquoted
Max-Forwards: 70
From: "Alice Liddell" <sip:alice@example.com>;tag=42
To: <sip:user@example.com>
Call-ID: quoted.1@example.com
CSeq: 1 OPTIONS
Content-Length: 0

`

// RFC 3261 §20.20 From with unquoted token display name.
export const fromTokenDisplay = sipMsg`OPTIONS sip:user@example.com SIP/2.0
Via: SIP/2.0/UDP host.example.com;branch=z9hG4bKtoken
Max-Forwards: 70
From: Alice <sip:alice@example.com>;tag=43
To: <sip:user@example.com>
Call-ID: token.1@example.com
CSeq: 1 OPTIONS
Content-Length: 0

`

// RFC 3261 §20.10 Contact in canonical name-addr form, no LWS inside `<>`.
export const contactNameAddr = sipMsg`REGISTER sip:example.com SIP/2.0
Via: SIP/2.0/UDP host.example.com;branch=z9hG4bKcontact
Max-Forwards: 70
From: <sip:alice@example.com>;tag=44
To: <sip:alice@example.com>
Call-ID: contact.1@example.com
CSeq: 1 REGISTER
Contact: <sip:alice@host.example.com>;expires=3600
Content-Length: 0

`

// RFC 3261 §20.10 Contact as bare addr-spec (no params, no embedded headers).
export const contactBareUri = sipMsg`REGISTER sip:example.com SIP/2.0
Via: SIP/2.0/UDP host.example.com;branch=z9hG4bKbare
Max-Forwards: 70
From: <sip:alice@example.com>;tag=45
To: <sip:alice@example.com>
Call-ID: bare.1@example.com
CSeq: 1 REGISTER
Contact: sip:alice@host.example.com
Content-Length: 0

`
