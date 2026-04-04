/**
 * RFC 4475 Section 3.1.2 — Syntactically invalid SIP messages.
 *
 * These messages contain syntax errors that a strict parser SHOULD reject.
 * JsSIP may accept some of them — tests document which ones.
 */

import { sipMsg } from "./rfc4475-valid.js"

// ---------------------------------------------------------------------------
// 3.1.2.1 — Extraneous Header Field Separators (badinv01)
//
// Extra semicolons/commas in Via and Contact parameters.
// ---------------------------------------------------------------------------

export const extraneousSeparators = sipMsg`INVITE sip:user@example.com SIP/2.0
To: sip:j.user@example.com
From: sip:caller@example.net;tag=134161461246
Max-Forwards: 7
Call-ID: badinv01.0ha0isndaksdjasdf3234nas
CSeq: 8 INVITE
Via: SIP/2.0/UDP 192.0.2.15;;,;,,
Contact: "Joe" <sip:joe@example.org>;;;;
Content-Length: 152
Content-Type: application/sdp

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.15
s=-
c=IN IP4 192.0.2.15
t=0 0
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.2.2 — Content Length Larger Than Message (clerr)
//
// Content-Length claims 9999 but actual body is ~150 bytes.
// ---------------------------------------------------------------------------

export const contentLengthTooLarge = sipMsg`INVITE sip:user@example.com SIP/2.0
Max-Forwards: 80
To: sip:j.user@example.com
From: sip:caller@example.net;tag=93942939o2
Contact: <sip:caller@hungry.example.net>
Call-ID: clerr.0ha0isndaksdjweiafasdk3
CSeq: 8 INVITE
Via: SIP/2.0/UDP host5.example.com;branch=z9hG4bK-39234-23523
Content-Type: application/sdp
Content-Length: 9999

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.155
s=-
c=IN IP4 192.0.2.155
t=0 0
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.2.3 — Negative Content-Length (ncl)
//
// Content-Length: -999 is not a valid value.
// ---------------------------------------------------------------------------

export const negativeContentLength = sipMsg`INVITE sip:user@example.com SIP/2.0
Max-Forwards: 254
To: sip:j.user@example.com
From: sip:caller@example.net;tag=32394234
Call-ID: ncl.0ha0isndaksdj2193423r542w35
CSeq: 0 INVITE
Via: SIP/2.0/UDP 192.0.2.53;branch=z9hG4bKkdjuw
Contact: <sip:caller@example53.example.net>
Content-Type: application/sdp
Content-Length: -999

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.53
s=-
c=IN IP4 192.0.2.53
t=0 0
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.2.4 — Request Scalar Fields with Overlarge Values (scalar02)
//
// CSeq: 36893488147419103232 overflows 32-bit unsigned.
// Max-Forwards: 300 exceeds 255 limit.
// ---------------------------------------------------------------------------

export const overlargRequestScalars = sipMsg`REGISTER sip:example.com SIP/2.0
Via: SIP/2.0/TCP host129.example.com;branch=z9hG4bK342sdfoi3
To: <sip:user@example.com>
From: <sip:user@example.com>;tag=239232jh3
CSeq: 36893488147419103232 REGISTER
Call-ID: scalar02.23o0pd9vanlq3wnrlnewofjas9ui32
Max-Forwards: 300
Expires: 10000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
Contact: <sip:user@host129.example.com>;expires=280297596632815
Content-Length: 0

`

// ---------------------------------------------------------------------------
// 3.1.2.5 — Response Scalar Fields with Overlarge Values (scalarlg)
//
// CSeq number and Retry-After exceed 32-bit.
// Warning code 1812 is out of range (must be 100-699).
// ---------------------------------------------------------------------------

export const overlargResponseScalars = sipMsg`SIP/2.0 503 Service Unavailable
Via: SIP/2.0/TCP host129.example.com;branch=z9hG4bKzzxdiwo34sw;received=192.0.2.129
To: <sip:user@example.com>
From: <sip:other@example.net>;tag=2easdjfejw
CSeq: 9292394834772304023312 OPTIONS
Call-ID: scalarlg.noase0of0234hn2qofoaf0232aewf2394r
Retry-After: 949302838503028349304023988
Warning: 1812 overture "In Progress"
Content-Length: 0

`

// ---------------------------------------------------------------------------
// 3.1.2.6 — Unterminated Quoted String in Display Name (quotbal)
//
// To header has opening " but no closing ".
// ---------------------------------------------------------------------------

export const unterminatedQuotedString = sipMsg`INVITE sip:user@example.com SIP/2.0
To: "Mr. J. User <sip:j.user@example.com>
From: sip:caller@example.net;tag=93334
Max-Forwards: 10
Call-ID: quotbal.aksdj
Contact: <sip:caller@host59.example.net>
CSeq: 8 INVITE
Via: SIP/2.0/UDP 192.0.2.59:5050;branch=z9hG4bKkdjuw39234
Content-Type: application/sdp
Content-Length: 152

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.15
s=-
c=IN IP4 192.0.2.15
t=0 0
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.2.7 — <> Enclosing Request-URI (ltgtruri)
//
// Request-URI should not be enclosed in angle brackets.
// ---------------------------------------------------------------------------

export const angleBracketRequestUri = sipMsg`INVITE <sip:user@example.com> SIP/2.0
To: sip:user@example.com
From: sip:caller@example.net;tag=39291
Max-Forwards: 23
Call-ID: ltgtruri.1@192.0.2.5
CSeq: 1 INVITE
Via: SIP/2.0/UDP 192.0.2.5
Contact: <sip:caller@host5.example.net>
Content-Type: application/sdp
Content-Length: 159

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.5
s=-
c=IN IP4 192.0.2.5
t=3149328700 0
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.2.8 — Malformed SIP Request-URI with embedded LWS (lwsruri)
//
// Space before "lr" in Request-URI is illegal.
// ---------------------------------------------------------------------------

export const embeddedLwsInUri = sipMsg`INVITE sip:user@example.com; lr SIP/2.0
To: sip:user@example.com;tag=3xfe-9921883-z9f
From: sip:caller@example.net;tag=231413434
Max-Forwards: 5
Call-ID: lwsruri.asdfasdoeoi2323-asdfwrn23-asd834rk423
CSeq: 2130706432 INVITE
Via: SIP/2.0/UDP 192.0.2.1:5060;branch=z9hG4bKkdjuw2395
Contact: <sip:caller@host1.example.net>
Content-Type: application/sdp
Content-Length: 159

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.1
s=-
c=IN IP4 192.0.2.1
t=3149328700 0
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.2.9 — Multiple SP Separating Request-Line Elements (lwsstart)
//
// Double space between method, R-URI, and version.
// ---------------------------------------------------------------------------

export const multipleSPInRequestLine = sipMsg`INVITE  sip:user@example.com  SIP/2.0
Max-Forwards: 8
To: sip:user@example.com
From: sip:caller@example.net;tag=8814
Call-ID: lwsstart.dfknq234oi243099adsdfnawe3@example.com
CSeq: 1893884 INVITE
Via: SIP/2.0/UDP host1.example.com;branch=z9hG4bKkdjuw3923
Contact: <sip:caller@host1.example.net>
Content-Type: application/sdp
Content-Length: 150

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.1
s=-
c=IN IP4 192.0.2.1
t=0 0
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.2.10 — SP Characters at End of Request-Line (trws)
//
// Two trailing spaces after SIP/2.0 before CRLF.
// ---------------------------------------------------------------------------

export const trailingSpacesInRequestLine = sipMsg`OPTIONS sip:remote-target@example.com SIP/2.0
Via: SIP/2.0/TCP host1.example.com;branch=z9hG4bK299342093
To: <sip:remote-target@example.com>
From: <sip:local-resource@example.com>;tag=329429089
Call-ID: trws.oicu34958239neffasdhr2345r
Accept: application/sdp
CSeq: 238923 OPTIONS
Max-Forwards: 70
Content-Length: 0

`

// ---------------------------------------------------------------------------
// 3.1.2.11 — Escaped Headers in SIP Request-URI (escruri)
//
// Request-URI contains ?Route= query string with escaped headers.
// ---------------------------------------------------------------------------

export const escapedHeadersInUri = sipMsg`INVITE sip:user@example.com?Route=%3Csip:example.com%3E SIP/2.0
To: sip:user@example.com
From: sip:caller@example.net;tag=341518
Max-Forwards: 7
Contact: <sip:caller@host39923.example.net>
Call-ID: escruri.23940-asdfhj-aje3br-234q098w-fawerh2q-h4n5
CSeq: 149209342 INVITE
Via: SIP/2.0/UDP host-of-the-hour.example.com;branch=z9hG4bKkdjuw
Content-Type: application/sdp
Content-Length: 150

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.1
s=-
c=IN IP4 192.0.2.1
t=0 0
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.2.12 — Invalid Time Zone in Date Header (baddate)
//
// Date uses "EST" instead of required "GMT".
// ---------------------------------------------------------------------------

export const invalidTimezone = sipMsg`INVITE sip:user@example.com SIP/2.0
To: sip:user@example.com
From: sip:caller@example.net;tag=2234923
Max-Forwards: 70
Call-ID: baddate.239423mnsadf3j23lj42--sedfnm234
CSeq: 1392934 INVITE
Via: SIP/2.0/UDP host.example.com;branch=z9hG4bKkdjuw
Date: Fri, 01 Jan 2010 16:00:00 EST
Contact: <sip:caller@host5.example.net>
Content-Type: application/sdp
Content-Length: 150

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.5
s=-
c=IN IP4 192.0.2.5
t=0 0
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.2.13 — Failure to Enclose name-addr URI in <> (regbadct)
//
// Contact has escaped headers but no angle brackets.
// ---------------------------------------------------------------------------

export const unencloseNameAddr = sipMsg`REGISTER sip:example.com SIP/2.0
To: sip:user@example.com
From: sip:user@example.com;tag=998332
Max-Forwards: 70
Call-ID: regbadct.k345asrl3fdbv@10.0.0.1
CSeq: 1 REGISTER
Via: SIP/2.0/UDP 135.180.130.133:5060;branch=z9hG4bKkdjuw
Contact: sip:user@example.com?Route=%3Csip:sip.example.com%3E
l: 0

`

// ---------------------------------------------------------------------------
// 3.1.2.14 — Spaces within addr-spec (badaspec)
//
// To header has spaces inside the angle brackets around the URI.
// ---------------------------------------------------------------------------

export const spacesInAddrSpec = sipMsg`OPTIONS sip:user@example.org SIP/2.0
Via: SIP/2.0/UDP host4.example.com:5060;branch=z9hG4bKkdju43234
Max-Forwards: 70
From: "Bell, Alexander" <sip:a.g.bell@example.com>;tag=433423
To: "Watson, Thomas" < sip:t.watson@example.org >
Call-ID: badaspec.sdf0234n2nds0a099u23h3hnnw009cdkne3
Accept: application/sdp
CSeq: 3923239 OPTIONS
l: 0

`

// ---------------------------------------------------------------------------
// 3.1.2.15 — Non-token Characters in Display Name (baddn)
//
// Unquoted display name contains comma (not a valid token char).
// ---------------------------------------------------------------------------

export const nonTokenDisplayName = sipMsg`OPTIONS sip:t.watson@example.org SIP/2.0
Via:     SIP/2.0/UDP c.example.com:5060;branch=z9hG4bKkdjuw
Max-Forwards:      70
From:    Bell, Alexander <sip:a.g.bell@example.com>;tag=43
To:      Watson, Thomas <sip:t.watson@example.org>
Call-ID: baddn.31415@c.example.com
Accept: application/sdp
CSeq:    3923239 OPTIONS
l: 0

`

// ---------------------------------------------------------------------------
// 3.1.2.16 — Unknown Protocol Version (badvers)
//
// SIP/7.0 instead of SIP/2.0.
// ---------------------------------------------------------------------------

export const unknownProtocolVersion = sipMsg`OPTIONS sip:t.watson@example.org SIP/7.0
Via:     SIP/7.0/UDP c.example.com;branch=z9hG4bKkdjuw
Max-Forwards:     70
From:    A. Bell <sip:a.g.bell@example.com>;tag=qweoiqpe
To:      T. Watson <sip:t.watson@example.org>
Call-ID: badvers.31417@c.example.com
CSeq:    1 OPTIONS
l: 0

`

// ---------------------------------------------------------------------------
// 3.1.2.17 — Start Line and CSeq Method Mismatch (mismatch01)
//
// Request line says OPTIONS but CSeq says INVITE.
// ---------------------------------------------------------------------------

export const methodMismatch = sipMsg`OPTIONS sip:user@example.com SIP/2.0
To: sip:j.user@example.com
From: sip:caller@example.net;tag=34525
Max-Forwards: 6
Call-ID: mismatch01.dj0234sxdfl3
CSeq: 8 INVITE
Via: SIP/2.0/UDP host.example.com;branch=z9hG4bKkdjuw
l: 0

`

// ---------------------------------------------------------------------------
// 3.1.2.18 — Unknown Method with CSeq Method Mismatch (mismatch02)
//
// Request line says NEWMETHOD but CSeq says INVITE.
// ---------------------------------------------------------------------------

export const unknownMethodMismatch = sipMsg`NEWMETHOD sip:user@example.com SIP/2.0
To: sip:j.user@example.com
From: sip:caller@example.net;tag=34525
Max-Forwards: 6
Call-ID: mismatch02.dj0234sxdfl3
CSeq: 8 INVITE
Contact: <sip:caller@host.example.net>
Via: SIP/2.0/UDP host.example.net;branch=z9hG4bKkdjuw
Content-Type: application/sdp
l: 138

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.1
c=IN IP4 192.0.2.1
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.2.19 — Overlarge Response Code (bigcode)
//
// Status code 4294967301 overflows standard 3-digit range.
// ---------------------------------------------------------------------------

export const overlargeResponseCode = sipMsg`SIP/2.0 4294967301 better not break the receiver
Via: SIP/2.0/UDP 192.0.2.105;branch=z9hG4bK2398ndaoe
Call-ID: bigcode.asdof3uj203asdnf3429uasdhfas3ehjasdfas9i
CSeq: 353494 INVITE
From: <sip:user@example.com>;tag=39ansfi3
To: <sip:user@example.edu>;tag=902jndnke3
Content-Length: 0
Contact: <sip:user@host105.example.com>

`
