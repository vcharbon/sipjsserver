/**
 * SIP start-line parser — handles both Request-Line and Status-Line.
 *
 * Request-Line:  Method SP Request-URI SP SIP-Version CRLF
 * Status-Line:   SIP-Version SP Status-Code SP Reason-Phrase CRLF
 *
 * Uses the Scanner for byte-level access. No regex.
 */

import { Scanner, SP, CR, LF, isTokenChar } from "./scanner.js"

export interface RequestLine {
  readonly type: "request"
  readonly method: string
  readonly uri: string
  readonly version: string
}

export interface StatusLine {
  readonly type: "response"
  readonly version: string
  readonly status: number
  readonly reason: string
}

export type StartLine = RequestLine | StatusLine

/**
 * Parse the start line from the scanner.
 * Advances the scanner past the CRLF terminator.
 */
export function parseStartLine(s: Scanner): StartLine {
  // Read first token until SP
  const firstToken = readUntilSP(s)
  if (firstToken.length === 0) {
    throw new Error("Empty start line")
  }

  // Exactly one SP between elements (RFC 3261 §7.1)
  if (s.peek() !== SP) {
    throw new Error("Expected SP after first start-line token")
  }
  s.advance()

  // Multiple SP in request line is invalid (3.1.2.9)
  if (s.peek() === SP) {
    throw new Error("Multiple SP in start line")
  }

  // If first token starts with "SIP/" → Status-Line
  if (firstToken.startsWith("SIP/")) {
    return parseStatusLine(s, firstToken)
  }

  // Otherwise → Request-Line
  return parseRequestLine(s, firstToken)
}

function parseRequestLine(s: Scanner, method: string): RequestLine {
  // Request-URI: everything until next SP
  // Must not start with < (3.1.2.7)
  if (s.peek() === 0x3c) { // <
    throw new Error("Request-URI must not be enclosed in angle brackets")
  }

  const uri = readUntilSP(s)
  if (uri.length === 0) {
    throw new Error("Empty Request-URI")
  }

  // Exactly one SP before version
  if (s.peek() !== SP) {
    throw new Error("Expected SP after Request-URI")
  }
  s.advance()

  // SIP-Version: rest until CRLF, must not have trailing spaces (3.1.2.10)
  const version = readUntilCRLF(s)
  if (version !== version.trimEnd()) {
    throw new Error("Trailing whitespace in request line")
  }

  // Validate SIP version (3.1.2.16)
  if (version !== "SIP/2.0") {
    throw new Error(`Unsupported SIP version: "${version}"`)
  }

  s.expectCRLF()

  return { type: "request", method: method.toUpperCase(), uri, version }
}

function parseStatusLine(s: Scanner, version: string): StatusLine {
  // Validate SIP version
  if (version !== "SIP/2.0") {
    throw new Error(`Unsupported SIP version: "${version}"`)
  }

  // Status-Code: exactly 3 digits
  const statusStr = readUntilSP(s)
  const status = parseInt(statusStr, 10)
  if (!Number.isFinite(status) || statusStr.length !== 3) {
    throw new Error(`Invalid status code: "${statusStr}"`)
  }
  if (status < 100 || status > 699) {
    throw new Error(`Status code out of range: ${status}`)
  }

  // After status code there should be SP before reason phrase
  // But reason phrase may be empty (3.1.1.13), and the SP is optional in that case
  const b = s.peek()
  if (b === SP) {
    s.advance()
  }

  // Reason-Phrase: everything until CRLF (may be empty)
  const reason = readUntilCRLF(s)
  s.expectCRLF()

  return { type: "response", version, status, reason }
}

/** Read bytes until SP, without consuming the SP. */
function readUntilSP(s: Scanner): string {
  const start = s.pos
  while (s.pos < s.buf.length) {
    const b = s.buf[s.pos]!
    if (b === SP) break
    // Also stop at CRLF (for edge cases like empty reason phrase)
    if (b === CR || b === LF) break
    s.pos++
  }
  return s.buf.toString("utf-8", start, s.pos)
}

/** Read bytes until CRLF (or bare LF), without consuming the line ending. */
function readUntilCRLF(s: Scanner): string {
  const start = s.pos
  while (s.pos < s.buf.length) {
    const b = s.buf[s.pos]!
    if (b === CR || b === LF) break
    s.pos++
  }
  return s.buf.toString("utf-8", start, s.pos)
}
