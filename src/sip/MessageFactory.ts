/**
 * MessageFactory — builds structured SipRequest/SipResponse objects.
 *
 * All functions return structured types (not Buffers). Via and Contact headers
 * are left as placeholders — SipRouter stamps them with callRef/leg params
 * before serialization.
 *
 * No Effect dependencies — these are deterministic transformations.
 */

import { randomUUID } from "node:crypto"
import type { SipHeader, SipRequest, SipResponse } from "./types.js"
import {
  parseNameAddr,
  parseVia as parseViaHeader,
  parseContact as parseContactHeader,
  parseSipUriString,
} from "./parsers/custom/structured-headers.js"

// ---------------------------------------------------------------------------
// Header accessors (reused from Builder, kept here as the canonical location)
// ---------------------------------------------------------------------------

/** Returns the first header value matching name (case-insensitive). */
export function getHeader(headers: ReadonlyArray<SipHeader>, name: string): string | undefined {
  const lower = name.toLowerCase()
  return headers.find((h) => h.name.toLowerCase() === lower)?.value
}

/** Returns all header values matching name (case-insensitive). */
export function getHeaders(headers: ReadonlyArray<SipHeader>, name: string): string[] {
  const lower = name.toLowerCase()
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value)
}

/** Set or replace a header (first occurrence). Returns new headers array. */
export function setHeader(headers: ReadonlyArray<SipHeader>, name: string, value: string): SipHeader[] {
  const lower = name.toLowerCase()
  const result = [...headers]
  const idx = result.findIndex((h) => h.name.toLowerCase() === lower)
  if (idx >= 0) {
    result[idx] = { name, value }
  } else {
    result.push({ name, value })
  }
  return result
}

/** Remove all headers matching name (case-insensitive). */
export function removeHeader(headers: ReadonlyArray<SipHeader>, name: string): SipHeader[] {
  const lower = name.toLowerCase()
  return headers.filter((h) => h.name.toLowerCase() !== lower)
}

/**
 * Extracts the tag parameter from a From/To header value.
 * Quote-aware — uses structured parser, immune to injection from display names.
 */
export function extractTag(headerValue: string): string | undefined {
  return parseNameAddr(headerValue).tag
}

/**
 * Strips the tag parameter from a From/To header value.
 * Quote-aware — reconstructs the header value without the tag param.
 */
export function stripTag(headerValue: string): string {
  const parsed = parseNameAddr(headerValue)
  if (parsed.tag === undefined) return headerValue

  // Rebuild: display-name <uri> ;other-params (without ;tag=...)
  let result = ""
  if (parsed.displayName !== undefined) {
    result += `"${parsed.displayName}" `
  }
  result += `<${parsed.uri}>`

  // Append non-tag params
  for (const [k, v] of Object.entries(parsed.params)) {
    if (k === "tag") continue
    if (v === true) {
      result += `;${k}`
    } else {
      result += `;${k}=${v}`
    }
  }
  return result
}

/**
 * Extracts the URI from a Contact header value.
 * Quote-aware — uses structured parser.
 */
export function extractContactUri(contactValue: string): string {
  return parseContactHeader(contactValue).uri
}

/** Parsed SIP URI fields. */
export interface ParsedSipUri {
  readonly scheme: string
  readonly user: string | undefined
  readonly host: string
  readonly port: number
  readonly params: Record<string, string>
}

/**
 * Parse a SIP URI. Zero-regex, zero JsSIP dependency.
 */
export function parseSipUri(uri: string): ParsedSipUri | undefined {
  // Strip angle brackets if present
  let cleaned = uri
  const ltIdx = cleaned.indexOf("<")
  if (ltIdx !== -1) {
    const gtIdx = cleaned.indexOf(">", ltIdx)
    cleaned = gtIdx !== -1 ? cleaned.slice(ltIdx + 1, gtIdx) : cleaned.slice(ltIdx + 1)
  }
  const parsed = parseSipUriString(cleaned)
  if (parsed === undefined) return undefined
  return {
    scheme: parsed.scheme,
    user: parsed.user,
    host: parsed.host,
    port: parsed.port ?? 5060,
    params: parsed.params,
  }
}

/** Extract host:port from a SIP URI string. */
export function extractHostPort(uri: string): { host: string; port: number } | undefined {
  const parsed = parseSipUri(uri)
  if (parsed === undefined) return undefined
  return { host: parsed.host, port: parsed.port }
}

/** Parse URI parameters from a SIP URI (e.g., "sip:b2bua@host;callRef=abc;leg=a"). */
export function parseUriParams(uri: string): Record<string, string> {
  const parsed = parseSipUri(uri)
  if (parsed === undefined) return {}
  return parsed.params
}

/**
 * Parse custom parameters from a Via header value.
 * Zero-regex — uses the structured Via parser.
 */
export function parseViaParams(viaValue: string): { cr: string | undefined; lg: string | undefined; branch: string | undefined } {
  const parsed = parseViaHeader(viaValue)
  return {
    branch: parsed.branch,
    cr: typeof parsed.params["cr"] === "string" ? parsed.params["cr"] : undefined,
    lg: typeof parsed.params["lg"] === "string" ? parsed.params["lg"] : undefined,
  }
}

// ---------------------------------------------------------------------------
// Identifier generators
// ---------------------------------------------------------------------------

export function newCallId(localHost: string): string {
  return `${randomUUID()}@${localHost}`
}

export function newTag(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Ensures a To header value has a tag parameter.
 * RFC 3261 §8.2.6.2: UAS MUST add a tag to To in responses > 100.
 * If a tag already exists, the value is returned unchanged.
 */
function ensureToTag(toValue: string): string {
  if (/;tag=/i.test(toValue)) return toValue
  return `${toValue};tag=${newTag()}`
}

export function newBranch(): string {
  return `z9hG4bK${randomUUID().replace(/-/g, "").slice(0, 16)}`
}

// ---------------------------------------------------------------------------
// Header transparency
// ---------------------------------------------------------------------------

/**
 * Structural headers fully managed by the B2BUA — never copied transparently.
 * All other headers pass through from the original message.
 * TODO: merge with env-configurable blacklist
 */
const STRUCTURAL_HEADERS = new Set([
  "via", "contact", "from", "to", "call-id", "cseq",
  "max-forwards", "content-length", "record-route", "route",
])

/**
 * Copies all non-structural headers from `source` into `dest`.
 * Skips headers already present in `dest` (case-insensitive).
 */
function copyTransparentHeaders(source: ReadonlyArray<SipHeader>, dest: SipHeader[]): void {
  const existing = new Set(dest.map((h) => h.name.toLowerCase()))
  for (const hdr of source) {
    const lower = hdr.name.toLowerCase()
    if (STRUCTURAL_HEADERS.has(lower)) continue
    if (existing.has(lower)) continue
    dest.push(hdr)
    existing.add(lower)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_BODY = new Uint8Array(0)
const EMPTY_RAW = Buffer.alloc(0)

function makeRequest(
  method: string,
  uri: string,
  headers: SipHeader[],
  body: Uint8Array = EMPTY_BODY
): SipRequest {
  return { type: "request", method, uri, version: "SIP/2.0", headers, body, raw: EMPTY_RAW }
}

function makeResponse(
  status: number,
  reason: string,
  headers: SipHeader[],
  body: Uint8Array = EMPTY_BODY
): SipResponse {
  return { type: "response", version: "SIP/2.0", status, reason, headers, body, raw: EMPTY_RAW }
}

function h(name: string, value: string): SipHeader {
  return { name, value }
}

// ---------------------------------------------------------------------------
// B-leg INVITE
// ---------------------------------------------------------------------------

/**
 * Constructs the outgoing INVITE for the b-leg.
 * Via and Contact are placeholders — SipRouter stamps them.
 */
export function buildBLegInvite(
  aLeg: SipRequest,
  bLegCallId: string,
  bLegFromTag: string,
  overrideUri?: string,
  headerUpdates?: Record<string, string | null>,
  cseqNum?: number
): SipRequest {
  const from = getHeader(aLeg.headers, "from") ?? "unknown"
  const to = getHeader(aLeg.headers, "to") ?? aLeg.uri
  const cseq = cseqNum !== undefined ? `${cseqNum} INVITE` : (getHeader(aLeg.headers, "cseq") ?? "1 INVITE")
  const maxForwardsRaw = getHeader(aLeg.headers, "max-forwards")
  const maxForwards = Math.max(0, parseInt(maxForwardsRaw ?? "70", 10) - 1)
  const body = aLeg.body

  const headers: SipHeader[] = [
    // Via placeholder — SipRouter stamps with cr/lg params
    h("Via", "__PLACEHOLDER__"),
    h("Record-Route", "__PLACEHOLDER__"),
    h("Max-Forwards", String(maxForwards)),
    h("From", `${stripTag(from)};tag=${bLegFromTag}`),
    h("To", stripTag(to)),
    h("Call-ID", bLegCallId),
    h("CSeq", cseq),
    // Contact placeholder — SipRouter stamps with callRef/leg params
    h("Contact", "__PLACEHOLDER__"),
  ]
  // Copy all non-structural headers transparently
  copyTransparentHeaders(aLeg.headers, headers)

  // Apply header updates from routing decision
  if (headerUpdates) {
    for (const [name, value] of Object.entries(headerUpdates)) {
      if (value === null) {
        const idx = headers.findIndex((hdr) => hdr.name.toLowerCase() === name.toLowerCase())
        if (idx >= 0) headers.splice(idx, 1)
      } else {
        const idx = headers.findIndex((hdr) => hdr.name.toLowerCase() === name.toLowerCase())
        if (idx >= 0) {
          headers[idx] = h(name, value)
        } else {
          headers.push(h(name, value))
        }
      }
    }
  }

  headers.push(h("Content-Length", String(body.byteLength)))

  const requestUri = overrideUri ?? aLeg.uri
  return makeRequest("INVITE", requestUri, headers, body)
}

// ---------------------------------------------------------------------------
// Response relay (b-leg -> a-leg)
// ---------------------------------------------------------------------------

/**
 * Rewrites a b-leg response for relay back to the a-leg.
 * Via and Contact are placeholders — SipRouter stamps them.
 */
export function relayResponse(
  bLegResp: SipResponse,
  aLegCallId: string,
  aLegVias: ReadonlyArray<string>,
  aLegFrom?: string,
  aLegTo?: string,
  aLegCSeq?: string
): SipResponse {
  const body = bLegResp.body
  const headers: SipHeader[] = []

  // Restore original a-leg Via headers (replacing b-leg Vias)
  for (const via of aLegVias) {
    headers.push(h("Via", via))
  }

  // Record-Route placeholder — SipRouter stamps with a-leg callRef/leg params
  headers.push(h("Record-Route", "__PLACEHOLDER__"))

  // Copy all non-structural headers transparently
  // From/To conditionally rewritten below — skip them if we have replacements
  const skipExtra = new Set<string>()
  if (aLegFrom !== undefined) skipExtra.add("from")
  if (aLegTo !== undefined) skipExtra.add("to")

  for (const hdr of bLegResp.headers) {
    const lower = hdr.name.toLowerCase()
    if (STRUCTURAL_HEADERS.has(lower)) continue
    if (skipExtra.has(lower)) continue
    headers.push(hdr)
  }

  // Restore original a-leg From header (responses must echo the request's From)
  if (aLegFrom !== undefined) {
    headers.push(h("From", aLegFrom))
  }

  // Rewrite To header with B2BUA's tag for Alice
  if (aLegTo !== undefined) {
    headers.push(h("To", aLegTo))
  }

  headers.push(h("Call-ID", aLegCallId))
  // CSeq must match the a-leg's original request CSeq (RFC 3261 §8.2.6.2)
  const cseq = aLegCSeq ?? getHeader(bLegResp.headers, "cseq") ?? ""
  headers.push(h("CSeq", cseq))
  // Contact placeholder — stamped by SipRouter with callRef;leg params
  headers.push(h("Contact", "__PLACEHOLDER__"))
  headers.push(h("Content-Length", String(body.byteLength)))

  return makeResponse(bLegResp.status, bLegResp.reason, headers, body)
}

// ---------------------------------------------------------------------------
// ACK (for 2xx — end-to-end, application-level)
// ---------------------------------------------------------------------------

/**
 * Builds the ACK request to send to a leg after receiving its 200 OK.
 * Via and Contact are placeholders.
 */
export function buildAck(
  callId: string,
  fromTag: string,
  toTag: string,
  toUri: string,
  cseq: number = 1,
  fromUri?: string
): SipRequest {
  const from = fromUri ?? toUri
  const headers: SipHeader[] = [
    h("Via", "__PLACEHOLDER__"),
    h("Max-Forwards", "70"),
    h("From", `<${from}>;tag=${fromTag}`),
    h("To", toTag ? `<${toUri}>;tag=${toTag}` : `<${toUri}>`),
    h("Call-ID", callId),
    h("CSeq", `${cseq} ACK`),
    h("Content-Length", "0"),
  ]

  return makeRequest("ACK", toUri, headers)
}

/**
 * Builds a relayed ACK for the b-leg, preserving the original body (may contain SDP).
 * Via and Contact are placeholders.
 */
export function buildRelayedAck(
  origAck: SipRequest,
  callId: string,
  fromTag: string,
  toTag: string,
  toUri: string,
  cseq: number = 1,
  fromUri?: string
): SipRequest {
  const body = origAck.body
  const from = fromUri ?? toUri

  const headers: SipHeader[] = [
    h("Via", "__PLACEHOLDER__"),
    h("Max-Forwards", "70"),
    h("From", `<${from}>;tag=${fromTag}`),
    h("To", toTag ? `<${toUri}>;tag=${toTag}` : `<${toUri}>`),
    h("Call-ID", callId),
    h("CSeq", `${cseq} ACK`),
    h("Contact", "__PLACEHOLDER__"),
  ]
  copyTransparentHeaders(origAck.headers, headers)
  headers.push(h("Content-Length", String(body.byteLength)))

  return makeRequest("ACK", toUri, headers, body)
}

// ---------------------------------------------------------------------------
// BYE
// ---------------------------------------------------------------------------

/** Builds a BYE request. Via and Contact are placeholders. */
export function buildBye(
  callId: string,
  fromTag: string,
  toTag: string,
  toUri: string,
  cseq: number,
  fromUri?: string
): SipRequest {
  const from = fromUri ?? toUri
  const headers: SipHeader[] = [
    h("Via", "__PLACEHOLDER__"),
    h("Max-Forwards", "70"),
    h("From", `<${from}>;tag=${fromTag}`),
    h("To", `<${toUri}>;tag=${toTag}`),
    h("Call-ID", callId),
    h("CSeq", `${cseq} BYE`),
    h("Content-Length", "0"),
  ]

  return makeRequest("BYE", toUri, headers)
}

/**
 * Builds a relayed BYE from one leg to the other with translated headers.
 * Via and Contact are placeholders.
 */
export function buildRelayedBye(
  origBye: SipRequest,
  callId: string,
  fromTag: string,
  toTag: string,
  toUri: string,
  cseq: string,
  direction: "a-to-b" | "b-to-a",
  fromUri?: string
): SipRequest {
  const from = fromUri ?? toUri
  const headers: SipHeader[] = [
    h("Via", "__PLACEHOLDER__"),
    h("Max-Forwards", "70"),
    h("From", `<${from}>;tag=${fromTag}`),
    h("To", `<${toUri}>;tag=${toTag}`),
    h("Call-ID", callId),
    h("CSeq", cseq),
  ]
  copyTransparentHeaders(origBye.headers, headers)
  headers.push(h("Content-Length", "0"))

  return makeRequest("BYE", toUri, headers)
}

// ---------------------------------------------------------------------------
// CANCEL
// ---------------------------------------------------------------------------

/** Builds a CANCEL for an outgoing INVITE. Via and Contact are placeholders. */
export function buildCancel(
  callId: string,
  fromTag: string,
  toUri: string,
  cseq: number,
  fromUri?: string
): SipRequest {
  const from = fromUri ?? toUri
  const headers: SipHeader[] = [
    h("Via", "__PLACEHOLDER__"),
    h("Max-Forwards", "70"),
    h("From", `<${from}>;tag=${fromTag}`),
    h("To", `<${toUri}>`),
    h("Call-ID", callId),
    h("CSeq", `${cseq} CANCEL`),
    h("Content-Length", "0"),
  ]

  return makeRequest("CANCEL", toUri, headers)
}

// ---------------------------------------------------------------------------
// 200 OK (for BYE, CANCEL, OPTIONS)
// ---------------------------------------------------------------------------

/** Builds a 200 OK mirroring the original request's key headers. */
export function build200Ok(request: SipRequest): SipResponse {
  const from = getHeader(request.headers, "from") ?? ""
  const to = ensureToTag(getHeader(request.headers, "to") ?? "")
  const callId = getHeader(request.headers, "call-id") ?? ""
  const cseq = getHeader(request.headers, "cseq") ?? ""
  const via = getHeader(request.headers, "via") ?? ""

  const headers: SipHeader[] = [
    h("Via", via),
    h("From", from),
    h("To", to),
    h("Call-ID", callId),
    h("CSeq", cseq),
    h("Contact", "__PLACEHOLDER__"),
    h("Content-Length", "0"),
  ]

  return makeResponse(200, "OK", headers)
}

/** Builds a 487 Request Terminated response. */
export function build487(request: SipRequest): SipResponse {
  const from = getHeader(request.headers, "from") ?? ""
  const to = ensureToTag(getHeader(request.headers, "to") ?? "")
  const callId = getHeader(request.headers, "call-id") ?? ""
  const cseq = getHeader(request.headers, "cseq") ?? ""
  const via = getHeader(request.headers, "via") ?? ""

  const headers: SipHeader[] = [
    h("Via", via),
    h("From", from),
    h("To", to),
    h("Call-ID", callId),
    h("CSeq", cseq),
    h("Content-Length", "0"),
  ]

  return makeResponse(487, "Request Terminated", headers)
}

/** Builds a 491 Request Pending response (re-INVITE glare). */
export function build491(request: SipRequest): SipResponse {
  const from = getHeader(request.headers, "from") ?? ""
  const to = ensureToTag(getHeader(request.headers, "to") ?? "")
  const callId = getHeader(request.headers, "call-id") ?? ""
  const cseq = getHeader(request.headers, "cseq") ?? ""
  const via = getHeader(request.headers, "via") ?? ""

  const headers: SipHeader[] = [
    h("Via", via),
    h("From", from),
    h("To", to),
    h("Call-ID", callId),
    h("CSeq", cseq),
    h("Content-Length", "0"),
  ]

  return makeResponse(491, "Request Pending", headers)
}

/** Builds a 100 Trying response. */
export function build100Trying(request: SipRequest): SipResponse {
  const from = getHeader(request.headers, "from") ?? ""
  const to = getHeader(request.headers, "to") ?? ""
  const callId = getHeader(request.headers, "call-id") ?? ""
  const cseq = getHeader(request.headers, "cseq") ?? ""
  const via = getHeader(request.headers, "via") ?? ""

  const headers: SipHeader[] = [
    h("Via", via),
    h("From", from),
    h("To", to),
    h("Call-ID", callId),
    h("CSeq", cseq),
    h("Content-Length", "0"),
  ]

  return makeResponse(100, "Trying", headers)
}

// ---------------------------------------------------------------------------
// Reject response (4xx/5xx/6xx)
// ---------------------------------------------------------------------------

/** Builds a SIP error response to reject an incoming request. */
export function buildRejectResponse(
  request: SipRequest,
  statusCode: number,
  reason: string
): SipResponse {
  const from = getHeader(request.headers, "from") ?? ""
  const to = ensureToTag(getHeader(request.headers, "to") ?? "")
  const callId = getHeader(request.headers, "call-id") ?? ""
  const cseq = getHeader(request.headers, "cseq") ?? ""
  const via = getHeader(request.headers, "via") ?? ""

  const headers: SipHeader[] = [
    h("Via", via),
    h("From", from),
    h("To", to),
    h("Call-ID", callId),
    h("CSeq", cseq),
    h("Contact", "__PLACEHOLDER__"),
    h("Content-Length", "0"),
  ]

  return makeResponse(statusCode, reason, headers)
}

// ---------------------------------------------------------------------------
// Stateless 503 byte template (overload protection — Tier 1 / dispatcher)
// ---------------------------------------------------------------------------

/**
 * Build a stateless 503 Service Unavailable response by byte-slicing header
 * lines verbatim out of an inbound INVITE buffer. No JsSIP parse, no
 * transaction allocation, no fiber. Used by Tier 1 (UdpTransport) and the
 * dispatcher when the normal-new-call queue overflows.
 *
 * Required headers per RFC 3261 §8.2.6.2 are copied verbatim from the
 * request:
 *   - Via       (the topmost Via — what UAC needs to match the response)
 *   - From      (echoed)
 *   - To        (echoed without adding our own tag — see note below)
 *   - Call-ID
 *   - CSeq
 *
 * Note: we deliberately do NOT add a To-tag. The resulting ACK from the UAC
 * will therefore have no dialog context, so it cannot match anything in
 * TransactionLayer's dialog index and is dropped at the orphan-ACK rule.
 * This is the cheap-rejection contract.
 *
 * Returns null if the buffer doesn't look like a SIP request we can template
 * (in which case the caller should drop the packet silently).
 */
export function buildStatelessReject503Buffer(
  raw: Buffer,
  retryAfterSec: number
): Buffer | null {
  // Find header section end (CRLFCRLF or LFLF as a fallback)
  let headerEnd = raw.indexOf("\r\n\r\n")
  let lineSep: "\r\n" | "\n" = "\r\n"
  if (headerEnd === -1) {
    headerEnd = raw.indexOf("\n\n")
    if (headerEnd === -1) return null
    lineSep = "\n"
  }

  // Slice header section, walk lines, capture the first occurrence of each
  // required header verbatim (case-insensitive name match).
  const headerSection = raw.subarray(0, headerEnd).toString("ascii")
  const lines = headerSection.split(lineSep)
  if (lines.length < 2) return null

  // First line must be a request line — we only template responses to requests
  const requestLine = lines[0]!
  if (!requestLine.includes("SIP/2.0")) return null

  let viaLine: string | undefined
  let fromLine: string | undefined
  let toLine: string | undefined
  let callIdLine: string | undefined
  let cseqLine: string | undefined

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.length === 0) continue
    // Continuation line (starts with whitespace) belongs to previous header — skip
    if (line.charCodeAt(0) === 0x20 || line.charCodeAt(0) === 0x09) continue

    const colon = line.indexOf(":")
    if (colon === -1) continue
    const name = line.slice(0, colon).trim().toLowerCase()

    switch (name) {
      case "via":
      case "v":
        if (viaLine === undefined) viaLine = line
        break
      case "from":
      case "f":
        if (fromLine === undefined) fromLine = line
        break
      case "to":
      case "t":
        if (toLine === undefined) toLine = line
        break
      case "call-id":
      case "i":
        if (callIdLine === undefined) callIdLine = line
        break
      case "cseq":
        if (cseqLine === undefined) cseqLine = line
        break
    }

    if (viaLine && fromLine && toLine && callIdLine && cseqLine) break
  }

  if (!viaLine || !fromLine || !toLine || !callIdLine || !cseqLine) {
    return null
  }

  // Normalize header names for the response (use canonical form on output)
  const normalizeHeaderLine = (line: string, canonicalName: string): string => {
    const colon = line.indexOf(":")
    return canonicalName + line.slice(colon)
  }

  const responseLines = [
    "SIP/2.0 503 Service Unavailable",
    normalizeHeaderLine(viaLine, "Via"),
    normalizeHeaderLine(fromLine, "From"),
    normalizeHeaderLine(toLine, "To"),
    normalizeHeaderLine(callIdLine, "Call-ID"),
    normalizeHeaderLine(cseqLine, "CSeq"),
    `Reason: SIP;cause=503;text="overload"`,
    `Retry-After: ${retryAfterSec}`,
    "Content-Length: 0",
    "",
    "",
  ]

  return Buffer.from(responseLines.join("\r\n"), "ascii")
}

/**
 * Compute a jittered Retry-After value (seconds).
 */
export function jitteredRetryAfter(baseSec: number, jitterSec: number): number {
  if (jitterSec <= 0) return baseSec
  return baseSec + Math.floor(Math.random() * (jitterSec + 1))
}

/**
 * Check whether a parsed SIP request carries an emergency Resource-Priority
 * header (esnet.0 / wps.0 / q735.0). Used by the Tier 3 admission controller
 * and InitialInviteHandler / SipRouter to set `call.emergency`.
 *
 * Case-insensitive header lookup; case-sensitive value match (canonical
 * casing required by the upstream contract — see docs/overload-protection.md).
 */
export function isEmergencyRequest(req: SipRequest): boolean {
  const value = getHeader(req.headers, "resource-priority")
  if (value === undefined) return false
  return (
    value.indexOf("esnet.0") !== -1 ||
    value.indexOf("wps.0") !== -1 ||
    value.indexOf("q735.0") !== -1
  )
}

// ---------------------------------------------------------------------------
// Cheap byte-level classifier helpers (overload protection)
// ---------------------------------------------------------------------------

/**
 * Quick check: does the buffer start with "INVITE " (i.e. is this a new-INVITE
 * request, before parsing)? Returns false for ACK/BYE/CANCEL/responses.
 */
export function isInviteRequestBuffer(raw: Buffer): boolean {
  if (raw.length < 7) return false
  // "INVITE " = 0x49 0x4E 0x56 0x49 0x54 0x45 0x20
  return (
    raw[0] === 0x49 &&
    raw[1] === 0x4e &&
    raw[2] === 0x56 &&
    raw[3] === 0x49 &&
    raw[4] === 0x54 &&
    raw[5] === 0x45 &&
    raw[6] === 0x20
  )
}

/**
 * Cheap byte scan: does the buffer carry an emergency Resource-Priority?
 * Matches `Resource-Priority:` (case-sensitive — canonical casing required by
 * the contract documented in docs/overload-protection.md) followed within the
 * same line by one of `esnet.0`, `wps.0`, `q735.0`.
 *
 * Also matches the dispatcher-side markers `;emerg=1` (Request-URI) or `;em=1`
 * (Via custom param) which subsequent in-dialog packets carry once an
 * emergency call has been admitted.
 */
export function bufferHasEmergencyMarker(raw: Buffer): boolean {
  // Cheap path: dispatcher-side markers stamped on admitted calls
  if (raw.indexOf(";emerg=1") !== -1) return true
  if (raw.indexOf(";em=1") !== -1) return true

  // Initial INVITE: Resource-Priority header (case-sensitive canonical)
  const rpIdx = raw.indexOf("Resource-Priority:")
  if (rpIdx === -1) return false
  // Find end of that header line
  const lineEnd = raw.indexOf("\r\n", rpIdx)
  const slice = lineEnd === -1 ? raw.subarray(rpIdx) : raw.subarray(rpIdx, lineEnd)
  const value = slice.toString("ascii")
  return (
    value.indexOf("esnet.0") !== -1 ||
    value.indexOf("wps.0") !== -1 ||
    value.indexOf("q735.0") !== -1
  )
}

/**
 * Cheap byte scan: does the buffer have a To-tag (`;tag=` after the To header)?
 * Used to distinguish initial INVITE (no tag) from in-dialog INVITE/ACK/BYE.
 */
export function bufferHasToTag(raw: Buffer): boolean {
  // Find To header line — must be at line start (avoid matching "History-Info" etc.)
  // SIP allows "t" as compact form too.
  let idx = 0
  while (idx < raw.length) {
    const lineStart = idx
    const lineEnd = raw.indexOf("\r\n", lineStart)
    if (lineEnd === -1) return false
    const lineLen = lineEnd - lineStart
    if (lineLen === 0) return false // end of headers

    // Match "To:" or "To " or "t:" or "t " at line start (case-sensitive
    // canonical — same contract as Resource-Priority).
    const c0 = raw[lineStart]
    if (c0 === 0x54 /*'T'*/ && raw[lineStart + 1] === 0x6f /*'o'*/) {
      const c2 = raw[lineStart + 2]
      if (c2 === 0x3a /*':'*/ || c2 === 0x20 /*' '*/) {
        // Found To header — scan its value for ;tag=
        const lineSlice = raw.subarray(lineStart, lineEnd)
        return lineSlice.indexOf(";tag=") !== -1
      }
    } else if (c0 === 0x74 /*'t'*/ && (raw[lineStart + 1] === 0x3a || raw[lineStart + 1] === 0x20)) {
      const lineSlice = raw.subarray(lineStart, lineEnd)
      return lineSlice.indexOf(";tag=") !== -1
    }

    idx = lineEnd + 2
  }
  return false
}

// ---------------------------------------------------------------------------
// OPTIONS (keepalive)
// ---------------------------------------------------------------------------

/** Builds an OPTIONS request for in-dialog keepalive. Via and Contact are placeholders. */
export function buildOptions(
  callId: string,
  fromTag: string,
  toTag: string,
  toUri: string,
  cseq: number,
  fromUri?: string
): SipRequest {
  const from = fromUri ?? toUri
  const headers: SipHeader[] = [
    h("Via", "__PLACEHOLDER__"),
    h("Max-Forwards", "70"),
    h("From", `<${from}>;tag=${fromTag}`),
    h("To", `<${toUri}>;tag=${toTag}`),
    h("Call-ID", callId),
    h("CSeq", `${cseq} OPTIONS`),
    h("Contact", "__PLACEHOLDER__"),
    h("Accept", "application/sdp"),
    h("Content-Length", "0"),
  ]

  return makeRequest("OPTIONS", toUri, headers)
}

// ---------------------------------------------------------------------------
// PRACK relay
// ---------------------------------------------------------------------------

/** Builds a relayed PRACK. Via and Contact are placeholders. */
export function buildRelayedPrack(
  origPrack: SipRequest,
  callId: string,
  fromTag: string,
  toTag: string,
  toUri: string,
  cseq: number,
  rack: string,
  fromUri?: string
): SipRequest {
  const body = origPrack.body
  const from = fromUri ?? toUri

  const headers: SipHeader[] = [
    h("Via", "__PLACEHOLDER__"),
    h("Max-Forwards", "70"),
    h("From", `<${from}>;tag=${fromTag}`),
    h("To", `<${toUri}>;tag=${toTag}`),
    h("Call-ID", callId),
    h("CSeq", `${cseq} PRACK`),
    h("Contact", "__PLACEHOLDER__"),
    h("RAck", rack),
  ]
  copyTransparentHeaders(origPrack.headers, headers)
  headers.push(h("Content-Length", String(body.byteLength)))

  return makeRequest("PRACK", toUri, headers, body)
}

// ---------------------------------------------------------------------------
// re-INVITE relay
// ---------------------------------------------------------------------------

/** Builds a relayed re-INVITE. Via and Contact are placeholders. Preserves body (SDP) and passthrough headers. */
export function buildRelayedReInvite(
  origInvite: SipRequest,
  callId: string,
  fromTag: string,
  toTag: string,
  toUri: string,
  cseq: number,
  fromUri?: string
): SipRequest {
  const body = origInvite.body
  const from = fromUri ?? toUri

  const headers: SipHeader[] = [
    h("Via", "__PLACEHOLDER__"),
    h("Max-Forwards", "70"),
    h("From", `<${from}>;tag=${fromTag}`),
    h("To", `<${toUri}>;tag=${toTag}`),
    h("Call-ID", callId),
    h("CSeq", `${cseq} INVITE`),
    h("Contact", "__PLACEHOLDER__"),
  ]
  copyTransparentHeaders(origInvite.headers, headers)
  headers.push(h("Content-Length", String(body.byteLength)))

  return makeRequest("INVITE", toUri, headers, body)
}
