/**
 * SIP header parameter-grammar gap fixtures.
 *
 * Each case is a SIP message that is RFC-3261-grammar-invalid in a specific
 * parameter position (Via port, From/To tag, Via branch, URI port, etc.) but
 * was previously accepted by the custom parser. Every parser under test
 * SHOULD reject these; tracked per-parser leniency in the test file when
 * upstream parsers (jssip, sip-parser) don't agree.
 */
import { sipMsg } from "./rfc4475-valid.js"

// Via with port > 65535 — RFC 3261 §19.1.1 / RFC 3986 §3.2.3.
export const viaPortOverflow = sipMsg`INVITE sip:user@host SIP/2.0
Via: SIP/2.0/UDP example.com:99999;branch=z9hG4bK-foo
To: <sip:b@h>;tag=t
From: <sip:a@h>;tag=f
Call-ID: param-via-port-overflow
CSeq: 1 INVITE
Max-Forwards: 70
Content-Length: 0

`

// Via with port = 0 — reserved per IANA; never valid in SIP.
export const viaPortZero = sipMsg`INVITE sip:user@host SIP/2.0
Via: SIP/2.0/UDP example.com:0;branch=z9hG4bK-foo
To: <sip:b@h>;tag=t
From: <sip:a@h>;tag=f
Call-ID: param-via-port-zero
CSeq: 1 INVITE
Max-Forwards: 70
Content-Length: 0

`

// Request-URI with port > 65535.
export const requestUriPortOverflow = sipMsg`INVITE sip:user@host:99999 SIP/2.0
Via: SIP/2.0/UDP example.com;branch=z9hG4bK-foo
To: <sip:b@h>;tag=t
From: <sip:a@h>;tag=f
Call-ID: param-ruri-port-overflow
CSeq: 1 INVITE
Max-Forwards: 70
Content-Length: 0

`

// Empty branch value — RFC 3261 §8.1.1.7 requires the branch token to be
// present and begin with "z9hG4bK".
export const viaEmptyBranch = sipMsg`INVITE sip:user@host SIP/2.0
Via: SIP/2.0/UDP example.com;branch=
To: <sip:b@h>;tag=t
From: <sip:a@h>;tag=f
Call-ID: param-via-empty-branch
CSeq: 1 INVITE
Max-Forwards: 70
Content-Length: 0

`

// Empty From tag — RFC 3261 §19.3 says `tag` is the dialog identifier;
// an empty value can confuse dialog matching.
export const fromEmptyTag = sipMsg`INVITE sip:user@host SIP/2.0
Via: SIP/2.0/UDP example.com;branch=z9hG4bK-foo
To: <sip:b@h>;tag=t
From: <sip:a@h>;tag=
Call-ID: param-from-empty-tag
CSeq: 1 INVITE
Max-Forwards: 70
Content-Length: 0

`

// Duplicate From tag — RFC 3261 grammar permits only one tag per
// From/To header. Two values is ambiguous (which one identifies the dialog?).
export const fromDuplicateTag = sipMsg`INVITE sip:user@host SIP/2.0
Via: SIP/2.0/UDP example.com;branch=z9hG4bK-foo
To: <sip:b@h>;tag=t
From: <sip:a@h>;tag=aaa;tag=bbb
Call-ID: param-from-duplicate-tag
CSeq: 1 INVITE
Max-Forwards: 70
Content-Length: 0

`

// Trailing non-digit characters after a port — `:8080xyz` is ambiguous
// (is it port 8080, or a malformed authority component?). The current
// parser silently truncates at the first non-digit, producing port=8080
// and discarding `xyz`. That is the kind of "lenient accept" that lets
// SIP-aware ALG confusion attacks slip through.
export const viaPortTrailingGarbage = sipMsg`INVITE sip:user@host SIP/2.0
Via: SIP/2.0/UDP example.com:8080xyz;branch=z9hG4bK-foo
To: <sip:b@h>;tag=t
From: <sip:a@h>;tag=f
Call-ID: param-via-port-trailing-garbage
CSeq: 1 INVITE
Max-Forwards: 70
Content-Length: 0

`

// Request-URI without a host portion — `sip:user@` is grammar-invalid
// per RFC 3261 §19.1.1 (host is mandatory in addr-spec).
export const requestUriNoHost = sipMsg`INVITE sip:user@ SIP/2.0
Via: SIP/2.0/UDP example.com;branch=z9hG4bK-foo
To: <sip:b@h>;tag=t
From: <sip:a@h>;tag=f
Call-ID: param-ruri-no-host
CSeq: 1 INVITE
Max-Forwards: 70
Content-Length: 0

`

// IPv6 reference without closing bracket — `[::1` rather than `[::1]`.
// Lenient parsers swallow everything after `[` as the host string, which
// hands an attacker a way to smuggle bytes into header-stored state.
export const requestUriIpv6Unclosed = sipMsg`INVITE sip:user@[::1 SIP/2.0
Via: SIP/2.0/UDP example.com;branch=z9hG4bK-foo
To: <sip:b@h>;tag=t
From: <sip:a@h>;tag=f
Call-ID: param-ruri-ipv6-unclosed
CSeq: 1 INVITE
Max-Forwards: 70
Content-Length: 0

`

// Request-URI port followed by alphabetic trailing garbage —
// `:8080xyz`. Same SIP-ALG confusion vector as `viaPortTrailingGarbage`,
// but inside a URI authority component.
export const requestUriPortTrailingGarbage = sipMsg`INVITE sip:user@host:8080xyz SIP/2.0
Via: SIP/2.0/UDP example.com;branch=z9hG4bK-foo
To: <sip:b@h>;tag=t
From: <sip:a@h>;tag=f
Call-ID: param-ruri-port-trailing-garbage
CSeq: 1 INVITE
Max-Forwards: 70
Content-Length: 0

`

// Control byte inside a URI parameter name — `;trans\x16port=udp`.
// RFC 3261 §25.1: uri-parameter name is a token; CTL bytes are not
// permitted. Same class as CVE-2023-27598 but in the URI scope.
const SYN = "\x16"
export const requestUriCtlInParamName = sipMsg`INVITE sip:user@host;trans${SYN}port=udp SIP/2.0
Via: SIP/2.0/UDP example.com;branch=z9hG4bK-foo
To: <sip:b@h>;tag=t
From: <sip:a@h>;tag=f
Call-ID: param-ruri-ctl-in-param
CSeq: 1 INVITE
Max-Forwards: 70
Content-Length: 0

`
