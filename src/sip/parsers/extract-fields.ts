/**
 * Shared mandatory-header extraction. Every parser adapter (custom,
 * jssip, sip-parser) feeds its decoded `headers` array through these
 * helpers to produce an `EagerHeaderSlots` record that backs the
 * `msg.getHeader()` fast path.
 *
 * RFC 3261 §8.1.1 — From, To, Call-ID, CSeq, and at least one Via are
 * mandatory in every SIP message; requests additionally carry a
 * Request-URI in the start line. Absent or malformed → parse error.
 */

import { Result } from "effect"
import type {
  SipHeader,
  SipRequest,
  SipResponse,
  ParsedRequestUriField,
} from "../types.js"
import { SipParseError } from "./errors.js"
import { makeGetHeader, type EagerHeaderSlots } from "../header-registry.js"
import {
  parseNameAddr,
  parseVia,
  parseContact,
  parseCSeq,
  parseSipUriString,
  splitTopLevelCommas,
} from "./custom/structured-headers.js"

/** Eager slots plus a parsed Request-URI for requests. */
interface RequestEager extends EagerHeaderSlots {
  readonly requestUri: ParsedRequestUriField
}

function getHeaderValue(headers: ReadonlyArray<SipHeader>, name: string): string | undefined {
  const lower = name.toLowerCase()
  return headers.find((h) => h.name.toLowerCase() === lower)?.value
}

function getHeaderValues(headers: ReadonlyArray<SipHeader>, name: string): string[] {
  const lower = name.toLowerCase()
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value)
}

/** RFC 3261 / RFC 3986 §3.2.3: SIP ports are 1..65535. */
function isValidPort(p: number): boolean {
  return Number.isInteger(p) && p >= 1 && p <= 65535
}

/**
 * True iff the URI carries unescaped control bytes (0x00-0x1F, 0x7F).
 * RFC 3261 §25.1: URI chars must come from unreserved / reserved /
 * percent-escaped sets. CTL bytes in any of these positions allow header
 * injection and downstream-system confusion (CVE-2023-27598 in the
 * header-name scope; the URI scope is analogous).
 *
 * HTAB (0x09) is tolerated because pre-LWS-trim parsers may leave it.
 */
function hasUnescapedCtlBytes(uri: string): boolean {
  for (let i = 0; i < uri.length; i++) {
    const c = uri.charCodeAt(i)
    if (c === 0x09) continue
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

/**
 * True iff `uri` contains an `[` without a matching `]`. The lenient
 * parseHostPort path silently treats everything after an unclosed `[` as
 * the host, smuggling URI bytes into the stored host slot.
 */
function hasUnbalancedSquareBrackets(uri: string): boolean {
  let open = 0
  for (let i = 0; i < uri.length; i++) {
    const c = uri.charCodeAt(i)
    if (c === 0x5b) open++
    else if (c === 0x5d) {
      if (open === 0) return true // close without open
      open--
    }
  }
  return open !== 0
}

/**
 * True iff the URI's host portion contains 2+ colons outside of `[…]`
 * brackets — i.e., an IPv6 address without the required bracket delimiters
 * (RFC 5118 §4.2). The lenient parser path swallows the first colon as
 * port-colon and the rest as port digits or trailing garbage, masking the
 * grammar violation.
 */
function hasUnbracketedIpv6(uri: string): boolean {
  const schemeColon = uri.indexOf(":")
  if (schemeColon < 0) return false
  let i = schemeColon + 1
  const atIdx = uri.indexOf("@", i)
  if (atIdx >= 0) i = atIdx + 1
  let depth = 0
  let colons = 0
  while (i < uri.length) {
    const c = uri.charCodeAt(i)
    if (c === 0x5b) depth++
    else if (c === 0x5d && depth > 0) depth--
    else if (depth === 0) {
      if (c === 0x3a) {
        colons++
        if (colons >= 2) return true
      } else if (c === 0x3b || c === 0x3f || c === 0x3e) {
        break
      }
    }
    i++
  }
  return false
}

/**
 * True iff `uri` has port digits followed by an alphabetic byte at the
 * host:port position. Same SIP-ALG confusion vector as the Via-side check;
 * context-aware so it does not false-trigger on `sip:5060xyz@host` (where
 * `5060xyz` is the user, not a port).
 */
function hasUriPortTrailingGarbage(uri: string): boolean {
  let i = uri.indexOf("@")
  if (i < 0) {
    i = uri.indexOf(":")
    if (i < 0) return false
  }
  i++ // past `@` or scheme colon
  // Skip IPv6 bracket if present
  if (i < uri.length && uri.charCodeAt(i) === 0x5b) {
    const close = uri.indexOf("]", i + 1)
    if (close < 0) return false
    i = close + 1
  } else {
    // Advance to host:port colon, stopping at URI-component delimiters.
    while (
      i < uri.length &&
      uri.charCodeAt(i) !== 0x3a &&
      uri.charCodeAt(i) !== 0x3b &&
      uri.charCodeAt(i) !== 0x3f &&
      uri.charCodeAt(i) !== 0x3e
    ) i++
  }
  if (i >= uri.length || uri.charCodeAt(i) !== 0x3a) return false
  i++
  const portStart = i
  while (i < uri.length && uri.charCodeAt(i) >= 0x30 && uri.charCodeAt(i) <= 0x39) i++
  if (i === portStart) return false
  if (i >= uri.length) return false
  const c = uri.charCodeAt(i)
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
}

/**
 * True iff `via` carries a port followed by alphabetic trailing garbage
 * (`host:8080xyz`-style). RFC 3261 mandates port = DIGIT+ followed by a
 * delimiter (`;`, `,`, LWS, end-of-value). Anything else lets a SIP-aware
 * ALG misparse where the SIP stack reads port=8080 — a classic confusion
 * vector. The parser's parseHostPort silently truncates at the first
 * non-digit, so we scan the raw Via value here to catch it.
 *
 * Quote-aware: a `:DIGITS letter` sequence inside a quoted-string (e.g. a
 * display name's literal text) does not trigger.
 */
function hasViaPortTrailingGarbage(via: string): boolean {
  let inQuote = false
  for (let i = 0; i < via.length - 1; i++) {
    const c = via.charCodeAt(i)
    if (inQuote) {
      if (c === 0x5c) { i++; continue } // escape pair
      if (c === 0x22) inQuote = false
      continue
    }
    if (c === 0x22) { inQuote = true; continue }
    if (c !== 0x3a) continue
    let j = i + 1
    const portStart = j
    while (j < via.length && via.charCodeAt(j) >= 0x30 && via.charCodeAt(j) <= 0x39) j++
    if (j === portStart) continue // no digits after this colon
    if (j >= via.length) continue
    const next = via.charCodeAt(j)
    if ((next >= 0x41 && next <= 0x5a) || (next >= 0x61 && next <= 0x7a)) {
      return true
    }
  }
  return false
}

/**
 * Count occurrences of the `;tag=` parameter in a header value, ignoring
 * occurrences inside quoted-strings. RFC 3261 grammar permits exactly one
 * tag per From / To header; duplicates create dialog-identifier ambiguity.
 */
function countTagParams(value: string): number {
  let count = 0
  let inQuote = false
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (inQuote) {
      if (c === 0x5c) { i++; continue } // escape pair
      if (c === 0x22) inQuote = false
      continue
    }
    if (c === 0x22) { inQuote = true; continue }
    if (c !== 0x3b) continue // looking for `;`
    let j = i + 1
    while (j < value.length && (value.charCodeAt(j) === 0x20 || value.charCodeAt(j) === 0x09)) j++
    if (j + 3 > value.length) continue
    const t = value.charCodeAt(j)
    const a = value.charCodeAt(j + 1)
    const g = value.charCodeAt(j + 2)
    if ((t !== 0x74 && t !== 0x54) || (a !== 0x61 && a !== 0x41) || (g !== 0x67 && g !== 0x47)) continue
    let k = j + 3
    while (k < value.length && (value.charCodeAt(k) === 0x20 || value.charCodeAt(k) === 0x09)) k++
    if (k >= value.length || value.charCodeAt(k) !== 0x3d) continue
    count++
  }
  return count
}

export function extractCommonFields(
  headers: ReadonlyArray<SipHeader>,
): Result.Result<EagerHeaderSlots, SipParseError> {
  // Mandatory headers — presence is enforced; internal field parsing is
  // best-effort. Empty `uri` / `host` slots are surfaced as-is so the
  // parser stays tolerant of partially-malformed but routable peers.

  const fromVal = getHeaderValue(headers, "From")
  if (fromVal === undefined) {
    return Result.fail(new SipParseError({ reason: "Missing mandatory From header" }))
  }
  const fromParsed = parseNameAddr(fromVal)
  if (fromParsed.tag !== undefined && fromParsed.tag.length === 0) {
    return Result.fail(new SipParseError({ reason: "Empty From tag parameter" }))
  }
  if (countTagParams(fromVal) > 1) {
    return Result.fail(new SipParseError({ reason: "Duplicate From tag parameter" }))
  }

  const toVal = getHeaderValue(headers, "To")
  if (toVal === undefined) {
    return Result.fail(new SipParseError({ reason: "Missing mandatory To header" }))
  }
  const toParsed = parseNameAddr(toVal)
  if (toParsed.tag !== undefined && toParsed.tag.length === 0) {
    return Result.fail(new SipParseError({ reason: "Empty To tag parameter" }))
  }
  if (countTagParams(toVal) > 1) {
    return Result.fail(new SipParseError({ reason: "Duplicate To tag parameter" }))
  }

  const callId = getHeaderValue(headers, "Call-ID")
  if (callId === undefined || callId.length === 0) {
    return Result.fail(new SipParseError({ reason: "Missing mandatory Call-ID header" }))
  }

  const cseqVal = getHeaderValue(headers, "CSeq")
  if (cseqVal === undefined) {
    return Result.fail(new SipParseError({ reason: "Missing mandatory CSeq header" }))
  }
  const cseqParsed = parseCSeq(cseqVal)

  const viaValues = getHeaderValues(headers, "Via")
  if (viaValues.length === 0) {
    return Result.fail(new SipParseError({ reason: "Missing mandatory Via header" }))
  }
  // RFC 3261 §7.3.1 allows the same header field name to appear once per
  // message with values comma-separated, OR multiple times with one value
  // per line. Both encodings are equivalent. Sipp echoing `[last_Via:]`
  // emits the multi-Via case as a single comma-list line, which is the
  // canonical case for a UAS responding through a proxy that prepended a
  // Via on the request. Split each header value at top-level commas before
  // parsing so the response-relay path sees `vias[0]` = our top stamp and
  // `vias[1]` = the next hop, regardless of which encoding the peer used.
  for (const v of viaValues) {
    for (const segment of splitTopLevelCommas(v)) {
      if (hasViaPortTrailingGarbage(segment)) {
        return Result.fail(
          new SipParseError({ reason: `Trailing non-digit after Via port: "${segment}"` }),
        )
      }
    }
  }
  const viasParsed = viaValues.flatMap((v) =>
    splitTopLevelCommas(v).map(parseVia),
  )
  for (const v of viasParsed) {
    if (v.port !== undefined && !isValidPort(v.port)) {
      return Result.fail(new SipParseError({ reason: `Via port out of range: ${v.port}` }))
    }
    if (v.branch !== undefined && v.branch.length === 0) {
      return Result.fail(new SipParseError({ reason: "Empty Via branch parameter" }))
    }
  }
  const vias = viasParsed.map((v) => ({
    transport: v.transport,
    host: v.host,
    port: v.port,
    branch: v.branch,
    params: v.params,
  }))

  const contactVal = getHeaderValue(headers, "Contact")
  const contactParsed = contactVal ? parseContact(contactVal) : undefined

  return Result.succeed({
    from: {
      displayName: fromParsed.displayName,
      uri: fromParsed.uri,
      tag: fromParsed.tag,
      params: fromParsed.params,
    },
    to: {
      displayName: toParsed.displayName,
      uri: toParsed.uri,
      tag: toParsed.tag,
      params: toParsed.params,
    },
    callId,
    cseq: cseqParsed,
    vias,
    contact: contactParsed,
  })
}

/**
 * Extract request-specific parsed fields (common + Request-URI).
 */
export function extractRequestFields(
  headers: ReadonlyArray<SipHeader>,
  requestUri: string,
): Result.Result<RequestEager, SipParseError> {
  const common = extractCommonFields(headers)
  if (Result.isFailure(common)) return Result.fail(common.failure)
  if (hasUnescapedCtlBytes(requestUri)) {
    return Result.fail(
      new SipParseError({ reason: `Control byte in Request-URI: "${requestUri}"` }),
    )
  }
  if (hasUnbalancedSquareBrackets(requestUri)) {
    return Result.fail(
      new SipParseError({ reason: `Unbalanced IPv6 brackets in Request-URI: "${requestUri}"` }),
    )
  }
  if (hasUriPortTrailingGarbage(requestUri)) {
    return Result.fail(
      new SipParseError({ reason: `Trailing non-digit after Request-URI port: "${requestUri}"` }),
    )
  }
  if (hasUnbracketedIpv6(requestUri)) {
    return Result.fail(
      new SipParseError({ reason: `Unbracketed IPv6 in Request-URI: "${requestUri}"` }),
    )
  }
  const requestUriParsed = parseSipUriString(requestUri)
  if (requestUriParsed === undefined) {
    return Result.fail(
      new SipParseError({ reason: `Malformed Request-URI: "${requestUri}"` }),
    )
  }
  if (requestUriParsed.host.length === 0) {
    return Result.fail(
      new SipParseError({ reason: `Empty host in Request-URI: "${requestUri}"` }),
    )
  }
  if (requestUriParsed.port !== undefined && !isValidPort(requestUriParsed.port)) {
    return Result.fail(
      new SipParseError({ reason: `Request-URI port out of range: ${requestUriParsed.port}` }),
    )
  }
  const parsedRequestUri: ParsedRequestUriField = {
    scheme: requestUriParsed.scheme,
    user: requestUriParsed.user,
    host: requestUriParsed.host,
    port: requestUriParsed.port,
    params: requestUriParsed.params,
  }
  return Result.succeed({
    ...common.success,
    requestUri: parsedRequestUri,
  })
}

/**
 * Extract response-specific parsed fields with status-aware validation.
 *
 * RFC 3261 §8.2.6.2 / §17.1.3: every response except 100 Trying MUST carry
 * a To-tag — for 1xx > 100 and final responses, the To-tag identifies the
 * dialog (or the would-be dialog for non-2xx). 100 Trying is purely a
 * hop-by-hop progress indicator and may omit the tag.
 *
 * Failing here keeps the rest of the B2BUA free of defensive `to.tag ?? ""`
 * fallbacks: every parsed response with `status > 100` is guaranteed to
 * have a non-empty To-tag.
 */
export function extractResponseFields(
  headers: ReadonlyArray<SipHeader>,
  status: number,
): Result.Result<EagerHeaderSlots, SipParseError> {
  const common = extractCommonFields(headers)
  if (Result.isFailure(common)) return common
  if (status > 100 && common.success.to.tag === undefined) {
    return Result.fail(
      new SipParseError({
        reason: `Non-100 response (status=${status}) missing mandatory To-tag`,
      }),
    )
  }
  return common
}

// Shared convenience methods attached to every finalized SipRequest /
// SipResponse so tests and rule code can avoid re-implementing body /
// header presence checks inline. The TextDecoder instance is module-
// scoped — decoders are stateless for UTF-8 and reuse is recommended.
const bodyDecoder = new TextDecoder()

function makeMessageHelpers(
  headers: ReadonlyArray<SipHeader>,
  body: Uint8Array,
): {
  hasBody: () => boolean
  bodyText: () => string | undefined
  bodyEquals: (other: Uint8Array) => boolean
  hasHeader: (name: string) => boolean
} {
  return {
    hasBody: () => body.length > 0,
    bodyText: () => (body.length === 0 ? undefined : bodyDecoder.decode(body)),
    bodyEquals: (other) => {
      if (body.byteLength !== other.byteLength) return false
      for (let i = 0; i < body.byteLength; i++) {
        if (body[i] !== other[i]) return false
      }
      return true
    },
    hasHeader: (name) => {
      const lower = name.toLowerCase()
      return headers.some((h) => h.name.toLowerCase() === lower)
    },
  }
}

/**
 * Construct a finalized `SipRequest` from parsed pieces. Attaches the
 * top-level `requestUri` and the `getHeader` accessor.
 */
export function finalizeRequest(args: {
  readonly method: string
  readonly uri: string
  readonly version: string
  readonly headers: ReadonlyArray<SipHeader>
  readonly body: Uint8Array
  readonly raw: Buffer
  readonly eager: RequestEager
}): SipRequest {
  const getHeader = makeGetHeader(args.headers, args.eager) as
    SipRequest["getHeader"]
  return {
    type: "request",
    method: args.method,
    uri: args.uri,
    requestUri: args.eager.requestUri,
    version: args.version,
    headers: args.headers,
    body: args.body,
    raw: args.raw,
    getHeader,
    ...makeMessageHelpers(args.headers, args.body),
  }
}

/** Construct a finalized `SipResponse` from parsed pieces. */
export function finalizeResponse(args: {
  readonly status: number
  readonly reason: string
  readonly version: string
  readonly headers: ReadonlyArray<SipHeader>
  readonly body: Uint8Array
  readonly raw: Buffer
  readonly eager: EagerHeaderSlots
}): SipResponse {
  const getHeader = makeGetHeader(args.headers, args.eager) as
    SipResponse["getHeader"]
  return {
    type: "response",
    version: args.version,
    status: args.status,
    reason: args.reason,
    headers: args.headers,
    body: args.body,
    raw: args.raw,
    getHeader,
    ...makeMessageHelpers(args.headers, args.body),
  }
}

/**
 * Hydrate a `SipRequest` from raw fields. Throws on malformed headers —
 * callers must produce a well-formed envelope.
 */
export function hydrateRequest(args: {
  readonly method: string
  readonly uri: string
  readonly version?: string
  readonly headers: SipHeader[]
  readonly body: Uint8Array
  readonly raw: Buffer
}): SipRequest {
  const fields = extractRequestFields(args.headers, args.uri)
  if (Result.isFailure(fields)) {
    throw new Error(`hydrateRequest: malformed headers — ${fields.failure.reason}`)
  }
  return finalizeRequest({
    method: args.method,
    uri: args.uri,
    version: args.version ?? "SIP/2.0",
    headers: args.headers,
    body: args.body,
    raw: args.raw,
    eager: fields.success,
  })
}

/** Hydrate a `SipResponse` from raw fields. Throws on malformed headers. */
export function hydrateResponse(args: {
  readonly status: number
  readonly reason: string
  readonly version?: string
  readonly headers: SipHeader[]
  readonly body: Uint8Array
  readonly raw: Buffer
}): SipResponse {
  const fields = extractCommonFields(args.headers)
  if (Result.isFailure(fields)) {
    throw new Error(`hydrateResponse: malformed headers — ${fields.failure.reason}`)
  }
  return finalizeResponse({
    status: args.status,
    reason: args.reason,
    version: args.version ?? "SIP/2.0",
    headers: args.headers,
    body: args.body,
    raw: args.raw,
    eager: fields.success,
  })
}
