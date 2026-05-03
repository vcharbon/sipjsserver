/**
 * Header-partition validator (SplitServiceLogic.md §D3).
 *
 * Adapters MUST NOT set FORBIDDEN or PARTIAL headers via `update_headers`:
 *
 *   FORBIDDEN (stack-only)
 *     Call-ID, Content-Length, Via, CSeq, Max-Forwards,
 *     Record-Route, Route, Contact
 *
 *   PARTIAL (structured slots own these)
 *     From, To
 *
 * Enforcement is belt + suspenders:
 *
 *   1. Compile-time — `AdapterHeaderName` excludes these names from the
 *      `HeaderName` union so the structured ADT used by B.2+ code cannot
 *      even mention them. Used to key `AdapterHeaderUpdates`.
 *
 *   2. Runtime — the legacy `update_headers: Record<string, string | null>`
 *      wire shape still lets an adapter smuggle a forbidden name through as
 *      a raw string. `validateUpdateHeaders` screens every key
 *      case-insensitively and returns a `CallDecisionError(kind:
 *      "semantic-violation")` on the first violation.
 *
 * The case-insensitive match subsumes the Content-Type and Content-Disposition
 * slots even though those two belong in the structured body model (§D4) — no
 * header-update path should ever set them either.
 *
 * Both lists overlap: violating a PARTIAL name is still a semantic violation,
 * it just has a slightly different reason string for diagnostic clarity.
 */

import { Effect } from "effect"
import type { KnownHeader, HeaderName } from "../../b2bua/rules/framework/actions/types.js"
import {
  CallDecisionError,
  type CallDecisionMethod,
} from "../schemas/errors.js"

// ── Partition membership ──────────────────────────────────────────────────

/**
 * Stack-only headers the adapter must never set via `update_headers`. The
 * `Contact` entry covers accepted calls; 3xx rejects use the structured
 * `contact: BareSipUri[]` slot (§D3 exception).
 */
export type ForbiddenHeaderName =
  | "Call-ID"
  | "Content-Length"
  | "Via"
  | "CSeq"
  | "Max-Forwards"
  | "Record-Route"
  | "Route"
  | "Contact"

/** Owned by the `fromUri`/`toUri`/`fromDisplayName`/`toDisplayName` slots. */
export type PartialHeaderName = "From" | "To"

const FORBIDDEN: ReadonlyArray<ForbiddenHeaderName> = [
  "Call-ID",
  "Content-Length",
  "Via",
  "CSeq",
  "Max-Forwards",
  "Record-Route",
  "Route",
  "Contact",
]

const PARTIAL: ReadonlyArray<PartialHeaderName> = ["From", "To"]

/** Content-* slots belong to the structured body model, never to update_headers. */
const BODY_SLOT_HEADERS: ReadonlyArray<string> = [
  "Content-Type",
  "Content-Length",
  "Content-Disposition",
  "Content-ID",
  "MIME-Version",
]

const FORBIDDEN_LOWER: ReadonlySet<string> = new Set(
  FORBIDDEN.map((h) => h.toLowerCase()),
)

const PARTIAL_LOWER: ReadonlySet<string> = new Set(
  PARTIAL.map((h) => h.toLowerCase()),
)

const BODY_SLOT_LOWER: ReadonlySet<string> = new Set(
  BODY_SLOT_HEADERS.map((h) => h.toLowerCase()),
)

// ── Compile-time exclusion (for B.2+ structured HeaderUpdates) ────────────

/** KnownHeaders an adapter is allowed to mention via structured updates. */
export type AdapterKnownHeader = Exclude<
  KnownHeader,
  ForbiddenHeaderName | PartialHeaderName
>

/**
 * `HeaderName` variant usable in adapter-provided structured updates. The
 * `well-known` arm drops the FORBIDDEN and PARTIAL names; the `proprietary`
 * arm is untouched because `custom()` already throws on well-known names
 * (including FORBIDDEN / PARTIAL).
 */
export type AdapterHeaderName =
  | { readonly kind: "well-known"; readonly name: AdapterKnownHeader }
  | { readonly kind: "proprietary"; readonly name: string }

// ── Runtime check ─────────────────────────────────────────────────────────

/** Classify a raw header key against the partition tiers. */
export function classifyHeader(name: string): "forbidden" | "partial" | "body-slot" | "ok" {
  const lower = name.trim().toLowerCase()
  if (FORBIDDEN_LOWER.has(lower)) return "forbidden"
  if (PARTIAL_LOWER.has(lower)) return "partial"
  if (BODY_SLOT_LOWER.has(lower)) return "body-slot"
  return "ok"
}

/**
 * Validate a wire-shape `update_headers` map. Returns null when every key is
 * acceptable, a `CallDecisionError(kind: "semantic-violation")` otherwise.
 *
 * The first violation short-circuits — the adapter has already broken the
 * contract so we don't need an exhaustive list to emit a 500.
 */
export function validateUpdateHeaders(
  adapterName: string,
  method: CallDecisionMethod,
  updateHeaders: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>> | undefined,
): CallDecisionError | null {
  if (updateHeaders === undefined) return null
  const entries = updateHeaders instanceof Map
    ? Array.from(updateHeaders.keys())
    : Object.keys(updateHeaders)
  for (const key of entries) {
    const tier = classifyHeader(key)
    if (tier === "ok") continue
    const detail = tier === "forbidden"
      ? `forbidden header "${key}" — stack-owned, adapter must not set it`
      : tier === "partial"
        ? `partial header "${key}" — use the structured from/to slots instead`
        : `body-slot header "${key}" — belongs in the structured body model`
    return new CallDecisionError({
      kind: "semantic-violation",
      adapterName,
      method,
      detail,
      cause: { header: key, tier },
    })
  }
  return null
}

/**
 * Effect-returning sibling of {@link validateUpdateHeaders}. Succeeds with
 * `void` when the map is clean, fails with the typed `CallDecisionError` on
 * the first violation. Use this from adapter call sites that already thread
 * errors through the Effect channel.
 */
export function validateUpdateHeadersEffect(
  adapterName: string,
  method: CallDecisionMethod,
  updateHeaders: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>> | undefined,
): Effect.Effect<void, CallDecisionError> {
  const violation = validateUpdateHeaders(adapterName, method, updateHeaders)
  return violation === null ? Effect.void : Effect.fail(violation)
}

// ── Reject-path partition ────────────────────────────────────────────────
//
// On reject there is no called-side response to merge with — the consumer
// is just authoring extra headers on the rejection response we emit.
// Per Issue 9 of the upstream-consumer plan:
//   - `Via`, `To`, `From`, `Call-ID`, `CSeq` — forbidden (RFC-mandated
//     copies from the request, must not be rewritten).
//   - `Contact` — allowed unconditionally. The B2BUA does not police
//     whether Contact is RFC-meaningful for the chosen status code; that
//     is the consumer's responsibility (302 in particular needs it).
//   - everything else (Reason, Retry-After, Warning, P-Asserted-Identity,
//     custom X-…) — allowed.
//
// Note: `Content-Length` is NOT listed here because reject responses
// typically have no body; if the consumer adds one we re-derive the
// length when serializing anyway.

const REJECT_FORBIDDEN: ReadonlyArray<string> = [
  "via",
  "to",
  "from",
  "call-id",
  "cseq",
]

const REJECT_FORBIDDEN_LOWER: ReadonlySet<string> = new Set(REJECT_FORBIDDEN)

/**
 * Validate `update_headers` from a `NewCallRejectResponse`. Returns null
 * when every key is acceptable, a `CallDecisionError(kind:
 * "semantic-violation")` on the first violation. See the
 * "Reject-path partition" comment above for rule rationale.
 */
export function validateRejectUpdateHeaders(
  adapterName: string,
  method: CallDecisionMethod,
  updateHeaders: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>> | undefined,
): CallDecisionError | null {
  if (updateHeaders === undefined) return null
  const entries = updateHeaders instanceof Map
    ? Array.from(updateHeaders.keys())
    : Object.keys(updateHeaders)
  for (const key of entries) {
    const lower = key.trim().toLowerCase()
    if (!REJECT_FORBIDDEN_LOWER.has(lower)) continue
    return new CallDecisionError({
      kind: "semantic-violation",
      adapterName,
      method,
      detail: `forbidden header "${key}" on reject — copied from the request per RFC 3261 §8.2.6.2`,
      cause: { header: key, tier: "reject-forbidden" },
    })
  }
  return null
}

/**
 * Effect-returning sibling of {@link validateRejectUpdateHeaders}.
 */
export function validateRejectUpdateHeadersEffect(
  adapterName: string,
  method: CallDecisionMethod,
  updateHeaders: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>> | undefined,
): Effect.Effect<void, CallDecisionError> {
  const violation = validateRejectUpdateHeaders(adapterName, method, updateHeaders)
  return violation === null ? Effect.void : Effect.fail(violation)
}

// ── Narrowing helper (for callers holding a structured HeaderName) ────────

/**
 * True when the given `HeaderName` is safe to appear in an adapter-sourced
 * structured `HeaderUpdates`. Used by call sites that still receive the
 * wider `HeaderName` (e.g., test helpers) and want to guard at runtime.
 */
export function isAdapterHeaderName(name: HeaderName): name is AdapterHeaderName {
  if (name.kind === "proprietary") return true
  const lower = name.name.toLowerCase()
  return !FORBIDDEN_LOWER.has(lower) && !PARTIAL_LOWER.has(lower)
}
