/**
 * Service-ext round-trip contract (ADR-0016).
 *
 * Locks the load-bearing invariant: `Call.ext[id]` / `Leg.ext[id]` carry the
 * **Encoded** (JSON-safe) form of a service slice, never a decoded value. A
 * `promotedSdp: Uint8Array` rides as its base64 string; the protobuf codec
 * `JSON.stringify`s opaque ext, which would corrupt a raw `Uint8Array` into a
 * numeric-keyed object. This test proves the base64 string survives encode →
 * decode across all three codecs AND re-decodes to the original bytes.
 *
 * It also exercises the leg-ext path with a typed `Leg.ext` entry even though
 * PEM itself uses call-ext only.
 */

import { describe, it, expect } from "vitest"
import { Schema } from "effect"
import { makeMsgpackUnsafe, makeProtobufUnsafe } from "../../src/call/codec/index.js"
import type { CallBodyCodecApi } from "../../src/call/codec/CallBodyCodec.js"
import { representativeCall } from "../bench/call-codec/fixture.js"
import type { Call } from "../../src/call/CallModel.js"

// The promote-pem call-ext shape (mirrors the service's PemCallExt).
const PemCallExt = Schema.Struct({
  promoted: Schema.Boolean,
  promotedSdp: Schema.optional(Schema.Uint8ArrayFromBase64),
  windowOpen: Schema.Boolean,
  resyncReinviteCSeq: Schema.optional(Schema.Int),
})

const CODECS: ReadonlyArray<{ name: string; codec: CallBodyCodecApi }> = [
  { name: "Msgpack", codec: makeMsgpackUnsafe(false) },
  { name: "MsgpackRecords", codec: makeMsgpackUnsafe(true) },
  { name: "Protobuf", codec: makeProtobufUnsafe() },
]

const sdpBytes = new TextEncoder().encode(
  "v=0\r\no=- 200 1 IN IP4 10.20.0.1\r\ns=-\r\nc=IN IP4 10.20.0.1\r\nt=0 0\r\nm=audio 40000 RTP/AVP 0\r\n",
)

// Encoded slice: promotedSdp is now a base64 *string* (the at-rest form).
const encodedSlice = Schema.encodeSync(PemCallExt)({
  promoted: true,
  promotedSdp: sdpBytes,
  windowOpen: true,
  resyncReinviteCSeq: 42,
})

const callWithExt: Call = {
  ...representativeCall,
  ext: { "promote-pem": encodedSlice },
  aLeg: { ...representativeCall.aLeg, ext: { "demo-leg-service": { role: "media" } } },
}

describe("service-ext round-trip across codecs (ADR-0016)", () => {
  for (const { name, codec } of CODECS) {
    describe(name, () => {
      it("call-ext promotedSdp base64 survives encode→decode and re-decodes to the original bytes", () => {
        const decoded = codec.decode(codec.encode(callWithExt))
        const slice = decoded.ext?.["promote-pem"]
        expect(slice).toEqual(encodedSlice)
        // The protobuf JSON path only ever sees the base64 string, never a Uint8Array.
        expect(typeof (slice as { promotedSdp: unknown }).promotedSdp).toBe("string")
        // Re-decoding the slice yields the original bytes.
        const reDecoded = Schema.decodeUnknownSync(PemCallExt)(slice)
        expect(reDecoded.promotedSdp).toEqual(sdpBytes)
        expect(reDecoded.resyncReinviteCSeq).toBe(42)
      })

      it("leg-ext entry survives encode→decode", () => {
        const decoded = codec.decode(codec.encode(callWithExt))
        expect(decoded.aLeg.ext?.["demo-leg-service"]).toEqual({ role: "media" })
      })
    })
  }
})
