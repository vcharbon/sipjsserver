/**
 * Runtime header registry — the runtime counterpart of the
 * `SipHeaderTypes` TS registry in types.ts.
 *
 * The host application installs built-ins via `registerStandardHeaders`
 * (see header-registry-defaults.ts) at module init. Third-party plugins
 * call `defaultRegistry.register({...})` for their custom headers and
 * extend `SipHeaderTypes` via TypeScript declaration merging:
 *
 *   declare module "<this-package>/sip/types.js" {
 *     interface SipHeaderTypes {
 *       "x-custom": Result.Result<MyParsed, SipParseError>
 *     }
 *   }
 *   defaultRegistry.register<MyParsed>({
 *     name: "x-custom",
 *     parse: (raws) => parseMyCustom(raws),
 *   })
 *
 * `getHeader(name)` on a message:
 *   1. Lowercases the input and resolves any compact-form alias.
 *   2. For built-in canonical names, reads from the precomputed eager
 *      slot record (From/To/Call-ID/CSeq/Via/Contact) or invokes the
 *      built-in lazy parser with per-message memoization.
 *   3. For third-party registered names, invokes the registered parser
 *      over the matching raw header values and memoizes the result per
 *      message instance.
 *   4. For unknown names, returns the raw `ReadonlyArray<string>` of
 *      matching header values (empty array when none present).
 */

import type {
  SipHeader,
  ParsedNameAddrField,
  ParsedViaField,
  ParsedContactField,
  ContactSet,
  ParsedCSeqField,
} from "./types.js"
import {
  parsePAssertedIdentity,
  parsePPreferredIdentity,
  parseDiversion,
  parseHistoryInfo,
  parseRemotePartyId,
  parseGeolocation,
  parseGeolocationError,
  parseGeolocationRouting,
  parseRackHeader,
  parseReferToHeader,
} from "./parsers/custom/lazy-parsers.js"

export interface HeaderDescriptor<T> {
  /** Canonical lowercase long-form header name (e.g. "p-asserted-identity"). */
  readonly name: string
  /** Optional alias names (e.g. compact forms like "f" for "from"). */
  readonly aliases?: ReadonlyArray<string>
  /**
   * Parse all matching raw header values into the typed shape.
   * Called at most once per message (the result is memoized).
   */
  readonly parse: (rawValues: ReadonlyArray<string>) => T
}

/**
 * Eager-slot record — the precomputed value for every built-in eagerly
 * parsed header. Built by `extractCommonFields` / `extractRequestFields`
 * before the message is finalized; private to the parser pipeline and
 * the `getHeader` closure.
 */
export interface EagerHeaderSlots {
  readonly from: ParsedNameAddrField
  readonly to: ParsedNameAddrField
  readonly callId: string
  readonly cseq: ParsedCSeqField
  /** Always at least one Via — parser rejects the message otherwise. */
  readonly vias: ReadonlyArray<ParsedViaField>
  /** First contact (`contacts[0]`), kept for the single-Contact dialog path. */
  readonly contact: ParsedContactField | undefined
  /** Every contact, parsed + validated eagerly; models `Contact: *`. */
  readonly contacts: ContactSet
}

/** Names that the built-in fast-path serves directly from eager slots / lazy parsers. */
const BUILTIN_NAMES = new Set<string>([
  "from",
  "to",
  "call-id",
  "cseq",
  "via",
  "contact",
  "contacts",
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
])

/** Compact-form aliases per RFC 3261 §20 / §7.3.3 / RFC 3265 / RFC 3892. */
const BUILTIN_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["f", "from"],
  ["t", "to"],
  ["v", "via"],
  ["i", "call-id"],
  ["m", "contact"],
]

export class SipHeaderRegistry {
  private readonly byName = new Map<string, HeaderDescriptor<unknown>>()
  private readonly aliasToCanonical = new Map<string, string>()

  constructor() {
    for (const [alias, canonical] of BUILTIN_ALIASES) {
      this.aliasToCanonical.set(alias, canonical)
    }
  }

  /** Register a custom header parser. Re-registration overwrites silently. */
  register<T>(desc: HeaderDescriptor<T>): void {
    const canonical = desc.name.toLowerCase()
    if (BUILTIN_NAMES.has(canonical)) {
      throw new Error(
        `SipHeaderRegistry.register: "${canonical}" is a built-in header and cannot be re-registered`,
      )
    }
    this.byName.set(canonical, desc as HeaderDescriptor<unknown>)
    if (desc.aliases) {
      for (const a of desc.aliases) {
        this.aliasToCanonical.set(a.toLowerCase(), canonical)
      }
    }
  }

  /** Resolve a raw lookup name to its canonical form (lowercased, alias-expanded). */
  resolve(name: string): string {
    const lower = name.toLowerCase()
    return this.aliasToCanonical.get(lower) ?? lower
  }

  /** True when this canonical name is one of the built-ins. */
  isBuiltin(canonical: string): boolean {
    return BUILTIN_NAMES.has(canonical)
  }

  /** Look up a third-party descriptor by canonical name. */
  get(canonical: string): HeaderDescriptor<unknown> | undefined {
    return this.byName.get(canonical)
  }
}

/** Process-wide default registry consulted by `getHeader()`. */
export const defaultRegistry = new SipHeaderRegistry()

// ---------------------------------------------------------------------------
// getHeader factory
// ---------------------------------------------------------------------------

function rawHeaderValues(
  headers: ReadonlyArray<SipHeader>,
  canonical: string,
): ReadonlyArray<string> {
  const out: string[] = []
  for (const h of headers) {
    if (h.name.toLowerCase() === canonical) out.push(h.value)
  }
  return out
}

/**
 * Build the `getHeader` closure attached to a parsed message.
 *
 * Lazy parsers (built-in or third-party) are memoized per message: the
 * first call computes; subsequent calls return the cached `Result` /
 * value identity.
 */
export function makeGetHeader(
  headers: ReadonlyArray<SipHeader>,
  eager: EagerHeaderSlots,
): (name: string) => unknown {
  let cache: Map<string, unknown> | undefined

  function memo<T>(key: string, compute: () => T): T {
    if (cache === undefined) cache = new Map()
    const hit = cache.get(key)
    if (hit !== undefined) return hit as T
    const v = compute()
    cache.set(key, v)
    return v
  }

  return function getHeader(name: string): unknown {
    const canonical = defaultRegistry.resolve(name)

    if (defaultRegistry.isBuiltin(canonical)) {
      switch (canonical) {
        case "from": return eager.from
        case "to": return eager.to
        case "call-id": return eager.callId
        case "cseq": return eager.cseq
        // Cast: extractCommonFields guarantees at least one Via or rejects.
        case "via": return eager.vias as unknown as readonly [ParsedViaField, ...ParsedViaField[]]
        case "contact": return eager.contact
        case "contacts": return eager.contacts
        case "p-asserted-identity": return memo(canonical, () => parsePAssertedIdentity(headers))
        case "p-preferred-identity": return memo(canonical, () => parsePPreferredIdentity(headers))
        case "diversion": return memo(canonical, () => parseDiversion(headers))
        case "history-info": return memo(canonical, () => parseHistoryInfo(headers))
        case "remote-party-id": return memo(canonical, () => parseRemotePartyId(headers))
        case "geolocation": return memo(canonical, () => parseGeolocation(headers))
        case "geolocation-error": return memo(canonical, () => parseGeolocationError(headers))
        case "geolocation-routing": return memo(canonical, () => parseGeolocationRouting(headers))
        case "rack": return memo(canonical, () => parseRackHeader(headers))
        case "refer-to": return memo(canonical, () => parseReferToHeader(headers))
      }
    }

    const desc = defaultRegistry.get(canonical)
    if (desc === undefined) {
      return rawHeaderValues(headers, canonical)
    }
    return memo(canonical, () => desc.parse(rawHeaderValues(headers, canonical)))
  }
}
