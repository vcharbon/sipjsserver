# Media-faithful endpoints: RTP play + record + verify

## Context

Today the SIP test fabric verifies **signaling only**. The simulated `SignalingNetwork`
routes SIP datagrams; [helpers/sdp.ts](src/test-harness/framework/helpers/sdp.ts) emits
string-heuristic SDP (offer = codecs `8 18 101`, answer = `8 101`) correlated by an
`x-offer-id` nonce; [offer-answer-tracker.ts](src/test-harness/framework/offer-answer-tracker.ts)
checks offer↔answer ordering and `port == offer+1`. **No RTP, no audio, no codec exist.**

The gap: the B2BUA is signaling-only and media is **end-to-end**, but it *rewrites or
synthesizes SDP* in several paths — fake-PRACK codec intersection
([SdpAnswerFromOffer.ts](src/sip/SdpAnswerFromOffer.ts)), REFER held-SDP / C-realign
([TransferRules.ts](src/b2bua/rules/defaults/TransferRules.ts)), `o=` origin rewrite,
early-media promotion ([promote18xPemTo200.ts](src/b2bua/rules/custom/promote18xPemTo200.ts),
[relayFirst18xTo180.ts](src/b2bua/rules/custom/relayFirst18xTo180.ts)). A bug in any of
these silently misdirects media or kills the codec — and **no test can currently tell
whether Alice and Bob can actually hear each other, or whether Alice hears ringback.**

Goal: endpoints that **send RTP, record it, and verify the audio** (voice-A vs voice-B vs
ringback) — strict enough to break when the offer/answer model is violated — without breaking
the fake-clock model, and reusable against a **real third-party SBC** (which, unlike our B2BUA,
anchors + transcodes media like rtpengine).

## Decisions (from grilling)

1. **End-to-end media; B2BUA rewrites SDP. Two media-control archetypes (the frontier).**
   *Endpoint control* — WebRTC `RTCPeerConnection` (`createOffer/Answer`, `addTrack`,
   `getStats()`) and rvoip `api::client` — *owns generation* (codec, RTP framing, RTCP, jitter;
   never exposes raw RTP). *Relay control* — rtpengine's "ng" offer/answer/delete protocol —
   *anchors + transcodes* in the middle and generates nothing. Our `MediaEndpoint` is the
   **endpoint** archetype (our endpoints = browsers); the **third-party SBC = rtpengine**
   archetype (device under test, configured externally). The framework *drives* endpoints and
   *tests the effect of* the relay; it never controls an rtpengine-style relay in-test.

2. **Dedicated production media package `src/media/`; comparator stays in test-harness.**
   The RTP stack (framing, SSRC/seq/timestamp, RTCP SR/RR), G.711 codec, PCM play/record, and
   the `MediaEndpoint` Layer/Tag are a **production-usable subsystem** under `src/media/` (peer of
   [src/sip](src/sip), [src/b2bua](src/b2bua)), exported as `./media` in package.json. Only the
   **audio comparator** (reference clips + spectral similarity + verdict) is test-only, under
   `src/test-harness/`.

3. **`MediaEndpoint` is an Effect `Layer`** reusing the **same `SignalingNetwork` + `Clock`
   services as SIP** — so it runs unchanged under fake-net/fake-clock, real-net/real-clock, and
   against a real SBC. `bindUdp(chosenIp, chosenPort)` gives port choice; `.send(rtpBytes, dstPort,
   dstAddr)` generates RTP (sim fabric routes by `dstIp:dstPort`; real fabric binds a dgram
   socket). Media binds use a **raw / non-SIP mode** so RTP is not run through the SIP parser, the
   SIP audit contracts (`withSignalingNetworkContracts`), or the SIP tracer on the shared fabric.

4. **Frontier = PCM (WebRTC-style).** Layer API = "play this PCM" / "give me recorded PCM" +
   `getStats()` aggregated counts. The impl owns codec encode/decode, RTP framing, SSRC/seq/ts,
   RTCP, jitter. The framework owns strict SDP O/A, reference clips, and the spectral verdict.
   (WebRTC/native engines never expose raw-RTP send, so a lower frontier blocks the swap goal.)
   A **TS-only raw-inject escape hatch** is reserved for future negative RTP-wire tests.

5. **Two endpoint implementations, same Tag — TS stack vs independent native cross-check.**
   - **TS impl** (`src/media/ts/`): hand-rolled RFC 3550 RTP over `SignalingNetwork`, paced by
     `Clock.sleep(ptime)`. The thing under test.
   - **Native cross-check impl** (`src/media/native/`): packets serialized/parsed by
     [rtp.js](https://www.npmjs.com/package/rtp.js) (versatica — actively maintained, TS,
     Node+browser, pure RTP+RTCP codec, no ICE/DTLS/SRTP). It rides the *same* `SignalingNetwork`
     + `Clock`, so it works in fake mode too. Pairing TS-send ↔ rtp.js-parse (and vice-versa)
     makes each an **independent witness** of the other's wire format — catching framing bugs a
     single self-consistent impl would miss. (Rejected: full WebRTC stacks `werift` /
     `@roamhq/wrtc` force SRTP/ICE/DTLS, mismatching the plain RTP/AVP the B2BUA + SBC use;
     `node-rtp` is send-only.) A future browser/rvoip impl drops in behind the same Tag.

6. **Media binds to the DIALOG, not the agent — but one local RTP port may back several forked
   dialogs.** One offer/answer exchange logically belongs to a dialog; re-offers (hold, REFER
   realign) mutate *that dialog's* session. `plays`/`hears` hang off the `DialogRef`
   (`aliceDialog.media.plays(...)`, `aliceDialog.media.hears(bobDialog.media)`), never off the
   agent. **But** a single INVITE offer can fork into N early dialogs that all answer with their
   own SDP, so the *caller's one local RTP transport (port)* may receive media from several
   remote destinations at once. So the model is: one **MediaTransport** (local port) per offer,
   carrying one or more **per-dialog peer negotiations**; the transport demuxes inbound RTP by
   source and the engine selects the **active peer** (next decision). See the dedicated
   "Forking & early-media" section.

7. **Per-test, non-blocking play; default 2 s at call start, silence after.** `plays(...)` is
   fire-and-forget: it starts a bounded sender fiber and returns immediately, so two dialogs
   play **concurrently** and the playout overlaps subsequent steps / `s.pause()`. Outside a play
   window senders are silent → zero TestClock fires during 15-min keepalive pauses. Real ptime
   (20 ms) inside the window. The session **records inbound PCM continuously** regardless of
   play state.

8. **Continuous "RBT then media" on one flow, no interruption.** A play directive is a *script*
   on one RTP flow: e.g. `{ ringback: 1500, then: clip, durationMs: 2000 }` emits ringback then
   the voice clip back-to-back on the same SSRC/sequence — no gap. The receive side can assert a
   **sequence** ("first ringback, then bob"), or just the final source. Default per-test choice:
   plain media, or RBT-then-media.

9. **Reference clips + spectral similarity; ref-based assertions (no correlation nonce).**
   Distinct short clips for Alice / Bob / Charlie / ringback (RBT = real 425 Hz EU / 440+480 Hz US
   tone). Verdict = **nearest-reference classification with a margin** (robust to SBC transcoding
   — relative match beats absolute threshold) + a **silence/energy guard** that fails when too
   little audio arrived. Codec: **G.711 PCMA (PT 8)**, PCMU optional.

   **Correlation is now physical, not a string.** Real RTP carries a real SSRC and real audio,
   and the SDP answer carries the *real* address/port where the endpoint listens. So the
   `x-offer-id` nonce + `port==offer+1` heuristic is **removed**. Correlation = "did audio from
   the source actually arrive at the address the negotiated SDP pointed to." The DSL takes the
   **source dialog's media ref**, not a string: `aliceDialog.media.hears(bobDialog.media)`,
   `aliceDialog.media.hears(RBT)`.

10. **Distinct Offer/Answer engine (RFC 3264/3262) — see dedicated section below.** A per-dialog
   O/A state machine in `src/media/sdp/` drives the MediaSession, does the strict filtering,
   distinguishes reliable from unreliable provisionals, and handles destination change. It is the
   independent conformance witness (separate code from the B2BUA's
   [SdpUtils.ts](src/sip/SdpUtils.ts)).

11. **Aggregated RTP/RTCP in the HTML report.** Per-stream rollup (ssrc, codec/pt,
    packets/bytes sent+received, lost, jitter, duration) + media verdict (matched source,
    similarity, classification) added to the run shape and rendered in
    `src/test-harness/framework/html-report.ts`; sequence-diagram media arrows annotated with
    **counts, not per-packet**.

12. **Optional audio recording to file alongside the HTML report.** A run flag dumps each
    dialog's recorded inbound PCM as a playable `.wav` (and the sent clip) next to the HTML
    report, linked from the media-verdict row, so a human can *listen* to what Alice actually
    received. Off by default; on in CI artifacts / when debugging.

## `src/media/` package layout (production)

```
src/media/
├── index.ts                 // public exports + ./media package.json entry
├── MediaEndpoint.ts         // Tag + Layer + MediaEndpointApi / MediaSession types
├── codec/g711.ts            // PCMA/PCMU encode+decode (PCM16 ⇄ A-law/µ-law)
├── rtp/{packet.ts,rtcp.ts}  // RFC 3550 framing, SSRC/seq/ts, SR/RR
├── transport.ts             // MediaTransport: local port, per-(addr,SSRC) demux + record + active-peer
├── session.ts               // per-dialog MediaSession (shares a MediaTransport under forking)
├── sdp/{negotiator.ts,parse.ts,types.ts}  // RFC 3264/3262 offer/answer engine (per-dialog)
├── ts/MediaEndpointTs.ts    // hand-rolled impl over SignalingNetwork + Clock
└── native/MediaEndpointRtpJs.ts  // same Tag, packets via rtp.js (independent witness)
```

### Layer interface (modeled on rvoip `MediaTransportClient` + WebRTC `getStats()`)

```ts
export class MediaEndpoint extends ServiceMap.Key<MediaEndpoint, MediaEndpointApi>() {}

interface MediaEndpointApi {
  // bind a local RTP port on the shared SignalingNetwork (sim or real); raw (non-SIP) mode.
  // One transport per offer; it may carry several per-dialog sessions under forking.
  open(localIp: string, localPort: number): Effect<MediaTransport, BindError, Scope>
}

interface MediaTransport {                              // one per offer = one local port
  readonly localAddr: { ip: string; port: number }
  readonly supportedCodecs: ReadonlyArray<CodecDesc>   // feeds the SDP O/A builder
  session(dialogId: string): Effect<MediaSession>      // per early/confirmed dialog; shares this port
  sources(): Effect<ReadonlyArray<SourceBucket>>       // per-(remoteAddr,SSRC) inbound, recorded
  activePeer(): Effect<MediaSession | null>            // the single committed peer (or none yet)
  stats(): Effect<ReadonlyArray<MediaStreamStats>>     // getStats()-style, per source
}

interface MediaSession {                               // one per dialog (negotiated remote)
  configure(remote: NegotiatedMedia): Effect<void, MediaNegotiationError> // codec, remote addr, direction
  commit(reason: "early-pem" | "confirmed"): Effect<void>  // becomes active peer; abandons siblings
  play(script: PlayScript): Effect<void>               // non-blocking; only sends once committed
  recorded(): Effect<PcmBuffer>                         // inbound PCM attributed to this peer
}

type PlayScript =
  | { kind: "clip"; clip: ClipRef; durationMs: number }
  | { kind: "ringback"; durationMs: number }
  | { kind: "sequence"; parts: PlayScript[] }           // RBT-then-media, one flow, no gap
```

`NegotiatedMedia` is produced by the **Offer/Answer engine** (below) from the SDP each side
actually received (after B2BUA rewriting), never from the raw offer — that's what makes a
misdirected `c=`/`m=` fail loudly.

## Offer/Answer engine (RFC 3264 / 3262) — `src/media/sdp/`

A **per-dialog** state machine — the endpoint's equivalent of WebRTC
`setLocalDescription` / `setRemoteDescription`. Production code in `src/media/` (a real UA needs
it), but **separate from the B2BUA's [SdpUtils.ts](src/sip/SdpUtils.ts)** so it acts as an
*independent conformance witness* of whatever SDP the B2BUA relays or synthesizes.

```ts
interface OfferAnswerEngine {                 // one per dialog, bound to that dialog's MediaSession
  localOffer(): Effect<Sdp, never>            // build offer from the bound session (real addr/port/codecs)
  answerTo(remoteOffer: Sdp): Effect<Sdp, SdpNegotiationError>   // strict; also configures send side
  applyRemote(sdp: Sdp, opts: { reliable: boolean }): Effect<NegotiatedMedia, SdpNegotiationError>
  state(): NegotiationState                   // idle | offer-sent | early(provisional) | committed | held
}
```

**Strict filtering (the bug-catch).** `answerTo` / `applyRemote` refuse — as typed
`SdpNegotiationError`s, each mapped to an RFC 3264 MUST — on: answer codec ∉ offer, empty codec
intersection, m-line count mismatch, `port==0` / `a=inactive` when media is expected,
answer-without-prior-offer, or a second offer while one is outstanding (glare → the dialog
replies 491). A real UA does exactly this; so a B2BUA that mangles the relayed `c=`/`m=`,
intersects codecs wrong in fake-PRACK, or drops the m-line makes the *receiving* engine reject
or mis-point → `hears(...)` fails.

**Reliable vs unreliable provisional.** `applyRemote(sdp, { reliable })`:
- *Unreliable 18x with SDP* → configures the session into an **early/provisional** remote so
  early media (e.g. network ringback) flows, but marks it non-final; a later answer may replace it.
- *Reliable 18x* (`Require:100rel` + `RSeq`, confirmed by PRACK) or *200 OK* → **commits**. A
  different 200 answer **supersedes** the early one and re-points the session.
- The interpreter already knows a provisional's reliability from its headers; it passes that flag
  in. (Early-media scenarios are a follow-up, but the engine models the states now so they slot in.)

**Destination change.** A re-offer in re-INVITE / UPDATE runs back through `answerTo` →
re-points the session's remote addr/port. `a=sendonly` / `a=inactive` / `c=0.0.0.0` stop the send
direction (hold). This is the same path behind `aliceDialog.media.hears(charlie)` after a REFER:
the B2BUA re-INVITEs alice's **a-leg dialog**, the engine re-points media from bob to charlie on
that one session — exercising held-SDP + realign-offer construction end to end.

**How it composes with the rest (data flow for basic-call):**
1. Interpreter binds a `MediaSession` per dialog at interpret-start; each session has a real
   `addr:port` and a real codec list.
2. `alice.invite(ruri, { media })` → body = `aliceDialog` engine `localOffer()`.
3. Bob's INVITE arrives (harness hands bob's engine the *observed* offer, i.e. after B2BUA
   rewrite); `bobDialog` engine `answerTo(offer)` → configures bob's session remote = the addr in
   that offer, and returns the answer SDP.
4. `bobTx.reply(200)` → body = that answer.
5. Alice's 200 arrives (after B2BUA rewrite); `aliceDialog` engine
   `applyRemote(answer, { reliable: true })` → configures alice's session remote = bob's addr.
   If the B2BUA corrupted it, alice points at the wrong place → no audio → `hears` fails.

**Relationship to the existing passive
[offer-answer-tracker.ts](src/test-harness/framework/offer-answer-tracker.ts):** the active
per-dialog engine supersedes the global nonce tracker. The tracker's *RFC-ordering assertions*
fold into the engine's typed errors; the nonce/`port+1` heuristic is deleted (real addresses +
real audio arrival replace it). A thin scenario-level check can still confirm "every offer got an
answer," sourced from engine state rather than body string-matching.

## Forking & early-media: multi-peer demux + active-peer gating (RFC 3261 §13 / RFC 5009)

A single INVITE offer can **fork** to multiple destinations. Each forked branch is a separate
**early dialog** (distinct To-tag) and may send its own answer SDP in a 18x — pointing media at a
*different* remote addr/port. The caller advertised **one** local RTP port in the offer, so that
one port can receive RTP from **several remotes concurrently**. Naively playing/recording the
first stream that arrives is the real-world "early-media clipping / latching" bug. The endpoint
must model this explicitly, and it mirrors the B2BUA's own **active peer** singleton.

**Model.**
- **`MediaTransport`** — one per offer (the local port). Owns the socket, demuxes inbound RTP into
  **per-source buckets** keyed by `(remote transport address, SSRC)`, records each bucket
  separately, and tracks per-source stats.
- **Per-dialog `MediaSession`** — one per early/confirmed dialog, each with its negotiated remote
  from *that dialog's* answer. Multiple sessions can share one `MediaTransport` during forking.
- **Active peer (singleton).** At most one session is the *committed* media peer at any instant —
  the only one the endpoint **sends** to and the one a plain `hears(dialog)` resolves against. The
  transport keeps recording all sources (so "who sent early media" is observable and reportable),
  but outbound and the established-media verdict track the active peer only.

**Commit / "switch on" rules (when an early dialog's media becomes valid):**
- **Early media** is accepted as playable from a branch only when that branch's provisional both
  carries **SDP** and is authorized as early media — i.e. **`P-Early-Media: sendrecv|sendonly`**
  (RFC 5009) on a reliable (or PEM-gated) 18x. A provisional without SDP, or with
  `P-Early-Media: inactive`/absent where the policy requires it, does **not** switch media on —
  it may still be recorded as an unauthorized source for reporting, but is not the active peer.
- **Confirmed media** commits on **200 OK** (or an established-dialog **re-INVITE/UPDATE** answer).
  The confirmed branch becomes the active peer; **all other forked branches are abandoned** — their
  sessions stop, their inbound buckets are sealed, and outbound moves to the confirmed remote.
- **Re-point** (REFER realign, hold/resume) runs through the same active-peer switch on the
  *confirmed* dialog.

This is the gate the user called out: *only switch on media when there's a valid RTP peer — SDP +
PEM for early media, or re-INVITE/200 in an established dialog.*

**What this lets tests assert.**
- `aD.media.hears(bD.media)` — established two-way (active peer = bob).
- `aD.media.hearsEarly(bD.media)` / `aD.media.hearsNoEarlyFrom(cD.media)` — alice gets *authorized*
  early media from bob's branch but **not** from an un-authorized forked branch (no PEM) → proves
  the endpoint doesn't clip in unauthorized early media.
- After fork resolves to a 200 from one branch, alice's active peer is that branch and the others
  are silent → proves abandonment.
- The per-source buckets feed the report: the rollup can show "3 early sources seen, 1 authorized,
  active peer = bob" with counts.

**Scope note.** Full forking/early-media *scenarios* are the deferred follow-up, but the
transport demux + active-peer state machine is built in **Slice 2** (alongside the O/A engine) so
the basic-call/REFER slices already run on the correct model rather than a 1:1 shortcut that would
need rework. The first-cut scenarios simply have a single branch and an immediate commit.

## Verification engine (transport-agnostic, pure TS, test-only)

`src/test-harness/media/audio/` — runs on recorded PCM regardless of endpoint impl:
- `clips.ts` — bundled reference PCM (alice / bob / charlie / ringback) + synth fallback.
- `spectral.ts` — MFCC / log-mel feature + cosine (or DTW) distance.
- `classify.ts` — nearest-reference + margin; silence/energy guard ⇒ `MediaVerdict`;
  supports **segment classification** for "RBT then voice" sequences.

## DSL surface (fleshed out)

Media is opt-in per agent; play is concurrent and non-blocking; assertions take refs.

```ts
const alice = s.agent("alice", { uri: "...", media: { clip: "alice" } })
const bob   = s.agent("bob",   { uri: "...", media: { clip: "bob" } })

// Offer/200-answer bodies come from the per-DIALOG media sessions' REAL addr/port+codecs
// via the O/A engine — no explicit body: arg, no nonce:
const { dialog: aD, transaction: aTx } = alice.invite(ruri)   // body = aD engine.localOffer()
const { dialog: bD, transaction: bTx } = bob.receiveInitialInvite()
bTx.reply(180)
bTx.reply(200)                                                 // body = bD engine.answerTo(observed offer)
aD.ack(); bD.expect("ACK")

// Media hangs off the DIALOG. Both start immediately and CONCURRENTLY — neither blocks:
aD.media.plays({ clip: "alice", durationMs: 2000 })
bD.media.plays({ clip: "bob",   durationMs: 2000 })
s.pause(2000)                                                  // media flows during this virtual window

// Deferred verdicts, evaluated at final sweep against continuously-recorded inbound PCM.
// The argument is the SOURCE DIALOG's media, not a string:
aD.media.hears(bD.media)      // alice's recorded audio ≈ bob's clip (proves O/A + relay correct)
bD.media.hears(aD.media)

// RBT-then-media on one uninterrupted flow (e.g. early-media style):
bD.media.plays({ sequence: [{ ringback: 1500 }, { clip: "bob", durationMs: 2000 }] })
aD.media.hears([RBT, bD.media])   // sequence assertion: first ringback, then bob's voice

// After a REFER transfer to Charlie, the B2BUA re-INVITEs alice's a-leg; the O/A engine
// re-points media on that SAME dialog → alice must now hear Charlie, not Bob:
aD.media.hears(cD.media)      // exercises held-SDP + realign-offer construction
```

**Concurrency & answer-generation interaction.** Media sessions bind per dialog at
interpret-start so each dialog's real `addr:port` is known before the first INVITE; the O/A engine
reads from the bound session (real port + real codec list) instead of random values — this is why
the correlation nonce is no longer needed. `plays(...)` records a non-blocking step that forks a
sender fiber bounded by `durationMs`; the fiber paces on the shared `Clock`, so under fake clock
the bytes flow exactly during the following `s.pause(...)`. `hears(ref)` records a **deferred
assertion** resolved at the existing final-sweep stage, comparing the receiver dialog's
continuously recorded PCM against the referenced source dialog's clip.

Recorded as new step types in [recorder.ts](src/test-harness/framework/recorder.ts) /
[types.ts](src/test-harness/framework/types.ts) (`media-play`, `media-expect`); executed in
[interpreter.ts](src/test-harness/framework/interpreter.ts); verdicts surfaced in the final
sweep alongside the RFC ledger.

## Reference audio samples (Slice 0)

Small **public-domain / CC0** PCM samples, one each for alice / bob / charlie, plus a synthesized
ringback. Distinct enough to classify reliably after G.711 transcoding (different voices /
spectral signatures). Sourced from a CC0 corpus (e.g. a short clip per speaker from a
public-domain speech set), trimmed to ≤2 s, downsampled to 8 kHz mono 16-bit PCM, committed as
small `.wav` (or raw PCM) assets under `src/test-harness/media/audio/clips/` with a `SOURCES.md`
recording provenance + license. Ringback is generated, not downloaded. A retrieval+prep script
(`scripts/fetch-media-clips.ts`) documents exactly where each came from and how it was trimmed, so
the assets are reproducible.

## Implementation slices (each independently testable; ship in order)

**Slice 0 — Reference clips + audio comparator (pure, no network).**
Retrieve/prepare the alice/bob/charlie samples + synth ringback (above). Build
`src/test-harness/media/audio/{clips,spectral,classify}.ts` and a `.wav` reader/writer.
*Tests:* comparator classifies each clip as itself; cross-clip distance exceeds the margin;
ringback ≠ any voice; silence guard fires on empty/near-empty PCM; classification still correct
after a round-trip through G.711 encode/decode (proves transcoding robustness). No SIP, no Effect.

**Slice 1 — RTP/codec layer + two impls + real-net/real-clock cross-check.**
`src/media/{codec/g711,rtp/packet,rtp/session,rtp/rtcp}.ts`, the `MediaEndpoint` Tag/Layer, the
TS impl (`ts/`), and the rtp.js impl (`native/`). Both ride `SignalingNetwork` + `Clock`.
*Tests:* G.711 encode/decode round-trip within tolerance; RTP header field round-trip; **TS-send
↔ rtp.js-parse and rtp.js-send ↔ TS-parse** agree on the wire (independent witness); a full
play→record loop over the **simulated** fabric under TestClock yields the played clip back; the
**same loop over real UDP + real wall-clock** (`it.live`) yields it back too (this is the
"cross-check with real network real clock"); `getStats()` packet/byte/RTCP counts match what was
sent. No B2BUA yet — endpoints talk directly to each other.

**Slice 2 — Offer/Answer engine + transport demux / active-peer state machine + exhaustive RFC
tests.** `src/media/sdp/{parse,negotiator,types}.ts` (per-dialog O/A) plus `src/media/transport.ts`
(per-`(addr,SSRC)` demux, per-source recording, active-peer singleton + commit/abandon).
*Tests (positive + negative, one per RFC clause):* offer→answer codec intersection picks a common
codec; answer applied → session remote = offered addr/port; **negative:** codec∉offer rejected,
empty intersection rejected, m-line count mismatch rejected, `port==0`/`a=inactive` → direction
stopped, answer-without-offer rejected, second-offer-while-pending → glare/491; reliable vs
unreliable provisional transitions (early→committed, supersede, re-point on re-offer / hold /
resume). **Forking/active-peer:** two answers on one transport → two source buckets both recorded;
no send + no established verdict until commit; early media switches on only with SDP + authorizing
`P-Early-Media` (RFC 5009); 200 OK commits one branch and abandons the rest; re-offer re-points
the active peer. Each negative maps to a named RFC 3264/3262/5009 MUST. Drives `NegotiatedMedia`
+ demux over Slice 1's transport — no B2BUA yet.

**Slice 3 — DSL + interpreter wiring + report, on `basic-call` (fake + live).**
Add `media` agent config, per-dialog `media.plays/hears`, new step types
([recorder.ts](src/test-harness/framework/recorder.ts), [types.ts](src/test-harness/framework/types.ts),
[interpreter.ts](src/test-harness/framework/interpreter.ts)), provide `MediaEndpoint` in
[stackLayer.ts](tests/support/stackLayer.ts), and the HTML report rollup + diagram arrows
([html-report.ts](src/test-harness/framework/html-report.ts)). Wire `basic-call` to play 2 s each
way and assert `aD.media.hears(bD.media)` + reverse.
*Tests:* basic-call media passes under **fake clock** and (`it.live`) **real clock**; a deliberate
B2BUA SDP-rewrite corruption makes `hears` fail (proves bug-catch); **HTML report contains** the
per-stream RTP/RTCP rollup + verdict (assert on generated HTML); one cross-check run uses the
rtp.js impl on one side. **Optional `.wav` dump** flag verified to emit playable files linked from
the report.

**Slice 4 — Alice→Bob→Charlie (REFER realign) media re-point.**
Wire `refer-c-realign` so after the transfer the O/A engine re-points alice's a-leg session; add
the ringback-then-media sequence capability + sequence assertion.
*Tests:* `aD.media.hears(cD.media)` (not bob) after realign, fake + live; `aD.media.hears([RBT,
bD.media])` sequence; a broken realign-offer (wrong codec/port) makes the re-point fail.

## First-cut scope (decided)

- **RTCP:** counts only — generate SR/RR on the standard interval, report aggregated
  packet/octet counts via `getStats()`; do **not** assert SR field contents yet.
- Early-media trio + hold/resume deferred to a follow-up (the O/A engine already models the states).

## Files

- **New (production):** `src/media/**` (layout above, incl. `sdp/` O/A engine); add `./media` to
  package.json `exports`; add `rtp.js` dependency.
- **New (test-only):** `src/test-harness/media/audio/**` (comparator, `.wav` read/write) +
  reference clip assets under `audio/clips/` (+ `SOURCES.md`) + `scripts/fetch-media-clips.ts`.
- **Extend:** [helpers/sdp.ts](src/test-harness/framework/helpers/sdp.ts) (real addr/port/codec
  O/A builders driven by the bound session; **remove** the `x-offer-id` nonce + `port==offer+1`
  path), [offer-answer-tracker.ts](src/test-harness/framework/offer-answer-tracker.ts) (rebuild
  on real-address correlation + strict refusal rules), [dsl.ts](src/test-harness/framework/dsl.ts)
  + [recorder.ts](src/test-harness/framework/recorder.ts) + [types.ts](src/test-harness/framework/types.ts)
  + [interpreter.ts](src/test-harness/framework/interpreter.ts) (media steps + agent `media` config),
  [stackLayer.ts](tests/support/stackLayer.ts) + [testLayers.ts](tests/support/testLayers.ts)
  (provide `MediaEndpoint`), [html-report.ts](src/test-harness/framework/html-report.ts) +
  `report-recorder` types (media rollup + diagram arrows).
- **Migration note:** scenarios using the old string `sdpOffer/sdpAnswer` keep working (the
  builders still emit valid SDP); only the nonce-correlation in the tracker is removed, replaced
  by structural + (for media agents) real-address checks.
- **Docs:** new `docs/media-testing.md` (test/operator vocabulary — kept **out of** CONTEXT.md
  per the glossary-only scope rule); new **ADR-0016** capturing the PCM-frontier + dedicated
  `src/media` package + per-dialog O/A engine as independent conformance witness +
  reuse-`SignalingNetwork` + independent-rtp.js-witness decisions (hard to reverse, surprising,
  real trade-off).

## Verification

Each slice carries its own tests (above). End-to-end gates:

- `npm run typecheck` clean (tsc + Effect plugin) after every slice.
- `npm run test:fake` — Slice 0–4 fake-clock tests green; the deliberate B2BUA SDP-rewrite
  corruption makes `hears(...)` fail → proves bug-catch.
- TS ↔ rtp.js cross-check (Slice 1) green → wire interop / framing correctness.
- `it.live` — play→record over real UDP+clock (Slice 1) and basic-call / refer media (Slice 3–4)
  against the in-process B2BUA.
- HTML report asserted to contain the aggregated RTP/RTCP rollup + verdict (Slice 3); optional
  `.wav` artifacts emitted and linked.
- SBC mode (manual / opt-in) — point endpoints at a real SBC; confirm spectral classification
  survives its transcoding DSP.
