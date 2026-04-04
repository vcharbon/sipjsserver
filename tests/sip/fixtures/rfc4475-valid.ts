/**
 * RFC 4475 Section 3.1.1 — Valid SIP messages (torture tests).
 *
 * Each message exercises edge cases that a conformant parser MUST accept.
 * The sipMsg helper converts LF→CRLF for SIP wire format.
 */

/** Convert LF line endings to CRLF as required by SIP wire format. */
export function sipMsg(strings: TemplateStringsArray, ...values: unknown[]): Buffer {
  const raw = String.raw(strings, ...values)
  const crlf = raw.replace(/\r?\n/g, "\r\n")
  return Buffer.from(crlf, "utf-8")
}

// ---------------------------------------------------------------------------
// 3.1.1.1 — A Short Tortuous INVITE (wsinv)
//
// Exercises: header folding, compact forms (s, v, m, l), unusual whitespace,
// escaped chars in display name, mixed-case header names, unknown params.
// ---------------------------------------------------------------------------

export const shortTorturousInvite = sipMsg`INVITE sip:vivekg@chair-dnrc.example.com;unknownparam SIP/2.0
TO :
 sip:vivekg@chair-dnrc.example.com ;   tag    = 1918181833n
from   : "J Rosenberg \\\""       <sip:jdrosen@example.com>
  ;
  tag = 98asjd8
MaX-fOrWaRdS: 0068
Call-ID: wsinv.ndaksdj@192.0.2.1
Content-Length   : 150
cseq: 0009
  INVITE
Via  : SIP  /   2.0
 /UDP
    192.0.2.2;branch=390skdjuw
s :
NewFangledHeader:   newfangled value
 continued newfangled value
UnknownHeaderWithUnusualValue: ;;,,;;,;
Content-Type: application/sdp
Route:
 <sip:services.example.com;lr;unknownwith=value;unknown-no-value>
v:  SIP  / 2.0  / TCP     spindle.example.com   ;
  branch  =   z9hG4bK9ikj8  ,
 SIP  /    2.0   / UDP  192.168.255.111   ; branch=
 z9hG4bK30239
m:"Quoted string \\"\\""  <sip:jdrosen@example.com> ; newparam =
      newvalue ;
  secondparam ; q = 0.33

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.3
s=-
c=IN IP4 192.0.2.4
t=0 0
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.1.2 — Wide Range of Valid Characters (intmeth)
//
// Exercises: non-alpha tokens in method, URIs, branch params, unusual
// display names, UTF-8 in header values.
// ---------------------------------------------------------------------------

export const wideRangeValidChars = (() => {
  // The method and R-URI contain unusual but valid token chars
  // UTF-8 bytes in To display name and extension header
  const toDisplayName = Buffer.from([0x07]) // BEL
  const nulByte = Buffer.from([0x00]) // NUL
  const delByte = Buffer.from([0x7f]) // DEL
  const fromParamUtf8 = Buffer.from("работающий", "utf-8")
  const extHeaderUtf8 = Buffer.from([0xef, 0xbb, 0xbf, 0xe5, 0xa4, 0xa7, 0xe5, 0x81, 0x9c, 0xe9, 0x9b, 0xbb])

  const msg = sipMsg`!interesting-Method0123456789_*+\`.\%indeed'~ sip:1_unusual.URI~(to-be!sure)&isn't+it$/crazy?,/;;*:&it+has=1,weird!*pas$wo~d_too.(doesn't-it)@example.com SIP/2.0
Via: SIP/2.0/TCP host1.example.com;branch=z9hG4bK-.!%66*_+\`'~
To: "BEL: NUL: DEL:" <sip:1_unusual.URI~(to-be!sure)&isn't+it$/crazy?,/;;*@example.com>
From: token1~\` token2'+_ token3*%!.- <sip:mundane@example.com>;fromParam''~+*_!.-%="working";tag=_token~1'+\`*%!-.
Call-ID: intmeth.word%ZK-!.*_+'@word\`~)(><:\\/"][?}{
CSeq: 139122385 !interesting-Method0123456789_*+\`.\%indeed'~
Max-Forwards: 255
extensionHeader-!.%*+_\`'~: value
Content-Length: 0

`
  return msg
})()

// ---------------------------------------------------------------------------
// 3.1.1.3 — Valid Use of the % Escaping Mechanism (esc01)
//
// Exercises: percent-hex-hex encoding in Request-URI, To, From, Contact.
// ---------------------------------------------------------------------------

export const validPercentEscaping = sipMsg`INVITE sip:sips%3Auser%40example.com@example.net SIP/2.0
To: sip:%75se%72@example.com
From: <sip:I%20have%20spaces@example.net>;tag=938
Max-Forwards: 87
i: esc01.239409asdfakjkn23onasd0-3234
CSeq: 234234 INVITE
Via: SIP/2.0/UDP host5.example.net;branch=z9hG4bKkdjuw
C: application/sdp
Contact:
  <sip:cal%6Cer@host5.example.net;%6C%72;n%61me=v%61lue%25%34%31>
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
// 3.1.1.4 — Escaped Nulls in URIs (escnull)
//
// Exercises: %00 (null) in URI user parts. Parser must not prematurely
// terminate the string.
// ---------------------------------------------------------------------------

export const escapedNulls = sipMsg`REGISTER sip:example.com SIP/2.0
To: sip:null-%00-null@example.com
From: sip:null-%00-null@example.com;tag=839923423
Max-Forwards: 70
Call-ID: escnull.39203ndfvkjdasfkq3w4otrq0adsfdfnavd
CSeq: 14398234 REGISTER
Via: SIP/2.0/UDP host5.example.com;branch=z9hG4bKkdjuw
Contact: <sip:%00@host5.example.com>
Contact: <sip:%00%00@host5.example.com>
L:0

`

// ---------------------------------------------------------------------------
// 3.1.1.5 — Use of % When It Is Not an Escape (esc02)
//
// Exercises: literal % in method name, display name, Via branch.
// The method is RE%47IST%45R (not REGISTER — % is literal, not escape).
// ---------------------------------------------------------------------------

export const percentNotEscape = sipMsg`RE%47IST%45R sip:registrar.example.com SIP/2.0
To: "%Z%45" <sip:resource@example.com>
From: "%Z%45" <sip:resource@example.com>;tag=f232jadfj23
Call-ID: esc02.asdfnqwo34rq23i34jrjasdcnl23nrlknsdf
Via: SIP/2.0/TCP host.example.com;branch=z9hG4bK209%fzsnel234
CSeq: 29344 RE%47IST%45R
Max-Forwards: 70
Contact: <sip:alias1@host1.example.com>
C%6Fntact: <sip:alias2@host2.example.com>
Contact: <sip:alias3@host3.example.com>
l: 0

`

// ---------------------------------------------------------------------------
// 3.1.1.6 — No LWS between Display Name and < (lwsdisp)
//
// Exercises: display name immediately adjacent to < with no space.
// ---------------------------------------------------------------------------

export const noLwsBeforeAngleBracket = sipMsg`OPTIONS sip:user@example.com SIP/2.0
To: sip:user@example.com
From: caller<sip:caller@example.com>;tag=323
Max-Forwards: 70
Call-ID: lwsdisp.1234abcd@funky.example.com
CSeq: 60 OPTIONS
Via: SIP/2.0/UDP funky.example.com;branch=z9hG4bKkdjuw
l: 0

`

// ---------------------------------------------------------------------------
// 3.1.1.7 — Long Values in Header Fields (longreq)
//
// Exercises: extremely long header values, many Via entries with varied
// capitalization, long parameter names/values.
// ---------------------------------------------------------------------------

export const longValues = (() => {
  const extremeUser = "extreme".repeat(10)
  const longVal = "long".repeat(20)
  const longParamName = "name".repeat(25)
  const longParamValue = "long".repeat(25)
  const callerName = "amazinglylongcallername".repeat(5)
  const tagRepeat = "982".repeat(50)
  const unknownHdrParamName = "name".repeat(20)
  const unknownHdrParamValue = "value".repeat(15)
  const valuelessParamName = "paramname".repeat(10)
  const longCallId = "really".repeat(20)
  const unknownLongName = "Long".repeat(20)
  const unknownLongValue = "long".repeat(20)
  const unknownLongParam = "long".repeat(20)
  const longBranch = "long".repeat(50)

  return sipMsg`INVITE sip:user@example.com SIP/2.0
To: "I have a user name of ${extremeUser} proportion" <sip:user@example.com:6000;unknownparam1=very${longVal}value;longparam${longParamName}=shortvalue;very${longParamValue}ParameterNameWithNoValue>
F: sip:${callerName}@example.net;tag=12${tagRepeat}424;unknownheaderparam${unknownHdrParamName}=unknowheaderparam${unknownHdrParamValue};unknownValueless${valuelessParamName}
Call-ID: longreq.one${longCallId}longcallid
CSeq: 3882340 INVITE
Unknown-${unknownLongName}-Name: unknown-${unknownLongValue}-value;unknown-${unknownLongParam}-parameter-name=unknown-${unknownLongParam}-parameter-value
Via: SIP/2.0/TCP sip33.example.com
v: SIP/2.0/TCP sip32.example.com
V: SIP/2.0/TCP sip31.example.com
Via: SIP/2.0/TCP sip30.example.com
ViA: SIP/2.0/TCP sip29.example.com
VIa: SIP/2.0/TCP sip28.example.com
VIA: SIP/2.0/TCP sip27.example.com
via: SIP/2.0/TCP sip26.example.com
viA: SIP/2.0/TCP sip25.example.com
vIa: SIP/2.0/TCP sip24.example.com
vIA: SIP/2.0/TCP sip23.example.com
V :  SIP/2.0/TCP sip22.example.com
v :  SIP/2.0/TCP sip21.example.com
V  : SIP/2.0/TCP sip20.example.com
v  : SIP/2.0/TCP sip19.example.com
Via : SIP/2.0/TCP sip18.example.com
Via  : SIP/2.0/TCP sip17.example.com
Via: SIP/2.0/TCP sip16.example.com
Via: SIP/2.0/TCP sip15.example.com
Via: SIP/2.0/TCP sip14.example.com
Via: SIP/2.0/TCP sip13.example.com
Via: SIP/2.0/TCP sip12.example.com
Via: SIP/2.0/TCP sip11.example.com
Via: SIP/2.0/TCP sip10.example.com
Via: SIP/2.0/TCP sip9.example.com
Via: SIP/2.0/TCP sip8.example.com
Via: SIP/2.0/TCP sip7.example.com
Via: SIP/2.0/TCP sip6.example.com
Via: SIP/2.0/TCP sip5.example.com
Via: SIP/2.0/TCP sip4.example.com
Via: SIP/2.0/TCP sip3.example.com
Via: SIP/2.0/TCP sip2.example.com
Via: SIP/2.0/TCP sip1.example.com
Via: SIP/2.0/TCP host.example.com;received=192.0.2.5;branch=very${longBranch}branchvalue
Max-Forwards: 70
Contact: <sip:${callerName}@host5.example.net>
Content-Type: application/sdp
l: 150

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.1
s=-
c=IN IP4 192.0.2.1
t=0 0
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`
})()

// ---------------------------------------------------------------------------
// 3.1.1.8 — Extra Trailing Octets in a UDP Datagram (dblreq)
//
// Exercises: Content-Length: 0 means parser should stop at the blank line;
// the trailing INVITE is spurious data that should be ignored.
// ---------------------------------------------------------------------------

export const extraTrailingOctets = sipMsg`REGISTER sip:example.com SIP/2.0
To: sip:j.user@example.com
From: sip:j.user@example.com;tag=43251j3j324
Max-Forwards: 8
I: dblreq.0ha0isndaksdj99sdfafnl3lk233412
Contact: sip:j.user@host.example.com
CSeq: 8 REGISTER
Via: SIP/2.0/UDP 192.0.2.125;branch=z9hG4bKkdjuw23492
Content-Length: 0

INVITE sip:joe@example.com SIP/2.0
t: sip:joe@example.com
From: sip:caller@example.net;tag=141334
Max-Forwards: 8
Call-ID: dblreq.0ha0isnda977644900765@192.0.2.15
CSeq: 8 INVITE
Via: SIP/2.0/UDP 192.0.2.15;branch=z9hG4bKkdjuw380234
Content-Type: application/sdp
Content-Length: 150

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.15
s=-
c=IN IP4 192.0.2.15
t=0 0
m=audio 49217 RTP/AVP 0 12
m =video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.1.9 — Semicolon-Separated Parameters in URI User Part (semiuri)
//
// Exercises: semicolons in Request-URI user part with escaped @.
// ---------------------------------------------------------------------------

export const semicolonInUserPart = sipMsg`OPTIONS sip:user;par=u%40example.net@example.com SIP/2.0
To: sip:j_user@example.com
From: sip:caller@example.org;tag=33242
Max-Forwards: 3
Call-ID: semiuri.0ha0isndaksdj
CSeq: 8 OPTIONS
Accept: application/sdp, application/pkcs7-mime,
        multipart/mixed, multipart/signed,
        message/sip, message/sipfrag
Via: SIP/2.0/UDP 192.0.2.1;branch=z9hG4bKkdjuw
l: 0

`

// ---------------------------------------------------------------------------
// 3.1.1.10 — Varied and Unknown Transport Types (transports)
//
// Exercises: UDP, SCTP, TLS, UNKNOWN, TCP in Via headers.
// ---------------------------------------------------------------------------

export const variedTransports = sipMsg`OPTIONS sip:user@example.com SIP/2.0
To: sip:user@example.com
From: <sip:caller@example.com>;tag=323
Max-Forwards: 70
Call-ID:  transports.kijh4akdnaqjkwendsasfdj
Accept: application/sdp
CSeq: 60 OPTIONS
Via: SIP/2.0/UDP t1.example.com;branch=z9hG4bKkdjuw
Via: SIP/2.0/SCTP t2.example.com;branch=z9hG4bKklasjdhf
Via: SIP/2.0/TLS t3.example.com;branch=z9hG4bK2980unddj
Via: SIP/2.0/UNKNOWN t4.example.com;branch=z9hG4bKasd0f3en
Via: SIP/2.0/TCP t5.example.com;branch=z9hG4bK0a9idfnee
l: 0

`

// ---------------------------------------------------------------------------
// 3.1.1.11 — Multipart MIME Message (multi)
//
// Exercises: multipart/mixed body with text and binary S/MIME parts.
// Simplified: we use a text-only multipart body since the binary S/MIME
// content is not relevant for parser testing (Content-Length is what matters).
// ---------------------------------------------------------------------------

export const multipartMime = sipMsg`MESSAGE sip:kumiko@example.org SIP/2.0
Via: SIP/2.0/UDP 127.0.0.1:5070;branch=z9hG4bK-d87543-4dade06d0bdb11ee-1--d87543-;rport
Max-Forwards: 70
Route: <sip:127.0.0.1:5080>
Contact: <sip:fluffy@127.0.0.1:5070>
To: <sip:kumiko@example.org>
From: <sip:fluffy@example.com>;tag=2fb0dcc9
Call-ID: 3d9485ad0c49859b@Zmx1ZmZ5LW1hYy0xNi5sb2NhbA..
CSeq: 1 MESSAGE
Content-Type: multipart/mixed;boundary=7a9cbec02ceef655
Date: Sat, 15 Oct 2005 04:44:56 GMT
User-Agent: SIPimp.org/0.2.5 (curses)
Content-Length: 106

--7a9cbec02ceef655
Content-Type: text/plain
Content-Transfer-Encoding: binary

Hello
--7a9cbec02ceef655
Content-Type: text/plain

World
--7a9cbec02ceef655--
`

// ---------------------------------------------------------------------------
// 3.1.1.12 — Unusual Reason Phrase (unreason)
//
// Exercises: non-standard reason text with mathematical expression.
// The original RFC includes UTF-8 Cyrillic — we use ASCII for portability.
// ---------------------------------------------------------------------------

export const unusualReasonPhrase = sipMsg`SIP/2.0 200 = 2**3 * 5**2 (a]]oiw)
Via: SIP/2.0/UDP 192.0.2.198;branch=z9hG4bK1324923
Call-ID: unreason.1234ksdfak3j2erwedfsASdf
CSeq: 35 INVITE
From: sip:user@example.com;tag=11141343
To: sip:user@example.edu;tag=2229
Content-Length: 154
Content-Type: application/sdp
Contact: <sip:user@host198.example.com>

v=0
o=mhandley 29739 7272939 IN IP4 192.0.2.198
s=-
c=IN IP4 192.0.2.198
t=0 0
m=audio 49217 RTP/AVP 0 12
m=video 3227 RTP/AVP 31
a=rtpmap:31 LPC
`

// ---------------------------------------------------------------------------
// 3.1.1.13 — Empty Reason Phrase (noreason)
//
// Exercises: status line with no reason text (just "SIP/2.0 100 ").
// ---------------------------------------------------------------------------

export const emptyReasonPhrase = sipMsg`SIP/2.0 100
Via: SIP/2.0/UDP 192.0.2.105;branch=z9hG4bK2398ndaoe
Call-ID: noreason.asndj203insdf99223ndf
CSeq: 35 INVITE
From: <sip:user@example.com>;tag=39ansfi3
To: <sip:user@example.edu>;tag=902jndnke3
Content-Length: 0
Contact: <sip:user@host105.example.com>

`
