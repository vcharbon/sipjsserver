/**
 * Minimal SDP parser + builder for the negotiation engine. Handles the subset
 * a plain RTP/AVP audio UA emits and reads: `v= o= s= c= t= m=audio` plus
 * `a=rtpmap` and direction attributes. Round-trippable. Independent of the
 * B2BUA's SDP code on purpose (conformance witness).
 */

import type { MediaDirection, Sdp, SdpMedia, SdpRtpMap } from "./types.js"

const DIRECTIONS: ReadonlySet<MediaDirection> = new Set([
  "sendrecv",
  "sendonly",
  "recvonly",
  "inactive",
])

function decode(input: Uint8Array | string): string {
  return typeof input === "string" ? input : new TextDecoder().decode(input)
}

export function parseSdp(input: Uint8Array | string): Sdp {
  const text = decode(input)
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)

  let origin = { username: "-", sessionId: "0", version: "0", address: "0.0.0.0" }
  let sessionConn: string | undefined
  const media: SdpMedia[] = []

  // Per-current-media accumulator.
  let cur: {
    type: string
    port: number
    protocol: string
    formats: number[]
    rtpmap: SdpRtpMap[]
    direction: MediaDirection
    connectionAddr?: string
  } | null = null

  const flush = () => {
    if (cur) {
      media.push({
        type: cur.type,
        port: cur.port,
        protocol: cur.protocol,
        formats: cur.formats,
        rtpmap: cur.rtpmap,
        direction: cur.direction,
        ...(cur.connectionAddr !== undefined ? { connectionAddr: cur.connectionAddr } : {}),
      })
      cur = null
    }
  }

  for (const line of lines) {
    const type = line[0]
    const value = line.slice(2)
    switch (type) {
      case "o": {
        const p = value.split(/\s+/)
        // o=<user> <sess-id> <sess-version> IN IP4 <addr>
        origin = {
          username: p[0] ?? "-",
          sessionId: p[1] ?? "0",
          version: p[2] ?? "0",
          address: p[5] ?? "0.0.0.0",
        }
        break
      }
      case "c": {
        // c=IN IP4 <addr>
        const addr = value.split(/\s+/)[2]
        if (addr !== undefined) {
          if (cur) cur.connectionAddr = addr
          else sessionConn = addr
        }
        break
      }
      case "m": {
        flush()
        const p = value.split(/\s+/)
        cur = {
          type: p[0] ?? "audio",
          port: parseInt(p[1] ?? "0", 10),
          protocol: p[2] ?? "RTP/AVP",
          formats: p.slice(3).map((f) => parseInt(f, 10)).filter((n) => !Number.isNaN(n)),
          rtpmap: [],
          direction: "sendrecv", // RFC 3264 default
        }
        break
      }
      case "a": {
        if (value.startsWith("rtpmap:")) {
          // a=rtpmap:<pt> <name>/<rate>[/<channels>]
          const rest = value.slice("rtpmap:".length)
          const sp = rest.indexOf(" ")
          const pt = parseInt(rest.slice(0, sp), 10)
          const [name, rate] = rest.slice(sp + 1).split("/")
          cur?.rtpmap.push({
            payloadType: pt,
            encodingName: name ?? "",
            clockRate: parseInt(rate ?? "8000", 10),
          })
        } else if (DIRECTIONS.has(value as MediaDirection)) {
          if (cur) cur.direction = value as MediaDirection
        }
        break
      }
      default:
        break
    }
  }
  flush()

  return {
    origin,
    ...(sessionConn !== undefined ? { connectionAddr: sessionConn } : {}),
    media,
  }
}

export function buildSdp(sdp: Sdp): string {
  const lines: string[] = []
  lines.push("v=0")
  lines.push(
    `o=${sdp.origin.username} ${sdp.origin.sessionId} ${sdp.origin.version} IN IP4 ${sdp.origin.address}`,
  )
  lines.push("s=-")
  if (sdp.connectionAddr !== undefined) lines.push(`c=IN IP4 ${sdp.connectionAddr}`)
  lines.push("t=0 0")
  for (const m of sdp.media) {
    lines.push(`m=${m.type} ${m.port} ${m.protocol} ${m.formats.join(" ")}`)
    if (m.connectionAddr !== undefined) lines.push(`c=IN IP4 ${m.connectionAddr}`)
    for (const r of m.rtpmap) {
      lines.push(`a=rtpmap:${r.payloadType} ${r.encodingName}/${r.clockRate}`)
    }
    lines.push(`a=${m.direction}`)
  }
  return lines.join("\r\n") + "\r\n"
}

export function encodeSdp(sdp: Sdp): Uint8Array {
  return new TextEncoder().encode(buildSdp(sdp))
}

/** The effective connection address for a media description (media-level wins). */
export function mediaConnectionAddr(sdp: Sdp, m: SdpMedia): string {
  return m.connectionAddr ?? sdp.connectionAddr ?? sdp.origin.address
}
