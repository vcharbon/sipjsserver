/**
 * StickinessCookie — B2BUA-side parser for the proxy's Record-Route
 * stickiness cookie (HA-resilience plan, Slice 5 / D7 / D15).
 *
 * The proxy stamps a `Record-Route` URI of the form:
 *
 *   <sip:proxy:port;w_pri=<id>;w_bak=<id>;v=2;kid=<id>;sig=<base64url>;lr>
 *
 * (See `LoadBalancer.encodeStickiness` + `ProxyCore.buildRecordRouteValue`.)
 *
 * The B2BUA only consumes `w_pri` and `w_bak` here. HMAC signature
 * verification is the proxy's job — by the time the INVITE reaches a
 * worker, the proxy has already validated the cookie and refused or
 * re-routed if it was tampered with. The B2BUA reads the trusted
 * ordinals to populate `Call._topology` (D7) for the dual-write
 * fan-out (Slice 5 phase D).
 *
 * Returns `null` when:
 *   - no Record-Route header present (single-worker / dev / test
 *     without a proxy in front),
 *   - the header is malformed,
 *   - `w_pri` is missing or empty (cookie not v2),
 *   - `v` is present but not "2" (forward-compat reject).
 *
 * Empty `w_bak` is allowed (single-worker cluster) and surfaces as
 * `bak: ""`. Callers decide whether to skip the dual-write.
 */

import type { SipHeader } from "../sip/types.js"
import { getHeader, parseSipUri } from "../sip/MessageHelpers.js"

/**
 * Cookie payload the B2BUA cares about. The opaque ordinals are
 * preserved verbatim — they round-trip into `Call._topology.{pri,bak}`
 * and onto outgoing peer-cache writes.
 */
export interface StickinessCookieInfo {
  readonly pri: string
  readonly bak: string
}

/**
 * Parse the stickiness cookie out of an inbound INVITE's top-most
 * Record-Route header. Returns `null` on every "not present / not
 * usable" branch (see module header). Caller substitutes a
 * self-as-primary fallback when needed.
 */
export function parseStickinessCookie(
  headers: ReadonlyArray<SipHeader>
): StickinessCookieInfo | null {
  // Top-most Record-Route is the one stamped by the inner-most proxy
  // (RFC 3261 §16.6.4). For our topology that's the front proxy that
  // selected this worker.
  const rrValue = getHeader(headers, "record-route")
  if (rrValue === undefined || rrValue.length === 0) return null

  const uri = parseSipUri(rrValue)
  if (uri === undefined) return null

  const pri = uri.params["w_pri"]
  if (pri === undefined || pri.length === 0) return null

  // v=2 only — earlier versions are rejected (matches the proxy's
  // decodeStickiness which also rejects mismatched versions).
  const version = uri.params["v"]
  if (version !== undefined && version !== "2") return null

  const bak = uri.params["w_bak"] ?? ""

  return { pri, bak }
}
