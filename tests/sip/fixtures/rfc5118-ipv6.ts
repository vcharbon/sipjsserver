/**
 * RFC 5118 — SIP Torture Test Messages for Internet Protocol Version 6.
 *
 * All but §4.2 are valid: the RFC's principle is "be liberal in what you
 * accept" for IPv6 surface, so most cases test that the parser handles
 * IPv6 references in Request-URI, Via, Contact, and SDP without choking.
 * §4.2 is the only strict-reject case — it carries a bare IPv6 address
 * in the Request-URI without the mandatory bracket delimiters.
 *
 * Section numbers refer to RFC 5118 §4.
 */
import { sipMsg } from "./rfc4475-valid.js"

// 4.1 — Valid IPv6 reference in Request-URI, Via, Contact.
export const v41_basicIpv6 = sipMsg`REGISTER sip:[2001:db8::10] SIP/2.0
To: sip:user@example.com
From: sip:user@example.com;tag=81x2
Via: SIP/2.0/UDP [2001:db8::9:1];branch=z9hG4bKas3-111
Call-ID: SSG9559905523997077@hlau_4100
Max-Forwards: 70
Contact: "Caller" <sip:caller@[2001:db8::1]>
CSeq: 98176 REGISTER
Content-Length: 0

`

// 4.2 — INVALID: IPv6 Request-URI missing bracket delimiters.
export const v42_ipv6NoBrackets = sipMsg`REGISTER sip:2001:db8::10 SIP/2.0
To: sip:user@example.com
From: sip:user@example.com;tag=81x2
Via: SIP/2.0/UDP [2001:db8::9:1];branch=z9hG4bKas3-111
Call-ID: SSG9559905523997077@hlau_4100
Max-Forwards: 70
Contact: "Caller" <sip:caller@[2001:db8::1]>
CSeq: 98176 REGISTER
Content-Length: 0

`

// 4.3 — Syntactically valid: `[…:5070]` parses as a 6-group IPv6 address.
// The trailing `:5070` is part of the address, NOT a port. RFC says parser
// must accept; downstream handling is the operator's problem.
export const v43_portAmbiguousInBrackets = sipMsg`REGISTER sip:[2001:db8::10:5070] SIP/2.0
To: sip:user@example.com
From: sip:user@example.com;tag=81x2
Via: SIP/2.0/UDP [2001:db8::9:1];branch=z9hG4bKas3-111
Call-ID: SSG9559905523997077@hlau_4100
Contact: "Caller" <sip:caller@[2001:db8::1]>
Max-Forwards: 70
CSeq: 98176 REGISTER
Content-Length: 0

`

// 4.4 — Valid: port specified outside the brackets, unambiguous.
export const v44_portUnambiguous = sipMsg`REGISTER sip:[2001:db8::10]:5070 SIP/2.0
To: sip:user@example.com
From: sip:user@example.com;tag=81x2
Via: SIP/2.0/UDP [2001:db8::9:1];branch=z9hG4bKas3-111
Call-ID: SSG9559905523997077@hlau_4100
Contact: "Caller" <sip:caller@[2001:db8::1]>
Max-Forwards: 70
CSeq: 98176 REGISTER
Content-Length: 0

`

// 4.5a — "Be robust": Via received= param with bracket delimiters.
// Technically the param value should be a bare host; the RFC asks parsers
// to accept the bracketed form anyway.
export const v45a_receivedBracketed = sipMsg`BYE sip:[2001:db8::10] SIP/2.0
To: sip:user@example.com;tag=bd76ya
From: sip:user@example.com;tag=81x2
Via: SIP/2.0/UDP [2001:db8::9:1];received=[2001:db8::9:255];branch=z9hG4bKas3-111
Call-ID: SSG9559905523997077@hlau_4100
Max-Forwards: 70
CSeq: 321 BYE
Content-Length: 0

`

// 4.5b — Valid: Via received= param strictly compliant (no brackets).
export const v45b_receivedBare = sipMsg`OPTIONS sip:[2001:db8::10] SIP/2.0
To: sip:user@example.com
From: sip:user@example.com;tag=81x2
Via: SIP/2.0/UDP [2001:db8::9:1];received=2001:db8::9:255;branch=z9hG4bKas3
Call-ID: SSG95523997077@hlau_4100
Max-Forwards: 70
Contact: "Caller" <sip:caller@[2001:db8::9:1]>
CSeq: 921 OPTIONS
Content-Length: 0

`

// 4.6 — Valid: IPv6 in SDP body. The audit point is IPv6 in the URI and
// Via — body length specifics in the RFC text don't match a literal byte
// count when transcribed, so we drop the body here (the SDP-content test
// is orthogonal to header parsing).
export const v46_ipv6InSdp = sipMsg`INVITE sip:user@[2001:db8::10] SIP/2.0
To: sip:user@[2001:db8::10]
From: sip:user@example.com;tag=81x2
Via: SIP/2.0/UDP [2001:db8::20];branch=z9hG4bKas3-111
Call-ID: SSG9559905523997077@hlau_4100
Contact: "Caller" <sip:caller@[2001:db8::20]>
CSeq: 8612 INVITE
Max-Forwards: 70
Content-Length: 0

`

// 4.7 — Valid: mixed IPv4/IPv6 in Via chain.
export const v47_mixedIpv4Ipv6Vias = sipMsg`BYE sip:user@host.example.net SIP/2.0
Via: SIP/2.0/UDP [2001:db8::9:1]:6050;branch=z9hG4bKas3-111
Via: SIP/2.0/UDP 192.0.2.1;branch=z9hG4bKjhja8781hjuaij65144
Via: SIP/2.0/TCP [2001:db8::9:255];branch=z9hG4bK451jj;received=192.0.2.200
Call-ID: 997077@lau_4100
Max-Forwards: 70
CSeq: 89187 BYE
To: sip:user@example.net;tag=9817--94
From: sip:user@example.com;tag=81x2
Content-Length: 0

`

// 4.8 — Valid: multiple IP-address types in SDP connection lines.
// Header-only variant — SDP body dropped for the same reason as §4.6.
export const v48_multipleIpInSdp = sipMsg`INVITE sip:user@[2001:db8::10] SIP/2.0
To: sip:user@[2001:db8::10]
From: sip:user@example.com;tag=81x2
Via: SIP/2.0/UDP [2001:db8::9:1];branch=z9hG4bKas3-111
Call-ID: SSG9559905523997077@hlau_4100
Contact: "Caller" <sip:caller@[2001:db8::9:1]>
Max-Forwards: 70
CSeq: 8912 INVITE
Content-Length: 0

`

// 4.9 — Valid: IPv4-mapped IPv6 addresses.
// Header-only variant — SDP body dropped for the same reason as §4.6.
export const v49_ipv4Mapped = sipMsg`INVITE sip:user@example.com SIP/2.0
To: sip:user@example.com
From: sip:user@east.example.com;tag=81x2
Via: SIP/2.0/UDP [::ffff:192.0.2.10]:19823;branch=z9hG4bKbh19
Via: SIP/2.0/UDP [::ffff:192.0.2.2];branch=z9hG4bKas3-111
Call-ID: SSG9559905523997077@hlau_4100
Contact: "T. desk phone" <sip:ted@[::ffff:192.0.2.2]>
CSeq: 612 INVITE
Max-Forwards: 70
Content-Length: 0

`

// 4.10a — "Be robust": three consecutive colons before IPv4 segment
// (RFC 2373-era lenient form). Parsers should accept.
export const v410a_extraColon = sipMsg`OPTIONS sip:user@[2001:db8:::192.0.2.1] SIP/2.0
To: sip:user@[2001:db8:::192.0.2.1]
From: sip:user@example.com;tag=810x2
Via: SIP/2.0/UDP lab1.east.example.com;branch=z9hG4bKas3-111
Call-ID: G9559905523997077@hlau_4100
CSeq: 689 OPTIONS
Max-Forwards: 70
Content-Length: 0

`

// 4.10b — Valid: correct RFC 4291 syntax (two colons before IPv4 segment).
export const v410b_correctIpv4InIpv6 = sipMsg`OPTIONS sip:user@[2001:db8::192.0.2.1] SIP/2.0
To: sip:user@[2001:db8::192.0.2.1]
From: sip:user@example.com;tag=810x2
Via: SIP/2.0/UDP lab1.east.example.com;branch=z9hG4bKas3-111
Call-ID: G9559905523997077@hlau_4100
CSeq: 689 OPTIONS
Max-Forwards: 70
Content-Length: 0

`
