/**
 * SIP header parser — extracts name:value pairs from the header section.
 *
 * Handles:
 * - Header folding (CRLF followed by SP/HTAB → unfold to single SP)
 * - Compact form expansion (v → Via, m → Contact, etc.)
 * - Content-Length extraction for body slicing
 * - Case-preserving header names
 *
 * No regex. All parsing via Scanner byte-level operations.
 */

import type { SipHeader } from "../../types.js"
import { Scanner, COLON, CR, LF, HTAB, isWSP, isTokenChar, strictNonNegativeDecimal } from "./scanner.js"
import { expandCompactForm } from "./compact-forms.js"
import type { SipParserLimits } from "../interface.js"

/**
 * Numeric-header registry — every header whose value must be a non-negative
 * decimal integer within a defined range. The strict validator runs in the
 * headers loop so any non-conformant value rejects the whole message at the
 * parser boundary.
 *
 * Using `strictNonNegativeDecimal` (byte-level `[0-9]+` check) rules out
 * float-injection (`1.5e10` ≠ integer), hex (`0x10`), octal (`0o10`),
 * scientific notation, signed forms (`+10` / `-10`), and surrounding
 * whitespace inside the value — every shape `parseInt(_, 10)` historically
 * silently accepted. See ADR-0007.
 *
 * Headers covered here:
 *  - Content-Length (§20.14, 0..2^31-1) — bounds body slicing.
 *  - CSeq seq      (§20.16, 0..2^31-1) — full CSeq grammar enforced in
 *                                       extract-fields.ts (digits + method).
 *  - Max-Forwards  (§20.22, 0..255)    — loop guard.
 *  - Expires       (§20.19, 0..2^32-1) — registration duration.
 *  - Min-Expires   (§20.23, 0..2^32-1) — registrar minimum.
 *  - Session-Expires (RFC 4028 §4)     — integer prefix only; refresher param
 *                                       (`;refresher=uac`) is split off and
 *                                       only the digit prefix is checked.
 *  - Min-SE        (RFC 4028 §5)       — integer prefix only.
 */
const UINT_32_MAX = 2 ** 32 - 1
const INT_32_MAX = 2 ** 31 - 1

interface NumericHeaderRule {
  readonly max: number
  /** True if value may carry `;param=...` tail (RFC 4028 session timers). */
  readonly allowParamTail?: boolean
}

const NUMERIC_HEADERS: Readonly<Record<string, NumericHeaderRule>> = {
  "content-length": { max: INT_32_MAX },
  "cseq": { max: INT_32_MAX },
  "max-forwards": { max: 255 },
  "expires": { max: UINT_32_MAX },
  "min-expires": { max: UINT_32_MAX },
  "session-expires": { max: UINT_32_MAX, allowParamTail: true },
  "min-se": { max: UINT_32_MAX, allowParamTail: true },
}

/**
 * Strict numeric extraction with optional param tail. For CSeq, the digit
 * prefix is followed by LWS + method — the LWS is taken as the terminator
 * and `parseHeaderValue` already trimmed nothing inside the value so any
 * non-digit byte (including space) ends the digit run.
 */
function extractStrictNumericPrefix(value: string, rule: NumericHeaderRule): number | undefined {
  let end = value.length
  if (rule.allowParamTail) {
    const semi = value.indexOf(";")
    if (semi >= 0) end = semi
  }
  // CSeq value is "1*DIGIT LWS Method" — terminate digit scan at first WSP.
  let i = 0
  for (; i < end; i++) {
    const c = value.charCodeAt(i)
    if (c === 0x20 || c === 0x09) break
  }
  return strictNonNegativeDecimal(value.slice(0, i).trim(), rule.max)
}

export interface ParsedHeaders {
  readonly headers: SipHeader[]
  readonly contentLength: number
}

/**
 * Parse all headers from current scanner position until double-CRLF.
 * Advances the scanner past the blank line (end-of-headers marker).
 */
export function parseHeaders(s: Scanner, limits: SipParserLimits): ParsedHeaders {
  const headers: SipHeader[] = []
  let contentLength = 0

  while (true) {
    // Check for end of headers (blank line)
    if (s.atEndOfHeaders()) {
      s.consumeEndOfHeaders()
      break
    }

    // EOF without blank line
    if (s.pos >= s.buf.length) break

    // Read header name: bytes until colon
    const rawName = readHeaderName(s)
    if (rawName.length === 0) {
      throw new Error(`Empty header name at position ${s.pos}`)
    }

    // Consume colon
    s.expect(COLON)

    // Skip optional LWS after colon
    s.skipLWS()

    // Read header value with folding support
    const value = s.readHeaderValue()

    // Expand compact forms
    const name = expandCompactForm(rawName)

    const trimmedValue = value.trim()
    const lowerName = name.toLowerCase()

    // Bound per-header memory cost: name + ": " + value, post-unfold/trim.
    const headerLen = name.length + 2 + trimmedValue.length
    if (headerLen > limits.maxHeaderLength) {
      throw new Error(
        `Header "${name}" length ${headerLen} exceeds limit ${limits.maxHeaderLength}`
      )
    }

    // Numeric-header strict validation. Registry-driven paranoid digit-only
    // pass — rejects floats, hex, octal, scientific notation, signed values,
    // inline whitespace, and anything `parseInt` would silently coerce.
    const numericRule = NUMERIC_HEADERS[lowerName]
    if (numericRule !== undefined) {
      const parsed = extractStrictNumericPrefix(trimmedValue, numericRule)
      if (parsed === undefined) {
        throw new Error(`Invalid ${name} numeric value: "${trimmedValue}"`)
      }
      if (lowerName === "content-length") {
        contentLength = parsed
      }
    }

    // For headers whose grammar uses quoted-string (display names, auth
    // params, contact params, etc.), reject unterminated quotes — see
    // CVE-2023-27599 (OpenSIPS parse_to_param crash on `a="T\` at EOL).
    // Generic readHeaderValue is context-free and cannot enforce this
    // because Call-ID's `word` grammar (RFC 3261) allows bare `"`.
    if (QUOTED_STRING_HEADERS.has(lowerName) && hasUnbalancedQuotes(trimmedValue)) {
      throw new Error(`Unterminated quoted-string in ${name} header`)
    }

    // Digest credentials (RFC 3261 §22.4) must be comma-separated
    // name=value pairs. The OpenSIPS PoC `Digest a a="",real` is a bare
    // token + orphan token shape that crashed parse_param_name (CVE-2023-28098).
    if (AUTHORIZATION_HEADERS.has(lowerName) && !isValidDigestCredentials(trimmedValue)) {
      throw new Error(`Malformed Digest credentials in ${name} header`)
    }

    headers.push({ name, value: trimmedValue })
  }

  return { headers, contentLength }
}

/**
 * Headers whose RFC 3261 grammar can carry a quoted-string. A `"` inside
 * one of these values must be properly paired (with `\<any>` escape support).
 */
const QUOTED_STRING_HEADERS = new Set([
  "to",
  "from",
  "contact",
  "reply-to",
  "refer-to",
  "subject",
  "authorization",
  "proxy-authorization",
  "www-authenticate",
  "proxy-authenticate",
  "authentication-info",
  "warning",
  "alert-info",
  "call-info",
  "error-info",
])

/**
 * True iff `value` contains an unterminated quoted-string.
 * Inside a quoted-string, `\<any>` is an escape pair — neither byte
 * influences quote state. Bytes outside a quoted-string are ignored.
 */
function hasUnbalancedQuotes(value: string): boolean {
  let inQuote = false
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (inQuote) {
      if (c === 0x5c) {
        // Escape pair — skip next char, do not toggle.
        i++
        continue
      }
      if (c === 0x22) {
        inQuote = false
      }
      continue
    }
    if (c === 0x22) {
      inQuote = true
    }
  }
  return inQuote
}

/**
 * Read header name bytes until colon.
 *
 * RFC 3261 §25.1 says header-name is a `token`, but real-world SIP traffic
 * (and RFC 4475 §3.1.1.2 itself) carries extension headers with chars that
 * fall outside the strict token grammar. We therefore reject only the
 * unambiguously-illegal bytes: CTL (0x00–0x1F except HTAB) and DEL (0x7F).
 * That catches CVE-2023-27598 (OpenSIPS parse_via crash on a `\x16ia:`-style
 * header line) while preserving the wide-range torture test.
 *
 * Trailing whitespace before the colon (e.g. `TO :`) is permitted by
 * RFC 4475 §3.1.1.1 — we read the name, then skip WSP up to the colon.
 */
function readHeaderName(s: Scanner): string {
  const start = s.pos
  while (s.pos < s.buf.length) {
    const b = s.buf[s.pos]!
    if (b === COLON || b === CR || b === LF) break
    if (isWSP(b)) break
    if (isIllegalHeaderNameByte(b)) {
      throw new Error(`Illegal byte 0x${b.toString(16)} in header name at position ${s.pos}`)
    }
    s.pos++
  }
  const name = s.buf.toString("utf-8", start, s.pos)
  // Skip optional WSP between name and colon (RFC 4475 §3.1.1.1).
  s.skipWSP()
  return name
}

/** CTL bytes (0x00-0x1F except HTAB) and DEL (0x7F) never belong in a header name. */
function isIllegalHeaderNameByte(b: number): boolean {
  if (b === HTAB) return false
  if (b < 0x20) return true
  if (b === 0x7f) return true
  return false
}

const AUTHORIZATION_HEADERS = new Set(["authorization", "proxy-authorization"])

/**
 * Validate a credentials header value (Authorization / Proxy-Authorization).
 * Only the `Digest` scheme is grammar-checked; other schemes pass through.
 *
 * For Digest: after the scheme, the value must be one or more comma-separated
 * `name=value` pairs (RFC 3261 §22.4). The name must be a non-empty token;
 * the value may be a token or a quoted-string. Bare tokens (no `=`) and
 * empty parts reject.
 */
function isValidDigestCredentials(value: string): boolean {
  const SCHEME = "digest"
  const lower = value.toLowerCase()
  if (!lower.startsWith(SCHEME)) return true // not Digest; skip
  const afterScheme = value.length > SCHEME.length ? value.charCodeAt(SCHEME.length) : -1
  if (afterScheme !== -1 && !isWSP(afterScheme)) return true // e.g. "Digestion" — not the Digest scheme
  const params = value.slice(SCHEME.length).trimStart()
  if (params.length === 0) return false

  const parts = splitTopLevelCommas(params)
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed.length === 0) return false
    const eqIdx = findUnquotedEquals(trimmed)
    if (eqIdx < 0) return false
    const name = trimmed.slice(0, eqIdx).trimEnd()
    if (name.length === 0) return false
    for (let i = 0; i < name.length; i++) {
      if (!isTokenChar(name.charCodeAt(i))) return false
    }
  }
  return true
}

/** Split a string on `,` that is not inside a quoted-string. */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = []
  let inQuote = false
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (inQuote) {
      if (c === 0x5c) { i++; continue } // escape pair
      if (c === 0x22) inQuote = false
      continue
    }
    if (c === 0x22) { inQuote = true; continue }
    if (c === 0x2c) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts
}

/** Index of the first `=` outside a quoted-string, or -1. */
function findUnquotedEquals(s: string): number {
  let inQuote = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (inQuote) {
      if (c === 0x5c) { i++; continue }
      if (c === 0x22) inQuote = false
      continue
    }
    if (c === 0x22) { inQuote = true; continue }
    if (c === 0x3d) return i
  }
  return -1
}
