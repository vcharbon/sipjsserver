/**
 * TargetAdmission — pre-flight check on b-leg destinations.
 *
 * The b2bua worker accepts call-control's `route.destination.host` verbatim
 * and hands it to the send path. A bogus host (e.g. `kindlab` from a
 * misconfigured fixture) flows through to `dgram.send`, where Node calls
 * `dns.lookup` and blocks the libuv threadpool for ~5 s on EAI_AGAIN.
 *
 * This module rejects targets whose host is neither an IP literal nor in
 * the allow-list at the decision boundary — before any state is allocated
 * for the b-leg. The proxy's `BufferedUdpEndpoint` quarantines the send
 * blocking even when admission lets a doomed target through; admission is
 * the cheap early filter.
 *
 * Allow-list semantics:
 *   - IPv4/IPv6 literals always pass (no DNS needed).
 *   - A list containing the literal `"*"` matches every host (rollback
 *     sentinel; restores pre-admission behavior without a redeploy).
 *   - Otherwise the host must end with one of the suffixes (case-
 *     insensitive). The suffix is matched verbatim — operators write
 *     `.svc.cluster.local` (with leading dot) to constrain to subdomains
 *     and avoid matching `example.svc.cluster.local.evil.com`.
 */

import { isIP } from "node:net"

export type AdmissionVerdict = "ip-literal" | "allow-listed" | "reject"

/**
 * Returns true if `host` is a valid IPv4 or IPv6 literal. Strips a single
 * pair of brackets (for IPv6 in URI form like `[::1]`).
 */
export const isIpLiteral = (host: string): boolean => {
  const stripped =
    host.length >= 2 && host.startsWith("[") && host.endsWith("]")
      ? host.slice(1, -1)
      : host
  return isIP(stripped) !== 0
}

/**
 * Returns true if any suffix in `suffixes` matches the host (case-
 * insensitive), or if the list contains the wildcard `"*"`.
 */
export const isAllowedSuffix = (
  host: string,
  suffixes: ReadonlyArray<string>,
): boolean => {
  for (const s of suffixes) {
    if (s === "*") return true
  }
  const lower = host.toLowerCase()
  for (const s of suffixes) {
    if (s === "*") continue
    if (lower.endsWith(s.toLowerCase())) return true
  }
  return false
}

/**
 * Classify a destination host against the suffix allow-list.
 *
 *   "ip-literal"   — short-circuit accept; no DNS will be required at send time.
 *   "allow-listed" — host matches the configured suffix policy.
 *   "reject"       — neither; admission gate emits 503 and terminates the call.
 */
export const classifyAdmission = (
  host: string,
  suffixes: ReadonlyArray<string>,
): AdmissionVerdict => {
  if (isIpLiteral(host)) return "ip-literal"
  if (isAllowedSuffix(host, suffixes)) return "allow-listed"
  return "reject"
}
