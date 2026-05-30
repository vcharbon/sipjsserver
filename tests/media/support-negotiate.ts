/**
 * Test helper: run a full SDP offer/answer exchange across two media
 * transports using the production O/A engine, with a pluggable "B2BUA rewrite"
 * applied to the offer and answer as they cross the middle. The identity
 * rewrite models a transparent (signaling-only) B2BUA; a corrupting rewrite
 * models an SDP-rewrite bug that misdirects media — which a `hears(...)`
 * assertion must then catch.
 *
 * Mirrors the data flow the interpreter will drive in the declarative
 * follow-up: alice offers from her bound transport, bob answers the *observed*
 * (rewritten) offer, alice applies the *observed* (rewritten) answer.
 */

import { Effect } from "effect"
import type { MediaSession, MediaTransport } from "../../src/media/MediaEndpoint.js"
import { createOfferAnswerEngine } from "../../src/media/sdp/negotiator.js"
import type { NegotiatedMedia, Sdp } from "../../src/media/sdp/types.js"

export type SdpRewrite = (sdp: Sdp) => Sdp

export const identityRewrite: SdpRewrite = (sdp) => sdp

/** Corrupt the connection address — models a B2BUA that misdirects media. */
export const corruptConnectionAddr =
  (bogusIp = "10.99.99.99"): SdpRewrite =>
  (sdp) => ({
    ...sdp,
    ...(sdp.connectionAddr !== undefined ? { connectionAddr: bogusIp } : {}),
    media: sdp.media.map((m) => ({
      ...m,
      ...(m.connectionAddr !== undefined ? { connectionAddr: bogusIp } : {}),
    })),
  })

export interface NegotiatedCall {
  readonly aliceSession: MediaSession
  readonly bobSession: MediaSession
  readonly aliceNegotiated: NegotiatedMedia
  readonly bobNegotiated: NegotiatedMedia
}

/**
 * Negotiate a confirmed call between two transports. `rewriteOffer` is applied
 * to the offer alice sends before bob sees it; `rewriteAnswer` likewise to
 * bob's answer before alice sees it (both default to identity).
 */
export function negotiateCall(
  alice: MediaTransport,
  bob: MediaTransport,
  opts: { rewriteOffer?: SdpRewrite; rewriteAnswer?: SdpRewrite; dialogId?: string } = {},
): Effect.Effect<NegotiatedCall, import("../../src/media/sdp/types.js").SdpNegotiationError> {
  const rewriteOffer = opts.rewriteOffer ?? identityRewrite
  const rewriteAnswer = opts.rewriteAnswer ?? identityRewrite
  const dialogId = opts.dialogId ?? "d"

  return Effect.gen(function* () {
    const aliceEng = createOfferAnswerEngine({ localAddr: alice.localAddr, codecs: alice.supportedCodecs })
    const bobEng = createOfferAnswerEngine({ localAddr: bob.localAddr, codecs: bob.supportedCodecs })

    // alice → INVITE (offer); bob answers the observed (rewritten) offer.
    // answerTo returns bob's answer SDP (bob's own addr/port/codec).
    const offer = aliceEng.localOffer()
    const answerSdp = yield* bobEng.answerTo(rewriteOffer(offer))
    const bobNegotiated = bobEng.negotiated()!
    const bobSession = yield* bob.session(dialogId)
    yield* bobSession.configure(bobNegotiated)

    // alice applies the observed (rewritten) answer → points her at bob.
    const aliceNegotiated = yield* aliceEng.applyRemote(rewriteAnswer(answerSdp), { reliable: true })
    const aliceSession = yield* alice.session(dialogId)
    yield* aliceSession.configure(aliceNegotiated)

    // 200 OK both ways → both sessions commit (become active peers).
    yield* aliceSession.commit("confirmed")
    yield* bobSession.commit("confirmed")

    return { aliceSession, bobSession, aliceNegotiated, bobNegotiated }
  })
}
