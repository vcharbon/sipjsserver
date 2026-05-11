/**
 * Built-in header registration entry point.
 *
 * The built-in headers (`from`, `to`, `via`, …, plus the lazy structured
 * set) are served directly out of the message's precomputed `.parsed` and
 * `.lazy` slots by the closure produced in header-registry.ts — there's
 * no double-parsing through the registry on the hot path.
 *
 * This module exists to:
 *
 *   1. Document the canonical built-in names a third party MUST NOT
 *      shadow (`registerStandardHeaders` doubles as a registry sanity
 *      check at startup).
 *   2. Provide the symmetric registration hook that PR 2 will use once
 *      the built-ins migrate off the `.parsed`/`.lazy` shortcut and
 *      register their parsers through the registry like everyone else.
 */

import type { SipHeaderRegistry } from "./header-registry.js"

/**
 * Canonical lowercase long-form names of the built-in headers that
 * `getHeader()` serves from precomputed `.parsed` / `.lazy` slots.
 * Listed for documentation and for the third-party extension test
 * that asserts these names cannot be re-registered.
 */
export const BUILTIN_HEADER_NAMES: ReadonlyArray<string> = [
  "from",
  "to",
  "call-id",
  "cseq",
  "via",
  "contact",
  "p-asserted-identity",
  "p-preferred-identity",
  "diversion",
  "history-info",
  "remote-party-id",
  "geolocation",
  "geolocation-error",
  "geolocation-routing",
  "rack",
  "refer-to",
]

/**
 * No-op for now — the built-ins are served by the closure in
 * header-registry.ts directly. Kept as the stable entry point the host
 * application calls at startup, so PR 2 can swap in real registrations
 * without changing any caller.
 *
 * Throws if anyone has pre-registered a third-party header whose name
 * collides with a built-in — that would be a startup-order bug.
 */
export function registerStandardHeaders(registry: SipHeaderRegistry): void {
  for (const name of BUILTIN_HEADER_NAMES) {
    if (registry.get(name) !== undefined) {
      throw new Error(
        `registerStandardHeaders: third-party registration for built-in header "${name}" was installed before the standard set — fix host bootstrap ordering`,
      )
    }
  }
}
