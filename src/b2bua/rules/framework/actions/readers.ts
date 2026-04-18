/**
 * Readers for SIP messages inside rule code.
 *
 * Exposed as free functions (not methods on `RuleContext`) because the
 * source of truth varies: the current event, the a-leg INVITE snapshot,
 * the held-SDP payload, etc. Forcing the caller to name the message
 * explicitly makes the source of every read visible at the call site.
 */

import type { SipMessage } from "../../../../sip/types.js"
import type { HeaderName } from "./types.js"

function headerKey(name: HeaderName): string {
  return name.name.toLowerCase()
}

/**
 * Read all values for a header name from a SIP message, preserving order.
 *
 * Returns an empty array when the header is absent. The lookup is
 * case-insensitive; for proprietary names the factory has already
 * lowercased the stored form.
 */
export function readHeaders(msg: SipMessage, name: HeaderName): ReadonlyArray<string> {
  const key = headerKey(name)
  const out: string[] = []
  for (const h of msg.headers) {
    if (h.name.toLowerCase() === key) out.push(h.value)
  }
  return out
}

/**
 * Read the raw body bytes of a SIP message, or `undefined` when empty.
 *
 * A zero-length body is modelled as "no body" (SIP Content-Length: 0
 * messages) so that rules can use `readBody(msg) ?? fallback` without
 * special-casing.
 */
export function readBody(msg: SipMessage): Uint8Array | undefined {
  const body = msg.body
  return body.byteLength === 0 ? undefined : body
}
