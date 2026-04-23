/**
 * Cid cross-reference validator (SplitServiceLogic.md §D4, §D11).
 *
 * Headers that reference body parts via the `cid:` URI scheme (RFC 2392)
 * must point at a part that actually exists in the outbound body. The
 * canonical example is Geolocation ↔ PIDF-LO linkage (RFC 6442):
 *
 *   Geolocation: <cid:location@example.com>
 *   Content-Type: multipart/mixed; boundary="b2bua-..."
 *     --...
 *     Content-Type: application/pidf+xml
 *     Content-ID: <location@example.com>
 *     ...
 *
 * If the adapter returns a Geolocation header pointing at a cid that no
 * part materializes, the caller never resolves the reference. We reject
 * this at canonical-validation time with a
 * `CallDecisionError(kind: "semantic-violation")`.
 *
 * Scanning rules:
 *   - Case-insensitive match on `cid:` prefix (RFC 3986 is scheme-insensitive).
 *   - Within a single header value, extract every `cid:<id>` token up to the
 *     first whitespace / `>` / `,` / `;` / closing-quote delimiter.
 *   - Part-side comparison is case-sensitive — RFC 2392 defers to
 *     RFC 2046 which treats Content-ID as octet-for-octet.
 */

import type { BodyIntent, BodyPart } from "../schemas/body.js"
import {
  CallDecisionError,
  type CallDecisionMethod,
} from "../schemas/errors.js"

export interface HeaderRef {
  readonly name: string
  readonly value: string
}

/**
 * Validate that every `cid:<id>` referenced in the supplied headers is
 * materialized by a part in the body. Returns null on success,
 * `CallDecisionError(kind: "semantic-violation")` on first failure.
 *
 * Only `BodyIntent.kind === "multipart"` can satisfy cid references —
 * scanning against `inherit` / `drop` / `sdp` / `raw` is meaningless and
 * any cid reference in the headers immediately fails.
 */
export function validateCidCrossReferences(
  adapterName: string,
  method: CallDecisionMethod,
  headers: Iterable<HeaderRef>,
  body: BodyIntent,
): CallDecisionError | null {
  const referenced = new Set<string>()
  for (const h of headers) {
    for (const id of extractCidIds(h.value)) {
      referenced.add(id)
    }
  }
  if (referenced.size === 0) return null

  const parts = body.kind === "multipart" ? body.parts : EMPTY_PARTS
  const available = new Set<string>()
  for (const part of parts) {
    const id = partContentId(part)
    if (id !== undefined) available.add(id)
  }

  for (const id of referenced) {
    if (!available.has(id)) {
      return new CallDecisionError({
        kind: "semantic-violation",
        adapterName,
        method,
        detail: `cid:${id} referenced in headers has no matching part Content-ID`,
        cause: { referencedCid: id, bodyKind: body.kind },
      })
    }
  }
  return null
}

// ── Helpers ───────────────────────────────────────────────────────────────

const EMPTY_PARTS: ReadonlyArray<BodyPart> = []

function partContentId(part: BodyPart): string | undefined {
  if (part.contentId === undefined) return undefined
  const trimmed = part.contentId.trim()
  // Strip optional angle brackets so callers can declare either form.
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Extract every `cid:<id>` token from a single header value. */
export function extractCidIds(value: string): string[] {
  const out: string[] = []
  const lower = value.toLowerCase()
  let pos = 0
  while (pos < lower.length) {
    const at = lower.indexOf("cid:", pos)
    if (at === -1) break
    // Ensure cid: isn't a substring of a longer identifier (e.g. "acid:")
    if (at > 0) {
      const prev = lower.charCodeAt(at - 1)
      if (isIdentifierChar(prev)) {
        pos = at + 4
        continue
      }
    }
    const start = at + 4
    let end = start
    while (end < value.length && !isCidTerminator(value.charCodeAt(end))) {
      end++
    }
    const id = value.slice(start, end).trim()
    if (id.length > 0) out.push(id)
    pos = end
  }
  return out
}

function isCidTerminator(code: number): boolean {
  // Space, tab, CR, LF, '>', ',', ';', '"', ')'
  return code === 32 || code === 9 || code === 13 || code === 10
    || code === 62 || code === 44 || code === 59 || code === 34 || code === 41
}

function isIdentifierChar(code: number): boolean {
  // [A-Za-z0-9_-]
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === 45
    || code === 95
}
