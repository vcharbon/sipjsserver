/**
 * SipHarness — typed-channel Tag for driver-side scenario events
 * (ADR-0013 D8). Unlike the wrapped service Tags, SipHarness has no
 * underlying impl to enforce contracts against — it is pure recording.
 * Drivers yield it, call one of the three methods, and the call lands
 * as a stamped event on `Recorder.forTag(SipHarness)`.
 *
 *   - `timeout`              an expect step elapsed without a match
 *   - `marker`               free-form phase / note marker
 *   - `linkObservedToExpect` correlate an observed SIP packet (by seq)
 *                            with the expect step it satisfied. Consumers
 *                            read these from `Recorder.forTag(SipHarness)`
 *                            and join against the SIP trace by `seq`.
 *
 * Stamps (`seq`, `atMs`) come from the channel, NOT from the caller.
 */

import { Effect, Layer, ServiceMap } from "effect"
import { Recorder } from "./report-recorder/Recorder.js"

// ---------------------------------------------------------------------------
// Typed event union
// ---------------------------------------------------------------------------

export type SipHarnessEvent =
  | {
      readonly tag: "timeout"
      readonly agent: string
      readonly waitingFor: string
      readonly expectStepId: string
    }
  | {
      readonly tag: "marker"
      readonly phase: string
      readonly note?: string
    }
  | {
      readonly tag: "linkObservedToExpect"
      readonly expectStepId: string
      readonly observedSipSeq: number
    }

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface SipHarnessApi {
  readonly timeout: (args: {
    readonly agent: string
    readonly waitingFor: string
    readonly expectStepId: string
  }) => Effect.Effect<void>
  readonly marker: (args: {
    readonly phase: string
    readonly note?: string
  }) => Effect.Effect<void>
  readonly linkObservedToExpect: (args: {
    readonly expectStepId: string
    readonly observedSipSeq: number
  }) => Effect.Effect<void>
}

export class SipHarness extends ServiceMap.Service<SipHarness, SipHarnessApi>()(
  "@sipjsserver/test-harness/SipHarness",
) {
  /**
   * Layer providing `SipHarness` against the surrounding `Recorder`.
   * Stamps (`seq`, `atMs`) are added by `Recorder.forTag` — callers
   * pass payload only.
   */
  static readonly layer: Layer.Layer<SipHarness, never, Recorder> = Layer.effect(
    SipHarness,
    Effect.gen(function* () {
      const recorder = yield* Recorder
      const channel = recorder.forTag<SipHarness, SipHarnessEvent>(SipHarness)
      return {
        timeout: (args) =>
          channel.record({
            tag: "timeout",
            agent: args.agent,
            waitingFor: args.waitingFor,
            expectStepId: args.expectStepId,
          }),
        marker: (args) =>
          channel.record(
            args.note !== undefined
              ? { tag: "marker", phase: args.phase, note: args.note }
              : { tag: "marker", phase: args.phase },
          ),
        linkObservedToExpect: (args) =>
          channel.record({
            tag: "linkObservedToExpect",
            expectStepId: args.expectStepId,
            observedSipSeq: args.observedSipSeq,
          }),
      }
    }),
  )
}

