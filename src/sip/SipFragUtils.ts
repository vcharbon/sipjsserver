/**
 * Helpers for constructing `message/sipfrag` payloads (RFC 3420).
 *
 * Used by the REFER subscription NOTIFY sequence to echo the current state
 * of the transferred-to call back to the referrer.
 */

/**
 * Build a sipfrag body containing only a SIP status line.
 *
 * RFC 3420 §2.1: a sipfrag is any fragment of a SIP message. The minimal
 * fragment used by REFER (RFC 3515 §2.4.4) is the Status-Line from a
 * response to the referred-to transaction.
 *
 * Returns `SIP/2.0 <code> <reason>\r\n` as UTF-8 bytes. A single trailing
 * CRLF is required — further MIME encoding is not added here, callers place
 * this payload verbatim in the NOTIFY body.
 */
export function sipfragFromStatus(code: number, reason: string): Uint8Array {
  const line = `SIP/2.0 ${code} ${reason}\r\n`
  return new TextEncoder().encode(line)
}
