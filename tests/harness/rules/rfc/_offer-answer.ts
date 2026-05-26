/**
 * Pure SDP body-parsing primitives shared across the RFC 3264 cross-message
 * rules. Each rule walks per-Call-ID message streams looking at SDP bodies;
 * this helper centralises the line-walk, session/media partitioning, m= /
 * c= / a= extraction so the rules stay focused on the spec invariant they
 * enforce.
 *
 * Best-effort parsing: a body that doesn't look like SDP (no `v=` prefix)
 * yields `null`. Beyond that, the helper is permissive — malformed bodies
 * still produce a parsed shape so the consuming rule can decide what to
 * flag. Strict SDP-grammar enforcement lives in `rfc.sdpBodyParseable`
 * (peer rule), not here.
 *
 * The helper does NOT depend on the SipMessage parser — it works directly
 * on raw body bytes via TextDecoder so it can be used wherever a `body:
 * Uint8Array` is available.
 *
 * Pure functions; no Effect, no I/O.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MediaLine {
  /** Media type token from `m=<type> <port> <transport> <formats>`. */
  readonly type: string
  /** Numeric port from the m= line (parseInt; NaN if unparseable). */
  readonly port: number
  /** Transport token (e.g. `RTP/AVP`, `RTP/SAVP`, `UDP/TLS/RTP/SAVPF`). */
  readonly transport: string
  /** Format / payload-type tokens that follow `port transport`. */
  readonly formats: ReadonlyArray<string>
  /** All `a=...` lines that appear inside this media block, without the leading `a=`. */
  readonly attributes: ReadonlyArray<string>
  /** First `c=` line inside this media block, if any. */
  readonly cLine?: string
  /** `a=ptime:<N>` value parsed to a number, if present. */
  readonly ptime?: number
}

export interface SdpDoc {
  /** Raw `v=` line value (`"0"` is the only valid value per RFC 4566). */
  readonly version: string | null
  /** Raw `o=` line tail (everything after `o=`), if present. */
  readonly origin: string | null
  /** Raw `s=` line tail, if present. */
  readonly sessionName: string | null
  /** Raw `t=` line tail (`"<start> <stop>"`), if present. */
  readonly tLine: string | null
  /** Session-level `c=` line tail, if present (media blocks may override). */
  readonly cLine: string | null
  /** Ordered media blocks in document order. */
  readonly media: ReadonlyArray<MediaLine>
  /** Raw decoded text for callers that want byte-level comparisons. */
  readonly raw: string
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const TEXT_DECODER = new TextDecoder()

interface MutableMedia {
  type: string
  port: number
  transport: string
  formats: string[]
  attributes: string[]
  cLine?: string
  ptime?: number
}

const newMedia = (rawMLine: string): MutableMedia => {
  // m=<type> <port> <transport> <fmt> ...
  const tokens = rawMLine.split(/\s+/)
  const type = tokens[0] ?? ""
  const portRaw = tokens[1] ?? ""
  const port = Number.parseInt(portRaw, 10)
  const transport = tokens[2] ?? ""
  const formats = tokens.slice(3)
  return {
    type,
    port: Number.isFinite(port) ? port : NaN,
    transport,
    formats,
    attributes: [],
  }
}

// ---------------------------------------------------------------------------
// parseSdpBody
// ---------------------------------------------------------------------------

/**
 * Best-effort SDP parse. Returns `null` when the body is empty or does not
 * start with the canonical `v=` token.
 *
 * The walk splits the document at the first `m=` line: every line before is
 * session-level; every line after (until the next `m=`) belongs to the
 * current media block.
 */
export const parseSdpBody = (body: Uint8Array): SdpDoc | null => {
  if (body.byteLength === 0) return null
  const text = TEXT_DECODER.decode(body)
  if (!text.startsWith("v=")) return null
  const lines = text.split(/\r?\n/)

  let version: string | null = null
  let origin: string | null = null
  let sessionName: string | null = null
  let tLine: string | null = null
  let sessionCLine: string | null = null
  const media: MutableMedia[] = []
  let current: MutableMedia | null = null

  for (const line of lines) {
    if (line.length === 0) continue
    if (line.length < 2 || line[1] !== "=") continue
    const key = line[0]!
    const value = line.slice(2)
    if (key === "m") {
      current = newMedia(value)
      media.push(current)
      continue
    }
    if (current === null) {
      // Session-level lines.
      if (key === "v") version ??= value
      else if (key === "o") origin ??= value
      else if (key === "s") sessionName ??= value
      else if (key === "t") tLine ??= value
      else if (key === "c") sessionCLine ??= value
      continue
    }
    // Media-level lines.
    if (key === "c") {
      if (current.cLine === undefined) current.cLine = value
      continue
    }
    if (key === "a") {
      current.attributes.push(value)
      if (current.ptime === undefined && value.toLowerCase().startsWith("ptime:")) {
        const n = Number.parseInt(value.slice("ptime:".length).trim(), 10)
        if (Number.isFinite(n)) current.ptime = n
      }
    }
  }

  return {
    version,
    origin,
    sessionName,
    tLine,
    cLine: sessionCLine,
    media: media.map((m) => ({
      type: m.type,
      port: m.port,
      transport: m.transport,
      formats: m.formats,
      attributes: m.attributes,
      cLine: m.cLine,
      ptime: m.ptime,
    })),
    raw: text,
  }
}

// ---------------------------------------------------------------------------
// Field extractors
// ---------------------------------------------------------------------------

/**
 * Given a raw `m=` line value (no leading `m=`), return the tokens after
 * `<type> <port> <transport>` — the format / payload-type list. Empty
 * array on malformed input.
 */
export const extractFormatList = (mLine: string): ReadonlyArray<string> => {
  const tokens = mLine.split(/\s+/)
  return tokens.length > 3 ? tokens.slice(3) : []
}

export type SdpDirection = "sendrecv" | "sendonly" | "recvonly" | "inactive"

/**
 * Inspect a media block's `a=...` attributes for `sendrecv` / `sendonly` /
 * `recvonly` / `inactive`. Per RFC 3264 §6.1, absence defaults to
 * `sendrecv`.
 */
export const extractDirection = (media: MediaLine): SdpDirection => {
  for (const attr of media.attributes) {
    const t = attr.trim().toLowerCase()
    if (t === "sendrecv") return "sendrecv"
    if (t === "sendonly") return "sendonly"
    if (t === "recvonly") return "recvonly"
    if (t === "inactive") return "inactive"
  }
  return "sendrecv"
}

/**
 * Parse every `a=rtpmap:<pt> <encoding>/<rate>[/<channels>]` attribute in
 * `media` into a `Map<paymentType, encodingString>`. The encoding string is
 * preserved verbatim (e.g. `"opus/48000/2"`). PTs that appear without a
 * valid `<pt> <encoding>` split are skipped.
 */
export const extractRtpmaps = (media: MediaLine): Map<string, string> => {
  const out = new Map<string, string>()
  for (const attr of media.attributes) {
    const lower = attr.toLowerCase()
    if (!lower.startsWith("rtpmap:")) continue
    const tail = attr.slice("rtpmap:".length).trim()
    const sp = tail.indexOf(" ")
    if (sp <= 0) continue
    const pt = tail.slice(0, sp).trim()
    const enc = tail.slice(sp + 1).trim()
    if (pt.length === 0 || enc.length === 0) continue
    if (!out.has(pt)) out.set(pt, enc)
  }
  return out
}
