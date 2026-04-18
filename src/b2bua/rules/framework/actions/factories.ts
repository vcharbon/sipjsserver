/**
 * Factories for the rule-action ADTs.
 *
 * All construction of branded types (`BareSipUri`, `NameAddr`,
 * `HeaderName`) goes through this file. No `as` casts to a brand are
 * allowed in rule code — the factories are the single enforcement point
 * for the invariants each brand represents.
 */

import { parseNameAddr } from "../../../../sip/parsers/custom/structured-headers.js"
import type {
  BareSipUri,
  HeaderName,
  HeaderUpdate,
  KnownHeader,
  NameAddr,
} from "./types.js"

// ── URI constructors ──────────────────────────────────────────────────────

/** Typed error thrown by `toBareUri` / `toNameAddr` when input is unusable. */
export class SipUriSyntaxError extends Error {
  readonly _tag = "SipUriSyntaxError"
  constructor(readonly input: string, reason: string) {
    super(`Invalid SIP URI input: ${reason} — got ${JSON.stringify(input)}`)
    this.name = "SipUriSyntaxError"
  }
}

/**
 * Coerce a string into a `BareSipUri`. Accepts both the bare form
 * (`sip:...`) and the name-addr form (`"Display" <sip:...>;tag=...`);
 * in the latter case the URI *inside* the angle brackets is extracted.
 *
 * This is intentionally more permissive than the brand's strict grammar
 * because rule code frequently receives a raw header value (`Refer-To`,
 * `Contact`, etc.) and needs to turn it into a bare URI for use as a
 * Request-URI slot. The header parameters (tag, expires, …) are
 * discarded — they belong on the name-addr wrapper, not the URI.
 */
export function toBareUri(input: string | NameAddr): BareSipUri {
  const raw = (typeof input === "string" ? input : (input as string)).trim()
  if (raw.length === 0) {
    throw new SipUriSyntaxError(input as string, "empty string")
  }

  // If the value contains angle brackets or a display name, route through
  // the name-addr parser — it is quote-aware and strips header params.
  const hasAngle = raw.includes("<")
  if (hasAngle) {
    const parsed = parseNameAddr(raw)
    if (parsed.uri.length === 0) {
      throw new SipUriSyntaxError(input as string, "name-addr without URI")
    }
    if (!/^sips?:/i.test(parsed.uri)) {
      throw new SipUriSyntaxError(input as string, "URI missing sip:/sips: scheme")
    }
    return parsed.uri as BareSipUri
  }

  // Plain addr-spec. Accept only sip:/sips:.
  if (!/^sips?:/i.test(raw)) {
    throw new SipUriSyntaxError(input as string, "missing sip:/sips: scheme")
  }
  return raw as BareSipUri
}

/**
 * Wrap a `BareSipUri` into a `NameAddr`. Display name is optional and
 * passed through verbatim — the caller is responsible for quoting it if
 * it contains characters that require quoting (spaces, `,`, `;`, `<`, …).
 */
export function toNameAddr(uri: BareSipUri, display?: string): NameAddr {
  const prefix = display !== undefined && display.length > 0 ? `"${display}" ` : ""
  return `${prefix}<${uri as string}>` as NameAddr
}

/**
 * Read the header parameters (tag, expires, q, …) from a `NameAddr`.
 * Returns an empty map when none are present.
 */
export function tagsOf(addr: NameAddr): ReadonlyMap<string, string> {
  const parsed = parseNameAddr(addr as string)
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(parsed.params)) {
    if (typeof v === "string") out.set(k, v)
    else out.set(k, "")
  }
  return out
}

// ── HeaderName constructors ───────────────────────────────────────────────

const KNOWN_HEADERS: ReadonlyArray<KnownHeader> = [
  "From", "To", "Call-ID", "CSeq", "Via", "Contact",
  "Content-Type", "Content-Length", "Max-Forwards", "Expires",
  "Route", "Record-Route", "Supported", "Require",
  "Refer-To", "Refer-Sub", "Referred-By", "Replaces",
  "Diversion", "History-Info", "P-Asserted-Identity", "P-Preferred-Identity",
  "Subject", "User-Agent", "Allow", "Event", "Subscription-State",
  "RAck", "RSeq",
]

const KNOWN_LOWER: ReadonlySet<string> = new Set(KNOWN_HEADERS.map((n) => n.toLowerCase()))

/** Factory for a well-known header name. Typed and typo-proof. */
function knownHeader(name: KnownHeader): HeaderName {
  return { kind: "well-known", name }
}

/** Factory object giving `H.From`, `H.Contact`, … for every known header. */
export const H: { readonly [K in KnownHeader]: HeaderName } = Object.freeze(
  KNOWN_HEADERS.reduce((acc, name) => {
    ;(acc as Record<KnownHeader, HeaderName>)[name] = knownHeader(name)
    return acc
  }, {} as { [K in KnownHeader]: HeaderName }),
)

/**
 * Factory for a proprietary header name (X-*, P-*, bespoke).
 *
 * Throws if the caller passes a well-known name — those must use `H.*`
 * so that rule code can't accidentally take the lowercased/untyped path
 * around the typed surface.
 */
export function custom(name: string): HeaderName {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    throw new Error("custom() requires a non-empty header name")
  }
  if (KNOWN_LOWER.has(trimmed.toLowerCase())) {
    throw new Error(
      `custom(${JSON.stringify(name)}) is a well-known header — use H.${trimmed} instead`,
    )
  }
  return { kind: "proprietary", name: trimmed.toLowerCase() }
}

// ── HeaderUpdate constructors ─────────────────────────────────────────────

/**
 * Replace every occurrence of the header with the given non-empty
 * sequence of values, in order. At least one value is required at the
 * type level so that `replaceH()` cannot be used as a no-op / remove.
 */
export function replaceH(...values: [string, ...string[]]): HeaderUpdate {
  return { kind: "replace", values }
}

/** Remove every occurrence of the header. */
export function removeH(): HeaderUpdate {
  return { kind: "remove" }
}
