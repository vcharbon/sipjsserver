/**
 * Minimal canonical RIFF/WAVE reader + writer for the audio comparator and
 * the optional `.wav` artifact dump. Mono 16-bit PCM only — the one shape the
 * media stack works in (8 kHz telephony). Not a general WAV library: it reads
 * the canonical 44-byte header layout and writes exactly that.
 */

export interface WavData {
  readonly sampleRate: number
  readonly pcm: Int16Array
}

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

/** Parse a canonical mono 16-bit PCM WAV. Walks chunks to find `fmt `/`data`. */
export function decodeWav(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (fourCC(view, 0) !== "RIFF" || fourCC(view, 8) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file")
  }

  let sampleRate = 0
  let bitsPerSample = 0
  let channels = 0
  let dataOffset = -1
  let dataLength = 0

  let pos = 12
  while (pos + 8 <= bytes.length) {
    const id = fourCC(view, pos)
    const size = view.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === "fmt ") {
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (id === "data") {
      dataOffset = body
      dataLength = size
    }
    pos = body + size + (size & 1) // chunks are word-aligned
  }

  if (dataOffset < 0) throw new Error("missing data chunk")
  if (channels !== 1) throw new Error(`expected mono, got ${channels} channels`)
  if (bitsPerSample !== 16) throw new Error(`expected 16-bit, got ${bitsPerSample}`)

  const sampleCount = dataLength >> 1
  const pcm = new Int16Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = view.getInt16(dataOffset + i * 2, true)
  }
  return { sampleRate, pcm }
}

/** Serialize mono 16-bit PCM to a canonical 44-byte-header WAV. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataLength = pcm.length * 2
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i)
  }

  const byteRate = sampleRate * 2 // mono, 2 bytes/sample
  writeStr(0, "RIFF")
  view.setUint32(4, 36 + dataLength, true)
  writeStr(8, "WAVE")
  writeStr(12, "fmt ")
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, "data")
  view.setUint32(40, dataLength, true)
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i]!, true)

  return bytes
}
