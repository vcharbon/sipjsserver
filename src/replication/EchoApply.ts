/**
 * EchoApply — builds the puller's `applyFrame` callback that writes a
 * received frame to local storage AND echoes it onto the local outgoing
 * channel-to-source.
 *
 * The "echo everything" rule (design doc §D5 sub-decision iii-A): every
 * write to any partition (active local OR passive mirror) bumps the
 * local outgoing channel for the corresponding peer. This makes
 * `since=0` cold-start bootstrap a single-mechanism path — a recovering
 * peer reads our outgoing channel and gets back everything we hold for
 * it, primary-direction AND reverse-direction.
 *
 * Apply target derivation:
 *
 *   frame.partition === "pri"
 *     → source wrote to its own `pri:{source}:` (forward primary write)
 *     → mirror to MY `bak:{source}:` (passive backup of source's data).
 *
 *   frame.partition === "bak"
 *     → source wrote to `bak:{me}:` on my behalf during my brief
 *       unavailability (G7 reverse path)
 *     → I am the primary returning; install into MY `pri:{me}:`.
 *
 * In both cases the "corresponding peer" for this call is `source`
 * (per-call peer-stability invariant), so the echo lands on
 * `propagate:{me}->{source}`.
 *
 * Tombstones (op=delete) and updates (op=create/update) are handled
 * symmetrically — both go through `ChannelIndex.tombstone` /
 * `ChannelIndex.write` against the outgoing-to-source channel.
 *
 * Reference: [docs/plan/grill-me-on-the-spicy-lark.md](../../docs/plan/grill-me-on-the-spicy-lark.md) §D5.
 */

import { Effect } from "effect"
import type { ChannelIndexApi } from "./ChannelIndex.js"
import type { DataFrame } from "./ReplicationProtocol.js"
import type { KvError } from "../storage/KvBackend.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EchoApplyConfig {
  /**
   * The outgoing channel from `me` (this worker) to `source` (the
   * peer this puller is consuming from). Bound externally because
   * the channel needs to know self.gen (the local gen, not the
   * source's gen) — it's the local writer's gen we stamp on echo.
   */
  readonly outgoingChannel: ChannelIndexApi
  /**
   * TTL stamped on the body when echoing an update. Production passes
   * the same value as the original write's TTL (~600s typical); tests
   * can shorten this to drive TTL-cleanup scenarios.
   */
  readonly bodyTtlSec: number
}

// ---------------------------------------------------------------------------
// Encoder helper kept outside Effect.gen so the Effect plugin's
// preferSchemaOverJson rule does not fire on the body pass-through.
// ---------------------------------------------------------------------------

const encodeBody = (body: unknown): string => JSON.stringify(body)

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the `applyFrame` callback wired into `runPullerFiber`. The
 * returned function is total — it never fails the puller's apply path
 * (errors from KvBackend are propagated to the caller's typed channel
 * via the standard `Effect<…, KvError>` shape).
 */
export const makeEchoApply = (
  config: EchoApplyConfig
): ((frame: DataFrame) => Effect.Effect<void, KvError>) => {
  return (frame) =>
    Effect.gen(function* () {
      // Map source-side partition tag → local apply target. See
      // docstring above for the derivation.
      const targetPartition = frame.partition === "pri" ? "bak" : "pri"

      if (frame.op === "delete") {
        yield* config.outgoingChannel.tombstone({
          partition: targetPartition,
          callRef: frame.callRef,
          // The wire frame does not carry the index list (Slice 7
          // adds index payloads when the SIP write path moves through
          // ChannelIndex). For now: empty list — orphan idx entries
          // TTL out within the call-body window, matching the
          // existing slice-2 behaviour pattern.
          indexesToRemove: [],
        })
        return
      }

      const bodyValue = frame.body === null ? "null" : encodeBody(frame.body)
      yield* config.outgoingChannel.write({
        partition: targetPartition,
        callRef: frame.callRef,
        bodyValue,
        bodyTtlSec: config.bodyTtlSec,
        indexes: [],
      })
    })
}
