/**
 * RFC 3261 §7.3.3 — Compact header form expansion.
 * Maps single-character compact forms to their full canonical names.
 */

const COMPACT_FORMS: Record<string, string> = {
  i: "Call-ID",
  m: "Contact",
  e: "Content-Encoding",
  l: "Content-Length",
  c: "Content-Type",
  f: "From",
  s: "Subject",
  k: "Supported",
  t: "To",
  v: "Via",
}

/**
 * If the header name is a single-character compact form, expand it
 * to the full canonical name. Otherwise return as-is.
 */
export function expandCompactForm(name: string): string {
  if (name.length === 1) {
    return COMPACT_FORMS[name.toLowerCase()] ?? name
  }
  return name
}
