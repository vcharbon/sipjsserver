/**
 * Spectral feature extraction for audio classification: framed MFCCs reduced
 * to a single clip-level signature, plus cosine distance between signatures.
 *
 * The pipeline is the textbook one — pre-emphasis → Hamming-windowed frames →
 * power spectrum (radix-2 FFT) → mel filterbank → log → DCT-II → keep the low
 * cepstral coefficients. The clip signature is the per-frame MFCC mean over
 * voiced frames (dropping c0 so the match is gain-invariant), which makes the
 * nearest-reference verdict robust to the level changes and companding an SBC
 * or G.711 leg introduces.
 *
 * Pure TS, no deps — small clips (≤2 s @ 8 kHz) so an O(n log n) FFT per 10 ms
 * frame is cheap.
 */

const DEFAULT_SAMPLE_RATE = 8000
const FRAME_MS = 25
const HOP_MS = 10
const PRE_EMPHASIS = 0.97
const MEL_FILTERS = 26
const MFCC_COEFFS = 13 // includes c0; the signature drops c0
const FFT_SIZE = 256 // next pow2 ≥ 25 ms @ 8 kHz (200 samples)

export interface MfccOptions {
  readonly sampleRate?: number
  /** Frames whose log-energy is below (max - this many dB) are treated as silence and skipped. */
  readonly voicedFloorDb?: number
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}
function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1)
}

/** In-place iterative radix-2 Cooley–Tukey FFT. `re`/`im` length must be a power of 2. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k]!
        const aIm = im[i + k]!
        const bRe = re[i + k + len / 2]!
        const bIm = im[i + k + len / 2]!
        const tRe = bRe * curRe - bIm * curIm
        const tIm = bRe * curIm + bIm * curRe
        re[i + k] = aRe + tRe
        im[i + k] = aIm + tIm
        re[i + k + len / 2] = aRe - tRe
        im[i + k + len / 2] = aIm - tIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

/** Build the triangular mel filterbank (filter index → [binStart, weights]). */
function melFilterbank(sampleRate: number, fftSize: number, numFilters: number) {
  const nyquist = sampleRate / 2
  const melMax = hzToMel(nyquist)
  const points = new Array<number>(numFilters + 2)
  for (let i = 0; i < points.length; i++) {
    const hz = melToHz((melMax * i) / (numFilters + 1))
    points[i] = Math.floor(((fftSize + 1) * hz) / sampleRate)
  }
  const bins = fftSize / 2 + 1
  const filters: Array<Float64Array> = []
  for (let m = 1; m <= numFilters; m++) {
    const f = new Float64Array(bins)
    const left = points[m - 1]!
    const center = points[m]!
    const right = points[m + 1]!
    for (let k = left; k < center; k++) {
      if (center > left) f[k] = (k - left) / (center - left)
    }
    for (let k = center; k < right; k++) {
      if (right > center) f[k] = (right - k) / (right - center)
    }
    filters.push(f)
  }
  return filters
}

function hammingWindow(size: number): Float64Array {
  const w = new Float64Array(size)
  for (let i = 0; i < size; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1))
  }
  return w
}

/** DCT-II of `input`, keeping the first `coeffs` outputs (orthonormal-ish scaling). */
function dct(input: Float64Array, coeffs: number): Float64Array {
  const n = input.length
  const out = new Float64Array(coeffs)
  for (let k = 0; k < coeffs; k++) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      sum += input[i]! * Math.cos((Math.PI * k * (i + 0.5)) / n)
    }
    out[k] = sum
  }
  return out
}

export interface MfccFrames {
  /** Per-frame MFCC vectors (length MFCC_COEFFS each). */
  readonly frames: ReadonlyArray<Float64Array>
  /** Per-frame log-energy, used for the silence guard. */
  readonly logEnergy: ReadonlyArray<number>
}

/** Compute per-frame MFCCs over a PCM clip. */
export function mfcc(pcm: Int16Array, opts: MfccOptions = {}): MfccFrames {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE
  const frameLen = Math.round((FRAME_MS / 1000) * sampleRate)
  const hop = Math.round((HOP_MS / 1000) * sampleRate)
  const window = hammingWindow(frameLen)
  const filters = melFilterbank(sampleRate, FFT_SIZE, MEL_FILTERS)
  const bins = FFT_SIZE / 2 + 1

  const frames: Array<Float64Array> = []
  const logEnergy: Array<number> = []

  for (let start = 0; start + frameLen <= pcm.length; start += hop) {
    const re = new Float64Array(FFT_SIZE)
    const im = new Float64Array(FFT_SIZE)
    let energy = 0
    let prev = start > 0 ? pcm[start - 1]! : pcm[start]!
    for (let i = 0; i < frameLen; i++) {
      const sample = pcm[start + i]!
      const emphasized = sample - PRE_EMPHASIS * prev
      prev = sample
      re[i] = emphasized * window[i]!
      energy += re[i]! * re[i]!
    }
    logEnergy.push(Math.log(energy + 1e-10))

    fft(re, im)
    const power = new Float64Array(bins)
    for (let k = 0; k < bins; k++) {
      power[k] = (re[k]! * re[k]! + im[k]! * im[k]!) / FFT_SIZE
    }
    const melLog = new Float64Array(MEL_FILTERS)
    for (let m = 0; m < MEL_FILTERS; m++) {
      const filt = filters[m]!
      let acc = 0
      for (let k = 0; k < bins; k++) acc += power[k]! * filt[k]!
      melLog[m] = Math.log(acc + 1e-10)
    }
    frames.push(dct(melLog, MFCC_COEFFS))
  }

  return { frames, logEnergy }
}

/**
 * Reduce per-frame MFCCs to one clip-level signature: the mean of c1..cN over
 * voiced frames (c0 dropped → gain-invariant). Returns null if no voiced frame.
 */
export function signature(frames: MfccFrames, voicedFloorDb = 25): Float64Array | null {
  const { frames: mf, logEnergy } = frames
  if (mf.length === 0) return null
  const maxLog = Math.max(...logEnergy)
  // dB floor relative to the loudest frame (10*log10 over natural-log energy).
  const floor = maxLog - (voicedFloorDb / 10) * Math.LN10

  const dim = MFCC_COEFFS - 1
  const sum = new Float64Array(dim)
  let count = 0
  for (let i = 0; i < mf.length; i++) {
    if (logEnergy[i]! < floor) continue
    const v = mf[i]!
    for (let d = 0; d < dim; d++) sum[d] = sum[d]! + v[d + 1]!
    count++
  }
  if (count === 0) return null
  for (let d = 0; d < dim; d++) sum[d] = sum[d]! / count
  return sum
}

/** Cosine distance (1 - cosine similarity) in [0, 2]. */
export function cosineDistance(a: Float64Array, b: Float64Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 1
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Convenience: signature of a raw PCM clip in one call. */
export function clipSignature(pcm: Int16Array, opts: MfccOptions = {}): Float64Array | null {
  return signature(mfcc(pcm, opts), opts.voicedFloorDb)
}
