# Media testing (RTP play / record / verify)

Test/operator vocabulary for the media subsystem. Kept **out of** CONTEXT.md
(that file is the SIP B2BUA domain glossary only). Decisions: [ADR-0017](adr/0017-media-rtp-test-subsystem.md).

## What it does

The SIP fabric verifies signaling; this verifies **audio**. Endpoints send real
RTP, record inbound RTP, and the comparator classifies the recording against
reference clips — so a test can assert "Alice hears Bob" / "Alice hears
ringback", strict enough to break when the offer/answer model is violated.

Media is **end-to-end**; the B2BUA is signaling-only but rewrites/synthesizes
SDP. If a rewrite misdirects the connection address, the receiver gets no audio
and the `hears(...)` verdict fails — that is the bug-catch.

## The pieces

| Area | Location |
|------|----------|
| G.711 PCMA/PCMU codec | `src/media/codec/g711.ts` |
| RFC 3550 RTP framing (TS) + `RtpFraming` seam | `src/media/rtp/packet.ts` |
| RTCP SR/RR (counts only) + RFC 5761 mux demux | `src/media/rtp/rtcp.ts` |
| Transport engine (bind, paced sender, recorder, demux, active-peer, stats) | `src/media/transport.ts` |
| `MediaEndpoint` Tag + `MediaTransport`/`MediaSession` types | `src/media/MediaEndpoint.ts` |
| TS engine (under test) | `src/media/ts/MediaEndpointTs.ts` |
| rtp.js engine (independent wire witness) | `src/media/native/MediaEndpointRtpJs.ts` |
| Offer/Answer engine + P-Early-Media gate | `src/media/sdp/{parse,negotiator,types}.ts` |
| Reference clips (synth voices + ringback) | `src/test-harness/media/audio/clips.ts` |
| Spectral features (MFCC + cosine) | `src/test-harness/media/audio/spectral.ts` |
| Verdict (nearest-reference + margin + silence guard) | `src/test-harness/media/audio/classify.ts` |
| WAV reader/writer | `src/test-harness/media/audio/wav.ts` |

## Concepts

- **MediaTransport** — one local RTP port (= one SDP offer). Demuxes inbound RTP
  into per-`(remote, SSRC)` **source buckets**, records each continuously, and
  tracks per-source stats. `open(ip, port?)` auto-allocates an even RTP port
  when none is given.
- **MediaSession** — one per dialog. `configure(NegotiatedMedia)` sets codec +
  remote + direction; `commit("confirmed"|"early-pem")` makes it the **active
  peer** (abandoning siblings); `play(script)` is non-blocking and only emits
  once committed + send-enabled; `recorded()` returns inbound PCM attributed to
  this peer.
- **Active peer** — at most one committed session per transport: the only one
  sent from, and the one a plain `hears(dialog)` resolves against. All sources
  keep recording (so forked early media is observable for the report).
- **Offer/Answer engine** — per-dialog RFC 3264/3262 state machine. `localOffer`
  builds an offer from the bound transport's real addr/port + codecs; `answerTo`
  builds a strict final answer; `applyRemote` applies a received answer
  (provisional or final). Refusals are typed `SdpNegotiationError`s, each a
  named RFC MUST (codec-not-in-offer, empty-intersection, m-line mismatch,
  answer-without-offer, glare). `isEarlyMediaAuthorized` is the RFC 5009 gate
  (SDP + `P-Early-Media: sendrecv|sendonly`).

## Reference clips & verdict

Four clips — `alice` / `bob` / `charlie` (distinct synthetic voices via
formant synthesis) and `ringback` (425 Hz EU tone) — generated deterministically
(no RNG, no clock); see `src/test-harness/media/audio/clips/SOURCES.md`. Run
`tsx scripts/fetch-media-clips.ts` to render them to listenable `.wav`.

The verdict is **nearest-reference with a margin** (relative match, robust to
transcoding) plus a **silence/energy guard** that fails when too little audio
arrived. `classifySequence` segments a recording for "ringback then voice"
assertions. Codec: G.711 PCMA (PT 8), PCMU optional.

## Running media on the shared fabric

`MediaEndpoint` rides the same `SignalingNetwork` + `Clock` as SIP. Media binds
are **raw** (`BindUdpOpts.raw`): RTP bypasses the SIP audit contracts and the
hop-by-hop tracer but still shares the routing fabric. `stackLayer({mode})`
provides `MediaEndpoint` in both fake and live; it is **inert until a test
opens a transport** (media is opt-in per test).

Fake: simulated fabric + TestClock — RTP flows during the following
`s.pause(...)` / `TestClock.adjust(...)`, real ptime (20 ms) inside the play
window, zero fires when idle. Live: real UDP + real `Effect.sleep`.

## Tests

- `tests/media/audio-comparator.test.ts` — clips classify as themselves, cross
  separation, ringback ≠ voice, silence guard, G.711-round-trip robustness, WAV
  round-trip, segment sequence.
- `tests/media/rtp-media.test.ts` + `rtp-media-live.test.ts` — RTP framing
  cross-check (TS ↔ rtp.js, both directions), play→record over fake + real UDP,
  stats, RTCP counts.
- `tests/media/sdp-negotiation.test.ts` — RFC 3264/3262/5009 matrix
  (positive + one negative per MUST).
- `tests/media/transport-active-peer.test.ts` — forking demux, no-send-until-
  commit, 200-commits-one-abandons-rest, re-offer re-point.
- `tests/media/media-e2e.test.ts` — end-to-end O/A over the fabric: transparent
  relay → both hear each other; corrupted-answer (SDP-rewrite bug) → `hears`
  catches it. Runs with both the TS and rtp.js engines.
- `tests/media/media-audited-fabric.test.ts` — RTP rides the *audited* fabric
  (raw bind) cleanly; auto port allocation.

## Not yet (follow-ups)

- Declarative DSL: `media` agent config + `dialog.media.plays/hears`, interpreter
  SDP-driving (the agent's SIP SDP body comes from the bound session), final-
  sweep media verdicts, and the HTML report RTP/RTCP rollup + verdict rows.
- Real-SBC mode (point endpoints at rtpengine and confirm classification
  survives its transcoding DSP).
- RTCP field assertions; early-media trio + hold/resume scenarios.
