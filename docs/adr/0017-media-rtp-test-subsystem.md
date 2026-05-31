# ADR 0017 — Media (RTP) test subsystem: PCM frontier, dedicated `src/media`, independent O/A witness

## Status

Implemented end to end, including the declarative DSL (`media: {}` agent config,
`dialog.media.plays/hears`, interpreter SDP-driving, final-sweep verdicts, HTML
media panel). The REFER media scenario caught and drove the fix of a one-way-audio
transfer bug (a-realign carried C's held `a=inactive` SDP to A). Live: the production
`src/media` package (G.711 codec, RFC 3550 RTP framing, RTCP SR/RR counts,
`MediaEndpoint` Layer/Tag, per-dialog RFC 3264/3262/5009 offer-answer engine,
transport demux + active-peer state machine), two engine implementations behind
one Tag (hand-rolled TS + rtp.js witness), the test-only audio comparator under
`src/test-harness/media/audio`, and end-to-end media over the shared
`SignalingNetwork` (fake + live) with the SDP-misdirection bug-catch. The
declarative DSL (`dialog.media.plays/hears`), interpreter SDP-driving, and HTML
report rollup are the remaining Slice 3b increment.

Relates to [ADR-0007](0007-strict-sip-parser-as-security-boundary.md) (the SIP
fabric these binds share) and the media-testing operator notes in
[docs/media-testing.md](../media-testing.md). Plan:
`docs/plan/test-extentions-to-include-structured-pelican.md`.

## Context

The SIP test fabric verified **signaling only**. SDP bodies were
string-heuristic (offer `8 18 101`, answer `8 101`) correlated by an
`x-offer-id` nonce + `port == offer+1`. No RTP, no audio, no codec existed — so
no test could tell whether Alice and Bob can actually *hear* each other, or
whether an SDP-rewrite bug in the (signaling-only) B2BUA silently misdirects
media. Media is end-to-end; the B2BUA rewrites/synthesizes SDP in several paths
(fake-PRACK codec intersection, REFER realign, `o=` rewrite, early-media
promotion) — each a place a bug can kill the codec or point media at nowhere.

## Decision

- **PCM frontier (WebRTC-style).** The endpoint *owns* generation — codec, RTP
  framing, SSRC/seq/timestamp, RTCP, pacing — and never exposes raw RTP on its
  public surface. The Layer API is "play this PCM" / "give me recorded PCM" +
  `getStats()` counts. A TS-only `sendRaw` escape hatch is reserved for future
  negative RTP-wire tests. Rationale: real WebRTC/rvoip engines never expose
  raw-RTP send, so a lower frontier would block dropping a real engine in later.

- **Dedicated production package `src/media`** (peer of `src/sip`, `src/b2bua`),
  exported as `@vcharbon/sipjs/media`. Only the **audio comparator** (reference
  clips + spectral classification + verdict) is test-only, under
  `src/test-harness/media/audio`.

- **`MediaEndpoint` is an Effect Layer reusing the same `SignalingNetwork` +
  `Clock` as SIP** — so it runs unchanged under fake-net/fake-clock, real-net/
  real-clock, and (later) against a real SBC. Media binds are **raw**
  (`BindUdpOpts.raw`): the contracts wrapper and the dgram tracer skip raw
  binds, so RTP is never parsed as SIP, audited against RFC rules, or rendered
  in the SIP sequence diagram, while still sharing the routing fabric.

- **Per-dialog offer-answer engine as an independent conformance witness.** The
  RFC 3264/3262/5009 state machine in `src/media/sdp` is deliberately separate
  from the B2BUA's `src/sip/SdpUtils.ts`. It does strict filtering (each refusal
  a typed `SdpNegotiationError` mapped to a named RFC MUST), so a B2BUA that
  mangles the relayed `c=`/`m=`, intersects codecs wrong, or drops an m-line
  makes the *receiving* engine reject or mis-point → `hears(...)` fails. This
  replaces the `x-offer-id` nonce + `port+1` heuristic with physical
  correlation: did audio from the source actually arrive where the negotiated
  SDP pointed.

- **Two implementations, one Tag — independent wire witnesses.** A hand-rolled
  RFC 3550 codec (`src/media/rtp/packet.ts`, the thing under test) and an
  rtp.js-backed codec (`src/media/native`, versatica) share the entire
  transport engine via an `RtpFraming` seam and differ only in serialization.
  Pairing TS-encode ↔ rtp.js-parse (and vice-versa) catches framing bugs a
  single self-consistent impl would miss. Rejected: full WebRTC stacks
  (`werift`, `@roamhq/wrtc`) force SRTP/ICE/DTLS, mismatching the plain RTP/AVP
  the B2BUA + SBC use; `node-rtp` is send-only.

- **Forking model: transport demux + active-peer singleton.** One
  `MediaTransport` per offer (one local port) demuxes inbound RTP into
  per-`(remote,SSRC)` buckets and records each continuously; one or more
  per-dialog `MediaSession`s share it. At most one session is the *committed*
  active peer — the only one sent from and the one a plain `recorded()`/`hears`
  resolves against. Early media switches on only with SDP + authorizing
  `P-Early-Media` (RFC 5009); a 200 OK commits one branch and abandons the rest;
  a re-offer re-points the active peer. This mirrors the B2BUA's own
  singleton-active-peer model ([ADR-0014](0014-leg-kind-and-singleton-active-peer.md)).

- **RTP port choice belongs to the endpoint, not `SignalingNetwork`.**
  `MediaEndpoint.open(ip, port?)` auto-allocates an even port from its media
  range when none is given; `SignalingNetwork.bindUdp` stays the dumb bind
  primitive (same as for SIP).

## Consequences

- A real SDP-rewrite bug now fails a test: corrupting the relayed connection
  address makes the receiver get no audio (`hears` → silence/no-audio), while
  the source bucket proves the fabric is alive and the misdirection is targeted.
- The comparator is robust to transcoding: nearest-reference classification with
  a margin survives a G.711 round-trip (and, by design, an SBC's DSP) where an
  absolute threshold would not.
- First-cut scope: RTCP is counts-only (SR/RR on the standard interval, no field
  assertions yet); the early-media trio and hold/resume scenarios are deferred,
  though the O/A engine already models the states.
- `rtp.js` is a runtime dependency because the witness impl lives in the
  production `src/media/native` tree.
