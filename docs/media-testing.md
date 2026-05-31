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

## Declarative scenarios (through the real B2BUA)

Opt a scenario agent into media with `media: {}` in its `AgentConfig`; the
interpreter then drives that agent's SIP SDP body from a bound `MediaTransport`
(engine offer/answer) instead of the static `sdpOffer()`/`sdpAnswer()` bodies.
`dialog.media.plays("alice")` emits a reference clip; `dialog.media.hears(other
.media)` registers a verdict resolved at the final sweep (classify the receiver's
recording against the clip the source played). RTP/RTCP counts + verdict rows
render in a dedicated **Media (RTP)** panel of the HTML report (never as SIP
arrows). Non-media agents are unaffected — engine SDP is unclassified, so the
`x-offer-id` nonce + port+1 path is left intact for everything else.

- `tests/media/basic-call-media.test.ts` — Alice/Bob hear each other through the
  real (signaling-only) B2BUA; asserts the HTML media panel + PASS verdicts.
- `tests/media/reroute-media.test.ts` — media survives an in-dialog re-INVITE
  re-negotiation (the re-offer path REFER's c-realign also uses).
- `tests/media/refer-transfer-media.test.ts` — REFER blind transfer; after merge
  A↔C must hear each other bidirectionally. This caught a real one-way-audio bug:
  the a-realign re-INVITE to A carried C's initial *held* (`a=inactive`) SDP, so A
  never enabled its send path (fixed in `referTransfer.ts` to carry C's active
  c-realign answer). Static SDP tests missed it — `sdpAnswer()` always emits
  `a=sendrecv`; only a direction-honouring media engine exposes it.
- `tests/media/p2p-media-live.test.ts` — the same declarative path over **real
  UDP + real wall-clock** (`it.live`, peer-to-peer, no external server). Proves
  the interpreter SDP-driving + paced senders + verdicts work on the wire, not
  just under TestClock. The live runners provide `MediaEndpoint` over
  `SignalingNetwork.real` (`harness.ts` `LiveMediaLayer`).

## Not yet (follow-ups)

- Live media through the *external* B2BUA (`createLiveRunner`) — the runner now
  provides `MediaEndpoint`, so a `LIVE_ENABLED` declarative scenario against a
  real server process is a drop-in once a server is running.
- Real-SBC mode (point endpoints at rtpengine and confirm classification
  survives its transcoding DSP).
- RTCP field assertions; early-media trio + hold/resume scenarios.
