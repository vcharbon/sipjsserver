/**
 * Minimal SDP helpers for the REFER / blind-transfer flow.
 *
 * Goals:
 *   - Extract the codec profile (payload types, rtpmaps, fmtp) from an A-leg
 *     SDP so we can place the INVITE to C with a compatible offer.
 *   - Build a synthetic "held" SDP (a=inactive, port 0) carrying that codec
 *     profile so C accepts the initial INVITE without media flowing until
 *     the c-realigning re-INVITE arrives.
 *
 * Kept deliberately string-based — no external SDP library. Not a full
 * parser: only the fields we need.
 */

import { sdpOriginAddress, sdpSessionId } from "./SdpAnswerFromOffer.js"

/** Codec profile extracted from the first audio m-line of an SDP body. */
export interface CodecProfile {
  /** Media type from the m-line (e.g. "audio"). */
  readonly media: string
  /** Payload types in m-line order. */
  readonly payloadTypes: readonly number[]
  /** rtpmap attribute lines for the payload types, original order. */
  readonly rtpmaps: readonly string[]
  /** fmtp attribute lines for the payload types, original order. */
  readonly fmtp: readonly string[]
  /** ptime attribute line, if present. */
  readonly ptime: string | undefined
  /** maxptime attribute line, if present. */
  readonly maxptime: string | undefined
}

const CRLF = "\r\n"

function decodeBody(body: Uint8Array | string): string {
  return typeof body === "string" ? body : new TextDecoder("utf-8").decode(body)
}

function splitLines(text: string): string[] {
  // Be lenient about line endings — SDP is commonly CRLF but LF-only appears
  // in tooling output. Drop any trailing empties.
  return text.split(/\r\n|\n/).filter((l) => l.length > 0)
}

/**
 * Extract the codec profile from the first audio m-section.
 *
 * Returns undefined when the body has no parsable audio m-line.
 */
export function extractCodecProfile(body: Uint8Array | string): CodecProfile | undefined {
  const text = decodeBody(body)
  const lines = splitLines(text)

  let mLineIdx = -1
  let media = ""
  let payloadTypes: number[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith("m=")) {
      // "m=<media> <port> <proto> <fmt>..."
      const parts = line.slice(2).trim().split(/\s+/)
      if (parts.length < 4) continue
      const [mediaPart, _port, _proto, ...fmts] = parts
      if (mediaPart !== "audio") continue
      const pts: number[] = []
      for (const fmt of fmts) {
        const n = Number.parseInt(fmt, 10)
        if (Number.isFinite(n)) pts.push(n)
      }
      if (pts.length === 0) continue
      media = mediaPart
      payloadTypes = pts
      mLineIdx = i
      break
    }
  }

  if (mLineIdx === -1) return undefined

  // Walk attributes that belong to this m-section (until next m= or end).
  const allowed = new Set(payloadTypes.map((n) => n))
  const rtpmaps: string[] = []
  const fmtps: string[] = []
  let ptime: string | undefined
  let maxptime: string | undefined

  for (let i = mLineIdx + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith("m=")) break
    if (!line.startsWith("a=")) continue

    if (line.startsWith("a=rtpmap:")) {
      const rest = line.slice("a=rtpmap:".length).trim()
      const space = rest.indexOf(" ")
      if (space === -1) continue
      const pt = Number.parseInt(rest.slice(0, space), 10)
      if (Number.isFinite(pt) && allowed.has(pt)) rtpmaps.push(line)
    } else if (line.startsWith("a=fmtp:")) {
      const rest = line.slice("a=fmtp:".length).trim()
      const space = rest.indexOf(" ")
      if (space === -1) continue
      const pt = Number.parseInt(rest.slice(0, space), 10)
      if (Number.isFinite(pt) && allowed.has(pt)) fmtps.push(line)
    } else if (line.startsWith("a=ptime:")) {
      if (ptime === undefined) ptime = line
    } else if (line.startsWith("a=maxptime:")) {
      if (maxptime === undefined) maxptime = line
    }
  }

  return {
    media,
    payloadTypes,
    rtpmaps,
    fmtp: fmtps,
    ptime,
    maxptime,
  }
}

export interface BuildHeldSdpOptions {
  /**
   * B2BUA's local SDP-origin address — written into the `o=` and `c=` lines
   * per RFC 4566 §5.2 / §5.7. When `0.0.0.0` / `::` (bind-all-interfaces)
   * the helper substitutes `127.0.0.1` so the held SDP is RFC-conformant.
   */
  readonly localIp: string
  /**
   * Wall-clock millis used to derive the `o=` `sess-id` / `sess-version`.
   * The helper converts to epoch-seconds for non-zero, RFC 4566 §5.2-style
   * uniqueness — held SDP is short-lived but still must round-trip through
   * RFC 3264 §8 SDP-version comparison on the subsequent re-INVITE.
   */
  readonly nowMs: number
}

/**
 * Build a synthetic held SDP offer that carries `profile`'s codec list with
 * the m-line port set to 0 and `a=inactive` — RFC 3264 §5.1. The B2BUA uses
 * this for the initial INVITE to C so C accepts the offer on the codec
 * profile alone. A subsequent re-INVITE (c-realigning) carries A's real SDP.
 *
 * `options.localIp` and `options.nowMs` populate the origin/connection lines
 * so the held SDP is RFC 4566 §5.2-conformant (no `0.0.0.0`, non-zero sess-id
 * / sess-version).
 */
export function buildHeldSdpFromProfile(
  profile: CodecProfile,
  options: BuildHeldSdpOptions
): Uint8Array {
  const originIp = sdpOriginAddress(options.localIp)
  const sessId = sdpSessionId(options.nowMs)
  const lines: string[] = [
    "v=0",
    `o=b2bua ${sessId} ${sessId} IN IP4 ${originIp}`,
    "s=-",
    `c=IN IP4 ${originIp}`,
    "t=0 0",
    `m=${profile.media} 0 RTP/AVP ${profile.payloadTypes.join(" ")}`,
  ]
  for (const line of profile.rtpmaps) lines.push(line)
  for (const line of profile.fmtp) lines.push(line)
  if (profile.ptime !== undefined) lines.push(profile.ptime)
  if (profile.maxptime !== undefined) lines.push(profile.maxptime)
  lines.push("a=inactive")
  return new TextEncoder().encode(lines.join(CRLF) + CRLF)
}
