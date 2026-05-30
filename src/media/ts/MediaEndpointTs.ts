/**
 * TS MediaEndpoint — the implementation under test. Hand-rolled RFC 3550 RTP
 * (see `../rtp/packet.ts`) over the shared SignalingNetwork + Clock.
 */

import type { Layer } from "effect"
import type { SignalingNetwork } from "../../sip/SignalingNetwork.js"
import type { MediaEndpoint } from "../MediaEndpoint.js"
import { tsFraming } from "../rtp/packet.js"
import { mediaEndpointLayer } from "../transport.js"

export { tsFraming }

export const MediaEndpointTs: Layer.Layer<MediaEndpoint, never, SignalingNetwork> =
  mediaEndpointLayer(tsFraming)
