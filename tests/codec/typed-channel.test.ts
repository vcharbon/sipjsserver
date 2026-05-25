/**
 * Verifies that the codec wrappers write typed `CallBodyCodecEvent`s
 * to `Recorder.forTag(CallBodyCodec)` for every encode/decode call.
 *
 * Recording is the source-of-truth contract; this asserts the four
 * lifecycle events fire in order (called/result × encode/decode) for
 * the paranoidInputs wrapper, and that a property violation pushes a
 * `codecPropertyViolation` anomaly through the projector.
 */

import { describe, it, expect } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
  CallBodyCodec,
  MsgpackLayer,
  type CallBodyCodecEvent,
  type PropertyTestOptions,
  PropertyViolation,
} from "../../src/call/codec/index.js"
import { Recorder } from "../../src/test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../../src/test-harness/framework/RunContext.js"
import { representativeCall } from "../bench/call-codec/fixture.js"

const RecorderEnv = Layer.mergeAll(Recorder.fake, RunContext.testWithRecorder)

describe("CallBodyCodec typed channel", () => {
  it.effect("paranoidInputs records encode + decode call/result events", () =>
    Effect.gen(function* () {
      const codec = yield* CallBodyCodec
      const recorder = yield* Recorder
      const bytes = codec.encode(representativeCall)
      const back = codec.decode(bytes)
      expect(back.callRef).toBe(representativeCall.callRef)
      const channel = recorder.forTag<CallBodyCodec, CallBodyCodecEvent>(
        CallBodyCodec,
      )
      const events = yield* channel.snapshot
      const tags = events.map((e) => e.tag)
      expect(tags).toEqual([
        "encode.called",
        "encode.result",
        "decode.called",
        "decode.result",
      ])
    }).pipe(
      Effect.provide(
        CallBodyCodec.paranoidInputs(MsgpackLayer).pipe(
          Layer.provide(RecorderEnv),
        ),
      ),
      Effect.provide(RecorderEnv),
    ),
  )

  it.effect("propertyTest records a codecPropertyViolation anomaly before throwing", () =>
    Effect.gen(function* () {
      const codec = yield* CallBodyCodec
      const recorder = yield* Recorder
      // A trivial extra property that always fails — the wrapper should
      // record the violation and throw PropertyViolation.
      expect(() => codec.encode(representativeCall)).toThrow(PropertyViolation)
      const snap = yield* recorder.snapshot
      const codecViolations = snap.anomalies.filter(
        (a) => a.kind === "codecPropertyViolation",
      )
      expect(codecViolations.length).toBeGreaterThan(0)
      expect(codecViolations[0]!.severity).toBe("fatal")
    }).pipe(
      Effect.provide(
        CallBodyCodec.propertyTest(MsgpackLayer, {
          extra: [
            {
              id: "ALWAYS_FAILS",
              check: () => "synthetic failure",
            },
          ],
        } satisfies PropertyTestOptions).pipe(Layer.provide(RecorderEnv)),
      ),
      Effect.provide(RecorderEnv),
    ),
  )
})
