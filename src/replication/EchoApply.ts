/**
 * Replication apply — the PULLER-side write path.
 *
 * Receives a `DataFrame` from a source peer and applies it to LOCAL
 * storage **only**. There is no outgoing channel write. Replication
 * is strictly originator → peer, one-way per channel; the peer
 * applies and stops there.
 *
 * Why no echo. The original Story 7d design wrote mirror entries
 * (`entryGen=0`) into `propagate:{self}->{source}` to support a
 * hypothetical cold-pull-rebuilds-from-mirrors recovery path. Three
 * problems made that wrong:
 *
 *   1. **Pure waste in steady state.** Warm pullers skip `gen=0`
 *      buckets by lex-order on `(gen, counter)`. The mirror entries
 *      are produced on every apply but never consumed.
 *
 *   2. **Update/delete crossing — a correctness bug.** When the
 *      originator A writes UPDATE(X) then DELETE(X), B applies
 *      UPDATE first, writes the mirror, then applies DELETE.
 *      Concurrently, A's puller pulls B's mirror. After A's own
 *      DELETE drained the body slot to `null`, the gate sees
 *      `local=null` for B's incoming UPDATE mirror and re-applies
 *      it locally — silently resurrecting the deleted call.
 *
 *   3. **NS5 sidecar-wipe recovery via mirrors is the wrong shape.**
 *      The legitimate recovery primitive after a sidecar wipe is a
 *      bootstrap SCAN of the peer's `bak:{self}:*` partition, not a
 *      cold pull of the peer's channel-to-self (which mixes the
 *      peer's originating writes with stale mirrors). NS5 is now
 *      skipped pending a peer-scan-bootstrap slice; see
 *      docs/plan/lets-plan-a-proper-crystalline-emerson.md.
 *
 * Apply rules:
 *
 *   - Per-call `callGen` content gate, UPDATE frames only. A delete
 *     supersedes any local content; gating it could starve the
 *     delete behind a higher-callGen local body produced by an
 *     out-of-order earlier write.
 *
 *   - Partition flip:
 *       frame.partition === "pri"  → write to bak:{source}: on me
 *       frame.partition === "bak"  → write to pri:{me}:    on me
 *
 *   - UPDATE: `kv.bodySet(targetBodyKey, ...)` + `kv.bodySet(idx, ...)`
 *     for each derived index. Indexes derived from the body via
 *     `callIndexKeysFromUnknown` and cached for the eventual DELETE.
 *
 *   - DELETE: `kv.bodyDel(targetBodyKey)` + `kv.bodyDel(idx)` for
 *     each cached index. Cache miss → "delete body only, let
 *     `idx:*` TTL out".
 */

import { Effect } from "effect"
import type { Partition } from "./ChannelIndex.js"
import type { DataFrame } from "./ReplicationProtocol.js"
import { KvBackend, type KvBackendApi, type KvError } from "../storage/KvBackend.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ReplicationApplyConfig {
  /** Local worker ordinal — used by the partition flip (target owner). */
  readonly self: string
  /** The puller's source peer — used by the partition flip. */
  readonly source: string
  /** Local KvBackend — the apply path reads/writes bodies + indexes here. */
  readonly localKv: KvBackendApi
  /**
   * Fallback body TTL for non-DELETE frames where the wire-level
   * `body_ttl_remaining_sec` is unset or `0`. In normal operation the
   * wire value wins; this is purely defensive for malformed frames.
   * Tests typically set 60s; production matches CallState's
   * `callContextTtlSec`.
   */
  readonly bodyTtlSec: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const idxKey = (k: string): string => `idx:${k}`

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export const makeReplicationApply = (
  config: ReplicationApplyConfig,
): ((frame: DataFrame) => Effect.Effect<void, KvError>) => {
  return (frame) =>
    Effect.gen(function* () {
      const targetPartition: Partition =
        frame.partition === "pri" ? "bak" : "pri"
      const targetOwner =
        targetPartition === "bak" ? config.source : config.self
      const targetBodyKey = `${targetPartition}:${targetOwner}:call:${frame.callRef}`

      const isDelete = frame.op === "delete" || frame.body === null

      // ---- DELETE path -------------------------------------------------
      if (isDelete) {
        // A delete supersedes any local content unconditionally — no
        // callGen gate. With echo killed, exactly one D-frame per call
        // reaches this peer (from the originator); there is no
        // crossing-tombstone scenario to mediate.
        //
        // Body + sidecar + indexes are DEL'd ATOMICALLY in one
        // exclusive section. Indexes come from frame.indexes — the
        // originator stamps them on both UPDATE and DELETE so the peer
        // does not need a per-call cache to know which idx:* keys to
        // remove.
        yield* config.localKv.applyReplicaDelete({
          bodyKey: targetBodyKey,
          indexKeys: frame.indexes.map(idxKey),
        })
        return
      }

      // ---- UPDATE path -------------------------------------------------
      // Per-call content gate (UPDATE only). Read the local callGen from
      // the 4-byte sidecar key — the body is NEVER decoded on this path
      // post-opaque-apply.
      const sidecarRaw = yield* config.localKv.bodyGet(
        KvBackend.bodyGenSidecarKey(targetBodyKey),
      )
      const localCallGen = KvBackend.decodeCallGenSidecar(sidecarRaw)
      const incomingCallGen = frame.callGen
      if (
        localCallGen !== null &&
        Number.isFinite(incomingCallGen) &&
        incomingCallGen <= localCallGen
      ) {
        return
      }

      const bodyTtlSec =
        frame.body_ttl_remaining_sec > 0
          ? frame.body_ttl_remaining_sec
          : config.bodyTtlSec
      // Body + sidecar + indexes set ATOMICALLY (see applyReplicaUpdate
      // rationale in src/storage/KvBackend.ts — the SIP hot path's
      // `resolveFromSipKey` requires body and indexes to be visible
      // together). The bodyValue is the originator's bytes passed
      // through opaquely so the local copy is bit-for-bit identical to
      // the source.
      yield* config.localKv.applyReplicaUpdate({
        bodyKey: targetBodyKey,
        bodyValue: frame.body,
        bodyTtlSec,
        callGen: Math.max(0, incomingCallGen),
        indexes: frame.indexes.map((k) => ({
          key: idxKey(k),
          value: frame.callRef,
          ttlSec: bodyTtlSec,
        })),
      })
    })
}

// ---------------------------------------------------------------------------
// Backward-compat aliases (kept until call sites update)
// ---------------------------------------------------------------------------

/** @deprecated Renamed to `makeReplicationApply`. */
export const makeEchoApply = makeReplicationApply

/** @deprecated Same as `ReplicationApplyConfig`. */
export type EchoApplyConfig = ReplicationApplyConfig

// Suppress unused-import noise: KvBackend is re-exported for consumers
// that want to construct backends in the same module.
void KvBackend
