/**
 * Property-based contract tests for `CallBodyCodec`. Exercises P1–P14
 * from the codec contract against every registered codec Layer. Uses
 * the deterministic fixture mixer from `tests/bench/call-codec/` for
 * representative coverage; the `propertyTest` wrapper enforces the
 * properties on every encode/decode call.
 *
 * Wiring follows the `effect-layer-test` skill: the wrapper stack is
 * composed via Tag-static methods —
 *
 *   CallBodyCodec.propertyTest(
 *     CallBodyCodec.paranoidInputs(layer)
 *   )
 *
 * The recording wrapper (`scopedAudit`) is intentionally NOT applied
 * here — these tests only exercise the per-call contract, not the
 * cross-call aggregates a scope-close finalizer would assert.
 *
 * Every codec layer (Msgpack, MsgpackRecords, Protobuf) runs under
 * the same stacked wrapper across the 200-sample fake-call fixture
 * pool, exercised under `it.effect` (TestClock-backed fake clock).
 */

// PA1 (Schema.is on encode input) is opt-in via `B2BUA_PARANOID`. Set it
// before importing `contracts` so the wrapper picks it up.
process.env["B2BUA_PARANOID"] = "1"

import { describe, it, expect } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  CallBodyCodec,
  MsgpackLayer,
  MsgpackRecordsLayer,
  ProtobufLayer,
  PropertyViolation,
  ParanoidInputViolation,
} from "../../src/call/codec/index.js"
import { Recorder } from "../../src/test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../../src/test-harness/framework/RunContext.js"
import { representativeCall } from "../bench/call-codec/fixture.js"
import { buildFixturePool, DEFAULT_MIX } from "../bench/call-codec/fixtureMix.js"
import type { Call } from "../../src/call/CallModel.js"

// Codec wrappers now require Recorder + RunContext for typed-channel
// recording. Tests provide the fake variants — recording is structurally
// in scope but the values aren't asserted here (separate test).
const RecorderEnv = Layer.mergeAll(Recorder.fake, RunContext.testWithRecorder)

const CODEC_LAYERS = [
  { name: "MsgpackLayer", layer: MsgpackLayer },
  { name: "MsgpackRecordsLayer", layer: MsgpackRecordsLayer },
  { name: "ProtobufLayer", layer: ProtobufLayer },
] as const

const SAMPLE_POOL: ReadonlyArray<Call> = buildFixturePool(DEFAULT_MIX, 200)

describe("CallBodyCodec contracts — property-based", () => {
  for (const { name, layer } of CODEC_LAYERS) {
    // Skill-canonical wiring: propertyTest(paranoidInputs(impl)). Paranoid
    // input check runs first (cheap precondition); then per-call property
    // assertions fire on every encode/decode.
    const stacked = CallBodyCodec.propertyTest(
      CallBodyCodec.paranoidInputs(layer),
    ).pipe(Layer.provide(RecorderEnv))

    describe(name, () => {
      it.effect("P1 round-trip preserves the representative fixture", () =>
        Effect.gen(function* () {
          const codec = yield* CallBodyCodec
          const encoded = codec.encode(representativeCall)
          const decoded = codec.decode(encoded)
          expect(decoded.callRef).toBe(representativeCall.callRef)
          expect(decoded.aLeg.callId).toBe(representativeCall.aLeg.callId)
          expect(decoded.bLegs.length).toBe(representativeCall.bLegs.length)
        }).pipe(Effect.provide(stacked)),
      )

      it.effect("P1-P14 over a 200-sample fixture pool (paranoid + property)", () =>
        Effect.gen(function* () {
          const codec = yield* CallBodyCodec
          for (const call of SAMPLE_POOL) {
            const encoded = codec.encode(call)
            expect(encoded.length).toBeGreaterThan(0)
            const decoded = codec.decode(encoded)
            expect(decoded.callRef).toBe(call.callRef)
          }
        }).pipe(Effect.provide(stacked)),
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

  describe("paranoidInputs (Tag-static wiring)", () => {
    it.effect("PA2 — empty Buffer decode throws synchronously (Msgpack)", () =>
      Effect.gen(function* () {
        const codec = yield* CallBodyCodec
        expect(() => codec.decode(Buffer.alloc(0))).toThrow(
          ParanoidInputViolation,
        )
      }).pipe(
        Effect.provide(
          CallBodyCodec.paranoidInputs(MsgpackLayer).pipe(
            Layer.provide(RecorderEnv),
          ),
        ),
      ),
    )

    it.effect("PA2 — empty Buffer decode throws synchronously (Protobuf)", () =>
      Effect.gen(function* () {
        const codec = yield* CallBodyCodec
        expect(() => codec.decode(Buffer.alloc(0))).toThrow(
          ParanoidInputViolation,
        )
      }).pipe(
        Effect.provide(
          CallBodyCodec.paranoidInputs(ProtobufLayer).pipe(
            Layer.provide(RecorderEnv),
          ),
        ),
      ),
    )

    it.effect("PA1 — Schema.is(CallSchema) rejects a malformed encode input (Protobuf)", () =>
      Effect.gen(function* () {
        const codec = yield* CallBodyCodec
        const malformed = { ...representativeCall, callRef: 42 as unknown as string }
        expect(() => codec.encode(malformed)).toThrow(ParanoidInputViolation)
      }).pipe(
        Effect.provide(
          CallBodyCodec.paranoidInputs(ProtobufLayer).pipe(
            Layer.provide(RecorderEnv),
          ),
        ),
      ),
    )
  })

  describe("parity (Tag-static wiring)", () => {
    it.effect("Msgpack vs MsgpackRecords decode to deep-equal Calls", () =>
      Effect.gen(function* () {
        const codec = yield* CallBodyCodec
        const bytes = codec.encode(representativeCall)
        expect(bytes.length).toBeGreaterThan(0)
        const decoded = codec.decode(bytes)
        expect(decoded.callRef).toBe(representativeCall.callRef)
      }).pipe(
        Effect.provide(
          CallBodyCodec.parity(MsgpackLayer, MsgpackRecordsLayer).pipe(
            Layer.provide(RecorderEnv),
          ),
        ),
      ),
    )

    it.effect("Msgpack vs Protobuf decode to deep-equal Calls", () =>
      Effect.gen(function* () {
        const codec = yield* CallBodyCodec
        const bytes = codec.encode(representativeCall)
        expect(bytes.length).toBeGreaterThan(0)
        const decoded = codec.decode(bytes)
        expect(decoded.callRef).toBe(representativeCall.callRef)
      }).pipe(
        Effect.provide(
          CallBodyCodec.parity(MsgpackLayer, ProtobufLayer).pipe(
            Layer.provide(RecorderEnv),
          ),
        ),
      ),
    )
  })
})

// Suppress unused-import warning for PropertyViolation (re-exported for
// caller-side dispatch when consumers wrap propertyTest).
void PropertyViolation
