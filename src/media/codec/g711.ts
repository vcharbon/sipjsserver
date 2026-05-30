/**
 * G.711 codec — PCMA (A-law, PT 8) and PCMU (µ-law, PT 0).
 *
 * Pure conversions between 16-bit linear PCM and the 8-bit companded G.711
 * representations. Used by the media RTP stack to frame audio and by the audio
 * comparator's transcoding-robustness test. This is the canonical ITU-T G.711
 * reference algorithm (the Sun/CCITT implementation): A-law works on the top 13
 * bits, µ-law on the top 14, with the standard segment search.
 */

const SIGN_BIT = 0x80
const QUANT_MASK = 0x0f
const SEG_SHIFT = 4
const SEG_MASK = 0x70
const BIAS = 0x84
const MU_CLIP = 8159

const SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff]
const SEG_UEND = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff]

function segmentSearch(val: number, table: ReadonlyArray<number>): number {
  for (let i = 0; i < table.length; i++) {
    if (val <= table[i]!) return i
  }
  return table.length
}

/** Encode one PCM16 sample to an A-law byte. */
export function alawEncodeSample(pcm: number): number {
  let mask: number
  let value = pcm >> 3 // scale to 13-bit
  if (value >= 0) {
    mask = 0xd5 // sign bit = 1 for positive
  } else {
    mask = 0x55
    value = -value - 1
  }
  const seg = segmentSearch(value, SEG_AEND)
  if (seg >= 8) return (0x7f ^ mask) & 0xff
  let aval = seg << SEG_SHIFT
  aval |= seg < 2 ? (value >> 1) & QUANT_MASK : (value >> seg) & QUANT_MASK
  return (aval ^ mask) & 0xff
}

/** Decode one A-law byte to a PCM16 sample. */
export function alawDecodeSample(alaw: number): number {
  const a = (alaw ^ 0x55) & 0xff
  let t = (a & QUANT_MASK) << 4
  const seg = (a & SEG_MASK) >> SEG_SHIFT
  if (seg === 0) {
    t += 8
  } else if (seg === 1) {
    t += 0x108
  } else {
    t += 0x108
    t <<= seg - 1
  }
  return (a & SIGN_BIT) !== 0 ? t : -t
}

/** Encode one PCM16 sample to a µ-law byte. */
export function mulawEncodeSample(pcm: number): number {
  let value = pcm >> 2 // scale to 14-bit
  let mask: number
  if (value < 0) {
    value = -value
    mask = 0x7f
  } else {
    mask = 0xff
  }
  if (value > MU_CLIP) value = MU_CLIP
  value += BIAS >> 2
  const seg = segmentSearch(value, SEG_UEND)
  if (seg >= 8) return (0x7f ^ mask) & 0xff
  const uval = (seg << 4) | ((value >> (seg + 1)) & 0x0f)
  return (uval ^ mask) & 0xff
}

/** Decode one µ-law byte to a PCM16 sample. */
export function mulawDecodeSample(mulaw: number): number {
  const u = ~mulaw & 0xff
  let t = ((u & QUANT_MASK) << 3) + BIAS
  t <<= (u & SEG_MASK) >> SEG_SHIFT
  return (u & SIGN_BIT) !== 0 ? BIAS - t : t - BIAS
}

export function alawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = alawEncodeSample(pcm[i]!)
  return out
}

export function alawDecode(alaw: Uint8Array): Int16Array {
  const out = new Int16Array(alaw.length)
  for (let i = 0; i < alaw.length; i++) out[i] = alawDecodeSample(alaw[i]!)
  return out
}

export function mulawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = mulawEncodeSample(pcm[i]!)
  return out
}

export function mulawDecode(mulaw: Uint8Array): Int16Array {
  const out = new Int16Array(mulaw.length)
  for (let i = 0; i < mulaw.length; i++) out[i] = mulawDecodeSample(mulaw[i]!)
  return out
}

export type G711Codec = "PCMA" | "PCMU"

/** Round-trip PCM through a G.711 codec — models what a transcoding leg does. */
export function g711RoundTrip(pcm: Int16Array, codec: G711Codec): Int16Array {
  return codec === "PCMA"
    ? alawDecode(alawEncode(pcm))
    : mulawDecode(mulawEncode(pcm))
}
