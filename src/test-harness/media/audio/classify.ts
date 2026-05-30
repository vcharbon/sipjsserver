/**
 * Audio verdict: classify recorded PCM against the reference clips by
 * nearest-signature with a margin, guarded by an energy floor.
 *
 * "Nearest with a margin" (relative match), not an absolute distance
 * threshold, is what survives an SBC's transcoding DSP — the matched clip just
 * has to be clearly closer than every other reference. The silence/energy
 * guard fails loudly when too little audio arrived, so a dead media path can't
 * masquerade as a weak match.
 */

import { clipSignature, cosineDistance } from "./spectral.js"
import { type ClipName, referenceClips } from "./clips.js"

export type Classification = "matched" | "ambiguous" | "silence" | "no-audio"

export interface MediaVerdict {
  readonly classification: Classification
  /** Nearest reference, or null when silence/no-audio/ambiguous-with-no-winner. */
  readonly matched: ClipName | null
  /** Cosine distance to the matched reference (lower = closer). */
  readonly distance: number
  /** Distance gap to the runner-up — the margin actually achieved. */
  readonly margin: number
  /** Distance to every reference, for reporting. */
  readonly distances: Record<string, number>
  /** RMS in [0,1] full-scale, for the silence diagnosis. */
  readonly rms: number
}

export interface ClassifyOptions {
  /** Min distance gap between best and runner-up to accept a match. */
  readonly margin?: number
  /** RMS floor (full-scale fraction) below which audio is "silence". */
  readonly rmsFloor?: number
  /** Min samples required before classifying at all. */
  readonly minSamples?: number
  /** Override the reference set (defaults to all bundled clips). */
  readonly references?: ReadonlyMap<ClipName, Int16Array>
}

const DEFAULTS = {
  margin: 0.05,
  rmsFloor: 0.01,
  minSamples: 800, // 100 ms @ 8 kHz
} as const

function rmsFullScale(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let acc = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]! / 32768
    acc += v * v
  }
  return Math.sqrt(acc / pcm.length)
}

let refSigCache: Map<ClipName, Float64Array> | null = null
function defaultReferenceSignatures(): Map<ClipName, Float64Array> {
  if (!refSigCache) {
    refSigCache = new Map()
    for (const [name, pcm] of referenceClips()) {
      const sig = clipSignature(pcm)
      if (sig) refSigCache.set(name, sig)
    }
  }
  return refSigCache
}

function referenceSignatures(
  refs?: ReadonlyMap<ClipName, Int16Array>,
): Map<ClipName, Float64Array> {
  if (!refs) return defaultReferenceSignatures()
  const m = new Map<ClipName, Float64Array>()
  for (const [name, pcm] of refs) {
    const sig = clipSignature(pcm)
    if (sig) m.set(name, sig)
  }
  return m
}

/** Classify a single recorded clip against the reference set. */
export function classify(pcm: Int16Array, opts: ClassifyOptions = {}): MediaVerdict {
  const margin = opts.margin ?? DEFAULTS.margin
  const rmsFloor = opts.rmsFloor ?? DEFAULTS.rmsFloor
  const minSamples = opts.minSamples ?? DEFAULTS.minSamples
  const rms = rmsFullScale(pcm)

  const empty: Record<string, number> = {}
  if (pcm.length < minSamples) {
    return { classification: "no-audio", matched: null, distance: Infinity, margin: 0, distances: empty, rms }
  }
  if (rms < rmsFloor) {
    return { classification: "silence", matched: null, distance: Infinity, margin: 0, distances: empty, rms }
  }

  const sig = clipSignature(pcm)
  if (!sig) {
    return { classification: "silence", matched: null, distance: Infinity, margin: 0, distances: empty, rms }
  }

  const refs = referenceSignatures(opts.references)
  const distances: Record<string, number> = {}
  let best: ClipName | null = null
  let bestD = Infinity
  let secondD = Infinity
  for (const [name, refSig] of refs) {
    const d = cosineDistance(sig, refSig)
    distances[name] = d
    if (d < bestD) {
      secondD = bestD
      bestD = d
      best = name
    } else if (d < secondD) {
      secondD = d
    }
  }

  const gap = secondD === Infinity ? Infinity : secondD - bestD
  if (best === null) {
    return { classification: "no-audio", matched: null, distance: Infinity, margin: 0, distances, rms }
  }
  if (gap < margin) {
    return { classification: "ambiguous", matched: null, distance: bestD, margin: gap, distances, rms }
  }
  return { classification: "matched", matched: best, distance: bestD, margin: gap, distances, rms }
}

export interface Segment {
  readonly label: ClipName | null
  readonly startMs: number
  readonly endMs: number
  readonly classification: Classification
}

export interface SequenceOptions extends ClassifyOptions {
  /** Sliding-window length for segment classification. */
  readonly windowMs?: number
  /** Hop between windows. */
  readonly hopMs?: number
  /** Sample rate of the recorded PCM. */
  readonly sampleRate?: number
}

/**
 * Classify a recording as an ordered sequence of segments — for "ringback then
 * voice" assertions on a single uninterrupted flow. Slides a window, classifies
 * each, then collapses runs of the same label into segments.
 */
export function classifySequence(pcm: Int16Array, opts: SequenceOptions = {}): ReadonlyArray<Segment> {
  const sampleRate = opts.sampleRate ?? 8000
  const windowMs = opts.windowMs ?? 400
  const hopMs = opts.hopMs ?? 200
  const win = Math.round((windowMs / 1000) * sampleRate)
  const hop = Math.round((hopMs / 1000) * sampleRate)

  const labeled: Array<{ label: ClipName | null; classification: Classification; startMs: number; endMs: number }> = []
  for (let start = 0; start + win <= pcm.length || (start === 0 && pcm.length > 0); start += hop) {
    const end = Math.min(start + win, pcm.length)
    const v = classify(pcm.subarray(start, end), { ...opts, minSamples: Math.min(opts.minSamples ?? 0, win) })
    labeled.push({
      label: v.matched,
      classification: v.classification,
      startMs: (start / sampleRate) * 1000,
      endMs: (end / sampleRate) * 1000,
    })
    if (end >= pcm.length) break
  }

  // Collapse consecutive windows sharing a label.
  const segments: Array<Segment> = []
  for (const w of labeled) {
    const prev = segments[segments.length - 1]
    if (prev && prev.label === w.label && prev.classification === w.classification) {
      segments[segments.length - 1] = { ...prev, endMs: w.endMs }
    } else {
      segments.push({ label: w.label, classification: w.classification, startMs: w.startMs, endMs: w.endMs })
    }
  }
  return segments
}

/** Does a classified recording match an expected ordered sequence of labels (ignoring silence gaps)? */
export function matchesSequence(segments: ReadonlyArray<Segment>, expected: ReadonlyArray<ClipName>): boolean {
  const seen = segments
    .filter((s) => s.classification === "matched" && s.label !== null)
    .map((s) => s.label as ClipName)
  // Collapse adjacent duplicates in the observed label stream.
  const collapsed: Array<ClipName> = []
  for (const l of seen) {
    if (collapsed[collapsed.length - 1] !== l) collapsed.push(l)
  }
  if (collapsed.length !== expected.length) return false
  return expected.every((e, i) => collapsed[i] === e)
}
