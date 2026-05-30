/**
 * Slice 0 — reference clips + audio comparator (pure, no network, no Effect).
 *
 * Proves the verdict engine the media slices depend on: each clip classifies
 * as itself with a real margin, voices don't collide with each other or with
 * ringback, the silence/energy guard fires, classification survives a G.711
 * transcode round-trip, and the WAV + codec round-trips are faithful.
 */
import { describe, expect, it } from "vitest"
import { type ClipName, referenceClip, referenceClips, CLIP_SAMPLE_RATE } from "../../src/test-harness/media/audio/clips.js"
import { classify, classifySequence, matchesSequence } from "../../src/test-harness/media/audio/classify.js"
import { clipSignature, cosineDistance } from "../../src/test-harness/media/audio/spectral.js"
import { decodeWav, encodeWav } from "../../src/test-harness/media/audio/wav.js"
import { alawDecode, alawEncode, g711RoundTrip, mulawDecode, mulawEncode } from "../../src/media/codec/g711.js"

const VOICES: ReadonlyArray<ClipName> = ["alice", "bob", "charlie"]

describe("reference clips classify as themselves", () => {
  for (const name of [...VOICES, "ringback" as const]) {
    it(`classifies '${name}' as '${name}' with a margin`, () => {
      const v = classify(referenceClip(name))
      expect(v.classification).toBe("matched")
      expect(v.matched).toBe(name)
      expect(v.margin).toBeGreaterThan(0.05)
    })
  }
})

describe("cross-clip separation", () => {
  it("every clip's nearest reference is itself, by a clear margin", () => {
    const clips = referenceClips()
    const sigs = new Map<ClipName, Float64Array>()
    for (const [name, pcm] of clips) {
      const s = clipSignature(pcm)
      expect(s).not.toBeNull()
      sigs.set(name, s!)
    }
    for (const [a, sigA] of sigs) {
      const self = cosineDistance(sigA, sigA)
      for (const [b, sigB] of sigs) {
        if (a === b) continue
        const cross = cosineDistance(sigA, sigB)
        expect(cross, `${a} vs ${b}`).toBeGreaterThan(self + 0.05)
      }
    }
  })

  it("ringback does not classify as any voice and vice-versa", () => {
    expect(classify(referenceClip("ringback")).matched).toBe("ringback")
    for (const v of VOICES) {
      expect(classify(referenceClip(v)).matched).not.toBe("ringback")
    }
  })
})

describe("silence / energy guard", () => {
  it("flags empty PCM as no-audio", () => {
    const v = classify(new Int16Array(0))
    expect(v.classification).toBe("no-audio")
    expect(v.matched).toBeNull()
  })

  it("flags too-short PCM as no-audio", () => {
    const v = classify(new Int16Array(100))
    expect(v.classification).toBe("no-audio")
  })

  it("flags near-silent PCM as silence", () => {
    const quiet = new Int16Array(CLIP_SAMPLE_RATE)
    for (let i = 0; i < quiet.length; i++) quiet[i] = (i % 3) - 1 // ±1 LSB dither
    const v = classify(quiet)
    expect(v.classification).toBe("silence")
    expect(v.matched).toBeNull()
  })
})

describe("transcoding robustness (G.711 round-trip)", () => {
  for (const codec of ["PCMA", "PCMU"] as const) {
    for (const name of VOICES) {
      it(`'${name}' still classifies as itself after ${codec} round-trip`, () => {
        const transcoded = g711RoundTrip(referenceClip(name), codec)
        const v = classify(transcoded)
        expect(v.classification).toBe("matched")
        expect(v.matched).toBe(name)
      })
    }
  }
})

describe("segment classification (ringback then voice)", () => {
  it("classifies a ringback→bob concatenation as the ordered sequence", () => {
    const rbt = referenceClip("ringback")
    const bob = referenceClip("bob")
    const joined = new Int16Array(rbt.length + bob.length)
    joined.set(rbt, 0)
    joined.set(bob, rbt.length)

    const segments = classifySequence(joined, { sampleRate: CLIP_SAMPLE_RATE })
    expect(matchesSequence(segments, ["ringback", "bob"])).toBe(true)
    expect(matchesSequence(segments, ["bob", "ringback"])).toBe(false)
  })
})

describe("G.711 codec sample round-trip", () => {
  it("PCMA decode∘encode stays within companding tolerance", () => {
    const pcm = referenceClip("alice")
    const back = alawDecode(alawEncode(pcm))
    expect(back.length).toBe(pcm.length)
    let maxErr = 0
    for (let i = 0; i < pcm.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(pcm[i]! - back[i]!))
    }
    // A-law step near full scale is coarse but bounded; well under 5% FS.
    expect(maxErr).toBeLessThan(1600)
  })

  it("PCMU decode∘encode stays within companding tolerance", () => {
    const pcm = referenceClip("bob")
    const back = mulawDecode(mulawEncode(pcm))
    let maxErr = 0
    for (let i = 0; i < pcm.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(pcm[i]! - back[i]!))
    }
    expect(maxErr).toBeLessThan(1600)
  })
})

describe("WAV reader/writer round-trip", () => {
  it("encode→decode preserves PCM and sample rate", () => {
    const pcm = referenceClip("charlie")
    const { pcm: back, sampleRate } = decodeWav(encodeWav(pcm, CLIP_SAMPLE_RATE))
    expect(sampleRate).toBe(CLIP_SAMPLE_RATE)
    expect(back.length).toBe(pcm.length)
    for (let i = 0; i < pcm.length; i++) expect(back[i]).toBe(pcm[i])
  })

  it("rejects a non-RIFF buffer", () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })
})
