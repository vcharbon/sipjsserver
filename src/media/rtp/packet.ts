/**
 * RFC 3550 RTP packet framing — the hand-rolled "TS" wire codec.
 *
 * Encodes the fixed 12-byte header (we never emit CSRCs, extensions, or
 * padding) and parses the full header form (CSRC count + extension + padding
 * honoured) so it can read whatever a peer — including the rtp.js witness —
 * puts on the wire. The `RtpFraming` seam lets the media engine swap this for
 * the rtp.js implementation, making each an independent witness of the other.
 */

export interface RtpHeader {
  readonly version: number
  readonly padding: boolean
  readonly extension: boolean
  readonly marker: boolean
  readonly payloadType: number
  readonly sequenceNumber: number
  readonly timestamp: number
  readonly ssrc: number
}

export interface RtpFramed {
  readonly header: RtpHeader
  readonly payload: Uint8Array
}

/** The wire-codec seam: two implementations (TS here, rtp.js in native/). */
export interface RtpFraming {
  readonly name: "ts" | "rtp.js"
  encodeRtp: (header: RtpHeader, payload: Uint8Array) => Uint8Array
  parseRtp: (bytes: Uint8Array) => RtpFramed | null
}

const RTP_HEADER_BYTES = 12

export function encodeRtp(header: RtpHeader, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(RTP_HEADER_BYTES + payload.length)
  const dv = new DataView(buf.buffer)
  dv.setUint8(
    0,
    ((header.version & 0x03) << 6) |
      (header.padding ? 0x20 : 0) |
      (header.extension ? 0x10 : 0),
    // CSRC count always 0 for our sender
  )
  dv.setUint8(1, (header.marker ? 0x80 : 0) | (header.payloadType & 0x7f))
  dv.setUint16(2, header.sequenceNumber & 0xffff)
  dv.setUint32(4, header.timestamp >>> 0)
  dv.setUint32(8, header.ssrc >>> 0)
  buf.set(payload, RTP_HEADER_BYTES)
  return buf
}

export function parseRtp(bytes: Uint8Array): RtpFramed | null {
  if (bytes.length < RTP_HEADER_BYTES) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const b0 = dv.getUint8(0)
  const version = (b0 >> 6) & 0x03
  if (version !== 2) return null
  const padding = (b0 & 0x20) !== 0
  const extension = (b0 & 0x10) !== 0
  const csrcCount = b0 & 0x0f
  const b1 = dv.getUint8(1)
  const marker = (b1 & 0x80) !== 0
  const payloadType = b1 & 0x7f
  const sequenceNumber = dv.getUint16(2)
  const timestamp = dv.getUint32(4)
  const ssrc = dv.getUint32(8)

  let offset = RTP_HEADER_BYTES + csrcCount * 4
  if (extension) {
    if (offset + 4 > bytes.length) return null
    const extWords = dv.getUint16(offset + 2)
    offset += 4 + extWords * 4
  }
  if (offset > bytes.length) return null

  let end = bytes.length
  if (padding && end > offset) {
    const padBytes = dv.getUint8(end - 1)
    if (padBytes > 0 && end - padBytes >= offset) end -= padBytes
  }

  return {
    header: { version, padding, extension, marker, payloadType, sequenceNumber, timestamp, ssrc },
    payload: bytes.subarray(offset, end),
  }
}

/** The TS RTP wire codec. */
export const tsFraming: RtpFraming = {
  name: "ts",
  encodeRtp,
  parseRtp,
}
