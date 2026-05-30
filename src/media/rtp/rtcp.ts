/**
 * Minimal RTCP — Sender Report (SR) and Receiver Report (RR) framing.
 *
 * First-cut scope is *counts only* (ADR / plan): we generate SR/RR on the
 * standard interval and report aggregated packet/octet counts via getStats();
 * we do not assert SR field contents yet. So this builds well-formed SR/RR
 * with no report blocks and exposes a demux helper to tell RTCP from RTP on a
 * muxed port (RFC 5761).
 */

export const RTCP_PT_SR = 200
export const RTCP_PT_RR = 201

export interface SenderReportFields {
  readonly ssrc: number
  readonly ntpMs: number // wall/virtual time in ms; split into NTP msw/lsw
  readonly rtpTimestamp: number
  readonly packetCount: number
  readonly octetCount: number
}

const NTP_EPOCH_OFFSET = 2208988800 // seconds between 1900 and 1970

function ntpFromMs(ms: number): { msw: number; lsw: number } {
  const seconds = Math.floor(ms / 1000) + NTP_EPOCH_OFFSET
  const fraction = Math.floor(((ms % 1000) / 1000) * 0x100000000)
  return { msw: seconds >>> 0, lsw: fraction >>> 0 }
}

/** Build a Sender Report with no report blocks (28 bytes). */
export function encodeSenderReport(f: SenderReportFields): Uint8Array {
  const buf = new Uint8Array(28)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, (2 << 6) | 0) // V=2, P=0, RC=0
  dv.setUint8(1, RTCP_PT_SR)
  dv.setUint16(2, 28 / 4 - 1) // length in 32-bit words minus one
  dv.setUint32(4, f.ssrc >>> 0)
  const ntp = ntpFromMs(f.ntpMs)
  dv.setUint32(8, ntp.msw)
  dv.setUint32(12, ntp.lsw)
  dv.setUint32(16, f.rtpTimestamp >>> 0)
  dv.setUint32(20, f.packetCount >>> 0)
  dv.setUint32(24, f.octetCount >>> 0)
  return buf
}

/** Build a Receiver Report with no report blocks (8 bytes). */
export function encodeReceiverReport(ssrc: number): Uint8Array {
  const buf = new Uint8Array(8)
  const dv = new DataView(buf.buffer)
  dv.setUint8(0, (2 << 6) | 0)
  dv.setUint8(1, RTCP_PT_RR)
  dv.setUint16(2, 8 / 4 - 1)
  dv.setUint32(4, ssrc >>> 0)
  return buf
}

/** RFC 5761 muxed-port demux: is this datagram RTCP (vs RTP)? */
export function isRtcp(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false
  const pt = bytes[1]!
  return pt >= 200 && pt <= 204
}

/** The RTCP packet type (second octet), for counting. */
export function rtcpPacketType(bytes: Uint8Array): number {
  return bytes.length >= 2 ? bytes[1]! : -1
}
