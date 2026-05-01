/**
 * MessageHelpers — SIP header accessors, structured-header parsers, identifier
 * generators, and byte-level dispatcher helpers (emergency / to-tag / 503
 * stateless reject).
 *
 * Message construction lives in `./generators.ts`. This module is the
 * transparent-parse side: it reads and rewrites existing headers rather than
 * constructing new ones.
 *
 * Identifier generators (newTag, newBranch, newCallId) read from the
 * current fiber's Effect `Random` reference via `Fiber.getCurrent`, so
 * tests pinning a seed with `Random.withSeed(...)` get a deterministic
 * stream while production keeps the default Math.random-backed RNG.
 * Outside an Effect fiber (top-level sync, vitest setup) the helpers
 * fall back to `Math.random` directly. The remaining exports are pure —
 * header parsing, byte-level classification, etc.
 */

import { Random } from "effect"
import * as Fiber from "effect/Fiber"
import type { SipHeader, SipRequest } from "./types.js"
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
 * Extracts the URI from a From/To header value (Name-Addr format).
 * Quote-aware — uses structured parser.
 */
export function extractNameAddrUri(headerValue: string): string {
  return parseNameAddr(headerValue).uri
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

/**
 * Resolve the current RNG: prefer the active fiber's `Random` reference
 * (so `Random.withSeed(...)` propagates), fall back to `Math.random`
 * when called outside any Effect fiber.
 *
 * Exported so that other modules with the same RFC-3261 nondeterminism
 * profile (e.g. `CallModel.randomInitialCSeq`) can reuse the same source
 * without depending on the Effect `Random` import directly.
 */
export function currentRng(): {
  nextDoubleUnsafe(): number
  nextIntUnsafe(): number
} {
  const fiber = Fiber.getCurrent()
  if (fiber !== undefined) return fiber.getRef(Random.Random)
  return {
    nextDoubleUnsafe: () => Math.random(),
    nextIntUnsafe: () =>
      Math.floor(
        Math.random() *
          (Number.MAX_SAFE_INTEGER - Number.MIN_SAFE_INTEGER + 1),
      ) + Number.MIN_SAFE_INTEGER,
  }
}

/** Generate a 16-byte sequence as 32 hex chars from the current fiber's RNG. */
function rngHex(rng: { nextIntUnsafe(): number }, byteCount: number): string {
  let hex = ""
  for (let i = 0; i < byteCount; i++) {
    hex += ((rng.nextIntUnsafe() >>> 0) & 0xff).toString(16).padStart(2, "0")
  }
  return hex
}

/** Build a v4 UUID string from the current fiber's RNG. */
function rngUuidV4(rng: { nextIntUnsafe(): number }): string {
  const bytes: number[] = []
  for (let i = 0; i < 16; i++) {
    bytes.push((rng.nextIntUnsafe() >>> 0) & 0xff)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = (n: number): string => n.toString(16).padStart(2, "0")
  return [
    bytes.slice(0, 4).map(hex).join(""),
    bytes.slice(4, 6).map(hex).join(""),
    bytes.slice(6, 8).map(hex).join(""),
    bytes.slice(8, 10).map(hex).join(""),
    bytes.slice(10, 16).map(hex).join(""),
  ].join("-")
}

export function newCallId(localHost: string): string {
  return `${rngUuidV4(currentRng())}@${localHost}`
}

export function newTag(): string {
  return currentRng().nextDoubleUnsafe().toString(36).slice(2, 10)
}

export function newBranch(): string {
  return `z9hG4bK${rngHex(currentRng(), 8)}`
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
 *
 * Stays synchronous (uses `Math.random`) because the only caller is the
 * UDP Tier-1 overload pre-ingress hook, which runs in a non-Effect
 * context. Overload-protection nondeterminism is explicitly out of
 * scope for the failover-test seeded-Random plumbing.
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

