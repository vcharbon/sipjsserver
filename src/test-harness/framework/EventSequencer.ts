/**
 * EventSequencer — monotonic per-scenario counter used as a deterministic
 * tiebreaker when two recorded events share the same `timestamp` (ms).
 *
 * Why this exists: the renderers (svg-sequence-diagram, text-report,
 * html-report) sort the merged SIP + replication + internal-hop entries
 * by `timestamp`. Under TestClock a burst of events can collide on the
 * same ms; under the hybrid (real + fake) stack the two clocks tick
 * from different origins and their entries collide whenever the real
 * clock happens to align. JS `Array.sort` is not stable across all
 * engines, and even when stable the insertion order across distinct
 * recording layers is not the temporal order they were captured in.
 *
 * Every recording layer (interpreter step trace, SignalingNetwork
 * NetworkTraceEntry, the unified Recorder service's typed channels
 * including `PartitionedRelayStorage`'s replication-frame channel)
 * allocates a `seq` at the moment of capture from this single shared
 * counter. Renderers tiebreak `(timestamp, seq)`.
 *
 * Sync vs Effect API: most capture sites live inside `Effect.gen` and
 * can `yield* sequencer.next`. The `realTracing` UDP recv handler is a
 * non-Effect Node callback — `nextSync()` covers that.
 */

import { Effect, Layer, ServiceMap } from "effect"

export interface EventSequencerApi {
  /** Allocate the next strictly-increasing sequence number. */
  readonly next: Effect.Effect<number>
  /**
   * Synchronous allocator for non-Effect callers (UDP recv callbacks,
   * synchronous trace-recorder `.record(...)` calls). Same counter as
   * `next`; calling both interleaves monotonically.
   */
  readonly nextSync: () => number
}

export class EventSequencer extends ServiceMap.Service<
  EventSequencer,
  EventSequencerApi
>()("@sipjsserver/test-harness/EventSequencer") {
  /**
   * Build a fresh sequencer. Each scenario should provide its own
   * `EventSequencer.layer` so seq numbers start at 1 per scenario —
   * sharing across scenarios would leak per-scenario state and
   * monotonic numbers would grow unboundedly across a test run.
   */
  static readonly layer: Layer.Layer<EventSequencer> = Layer.sync(
    EventSequencer,
    () => makeApi(),
  )
}

export const makeEventSequencer = (): EventSequencerApi => makeApi()

const makeApi = (): EventSequencerApi => {
  let counter = 0
  const nextSync = (): number => ++counter
  return {
    next: Effect.sync(nextSync),
    nextSync,
  }
}
