/**
 * ReplicationTraceRecorder — captures replication frames the simulated
 * `/replog` HTTP transport emits, so the test harness can render them
 * alongside the SIP trace in the scenario's HTML/text reports.
 *
 * Why a recorder rather than instrumenting `PeerFabric` directly: the
 * user-facing event is "frame arrived at receiver" — that's what shows
 * up in the report as a cross-worker arrow. The propagate-channel write
 * on the source side is observable in the source's KV snapshot but
 * doesn't carry timing useful for ordering against SIP messages. Tee'ing
 * the simulated HTTP stream is the natural choke point: every frame
 * that crosses between b2b-1 and b2b-2 passes through here.
 *
 * The recorder is in-process state: a mutable buffer that the SUT layer
 * pushes into and the harness drains at scenario end.
 */

import type { DataFrame } from "../../src/replication/PullerFiber.js"
import type { NoopFrame } from "../../src/replication/ReplicationProtocol.js"

/**
 * One observation in the replication trace. `from` is the source peer
 * (the side serving its `/replog` stream); `to` is the consumer (the
 * puller). `frame` is the decoded protocol frame.
 *
 * Data frames mutate the receiver's `bak:{primary}:` partition.
 * Noop frames carry no state but mark the receiver as caught-up; they
 * are useful for understanding when the consumer believes it has the
 * full picture from the source.
 */
export interface ReplicationTraceEvent {
  /** Virtual-clock instant the receiver applied the frame. */
  readonly timestamp: number
  /** Source peer ordinal — the worker whose `/replog` produced the frame. */
  readonly from: string
  /** Consumer peer ordinal — the worker pulling from `from`. */
  readonly to: string
  readonly frame: DataFrame | NoopFrame
  /**
   * Monotonic capture-order tiebreaker from the harness's shared
   * `EventSequencer` (see src/test-harness/framework/EventSequencer.ts).
   * Used by the renderers as the secondary sort key to break
   * `timestamp` collisions between replication frames and SIP entries
   * captured at the same virtual-clock ms.
   */
  readonly seq: number
}

export interface ReplicationTraceRecorder {
  /**
   * Append a frame observation. The caller passes everything except
   * `seq` — the recorder stamps `seq` from its sequencer so the same
   * counter the SIP layers use feeds the replication entries too.
   */
  readonly record: (event: Omit<ReplicationTraceEvent, "seq">) => void
  readonly drain: () => ReadonlyArray<ReplicationTraceEvent>
}

/**
 * Optional sequencer the harness supplies so this recorder stamps
 * `seq` from the same counter as the SIP recording layers. Omit it in
 * standalone tests; the recorder then uses a per-instance counter and
 * cross-layer same-ms ordering degrades to insertion order (the
 * pre-EventSequencer behaviour).
 */
export interface ReplicationTraceSequencer {
  readonly nextSync: () => number
}

export const makeReplicationTraceRecorder = (
  sequencer?: ReplicationTraceSequencer,
): ReplicationTraceRecorder => {
  const buffer: ReplicationTraceEvent[] = []
  const allocSeq: () => number = sequencer !== undefined
    ? sequencer.nextSync
    : (() => {
        let local = 0
        return () => ++local
      })()
  return {
    record: (event) => {
      buffer.push({ ...event, seq: allocSeq() })
    },
    drain: () => {
      const out = buffer.slice()
      buffer.length = 0
      return out
    },
  }
}
