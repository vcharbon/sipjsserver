/**
 * StickinessCookie — B2BUA-side parser for the proxy's Record-Route
 * stickiness cookie (HA-resilience plan, Slice 5 / D7 / D15).
 *
 * The proxy stamps a `Record-Route` URI of the form:
 *
 *   <sip:proxy:port;w_pri=<id>;w_bak=<id>;e=<0|1>;v=3;kid=<id>;sig=<base64url>;lr>
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
 *   - `w_pri` is missing or empty,
 *   - `v` is present but not in the accepted set.
 *
 * Accepted versions: "2" and "3". v=3 added `e=<0|1>` for emergency
 * tracking (slice 7 of the overload rework); B2BUA doesn't read `e`
 * but tolerates the bumped version so rolling deploys don't lose
 * topology information across the proxy/worker version boundary.
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

  // v=2 (legacy) and v=3 (with emergency flag — slice 7 of overload
  // rework) accepted. Anything else rejected.
  const version = uri.params["v"]
  if (version !== undefined && version !== "2" && version !== "3") return null

  const bak = uri.params["w_bak"] ?? ""

  return { pri, bak }
}
