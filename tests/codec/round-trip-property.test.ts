/**
 * Property-based contract tests for `CallBodyCodec`. Exercises P1–P14
 * from the codec contract against every registered codec Layer. Uses
 * the deterministic fixture mixer from `tests/bench/call-codec/` for
 * representative coverage; the `propertyTest` wrapper enforces the
 * properties on every encode/decode call.
 */

import { describe, it, expect } from "@effect/vitest"
import { Effect } from "effect"
import {
  CallBodyCodec,
} from "../../src/call/codec/CallBodyCodec.js"
import {
  MsgpackLayer,
  MsgpackRecordsLayer,
} from "../../src/call/codec/msgpack.js"
import {
  CallBodyCodecContracts,
  PropertyViolation,
  ParanoidInputViolation,
} from "../../src/call/codec/contracts.js"
import { representativeCall } from "../bench/call-codec/fixture.js"
import { buildFixturePool, DEFAULT_MIX } from "../bench/call-codec/fixtureMix.js"
import type { Call } from "../../src/call/CallModel.js"

const CODEC_LAYERS = [
  { name: "MsgpackLayer", layer: MsgpackLayer },
  { name: "MsgpackRecordsLayer", layer: MsgpackRecordsLayer },
] as const

const SAMPLE_POOL: ReadonlyArray<Call> = buildFixturePool(DEFAULT_MIX, 200)

describe("CallBodyCodec contracts — property-based", () => {
  for (const { name, layer } of CODEC_LAYERS) {
    describe(name, () => {
      it.effect("P1 round-trip preserves the representative fixture", () =>
        Effect.gen(function* () {
          const codec = yield* CallBodyCodec
          const encoded = codec.encode(representativeCall)
          const decoded = codec.decode(encoded)
          expect(decoded.callRef).toBe(representativeCall.callRef)
          expect(decoded.aLeg.callId).toBe(representativeCall.aLeg.callId)
          expect(decoded.bLegs.length).toBe(representativeCall.bLegs.length)
        }).pipe(Effect.provide(CallBodyCodecContracts.propertyTest(layer))),
      )

      it.effect("P1-P14 over a 200-sample fixture pool", () =>
        Effect.gen(function* () {
          const codec = yield* CallBodyCodec
          for (const call of SAMPLE_POOL) {
            const encoded = codec.encode(call)
            expect(encoded.length).toBeGreaterThan(0)
            const decoded = codec.decode(encoded)
            expect(decoded.callRef).toBe(call.callRef)
          }
        }).pipe(Effect.provide(CallBodyCodecContracts.propertyTest(layer))),
      )

      it.effect("P7 Uint8Array integrity at size 0 / 1 / 1k / 64k", () =>
        Effect.gen(function* () {
          const codec = yield* CallBodyCodec
          for (const len of [0, 1, 1024, 65536]) {
            const sdp = new Uint8Array(len)
            for (let i = 0; i < len; i++) sdp[i] = i & 0xff
            const c: Call = {
              ...representativeCall,
              aLegInvite: {
                ...representativeCall.aLegInvite!,
                body: sdp,
              },
            }
            const round = codec.decode(codec.encode(c))
            const decodedBody = round.aLegInvite?.body
            expect(decodedBody).toBeDefined()
            expect(Buffer.from(decodedBody!).equals(Buffer.from(sdp))).toBe(true)
          }
        }).pipe(Effect.provide(layer)),
      )

      it.effect("P5 undefined preservation — callbackContext", () =>
        Effect.gen(function* () {
          const codec = yield* CallBodyCodec
          const c: Call = {
            ...representativeCall,
            callbackContext: undefined,
          }
          const round = codec.decode(codec.encode(c))
          expect(round.callbackContext).toBeUndefined()
        }).pipe(Effect.provide(layer)),
      )
    })
  }

  describe("paranoidInputs", () => {
    it.effect("PA2 — empty Buffer decode throws synchronously", () =>
      Effect.gen(function* () {
        const codec = yield* CallBodyCodec
        expect(() => codec.decode(Buffer.alloc(0))).toThrow(
          ParanoidInputViolation,
        )
      }).pipe(
        Effect.provide(CallBodyCodecContracts.paranoidInputs(MsgpackLayer)),
      ),
    )
  })

  describe("parity", () => {
    it.effect("Msgpack vs MsgpackRecords decode to deep-equal Calls", () =>
      Effect.gen(function* () {
        const codec = yield* CallBodyCodec
        const bytes = codec.encode(representativeCall)
        expect(bytes.length).toBeGreaterThan(0)
        const decoded = codec.decode(bytes)
        expect(decoded.callRef).toBe(representativeCall.callRef)
      }).pipe(
        Effect.provide(
          CallBodyCodecContracts.parity(MsgpackLayer, MsgpackRecordsLayer),
        ),
      ),
    )
  })
})

// Suppress unused-import warning for PropertyViolation (re-exported for
// caller-side dispatch when consumers wrap propertyTest).
void PropertyViolation
