/**
 * Reference audio clips for the media verdict: distinct synthetic "voices" for
 * alice / bob / charlie and a real-cadence ringback tone. Generated
 * deterministically (no RNG, no clock) so tests are hermetic and reproducible;
 * `scripts/fetch-media-clips.ts` can render these to listenable `.wav` files
 * and documents the upgrade path to real CC0 speech clips behind the same API.
 *
 * The voices use source–filter synthesis (glottal impulse train → formant
 * resonators) so each has a genuinely different spectral envelope — the thing
 * MFCC classification keys on — rather than just a different pitch. Ringback is
 * a pure 425 Hz EU tone, spectrally unmistakable against the broadband voices.
 */

export const CLIP_SAMPLE_RATE = 8000
const CLIP_DURATION_MS = 2000
const CLIP_SAMPLES = (CLIP_SAMPLE_RATE * CLIP_DURATION_MS) / 1000

export type ClipName = "alice" | "bob" | "charlie" | "ringback"

interface VoiceSpec {
  readonly f0: number // glottal fundamental (Hz)
  readonly formants: ReadonlyArray<{ freq: number; bw: number; gain: number }>
  readonly noiseSeed: number
}

const VOICES: Record<Exclude<ClipName, "ringback">, VoiceSpec> = {
  alice: {
    f0: 200,
    formants: [
      { freq: 800, bw: 80, gain: 1.0 },
      { freq: 1300, bw: 90, gain: 0.6 },
      { freq: 2700, bw: 120, gain: 0.3 },
    ],
    noiseSeed: 0x1a2b,
  },
  bob: {
    f0: 110,
    formants: [
      { freq: 500, bw: 70, gain: 1.0 },
      { freq: 1000, bw: 90, gain: 0.7 },
      { freq: 2400, bw: 120, gain: 0.25 },
    ],
    noiseSeed: 0x3c4d,
  },
  charlie: {
    f0: 150,
    formants: [
      { freq: 650, bw: 80, gain: 1.0 },
      { freq: 1700, bw: 100, gain: 0.65 },
      { freq: 3000, bw: 130, gain: 0.35 },
    ],
    noiseSeed: 0x5e6f,
  },
}

/** Deterministic LCG → low-level aspiration noise; keeps voices broadband. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff - 0.5
  }
}

/** Slow syllable-like amplitude envelope (raised-cosine bursts). */
function syllableEnvelope(n: number, total: number): number {
  const syllableHz = 4 // ~4 syllables/sec
  const phase = (2 * Math.PI * syllableHz * n) / CLIP_SAMPLE_RATE
  const burst = 0.5 - 0.5 * Math.cos(phase)
  // gentle fade in/out over 50 ms to avoid edge clicks
  const fade = Math.round((50 / 1000) * CLIP_SAMPLE_RATE)
  let edge = 1
  if (n < fade) edge = n / fade
  else if (n > total - fade) edge = (total - n) / fade
  return (0.3 + 0.7 * burst) * Math.max(0, edge)
}

function synthVoice(spec: VoiceSpec): Int16Array {
  const out = new Float64Array(CLIP_SAMPLES)
  const period = CLIP_SAMPLE_RATE / spec.f0
  const noise = lcg(spec.noiseSeed)

  // Each formant is a 2nd-order resonator: y[n] = x[n] + a1 y[n-1] - a2 y[n-2].
  const res = spec.formants.map((f) => {
    const r = Math.exp((-Math.PI * f.bw) / CLIP_SAMPLE_RATE)
    const theta = (2 * Math.PI * f.freq) / CLIP_SAMPLE_RATE
    return { a1: 2 * r * Math.cos(theta), a2: r * r, gain: f.gain, y1: 0, y2: 0 }
  })

  let nextPulse = 0
  for (let n = 0; n < CLIP_SAMPLES; n++) {
    // glottal impulse train + a little breath noise as the source
    let x = 0.15 * noise()
    if (n >= nextPulse) {
      x += 1
      nextPulse += period
    }
    let sample = 0
    for (const f of res) {
      const y = x + f.a1 * f.y1 - f.a2 * f.y2
      f.y2 = f.y1
      f.y1 = y
      sample += f.gain * y
    }
    out[n] = sample * syllableEnvelope(n, CLIP_SAMPLES)
  }

  return normalize(out, 0.6)
}

/** EU ringback: 425 Hz tone, 1 s on / 1 s off cadence. */
function synthRingback(): Int16Array {
  const out = new Float64Array(CLIP_SAMPLES)
  const onSamples = CLIP_SAMPLE_RATE // 1 s on
  const cycle = 2 * CLIP_SAMPLE_RATE // 1 s on + 1 s off
  for (let n = 0; n < CLIP_SAMPLES; n++) {
    const inTone = n % cycle < onSamples
    out[n] = inTone ? Math.sin((2 * Math.PI * 425 * n) / CLIP_SAMPLE_RATE) : 0
  }
  return normalize(out, 0.6)
}

function normalize(buf: Float64Array, peak: number): Int16Array {
  let max = 0
  for (const v of buf) max = Math.max(max, Math.abs(v))
  const scale = max > 0 ? (peak * 32767) / max : 0
  const out = new Int16Array(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(buf[i]! * scale)))
  }
  return out
}

const cache = new Map<ClipName, Int16Array>()

/** The reference PCM for a clip (synthesized, cached). */
export function referenceClip(name: ClipName): Int16Array {
  let pcm = cache.get(name)
  if (!pcm) {
    pcm = name === "ringback" ? synthRingback() : synthVoice(VOICES[name])
    cache.set(name, pcm)
  }
  return pcm
}

export const CLIP_NAMES: ReadonlyArray<ClipName> = ["alice", "bob", "charlie", "ringback"]

/** All reference clips keyed by name. */
export function referenceClips(): Map<ClipName, Int16Array> {
  const m = new Map<ClipName, Int16Array>()
  for (const name of CLIP_NAMES) m.set(name, referenceClip(name))
  return m
}
