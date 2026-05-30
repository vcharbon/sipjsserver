/**
 * Leg-kind / adopted round-trip contract (ADR-0014).
 *
 * `Leg.kind` and `Leg.adopted` ride in the replicated call body and must
 * survive encode → decode across all three codecs — protobuf (optional proto
 * fields 15/16), msgpack, and msgpack-records (positional). A media leg's
 * `kind: "media"` / `adopted: false` is what the unadopted-leg gate keys on
 * after a worker takeover; losing it across replication would mis-route the
 * parked MRF leg on the backup.
 */

import { describe, it, expect } from "vitest"
import { makeMsgpackUnsafe, makeProtobufUnsafe } from "../../src/call/codec/index.js"
import type { CallBodyCodecApi } from "../../src/call/codec/CallBodyCodec.js"
import { representativeCall } from "../bench/call-codec/fixture.js"
import type { Call, Leg } from "../../src/call/CallModel.js"

const CODECS: ReadonlyArray<{ name: string; codec: CallBodyCodecApi }> = [
  { name: "Msgpack", codec: makeMsgpackUnsafe(false) },
  { name: "MsgpackRecords", codec: makeMsgpackUnsafe(true) },
  { name: "Protobuf", codec: makeProtobufUnsafe() },
]

const mediaLeg: Leg = {
  ...representativeCall.aLeg,
  legId: "media-1",
  kind: "media",
  adopted: false,
}

const callWithMediaLeg: Call = {
  ...representativeCall,
  // A-leg gets explicit kind/adopted; an unadopted media leg rides in bLegs.
  aLeg: { ...representativeCall.aLeg, kind: "a", adopted: true },
  bLegs: [...representativeCall.bLegs, mediaLeg],
}

describe("leg-kind round-trip across codecs (ADR-0014)", () => {
  for (const { name, codec } of CODECS) {
    describe(name, () => {
      it("a-leg kind/adopted survive encode→decode", () => {
        const decoded = codec.decode(codec.encode(callWithMediaLeg))
        expect(decoded.aLeg.kind).toBe("a")
        expect(decoded.aLeg.adopted).toBe(true)
      })

      it("media leg kind=media / adopted=false survive", () => {
        const decoded = codec.decode(codec.encode(callWithMediaLeg))
        const media = decoded.bLegs.find((l) => l.legId === "media-1")
        expect(media?.kind).toBe("media")
        expect(media?.adopted).toBe(false)
      })

      it("a leg without kind/adopted decodes with both absent (legacy bodies)", () => {
        const legacy: Call = {
          ...representativeCall,
          aLeg: { ...representativeCall.aLeg, kind: undefined, adopted: undefined },
        }
        const decoded = codec.decode(codec.encode(legacy))
        expect(decoded.aLeg.kind).toBeUndefined()
        expect(decoded.aLeg.adopted).toBeUndefined()
      })
    })
  }
})
