# Reference clip provenance

The media verdict classifies recorded RTP against four reference clips:
`alice`, `bob`, `charlie`, and `ringback`.

## Current source: synthesized (CC0 / generated)

These clips are **generated deterministically** by
[`../clips.ts`](../clips.ts) — no download, no third-party assets, no RNG, no
clock. Each voice uses source–filter synthesis (a glottal impulse train at a
distinct fundamental shaped by three formant resonators) so the four references
have genuinely different *spectral envelopes*, which is what the MFCC classifier
keys on. Ringback is a pure 425 Hz EU tone with a 1 s on / 1 s off cadence.

Because they are generated, the clips are CC0 (no rights reserved) and fully
reproducible: re-running `scripts/fetch-media-clips.ts` reproduces byte-identical
`.wav` files. Format: 8 kHz mono 16-bit PCM, ≤2 s.

| Clip     | Fundamental | Character                    |
|----------|-------------|------------------------------|
| alice    | 200 Hz      | high formants (800/1300/2700)|
| bob      | 110 Hz      | low formants (500/1000/2400) |
| charlie  | 150 Hz      | mid formants (650/1700/3000) |
| ringback | 425 Hz tone | EU ringback cadence          |

## Upgrade path: real CC0 speech

For more realistic SBC-transcoding robustness the synthetic voices can be
replaced with short real CC0 speech clips (one distinct speaker each) without
touching the classifier — the same `referenceClip(name)` API loads them. When
that happens, record here for each clip: source corpus + URL, license (must be
CC0 / public domain), the exact trim window, and the resample command used to
reach 8 kHz mono 16-bit PCM. `scripts/fetch-media-clips.ts` is the place to
encode the retrieval + prep steps so the assets stay reproducible.
