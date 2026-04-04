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
import { Scanner, COLON, SP, HTAB, CR, LF, isWSP } from "./scanner.js"
import { expandCompactForm } from "./compact-forms.js"

export interface ParsedHeaders {
  readonly headers: SipHeader[]
  readonly contentLength: number
}

/**
 * Parse all headers from current scanner position until double-CRLF.
 * Advances the scanner past the blank line (end-of-headers marker).
 */
export function parseHeaders(s: Scanner): ParsedHeaders {
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

    // Validate and track Content-Length
    if (lowerName === "content-length") {
      const parsed = parseInt(trimmedValue, 10)
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2147483647) {
        throw new Error(`Invalid Content-Length: "${trimmedValue}"`)
      }
      contentLength = parsed
    }

    // Validate CSeq range (3.1.2.4 — overlarge scalars)
    if (lowerName === "cseq") {
      const seqNum = parseInt(trimmedValue, 10)
      if (Number.isFinite(seqNum) && seqNum > 2147483647) {
        throw new Error(`CSeq number exceeds 2^31 - 1: ${seqNum}`)
      }
    }

    // Validate Max-Forwards range
    if (lowerName === "max-forwards") {
      const mf = parseInt(trimmedValue, 10)
      if (Number.isFinite(mf) && (mf < 0 || mf > 255)) {
        throw new Error(`Max-Forwards out of range: ${mf}`)
      }
    }

    headers.push({ name, value: trimmedValue })
  }

  return { headers, contentLength }
}

/**
 * Read header name bytes until colon.
 * Header names are tokens per RFC 3261, but we're lenient here —
 * we accept any non-colon, non-CR, non-LF byte.
 * Trailing whitespace before the colon is trimmed.
 */
function readHeaderName(s: Scanner): string {
  const start = s.pos
  while (s.pos < s.buf.length) {
    const b = s.buf[s.pos]!
    if (b === COLON || b === CR || b === LF) break
    s.pos++
  }
  // Trim trailing whitespace from name
  let end = s.pos
  while (end > start && isWSP(s.buf[end - 1]!)) {
    end--
  }
  return s.buf.toString("utf-8", start, end)
}
