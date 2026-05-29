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
  ParsedContactField,
  ContactSet,
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
  validateStrictHost,
  validateStrictSipUri,
} from "./custom/structured-headers.js"
import { DEFAULT_SIP_PARSER_LIMITS, type SipParserLimits } from "./interface.js"
import { strictNonNegativeDecimal, isTokenChar } from "./custom/scanner.js"

/** RFC 3261 §8.1.1.7 — top-Via branch MUST start with this magic cookie. */
const VIA_BRANCH_MAGIC_COOKIE = "z9hG4bK"

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

/**
 * Inspect a Via header's raw value to confirm the sent-protocol grammar:
 *   sent-protocol = protocol-name SLASH protocol-version SLASH transport
 *   SLASH         = SWS "/" SWS   ; LWS permitted around the `/`
 * RFC §25.1 — all three tokens must be non-empty `1*tchar` sequences. The
 * lenient `parseVia` swallows empty tokens silently; the strict check
 * re-scans the value byte-by-byte and surfaces the missing piece. The
 * RFC 4475 §3.1.1.1 "short tortuous INVITE" fixture exercises the LWS-
 * around-`/` form (e.g. `SIP  / 2.0  / TCP …`) and must still pass.
 */
function checkSentProtocol(via: string): string | undefined {
  const skipWS = (i: number) => {
    while (i < via.length && (via.charCodeAt(i) === 0x20 || via.charCodeAt(i) === 0x09)) i++
    return i
  }
  const readTokenRun = (i: number) => {
    while (i < via.length && isTokenChar(via.charCodeAt(i))) i++
    return i
  }
  let i = skipWS(0)
  const nameStart = i
  i = readTokenRun(i)
  if (i === nameStart) return "empty Via protocol-name"
  i = skipWS(i)
  if (i >= via.length || via.charCodeAt(i) !== 0x2f) return "missing `/` after Via protocol-name"
  i = skipWS(i + 1)
  const verStart = i
  i = readTokenRun(i)
  if (i === verStart) return "empty Via protocol-version"
  i = skipWS(i)
  if (i >= via.length || via.charCodeAt(i) !== 0x2f) return "missing `/` after Via protocol-version"
  i = skipWS(i + 1)
  const transStart = i
  i = readTokenRun(i)
  if (i === transStart) return "empty Via transport"
  return undefined
}

/**
 * Strictness mode for header extraction.
 *
 * - `"wire"` — every check enforced including ADR-0007 strict-grammar gates
 *   (Via magic cookie, transport allowlist, Via sent-protocol structure,
 *   strict host grammar, strict SIP-URI ABNF, CSeq paranoid digit + method
 *   presence, multi-colon sent-by detection). Used by the parser adapters
 *   on wire-received bytes.
 * - `"hydrate"` — the strict-grammar gates are skipped; only the
 *   pre-existing baseline checks fire (mandatory header presence, tag
 *   uniqueness, port range, CTL bytes). Used by `hydrateRequest` /
 *   `hydrateResponse` where the message is reconstructed from already
 *   trusted internal fields (test scaffolding, B2BUA re-INVITE building).
 */
type ExtractMode = "wire" | "hydrate"

export function extractCommonFields(
  headers: ReadonlyArray<SipHeader>,
  limits: SipParserLimits = DEFAULT_SIP_PARSER_LIMITS,
  mode: ExtractMode = "wire",
): Result.Result<EagerHeaderSlots, SipParseError> {
  // Mandatory headers — presence is enforced; internal field parsing is
  // best-effort. Empty `uri` / `host` slots are surfaced as-is so the
  // parser stays tolerant of partially-malformed but routable peers.

  // RFC 3261 §8.1.1 / §20: From, To, Call-ID and CSeq appear exactly once
  // in every request and response — Via is the sole mandatory header that
  // may repeat. Reject duplicates (compact forms are already expanded to
  // long names upstream, so `From:`+`f:` is caught too) so a smuggled
  // second From/To cannot open a parsing differential with a downstream hop.
  {
    let nFrom = 0
    let nTo = 0
    let nCallId = 0
    let nCseq = 0
    for (const hdr of headers) {
      switch (hdr.name.toLowerCase()) {
        case "from": nFrom++; break
        case "to": nTo++; break
        case "call-id": nCallId++; break
        case "cseq": nCseq++; break
      }
    }
    if (nFrom > 1) return Result.fail(new SipParseError({ reason: "Multiple From headers (RFC 3261 §8.1.1 — exactly one required)" }))
    if (nTo > 1) return Result.fail(new SipParseError({ reason: "Multiple To headers (RFC 3261 §8.1.1 — exactly one required)" }))
    if (nCallId > 1) return Result.fail(new SipParseError({ reason: "Multiple Call-ID headers (RFC 3261 §8.1.1 — exactly one required)" }))
    if (nCseq > 1) return Result.fail(new SipParseError({ reason: "Multiple CSeq headers (RFC 3261 §8.1.1 — exactly one required)" }))
  }

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
  // Strict URI grammar on the From URI (catches sip:@host, sip:::host, etc.).
  if (mode === "wire") {
    const fromUriReason = validateStrictSipUri(fromParsed.uri)
    if (fromUriReason !== undefined) {
      return Result.fail(new SipParseError({ reason: `Strict From URI: ${fromUriReason} ("${fromParsed.uri}")` }))
    }
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
  if (mode === "wire") {
    const toUriReason = validateStrictSipUri(toParsed.uri)
    if (toUriReason !== undefined) {
      return Result.fail(new SipParseError({ reason: `Strict To URI: ${toUriReason} ("${toParsed.uri}")` }))
    }
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
  // CSeq strict grammar: `1*DIGIT LWS Method` — both pieces mandatory and
  // paranoid-digit-only. Catches `CSeq: 1` (no method), `CSeq: 1.5 INVITE`
  // (float in seq), `CSeq: -1 INVITE` (sign), and `CSeq: 1 ` (whitespace
  // only after digits).
  if (mode === "wire") {
    const cseqRaw = cseqVal.trim()
    const cseqSpaceIdx = (() => {
      for (let i = 0; i < cseqRaw.length; i++) {
        const c = cseqRaw.charCodeAt(i)
        if (c === 0x20 || c === 0x09) return i
      }
      return -1
    })()
    if (cseqSpaceIdx === -1) {
      return Result.fail(new SipParseError({ reason: `CSeq missing method token: "${cseqVal}"` }))
    }
    const cseqDigits = cseqRaw.slice(0, cseqSpaceIdx)
    if (strictNonNegativeDecimal(cseqDigits, 2 ** 31 - 1) === undefined) {
      return Result.fail(new SipParseError({ reason: `CSeq seq malformed (paranoid digit check): "${cseqDigits}"` }))
    }
    const cseqMethodToken = cseqRaw.slice(cseqSpaceIdx + 1).trim()
    if (cseqMethodToken.length === 0) {
      return Result.fail(new SipParseError({ reason: `CSeq missing method token: "${cseqVal}"` }))
    }
  }

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
      if (mode === "wire") {
        const protoReason = checkSentProtocol(segment)
        if (protoReason !== undefined) {
          return Result.fail(
            new SipParseError({ reason: `${protoReason}: "${segment}"` }),
          )
        }
      }
    }
  }
  const viaSegments = viaValues.flatMap((v) => splitTopLevelCommas(v))
  const viasParsed = viaSegments.map(parseVia)
  for (let idx = 0; idx < viasParsed.length; idx++) {
    const v = viasParsed[idx]!
    const raw = viaSegments[idx]!
    if (v.port !== undefined && !isValidPort(v.port)) {
      return Result.fail(new SipParseError({ reason: `Via port out of range: ${v.port}` }))
    }
    if (v.branch !== undefined && v.branch.length === 0) {
      return Result.fail(new SipParseError({ reason: "Empty Via branch parameter" }))
    }
    if (mode !== "wire") continue
    // Top-Via magic cookie — RFC 3261 §8.1.1.7. Only enforced on the
    // topmost Via; deeper Vias trace upstream proxies that may pre-date
    // RFC 3261.
    if (idx === 0) {
      const branch = v.branch
      if (branch === undefined || !branch.startsWith(VIA_BRANCH_MAGIC_COOKIE)) {
        return Result.fail(
          new SipParseError({
            reason: `Top Via branch missing magic cookie "${VIA_BRANCH_MAGIC_COOKIE}": ${branch === undefined ? "<no branch>" : `"${branch}"`}`,
          }),
        )
      }
    }
    // Strict host grammar applies to every Via (IPv4 octet ≤255 + no
    // leading zeros / hostname label alphanum-start / IPv6 bracket-content
    // tolerated as-is).
    const hostReason = validateStrictHost(v.host)
    if (hostReason !== undefined) {
      return Result.fail(
        new SipParseError({ reason: `Strict Via sent-by host: ${hostReason} ("${v.host}")` }),
      )
    }
    // Multiple-colon sent-by — count colons in the raw Via value outside
    // `[...]` IPv6 brackets and before the first `;` params delimiter.
    // sent-protocol contributes 0 colons; well-formed sent-by contributes
    // 0 (host) or 1 (host:port). > 1 is malformed `host:::port` shape.
    {
      let inBracket = false
      let colonCount = 0
      for (let k = 0; k < raw.length; k++) {
        const c = raw.charCodeAt(k)
        if (c === 0x5b) { inBracket = true; continue }
        if (c === 0x5d) { inBracket = false; continue }
        if (c === 0x3b && !inBracket) break
        if (!inBracket && c === 0x3a) colonCount++
      }
      if (colonCount > 1) {
        return Result.fail(
          new SipParseError({ reason: `Via sent-by has ${colonCount} colons (must be ≤ 1): "${raw}"` }),
        )
      }
    }
    // Transport allowlist — RFC §7.1 permits `other-transport`; this
    // rejects per the SipParserLimits.allowedTransports policy.
    if (!limits.allowedTransports.has(v.transport.toUpperCase())) {
      return Result.fail(
        new SipParseError({ reason: `Via transport "${v.transport}" not in allowed set` }),
      )
    }
  }
  const vias = viasParsed.map((v) => ({
    transport: v.transport,
    host: v.host,
    port: v.port,
    branch: v.branch,
    params: v.params,
  }))

  // Contact — parse and validate every value up front. RFC 3261 §7.3.1: a
  // comma-list and repeated Contact lines are equivalent, so fold both into
  // one ordered list. `Contact: *` (§10.2.2 REGISTER wildcard) is a bare
  // token, not a URI: it skips the strict-URI gate and MUST stand alone.
  let contactWildcard = false
  const contactEntries: string[] = []
  for (const v of getHeaderValues(headers, "Contact")) {
    for (const seg of splitTopLevelCommas(v)) {
      const trimmed = seg.trim()
      if (trimmed.length === 0) continue
      if (trimmed === "*") {
        contactWildcard = true
        continue
      }
      contactEntries.push(seg)
    }
  }
  if (contactWildcard && contactEntries.length > 0) {
    return Result.fail(
      new SipParseError({ reason: "Contact: * wildcard must be the only value (RFC 3261 §10.2.2)" }),
    )
  }
  const contactList: ParsedContactField[] = []
  for (const entry of contactEntries) {
    const parsed = parseContact(entry)
    if (mode === "wire") {
      const contactReason = validateStrictSipUri(parsed.uri)
      if (contactReason !== undefined) {
        return Result.fail(
          new SipParseError({ reason: `Strict Contact URI: ${contactReason} ("${parsed.uri}")` }),
        )
      }
    }
    contactList.push(parsed)
  }
  const contacts: ContactSet = contactWildcard
    ? { wildcard: true }
    : { wildcard: false, contacts: contactList }
  const contactParsed: ParsedContactField | undefined = contactWildcard
    ? undefined
    : contactList[0]

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
    contacts,
  })
}

/**
 * Extract request-specific parsed fields (common + Request-URI).
 *
 * RFC 3261 §17.1.3 / §17.2.3 — the CSeq method in a request MUST match
 * the request method (with the standard CANCEL/ACK matching their parent
 * INVITE on the wire as separate transactions). When `method` is supplied
 * we cross-check; the check used to live in custom/index.ts but moving it
 * here means jssip / sip-parser adapters get the same enforcement.
 */
export function extractRequestFields(
  headers: ReadonlyArray<SipHeader>,
  requestUri: string,
  limits: SipParserLimits = DEFAULT_SIP_PARSER_LIMITS,
  method?: string,
  mode: ExtractMode = "wire",
): Result.Result<RequestEager, SipParseError> {
  const common = extractCommonFields(headers, limits, mode)
  if (Result.isFailure(common)) return Result.fail(common.failure)
  // Contact cardinality. A second Contact (or the `*` wildcard) is only
  // ambiguous when the Contact defines a dialog's remote target — i.e. on a
  // dialog-creating request — so only those are constrained. REGISTER lists
  // bindings / uses `*` (§10.2); other methods (OPTIONS, unknown, …) carry
  // Contact harmlessly and stay permissive (RFC 4475 §3.1.1.5 carries an
  // unknown method with two Contacts that must still parse). Presence
  // (mandatory on a dialog-creating request, §8.1.1.8) is a UA-level
  // semantic, enforced at the handler with a 400 — not dropped here.
  if (mode === "wire" && method !== undefined) {
    const m = method.toUpperCase()
    if (m === "INVITE" || m === "SUBSCRIBE" || m === "REFER") {
      const cs = common.success.contacts
      if (cs.wildcard) {
        return Result.fail(new SipParseError({ reason: `Contact: * wildcard is not valid in ${m} (RFC 3261 §10.2.2)` }))
      }
      if (cs.contacts.length > 1) {
        return Result.fail(new SipParseError({ reason: `${m} must not contain multiple Contact headers (RFC 3261 §8.1.1.8 — found ${cs.contacts.length})` }))
      }
    }
  }
  if (method !== undefined) {
    const cseqVal = getHeaderValue(headers, "CSeq")
    if (cseqVal !== undefined) {
      const cseqMethod = (() => {
        const trimmed = cseqVal.trim()
        for (let i = 0; i < trimmed.length; i++) {
          const c = trimmed.charCodeAt(i)
          if (c === 0x20 || c === 0x09) return trimmed.slice(i + 1).trim()
        }
        return ""
      })()
      if (cseqMethod.length > 0 && cseqMethod.toUpperCase() !== method.toUpperCase()) {
        return Result.fail(
          new SipParseError({
            reason: `CSeq method "${cseqMethod}" does not match request method "${method}"`,
          }),
        )
      }
    }
  }
  // Strict SIP-URI grammar on the Request-URI. Catches sip:@host,
  // sip:::host, sip:a@@host, sip: (empty hostport), host-label invalid
  // start char.
  if (mode === "wire") {
    const requestUriReason = validateStrictSipUri(requestUri)
    if (requestUriReason !== undefined) {
      return Result.fail(
        new SipParseError({ reason: `Strict Request-URI: ${requestUriReason} ("${requestUri}")` }),
      )
    }
  }
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
  limits: SipParserLimits = DEFAULT_SIP_PARSER_LIMITS,
  mode: ExtractMode = "wire",
): Result.Result<EagerHeaderSlots, SipParseError> {
  const common = extractCommonFields(headers, limits, mode)
  if (Result.isFailure(common)) return common
  if (status > 100 && common.success.to.tag === undefined) {
    return Result.fail(
      new SipParseError({
        reason: `Non-100 response (status=${status}) missing mandatory To-tag`,
      }),
    )
  }
  // Contact cardinality — mirror of the request side. Only a dialog-creating
  // method's NON-redirect response binds a remote target, so only those are
  // constrained to a single Contact. Redirects (3xx / 485) list alternatives
  // (§8.1.3.4); REGISTER responses list bindings (§10.3); other responses
  // stay permissive. CSeq method identifies the request class.
  if (mode === "wire") {
    const cseqMethod = common.success.cseq.method.toUpperCase()
    const isRedirect = status === 485 || (status >= 300 && status < 400)
    if (!isRedirect && (cseqMethod === "INVITE" || cseqMethod === "SUBSCRIBE" || cseqMethod === "REFER")) {
      const cs = common.success.contacts
      if (cs.wildcard) {
        return Result.fail(new SipParseError({ reason: `Contact: * wildcard is not valid in a ${status} response to ${cseqMethod} (RFC 3261 §10.2.2)` }))
      }
      if (cs.contacts.length > 1) {
        return Result.fail(new SipParseError({ reason: `${status} response to ${cseqMethod} must not contain multiple Contact headers (RFC 3261 §12.1.1 — found ${cs.contacts.length})` }))
      }
    }
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
  // mode "hydrate" — skip ADR-0007 wire-strict gates. Hydrate is for
  // already-trusted internal fields (test scaffolding, B2BUA re-INVITE
  // construction). Wire grammar enforcement runs on parser ingest only.
  const fields = extractRequestFields(args.headers, args.uri, undefined, undefined, "hydrate")
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
  const fields = extractCommonFields(args.headers, undefined, "hydrate")
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
