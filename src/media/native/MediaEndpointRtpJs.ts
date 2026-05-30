/**
 * Native cross-check MediaEndpoint — RTP packets serialized/parsed by rtp.js
 * (versatica) instead of the hand-rolled TS codec. It rides the *same*
 * transport engine, SignalingNetwork, and Clock, so it works in fake mode too.
 *
 * Pairing TS-send ↔ rtp.js-parse (and vice-versa) makes each an independent
 * witness of the other's wire format — catching a framing bug a single
 * self-consistent impl would miss. A future browser/rvoip impl drops in behind
 * the same Tag the same way.
 */

import type { Layer } from "effect"
import { packets } from "rtp.js"
import type { SignalingNetwork } from "../../sip/SignalingNetwork.js"
import type { MediaEndpoint } from "../MediaEndpoint.js"
import type { RtpFramed, RtpFraming, RtpHeader } from "../rtp/packet.js"
import { mediaEndpointLayer } from "../transport.js"

const { RtpPacket, isRtp } = packets

function toDataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function viewToBytes(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
}

export const rtpJsFraming: RtpFraming = {
  name: "rtp.js",
  encodeRtp(header: RtpHeader, payload: Uint8Array): Uint8Array {
    const p = new RtpPacket()
    p.setPayloadType(header.payloadType)
    p.setSequenceNumber(header.sequenceNumber & 0xffff)
    p.setTimestamp(header.timestamp >>> 0)
    p.setSsrc(header.ssrc >>> 0)
    p.setMarker(header.marker)
    p.setPayload(toDataView(payload))
    return viewToBytes(p.getView())
  },
  parseRtp(bytes: Uint8Array): RtpFramed | null {
    const view = toDataView(bytes)
    if (!isRtp(view)) return null
    const p = new RtpPacket(view)
    return {
      header: {
        version: 2,
        padding: false,
        extension: false,
        marker: p.getMarker(),
        payloadType: p.getPayloadType(),
        sequenceNumber: p.getSequenceNumber(),
        timestamp: p.getTimestamp(),
        ssrc: p.getSsrc(),
      },
      payload: viewToBytes(p.getPayload()),
    }
  },
}

export const MediaEndpointRtpJs: Layer.Layer<MediaEndpoint, never, SignalingNetwork> =
  mediaEndpointLayer(rtpJsFraming)
