/**
 * Per-dialog RFC 3264 / 3262 offer-answer engine — the endpoint's equivalent
 * of WebRTC setLocalDescription / setRemoteDescription, and an *independent*
 * conformance witness of whatever SDP the B2BUA relays or synthesizes.
 *
 * Strict refusals (typed `SdpNegotiationError`, each a named RFC MUST) catch a
 * B2BUA that mangles the relayed c=/m=, intersects codecs wrong, or drops an
 * m-line: the receiving engine rejects or mis-points, so a media `hears(...)`
 * assertion fails loudly.
 */

import { Effect } from "effect"
import type { CodecDesc, NetAddr } from "../MediaEndpoint.js"
import { PCMA, PCMU } from "../MediaEndpoint.js"
import { mediaConnectionAddr } from "./parse.js"
import {
  type MediaDirection,
  type NegotiatedMedia,
  type NegotiationState,
  type Sdp,
  type SdpMedia,
  SdpNegotiationError,
} from "./types.js"

export interface EngineConfig {
  /** Our local RTP transport address advertised in offers/answers. */
  readonly localAddr: NetAddr
  /** Our supported codecs, in preference order. */
  readonly codecs: ReadonlyArray<CodecDesc>
  /** o= username; defaults to "media". */
  readonly username?: string
}

export interface OfferAnswerEngine {
  /** Build an offer from the bound session (real addr/port + our codec list). */
  localOffer: () => Sdp
  /** UAS: build a strict final answer to a received offer; configures our send side. */
  answerTo: (remoteOffer: Sdp) => Effect.Effect<Sdp, SdpNegotiationError>
  /** UAC: apply a received answer (provisional or final); re-points the session. */
  applyRemote: (sdp: Sdp, opts: { reliable: boolean }) => Effect.Effect<NegotiatedMedia, SdpNegotiationError>
  negotiated: () => NegotiatedMedia | null
  state: () => NegotiationState
}

const STATIC_PT: Record<number, string> = { 0: "PCMU", 8: "PCMA" }

function resolveCodecName(media: SdpMedia, pt: number): string | undefined {
  const mapped = media.rtpmap.find((r) => r.payloadType === pt)
  return mapped?.encodingName ?? STATIC_PT[pt]
}

function audioMedia(sdp: Sdp): SdpMedia | undefined {
  return sdp.media.find((m) => m.type === "audio")
}

/** Reverse a direction for the answering side (RFC 3264 §6.1). */
function reverseDirection(d: MediaDirection): MediaDirection {
  switch (d) {
    case "sendonly":
      return "recvonly"
    case "recvonly":
      return "sendonly"
    default:
      return d // sendrecv / inactive are self-reverse
  }
}

function isReachable(addr: string, port: number): boolean {
  return port !== 0 && addr !== "0.0.0.0" && addr !== "::"
}

function err(rule: SdpNegotiationError["rule"], rfc: string, message: string) {
  return new SdpNegotiationError({ rule, rfc, message })
}

export function createOfferAnswerEngine(config: EngineConfig): OfferAnswerEngine {
  const username = config.username ?? "media"
  let state: NegotiationState = "idle"
  let pendingOffer: Sdp | null = null
  let negotiated: NegotiatedMedia | null = null
  let sessionVersion = 1

  const codecByName = (name: string): CodecDesc | undefined =>
    config.codecs.find((c) => c.name === name)

  const buildLocalSdp = (codecs: ReadonlyArray<CodecDesc>, direction: MediaDirection): Sdp => ({
    origin: {
      username,
      sessionId: String(deriveSessionId(config.localAddr)),
      version: String(sessionVersion),
      address: config.localAddr.ip,
    },
    connectionAddr: config.localAddr.ip,
    media: [
      {
        type: "audio",
        port: config.localAddr.port,
        protocol: "RTP/AVP",
        formats: codecs.map((c) => c.payloadType),
        rtpmap: codecs.map((c) => ({ payloadType: c.payloadType, encodingName: c.name, clockRate: c.clockRate })),
        direction,
      },
    ],
  })

  const localOffer = (): Sdp => {
    sessionVersion++
    pendingOffer = buildLocalSdp(config.codecs, "sendrecv")
    state = "offer-sent"
    return pendingOffer
  }

  const answerTo = (remoteOffer: Sdp): Effect.Effect<Sdp, SdpNegotiationError> =>
    Effect.gen(function* () {
      if (state === "offer-sent") {
        return yield* err(
          "glare-second-offer",
          "RFC 3264 §4 / RFC 3261 §14.2",
          "received an offer while our own offer is outstanding (glare → 491)",
        )
      }
      const m = audioMedia(remoteOffer)
      if (!m) {
        return yield* err("no-media", "RFC 3264 §5.1", "offer has no audio media description")
      }
      // Pick the first offered codec we support (honours offerer preference).
      let chosen: CodecDesc | undefined
      for (const pt of m.formats) {
        const name = resolveCodecName(m, pt)
        if (name) {
          const c = codecByName(name)
          if (c) {
            chosen = c
            break
          }
        }
      }
      if (!chosen) {
        return yield* err(
          "empty-codec-intersection",
          "RFC 3264 §6",
          "no codec in common between offer and our supported set",
        )
      }

      const remoteAddr = mediaConnectionAddr(remoteOffer, m)
      const answerDir = reverseDirection(m.direction)
      const reachable = isReachable(remoteAddr, m.port)
      const send = (answerDir === "sendrecv" || answerDir === "sendonly") && reachable
      const receive = answerDir === "sendrecv" || answerDir === "recvonly"

      negotiated = { remote: { ip: remoteAddr, port: m.port }, codec: chosen, direction: answerDir, send, receive }
      state = send ? "committed" : "held"

      sessionVersion++
      return buildLocalSdp([chosen], answerDir)
    })

  const applyRemote = (
    sdp: Sdp,
    opts: { reliable: boolean },
  ): Effect.Effect<NegotiatedMedia, SdpNegotiationError> =>
    Effect.gen(function* () {
      if (state === "idle" || pendingOffer === null) {
        return yield* err("answer-without-offer", "RFC 3264 §5", "answer received with no outstanding offer")
      }
      if (sdp.media.length !== pendingOffer.media.length) {
        return yield* err(
          "m-line-count-mismatch",
          "RFC 3264 §6",
          `answer has ${sdp.media.length} m-lines, offer had ${pendingOffer.media.length}`,
        )
      }
      const m = audioMedia(sdp)
      if (!m) {
        return yield* err("no-media", "RFC 3264 §5.1", "answer has no audio media description")
      }

      // The answer must select exactly from the codecs we offered.
      const offerNames = new Set(pendingOffer.media[0]!.rtpmap.map((r) => r.encodingName))
      const answerPt = m.formats[0]
      const answerName = answerPt !== undefined ? resolveCodecName(m, answerPt) : undefined
      if (!answerName || !offerNames.has(answerName)) {
        return yield* err(
          "answer-codec-not-in-offer",
          "RFC 3264 §6",
          `answer codec ${answerName ?? "(none)"} was not in the offer`,
        )
      }
      const chosen = codecByName(answerName)
      if (!chosen) {
        return yield* err("empty-codec-intersection", "RFC 3264 §6", `answer codec ${answerName} unsupported`)
      }

      const remoteAddr = mediaConnectionAddr(sdp, m)
      const reachable = isReachable(remoteAddr, m.port)
      // Map the answerer's direction to ours (mirror).
      const ourDir = reverseDirection(m.direction)
      const send = (ourDir === "sendrecv" || ourDir === "sendonly") && reachable
      const receive = ourDir === "sendrecv" || ourDir === "recvonly"

      negotiated = { remote: { ip: remoteAddr, port: m.port }, codec: chosen, direction: ourDir, send, receive }

      if (opts.reliable) {
        pendingOffer = null
        state = send ? "committed" : "held"
      } else {
        state = "early" // provisional; a later final answer may supersede
      }
      return negotiated
    })

  return {
    localOffer,
    answerTo,
    applyRemote,
    negotiated: () => negotiated,
    state: () => state,
  }
}

function deriveSessionId(addr: NetAddr): number {
  let h = 0x811c9dc5
  const s = `${addr.ip}:${addr.port}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export interface ProvisionalSignals {
  readonly hasSdp: boolean
  /** Value of the P-Early-Media header on the provisional, if present. */
  readonly pEarlyMedia?: MediaDirection
  readonly reliable: boolean
}

/**
 * RFC 5009 early-media gate: a forked branch's provisional may switch media on
 * only when it carries SDP and is authorized to send early media
 * (`P-Early-Media: sendrecv|sendonly`). Absent/`inactive`/`recvonly` → not
 * authorized; the source may still be recorded for reporting but is not the
 * active peer.
 */
export function isEarlyMediaAuthorized(signals: ProvisionalSignals): boolean {
  if (!signals.hasSdp) return false
  return signals.pEarlyMedia === "sendrecv" || signals.pEarlyMedia === "sendonly"
}

export { PCMA, PCMU }
