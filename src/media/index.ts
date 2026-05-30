/**
 * `@vcharbon/sipjs/media` — production media (RTP) subsystem.
 *
 * Endpoint archetype: owns codec / RTP framing / SSRC-seq-timestamp / RTCP /
 * pacing, rides the shared SignalingNetwork + Clock, exposes a PCM frontier.
 */

export * from "./MediaEndpoint.js"
export type { G711Codec } from "./codec/g711.js"
export {
  alawDecode,
  alawEncode,
  g711RoundTrip,
  mulawDecode,
  mulawEncode,
} from "./codec/g711.js"
export type { RtpFramed, RtpFraming, RtpHeader } from "./rtp/packet.js"
export { encodeRtp, parseRtp, tsFraming } from "./rtp/packet.js"
export { mediaEndpointLayer } from "./transport.js"
export { MediaEndpointTs } from "./ts/MediaEndpointTs.js"
export { MediaEndpointRtpJs, rtpJsFraming } from "./native/MediaEndpointRtpJs.js"

// SDP / offer-answer engine
export * from "./sdp/types.js"
export { buildSdp, encodeSdp, mediaConnectionAddr, parseSdp } from "./sdp/parse.js"
export {
  createOfferAnswerEngine,
  type EngineConfig,
  isEarlyMediaAuthorized,
  type OfferAnswerEngine,
  type ProvisionalSignals,
} from "./sdp/negotiator.js"
