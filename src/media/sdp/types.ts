/**
 * SDP / offer-answer types for the media subsystem's per-dialog negotiation
 * engine. Deliberately independent of the B2BUA's `src/sip/SdpUtils.ts` so the
 * engine is a separate conformance witness of whatever SDP the B2BUA relays.
 */

import { Schema } from "effect"
import type { CodecDesc, NetAddr } from "../MediaEndpoint.js"

export type MediaDirection = "sendrecv" | "sendonly" | "recvonly" | "inactive"

export interface SdpRtpMap {
  readonly payloadType: number
  readonly encodingName: string
  readonly clockRate: number
}

export interface SdpMedia {
  readonly type: string // "audio", "video", ...
  readonly port: number
  readonly protocol: string // "RTP/AVP"
  readonly formats: ReadonlyArray<number> // payload types in m= order
  readonly rtpmap: ReadonlyArray<SdpRtpMap>
  readonly direction: MediaDirection
  /** Media-level c= address; falls back to session-level when absent. */
  readonly connectionAddr?: string
}

export interface Sdp {
  readonly origin: { readonly username: string; readonly sessionId: string; readonly version: string; readonly address: string }
  readonly connectionAddr?: string
  readonly media: ReadonlyArray<SdpMedia>
}

/** The media the engine actually negotiated for a dialog (post-rewrite). */
export interface NegotiatedMedia {
  readonly remote: NetAddr
  readonly codec: CodecDesc
  readonly direction: MediaDirection
  /** direction includes send AND a real remote (port != 0, addr != 0.0.0.0). */
  readonly send: boolean
  readonly receive: boolean
}

export type NegotiationState = "idle" | "offer-sent" | "early" | "committed" | "held"

/**
 * Strict O/A refusals, each mapped to a named RFC MUST. The interpreter maps
 * `glare-second-offer` to a 491; the rest are local rejections that a UA must
 * not paper over.
 */
export const SdpRule = Schema.Literals([
  "answer-codec-not-in-offer", // RFC 3264 §6: answer PT MUST be from the offer
  "empty-codec-intersection", // RFC 3264 §6: no common codec
  "m-line-count-mismatch", // RFC 3264 §6: answer MUST have == m-lines as offer
  "answer-without-offer", // RFC 3264 §5: no offer outstanding
  "glare-second-offer", // RFC 3264 §4 / RFC 3261 §14.2: outstanding offer → 491
  "no-media", // RFC 3264 §5.1: no usable media description
])
export type SdpRule = typeof SdpRule.Type

export class SdpNegotiationError extends Schema.TaggedErrorClass<SdpNegotiationError>()(
  "SdpNegotiationError",
  {
    rule: SdpRule,
    rfc: Schema.String,
    message: Schema.String,
  },
) {}

export class MediaNegotiationError extends Schema.TaggedErrorClass<MediaNegotiationError>()(
  "MediaNegotiationError",
  {
    reason: Schema.String,
  },
) {}
