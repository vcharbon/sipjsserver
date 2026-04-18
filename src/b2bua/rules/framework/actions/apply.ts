/**
 * Apply helpers — translate ADT updates (`HeaderUpdates`, `BodyUpdate`,
 * `RuriOp`) into concrete mutations on `SipRequest` / `SipResponse`.
 *
 * Kept separate from `factories.ts` / `readers.ts` so that tests can
 * exercise them directly without constructing a `RuleContext`.
 */

import type { SipHeader, SipRequest, SipResponse } from "../../../../sip/types.js"
import type {
  BareSipUri,
  BodyUpdate,
  HeaderName,
  HeaderUpdates,
  RuriOp,
} from "./types.js"

function headerKey(name: HeaderName): string {
  return name.name.toLowerCase()
}

function preferredHeaderCasing(name: HeaderName): string {
  return name.kind === "well-known" ? name.name : name.name
}

/**
 * Apply a `HeaderUpdates` map to a message.
 *
 * Semantics, by `HeaderUpdate.kind`:
 *   - `replace` — every existing occurrence is removed and the new values
 *     are appended in order. A single `replaceH(a, b)` on a multi-valued
 *     header produces exactly two headers on the output, in that order.
 *   - `remove`  — every existing occurrence is removed.
 *
 * Content-Length is *not* updated here; callers that mutate the body
 * must use `applyBodyUpdate` separately.
 */
export function applyHeaderUpdates<M extends SipRequest | SipResponse>(
  msg: M,
  updates: HeaderUpdates,
): M {
  if (updates.size === 0) return msg

  // Build lowercased -> (update, preferred casing) lookup.
  const byKey = new Map<string, { update: ReturnType<HeaderUpdates["get"]>; casing: string }>()
  for (const [name, update] of updates) {
    byKey.set(headerKey(name), { update, casing: preferredHeaderCasing(name) })
  }

  // Drop every header that is mentioned in the update map; collect the
  // survivors in original order.
  const survivors: SipHeader[] = []
  for (const h of msg.headers) {
    if (!byKey.has(h.name.toLowerCase())) survivors.push(h)
  }

  // Append replacements in map-iteration order.
  const appended: SipHeader[] = []
  for (const [, { update, casing }] of byKey) {
    if (update === undefined) continue
    if (update.kind === "replace") {
      for (const v of update.values) appended.push({ name: casing, value: v })
    }
    // "remove" case: nothing to append.
  }

  // Preserve the convention that Content-Length stays at / near the end
  // of the header block — append after everything else.
  return { ...msg, headers: [...survivors, ...appended] }
}

/**
 * Apply a `BodyUpdate` to a message, updating Content-Length in lockstep.
 *
 *   - `inherit` — body + Content-Length left untouched.
 *   - `drop`    — body replaced with zero bytes, Content-Length set to 0.
 *   - `set`     — body replaced with the given bytes, Content-Length set
 *                 to `value.byteLength`.
 */
export function applyBodyUpdate<M extends SipRequest | SipResponse>(
  msg: M,
  update: BodyUpdate,
): M {
  if (update.kind === "inherit") return msg

  const body = update.kind === "set" ? update.value : new Uint8Array(0)
  const headers: SipHeader[] = msg.headers.map((h) =>
    h.name.toLowerCase() === "content-length"
      ? { name: h.name, value: String(body.byteLength) }
      : h,
  )
  // Ensure a Content-Length is present (SIP requires it, and downstream
  // serialization depends on it). Append one if the source lacked it.
  const hasCL = headers.some((h) => h.name.toLowerCase() === "content-length")
  const finalHeaders = hasCL
    ? headers
    : [...headers, { name: "Content-Length", value: String(body.byteLength) }]
  return { ...msg, body, headers: finalHeaders }
}

/**
 * Apply a `RuriOp` to a request. `inherit` is a no-op; `set` overwrites
 * the Request-URI with a `BareSipUri` (the brand guarantees no angle
 * brackets / display name / header params have leaked in).
 */
export function applyRuriOp(req: SipRequest, op: RuriOp): SipRequest {
  if (op.kind === "inherit") return req
  return { ...req, uri: op.value as unknown as string }
}

/** Re-export for callers that want the URI-type directly. */
export type { BareSipUri }
