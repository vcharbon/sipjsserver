/**
 * Structured SIP header extraction — quote-aware, zero-regex.
 *
 * Parses From/To (display name, URI, tag), Via (transport, host, port,
 * branch, custom params), Contact (URI, params), CSeq (number, method),
 * and SIP URIs (scheme, user, host, port, params).
 *
 * All functions operate on header value strings (already unfolded by
 * the header parser). Uses index-based scanning, not the Buffer Scanner.
 */

// =========================================================================
// Parsed types
// =========================================================================

export interface ParsedNameAddr {
  readonly displayName: string | undefined
  readonly uri: string
  readonly tag: string | undefined
  readonly params: Record<string, string | true>
}

export interface ParsedVia {
  readonly protocol: string   // "SIP"
  readonly version: string    // "2.0"
  readonly transport: string  // "UDP", "TCP", "TLS", etc.
  readonly host: string
  readonly port: number | undefined
  readonly branch: string | undefined
  readonly params: Record<string, string | true>
}

export interface ParsedContact {
  readonly displayName: string | undefined
  readonly uri: string
  readonly params: Record<string, string | true>
}

export interface ParsedCSeq {
  readonly seq: number
  readonly method: string
}

export interface ParsedRack {
  readonly rseq: number    // RFC 3262 response-num
  readonly seq: number     // CSeq-num of the original request being acknowledged
  readonly method: string  // method of the request being acknowledged
}

export interface ParsedReplaces {
  readonly callId: string
  readonly toTag: string
  readonly fromTag: string
  readonly earlyOnly: boolean
}

export interface ParsedReferTo {
  readonly displayName: string | undefined
  readonly uri: string                                  // raw URI as written, angle brackets stripped
  readonly parsedUri: ParsedUri | undefined             // host/port/user/scheme/uri-params (parsed up to `?`)
  readonly params: Record<string, string | true>        // header-level params (after `;` past the `>`), e.g. method=INVITE
  readonly embeddedHeaders: Record<string, string>      // URI-embedded `?key=value` headers, percent-decoded; Replaces lives here
  readonly replaces: ParsedReplaces | undefined         // RFC 3891 — populated when embeddedHeaders has a Replaces that parses
}

export interface ParsedUri {
  readonly scheme: string
  readonly user: string | undefined
  readonly host: string
  readonly port: number | undefined
  readonly params: Record<string, string>
}

// =========================================================================
// Top-level comma splitter — quote-aware and angle-bracket-aware.
//
// Used to split multi-value headers (P-Asserted-Identity, Diversion,
// History-Info, Geolocation, Remote-Party-ID) at the entry boundary
// without breaking on commas inside quoted display names or URI params.
// =========================================================================

export function splitTopLevelCommas(value: string): string[] {
  const out: string[] = []
  let depth = 0          // angle-bracket depth (URIs)
  let inQuote = false    // inside "..."
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (inQuote) {
      if (c === 0x5c && i + 1 < value.length) { i++; continue } // escaped char
      if (c === 0x22) inQuote = false                            // closing "
      continue
    }
    if (c === 0x22) { inQuote = true; continue }                 // opening "
    if (c === 0x3c) { depth++; continue }                        // <
    if (c === 0x3e && depth > 0) { depth--; continue }           // >
    if (c === 0x2c && depth === 0) {                             // top-level ,
      out.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  const tail = value.slice(start).trim()
  if (tail.length > 0 || out.length > 0) out.push(tail)
  return out
}

// =========================================================================
// From / To parsing (name-addr with tag)
//
// RFC 3261 §20.20 / §20.39:
//   From = ( name-addr / addr-spec ) *( SEMI from-param )
//   from-param = tag-param / generic-param
//   tag-param = "tag" EQUAL token
//
// name-addr = [ display-name ] LAQUOT addr-spec RAQUOT
// addr-spec = SIP-URI / SIPS-URI / absoluteURI
//
// Key: tag= is a HEADER parameter (after >), NOT a URI parameter (inside <>).
//       Quoted display names can contain any character including `;tag=`.
// =========================================================================

export function parseNameAddr(value: string): ParsedNameAddr {
  let i = 0
  const len = value.length

  // Skip leading whitespace
  i = skipWS(value, i)

  let displayName: string | undefined
  let uri: string

  // Check for quoted display name: "..."
  if (i < len && value.charCodeAt(i) === 0x22) { // "
    const { text, end } = readQuotedString(value, i)
    displayName = text
    i = skipWS(value, end)
    // Expect <uri>
    if (i < len && value.charCodeAt(i) === 0x3c) { // <
      const closeAngle = value.indexOf(">", i + 1)
      if (closeAngle === -1) {
        uri = value.slice(i + 1).trim()
        return { displayName, uri, tag: undefined, params: {} }
      }
      uri = value.slice(i + 1, closeAngle)
      i = closeAngle + 1
    } else {
      // Malformed — no angle bracket after display name
      uri = value.slice(i).trim()
      return { displayName, uri, tag: undefined, params: {} }
    }
  }
  // Check for <uri> without display name, or unquoted display name tokens before <
  else if (value.indexOf("<", i) !== -1) {
    const openAngle = value.indexOf("<", i)
    const beforeAngle = value.slice(i, openAngle).trim()
    displayName = beforeAngle.length > 0 ? beforeAngle : undefined
    const closeAngle = value.indexOf(">", openAngle + 1)
    if (closeAngle === -1) {
      uri = value.slice(openAngle + 1).trim()
      return { displayName, uri, tag: undefined, params: {} }
    }
    uri = value.slice(openAngle + 1, closeAngle)
    i = closeAngle + 1
  }
  // addr-spec (bare URI, no angle brackets)
  else {
    // Everything before first ; is the URI (or the whole thing)
    const semiIdx = value.indexOf(";", i)
    if (semiIdx === -1) {
      uri = value.slice(i).trim()
      return { displayName: undefined, uri, tag: undefined, params: {} }
    }
    uri = value.slice(i, semiIdx).trim()
    i = semiIdx
  }

  // Parse header parameters (after the > or after addr-spec)
  // These are the REAL parameters — tag lives here, not inside the URI
  const params = parseHeaderParams(value, i)
  const tag = typeof params["tag"] === "string" ? params["tag"] : undefined

  return { displayName, uri, tag, params }
}

// =========================================================================
// Via parsing
//
// RFC 3261 §20.42:
//   Via = sent-protocol LWS sent-by *( SEMI via-params )
//   sent-protocol = protocol-name SLASH protocol-version SLASH transport
//   sent-by = host [ COLON port ]
//   via-params = via-extension / via-branch / ...
// =========================================================================

export function parseVia(value: string): ParsedVia {
  let i = 0

  // sent-protocol: "SIP/2.0/UDP" or "SIP / 2.0 / TCP"
  i = skipWS(value, i)

  // Protocol name (usually "SIP")
  const protoEnd = scanUntilOneOf(value, i, "/")
  const protocol = value.slice(i, protoEnd).trim()
  i = protoEnd + 1 // skip /

  // Version (usually "2.0")
  const verEnd = scanUntilOneOf(value, i, "/")
  const version = value.slice(i, verEnd).trim()
  i = verEnd + 1 // skip /

  // Transport (UDP, TCP, TLS, etc.) — until whitespace
  i = skipWS(value, i)
  const transEnd = scanUntilWSOrSemi(value, i)
  const transport = value.slice(i, transEnd).trim()
  i = transEnd

  // sent-by: host[:port]
  i = skipWS(value, i)
  const { host, port, end: hostEnd } = parseHostPort(value, i)
  i = hostEnd

  // Via parameters (;branch=..., ;cr=..., ;lg=..., ;rport, ;received=...)
  const params = parseHeaderParams(value, i)
  const branch = typeof params["branch"] === "string" ? params["branch"] : undefined

  return { protocol, version, transport, host, port, branch, params }
}

// =========================================================================
// Contact parsing
// =========================================================================

export function parseContact(value: string): ParsedContact {
  // Contact has the same name-addr structure as From/To but tag is not
  // a standard param. We reuse the same parser.
  const parsed = parseNameAddr(value)
  return {
    displayName: parsed.displayName,
    uri: parsed.uri,
    params: parsed.params,
  }
}

// =========================================================================
// CSeq parsing: "number method"
// =========================================================================

export function parseCSeq(value: string): ParsedCSeq {
  let i = skipWS(value, 0)

  // Read digits
  const numStart = i
  while (i < value.length && value.charCodeAt(i) >= 0x30 && value.charCodeAt(i) <= 0x39) i++
  const seq = parseInt(value.slice(numStart, i), 10)

  // Skip whitespace
  i = skipWS(value, i)

  // Rest is method
  const method = value.slice(i).trim()

  return { seq, method }
}

// =========================================================================
// RAck parsing (RFC 3262 §7.2): "response-num CSeq-num method"
//
// Three whitespace-separated tokens; both numbers are non-negative integers.
// Returns undefined on any malformed input (missing token, non-numeric, etc.).
// =========================================================================

export function parseRack(value: string): ParsedRack | undefined {
  let i = skipWS(value, 0)

  // response-num
  const rseqStart = i
  while (i < value.length && value.charCodeAt(i) >= 0x30 && value.charCodeAt(i) <= 0x39) i++
  if (i === rseqStart) return undefined
  const rseq = parseInt(value.slice(rseqStart, i), 10)
  if (!Number.isFinite(rseq)) return undefined

  i = skipWS(value, i)
  if (i >= value.length) return undefined

  // CSeq-num
  const seqStart = i
  while (i < value.length && value.charCodeAt(i) >= 0x30 && value.charCodeAt(i) <= 0x39) i++
  if (i === seqStart) return undefined
  const seq = parseInt(value.slice(seqStart, i), 10)
  if (!Number.isFinite(seq)) return undefined

  i = skipWS(value, i)
  if (i >= value.length) return undefined

  // method (rest of line, trimmed; rejects extra whitespace tokens)
  const method = value.slice(i).trim()
  if (method.length === 0) return undefined
  // method is a single token — reject if it contains whitespace
  for (let j = 0; j < method.length; j++) {
    const c = method.charCodeAt(j)
    if (c === 0x20 || c === 0x09) return undefined
  }

  return { rseq, seq, method }
}

// =========================================================================
// Replaces parsing (RFC 3891 §6.1)
//
// Replaces = callid *(SEMI replaces-param)
// replaces-param = to-tag / from-tag / early-flag / generic-param
// to-tag      = "to-tag" EQUAL token
// from-tag    = "from-tag" EQUAL token
// early-flag  = "early-only"
//
// Both to-tag AND from-tag are mandatory per RFC 3891 §6.1; absence makes the
// header malformed. callid is everything before the first ;.
// =========================================================================

export function parseReplaces(value: string): ParsedReplaces | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined

  const semiIdx = trimmed.indexOf(";")
  const callId = (semiIdx === -1 ? trimmed : trimmed.slice(0, semiIdx)).trim()
  if (callId.length === 0) return undefined
  if (semiIdx === -1) return undefined // missing mandatory tags

  let toTag: string | undefined
  let fromTag: string | undefined
  let earlyOnly = false

  const paramStr = trimmed.slice(semiIdx + 1)
  for (const raw of paramStr.split(";")) {
    const part = raw.trim()
    if (part.length === 0) continue
    const eq = part.indexOf("=")
    if (eq === -1) {
      if (part.toLowerCase() === "early-only") earlyOnly = true
      continue
    }
    const k = part.slice(0, eq).trim().toLowerCase()
    const v = part.slice(eq + 1).trim()
    if (k === "to-tag") toTag = v
    else if (k === "from-tag") fromTag = v
  }

  if (toTag === undefined || fromTag === undefined) return undefined
  if (toTag.length === 0 || fromTag.length === 0) return undefined

  return { callId, toTag, fromTag, earlyOnly }
}

// =========================================================================
// Refer-To parsing (RFC 3515 §2.1, RFC 3891 §3 for embedded Replaces)
//
// Refer-To = ( name-addr / addr-spec ) *(SEMI generic-param)
//
// The URI inside <...> may carry embedded headers per RFC 3261 §19.1.1
// (`?key=value&key=value`), which is where Replaces lives for attended
// transfer.
//
// Quote-aware via parseNameAddr — display names containing the literal text
// "?replaces=" do NOT trigger replaces detection because we only look at the
// URI portion, not the raw header value.
// =========================================================================

export function parseReferTo(value: string): ParsedReferTo | undefined {
  const nameAddr = parseNameAddr(value)
  if (nameAddr.uri.length === 0) return undefined

  const uri = nameAddr.uri
  const qIdx = uri.indexOf("?")

  let uriHead = uri
  const embeddedHeaders: Record<string, string> = {}

  if (qIdx !== -1) {
    uriHead = uri.slice(0, qIdx)
    const headerStr = uri.slice(qIdx + 1)
    for (const pair of headerStr.split("&")) {
      if (pair.length === 0) continue
      const eq = pair.indexOf("=")
      if (eq === -1) continue
      const rawKey = pair.slice(0, eq)
      const rawVal = pair.slice(eq + 1)
      let key: string
      let val: string
      try {
        key = decodeURIComponent(rawKey)
        val = decodeURIComponent(rawVal)
      } catch {
        // Malformed percent-encoding — fall back to raw form rather than discard
        key = rawKey
        val = rawVal
      }
      embeddedHeaders[key] = val
    }
  }

  const parsedUri = parseSipUriString(uriHead)

  let replaces: ParsedReplaces | undefined
  for (const k of Object.keys(embeddedHeaders)) {
    if (k.toLowerCase() === "replaces") {
      replaces = parseReplaces(embeddedHeaders[k]!)
      break
    }
  }

  return {
    displayName: nameAddr.displayName,
    uri,
    parsedUri,
    params: nameAddr.params,
    embeddedHeaders,
    replaces,
  }
}

// =========================================================================
// SIP URI parsing: sip:user@host:port;params
// =========================================================================

export function parseSipUriString(uri: string): ParsedUri | undefined {
  let i = 0
  const len = uri.length

  // Scheme
  const colonIdx = uri.indexOf(":")
  if (colonIdx === -1) return undefined
  const scheme = uri.slice(0, colonIdx).toLowerCase()
  i = colonIdx + 1

  // user@host or just host
  let user: string | undefined
  let hostStart: number

  // Look for @ to determine if there's a user part
  // But @ could be in other contexts, so scan carefully:
  // find the first @, ;, or end — if @ comes before ; it's user@host
  const atIdx = scanUntilOneOf(uri, i, "@;>")
  if (atIdx < len && uri.charCodeAt(atIdx) === 0x40) { // @
    user = uri.slice(i, atIdx)
    hostStart = atIdx + 1
  } else {
    hostStart = i
  }

  // Parse host[:port]
  const { host, port, end: hostEnd } = parseHostPort(uri, hostStart)
  i = hostEnd

  // URI parameters (;key=value)
  const params: Record<string, string> = {}
  while (i < len && uri.charCodeAt(i) === 0x3b) { // ;
    i++ // skip ;
    const nameEnd = scanUntilOneOf(uri, i, "=;>? \t")
    const pname = uri.slice(i, nameEnd).toLowerCase()
    i = nameEnd
    if (i < len && uri.charCodeAt(i) === 0x3d) { // =
      i++ // skip =
      const valEnd = scanUntilOneOf(uri, i, ";>? \t")
      params[pname] = uri.slice(i, valEnd)
      i = valEnd
    } else {
      params[pname] = ""
    }
  }

  return { scheme, user, host, port: port ?? undefined, params }
}

// =========================================================================
// Internal helpers — string-index scanning, no regex
// =========================================================================

function skipWS(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i)
    if (c !== 0x20 && c !== 0x09) break
    i++
  }
  return i
}

/** Read a quoted string starting at position i (which must be "). Returns unescaped text and end position (after closing "). */
function readQuotedString(s: string, i: number): { text: string; end: number } {
  i++ // skip opening "
  let result = ""
  while (i < s.length) {
    const c = s.charCodeAt(i)
    if (c === 0x5c && i + 1 < s.length) { // backslash escape
      result += s[i + 1]
      i += 2
      continue
    }
    if (c === 0x22) { // closing "
      return { text: result, end: i + 1 }
    }
    result += s[i]
    i++
  }
  // Unterminated — return what we have
  return { text: result, end: i }
}

/** Scan forward from i until one of the delimiter chars is found. Returns index of delimiter (or end of string). */
function scanUntilOneOf(s: string, i: number, delims: string): number {
  while (i < s.length) {
    if (delims.indexOf(s[i]!) !== -1) return i
    i++
  }
  return i
}

/** Scan until whitespace or semicolon. */
function scanUntilWSOrSemi(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i)
    if (c === 0x20 || c === 0x09 || c === 0x3b || c === 0x2c) return i // SP, HTAB, ;, ,
    i++
  }
  return i
}

/** Parse host[:port] from position i. Host can be IPv4, IPv6 (in brackets), or hostname. */
function parseHostPort(s: string, i: number): { host: string; port: number | undefined; end: number } {
  const len = s.length

  // IPv6: [address]
  if (i < len && s.charCodeAt(i) === 0x5b) { // [
    const closeBracket = s.indexOf("]", i + 1)
    if (closeBracket === -1) {
      return { host: s.slice(i + 1), port: undefined, end: len }
    }
    const host = s.slice(i + 1, closeBracket)
    let j = closeBracket + 1
    let port: number | undefined
    if (j < len && s.charCodeAt(j) === 0x3a) { // :
      j++
      const portStart = j
      while (j < len && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x39) j++
      port = parseInt(s.slice(portStart, j), 10)
    }
    return { host, port, end: j }
  }

  // IPv4 or hostname: scan until : ; , SP or end
  const hostEnd = scanUntilOneOf(s, i, ":;,> \t?")
  const host = s.slice(i, hostEnd)

  let j = hostEnd
  let port: number | undefined
  if (j < len && s.charCodeAt(j) === 0x3a) { // :
    j++
    const portStart = j
    while (j < len && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x39) j++
    if (j > portStart) {
      port = parseInt(s.slice(portStart, j), 10)
    }
  }

  return { host, port, end: j }
}

/**
 * Parse header-level parameters (after > or after addr-spec).
 * These are semicolon-separated key=value pairs at the HEADER level,
 * NOT inside a URI. This is where tag= lives.
 *
 * Handles: ;tag=abc ;expires=3600 ;rport ;received=10.0.0.1
 */
function parseHeaderParams(s: string, i: number): Record<string, string | true> {
  const params: Record<string, string | true> = {}
  const len = s.length

  while (i < len) {
    i = skipWS(s, i)
    if (i >= len) break

    // Expect semicolon
    if (s.charCodeAt(i) !== 0x3b) { // ;
      // Skip unexpected characters (commas for multi-value headers, etc.)
      i++
      continue
    }
    i++ // skip ;
    i = skipWS(s, i)

    // Read parameter name
    const nameEnd = scanUntilOneOf(s, i, "=; \t,>")
    const pname = s.slice(i, nameEnd).toLowerCase()
    i = nameEnd

    // RFC 3261 EQUAL production permits surrounding LWS: `SWS "=" SWS`.
    // The 4475 wsinv fixture has a folded `branch= z9hG4bK30239` where the
    // SP after `=` is just LWS, not the start of the value.
    i = skipWS(s, i)
    if (i < len && s.charCodeAt(i) === 0x3d) { // =
      i++ // skip =
      i = skipWS(s, i)
      // Read parameter value — may be quoted
      if (i < len && s.charCodeAt(i) === 0x22) { // "
        const { text, end } = readQuotedString(s, i)
        params[pname] = text
        i = end
      } else {
        const valEnd = scanUntilOneOf(s, i, ";, \t>")
        params[pname] = s.slice(i, valEnd)
        i = valEnd
      }
    } else {
      // Flag parameter (no value) like ;rport
      if (pname.length > 0) {
        params[pname] = true
      }
    }
  }

  return params
}
