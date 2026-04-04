/**
 * Byte-level cursor scanner over a Buffer.
 * All character classification uses direct byte comparison — zero regex.
 */

// ASCII byte constants
const SP = 0x20     // space
const HTAB = 0x09   // horizontal tab
const CR = 0x0d     // \r
const LF = 0x0a     // \n
const COLON = 0x3a  // :

/** RFC 3261 token character: alphanum + -.!%*_+`'~ */
function isTokenChar(b: number): boolean {
  // A-Z
  if (b >= 0x41 && b <= 0x5a) return true
  // a-z
  if (b >= 0x61 && b <= 0x7a) return true
  // 0-9
  if (b >= 0x30 && b <= 0x39) return true
  // Special token chars: - . ! % * _ + ` ' ~
  switch (b) {
    case 0x2d: // -
    case 0x2e: // .
    case 0x21: // !
    case 0x25: // %
    case 0x2a: // *
    case 0x5f: // _
    case 0x2b: // +
    case 0x60: // `
    case 0x27: // '
    case 0x7e: // ~
      return true
  }
  return false
}

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39
}

function isWSP(b: number): boolean {
  return b === SP || b === HTAB
}

export class Scanner {
  pos: number

  constructor(readonly buf: Buffer, pos = 0) {
    this.pos = pos
  }

  /** Peek at current byte without advancing. Returns -1 at end. */
  peek(): number {
    return this.pos < this.buf.length ? this.buf[this.pos]! : -1
  }

  /** Read current byte and advance. Returns -1 at end. */
  advance(): number {
    return this.pos < this.buf.length ? this.buf[this.pos++]! : -1
  }

  /** Skip over SP and HTAB characters. */
  skipWSP(): void {
    while (this.pos < this.buf.length && isWSP(this.buf[this.pos]!)) {
      this.pos++
    }
  }

  /**
   * Skip LWS: SP/HTAB, and header-folding (CRLF followed by SP/HTAB).
   * Used when reading header values after the colon.
   */
  skipLWS(): void {
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos]!
      if (isWSP(b)) {
        this.pos++
        continue
      }
      // Check for header folding: CRLF followed by WSP
      if (
        b === CR &&
        this.pos + 2 < this.buf.length &&
        this.buf[this.pos + 1] === LF &&
        isWSP(this.buf[this.pos + 2]!)
      ) {
        this.pos += 3 // skip CR LF WSP
        continue
      }
      break
    }
  }

  /** Read bytes until the given delimiter byte. Does not consume the delimiter. */
  readUntil(byte: number): string {
    const start = this.pos
    while (this.pos < this.buf.length && this.buf[this.pos] !== byte) {
      this.pos++
    }
    return this.buf.toString("utf-8", start, this.pos)
  }

  /** Read a RFC 3261 token (alphanum + special chars). */
  readToken(): string {
    const start = this.pos
    while (this.pos < this.buf.length && isTokenChar(this.buf[this.pos]!)) {
      this.pos++
    }
    return this.buf.toString("utf-8", start, this.pos)
  }

  /** Read 1+ digit characters and return as integer. Throws if no digits found. */
  readDigits(): number {
    const start = this.pos
    while (this.pos < this.buf.length && isDigit(this.buf[this.pos]!)) {
      this.pos++
    }
    if (this.pos === start) {
      throw new Error(`Expected digit at position ${this.pos}`)
    }
    return parseInt(this.buf.toString("utf-8", start, this.pos), 10)
  }

  /**
   * Read the rest of the line until CRLF, handling header folding.
   * Continuation lines (CRLF followed by SP/HTAB) are unfolded
   * by replacing the CRLF+WSP with a single SP.
   * Returns the unfolded string. Consumes the final CRLF.
   */
  readHeaderValue(): string {
    let result = ""
    const start = this.pos
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos]!
      if (b === CR) {
        // Append what we've accumulated
        result += this.buf.toString("utf-8", start === this.pos ? start : start, this.pos)
        if (this.pos + 1 < this.buf.length && this.buf[this.pos + 1] === LF) {
          // Check for continuation line
          if (
            this.pos + 2 < this.buf.length &&
            isWSP(this.buf[this.pos + 2]!)
          ) {
            // Header folding: replace CRLF+WSP with single SP
            result += " "
            this.pos += 3 // skip CR LF WSP
            return result + this.readHeaderValue() // continue reading
          }
          // End of header value
          this.pos += 2 // consume CRLF
          return result
        }
      }
      if (b === LF) {
        // Bare LF (lenient)
        result += this.buf.toString("utf-8", start, this.pos)
        // Check for continuation line
        if (this.pos + 1 < this.buf.length && isWSP(this.buf[this.pos + 1]!)) {
          result += " "
          this.pos += 2
          return result + this.readHeaderValue()
        }
        this.pos++ // consume LF
        return result
      }
      this.pos++
    }
    // EOF without CRLF — return what we have
    return result + this.buf.toString("utf-8", start, this.pos)
  }

  /** Expect and consume CRLF. Throws if not found. Also accepts bare LF. */
  expectCRLF(): void {
    if (this.pos < this.buf.length && this.buf[this.pos] === CR) {
      this.pos++
    }
    if (this.pos < this.buf.length && this.buf[this.pos] === LF) {
      this.pos++
      return
    }
    throw new Error(`Expected CRLF at position ${this.pos}`)
  }

  /** Expect and consume specific byte. */
  expect(byte: number): void {
    if (this.pos >= this.buf.length || this.buf[this.pos] !== byte) {
      throw new Error(
        `Expected byte 0x${byte.toString(16)} at position ${this.pos}, got 0x${(this.buf[this.pos] ?? -1).toString(16)}`
      )
    }
    this.pos++
  }

  /** Check if we're at a CRLF (or bare LF) boundary. */
  atCRLF(): boolean {
    if (this.pos >= this.buf.length) return false
    if (this.buf[this.pos] === LF) return true
    return (
      this.buf[this.pos] === CR &&
      this.pos + 1 < this.buf.length &&
      this.buf[this.pos + 1] === LF
    )
  }

  /**
   * Check if we're at the blank line marking end of headers.
   * Since readHeaderValue() already consumed each header's trailing CRLF,
   * the blank line is just a single CRLF (or bare LF) at this position.
   */
  atEndOfHeaders(): boolean {
    const p = this.pos
    const len = this.buf.length
    if (p >= len) return true // EOF counts as end of headers

    // CRLF (blank line)
    if (p + 1 < len && this.buf[p] === CR && this.buf[p + 1] === LF) return true

    // Bare LF (lenient)
    if (this.buf[p] === LF) return true

    return false
  }

  /** Consume the blank line (single CRLF or bare LF). */
  consumeEndOfHeaders(): void {
    if (this.pos < this.buf.length && this.buf[this.pos] === CR) this.pos++
    if (this.pos < this.buf.length && this.buf[this.pos] === LF) this.pos++
  }

  /** Remaining bytes in buffer. */
  remaining(): number {
    return this.buf.length - this.pos
  }

  /** Slice the underlying buffer. */
  slice(start: number, end: number): Buffer {
    return this.buf.subarray(start, end)
  }
}

export { isTokenChar, isDigit, isWSP, SP, HTAB, CR, LF, COLON }
