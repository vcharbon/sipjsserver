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

import { Effect, MutableHashMap, Option } from "effect"
import { callIndexKeysFromUnknown } from "../call/CallModel.js"
import { mpUnpack, stripStampedPrefix } from "../call/CallCodec.js"
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

/**
 * Extract the per-call content-version from a decoded body object.
 * Schema-tolerant: missing field, wrong type, or null body all map to
 * `-Infinity` so the apply gate succeeds (create-if-not-exist).
 *
 * Looks for `_topology.gen` first (set by `CallState.flushToRedis` on
 * every put), then top-level `callGen` (legacy compatibility). Strict
 * max so a body carrying both never regresses.
 */
const extractCallGen = (body: unknown): number => {
  if (body === null || typeof body !== "object") return Number.NEGATIVE_INFINITY
  const obj = body as Record<string, unknown>
  let max = Number.NEGATIVE_INFINITY
  const topology = obj["_topology"]
  if (topology !== null && typeof topology === "object") {
    const tgen = (topology as Record<string, unknown>)["gen"]
    if (typeof tgen === "number" && Number.isFinite(tgen)) {
      if (tgen > max) max = tgen
    }
  }
  const top = obj["callGen"]
  if (typeof top === "number" && Number.isFinite(top)) {
    if (top > max) max = top
  }
  return max
}

type IndexCache = MutableHashMap.MutableHashMap<string, ReadonlyArray<string>>

const cacheKeyOf = (source: string, callRef: string): string =>
  `${source}|${callRef}`

const idxKey = (k: string): string => `idx:${k}`

/**
 * Decode a body Buffer, dispatching between legacy JSON and msgpack on
 * the first byte (matches `CallCodec.decodeBodyAuto`'s logic — the
 * apply path needs the SAME auto-detect because the originator and
 * receiver may briefly run different codec versions during a rolling
 * upgrade).
 */
const safeDecodeBody = (buf: Buffer): unknown => {
  try {
    if (buf.length > 0 && buf[0] === 0x7b) {
      return JSON.parse(buf.toString("utf8"))
    }
    return mpUnpack(stripStampedPrefix(buf))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export const makeReplicationApply = (
  config: ReplicationApplyConfig,
): ((frame: DataFrame) => Effect.Effect<void, KvError>) => {
  const indexCache: IndexCache = MutableHashMap.empty<
    string,
    ReadonlyArray<string>
  >()

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
        // Body + indexes are DEL'd ATOMICALLY in one exclusive section.
        // Sequential `bodyDel`s would cycle the per-store mutex and
        // open a window where the SIP hot path observes a deleted body
        // but lingering idx entries (or vice-versa) and 481s an in-
        // flight call — see `applyReplicaDelete` rationale in
        // src/storage/KvBackend.ts.
        const cached = MutableHashMap.get(
          indexCache,
          cacheKeyOf(config.source, frame.callRef),
        )
        const indexesToRemove = Option.isSome(cached) ? cached.value : []
        yield* config.localKv.applyReplicaDelete({
          bodyKey: targetBodyKey,
          indexKeys: indexesToRemove.map(idxKey),
        })
        MutableHashMap.remove(
          indexCache,
          cacheKeyOf(config.source, frame.callRef),
        )
        return
      }

      // ---- UPDATE path -------------------------------------------------
      // Per-call content gate (UPDATE only).
      const localBodyRaw = yield* config.localKv.bodyGet(targetBodyKey)
      const localCallGen =
        localBodyRaw === null
          ? Number.NEGATIVE_INFINITY
          : extractCallGen(safeDecodeBody(localBodyRaw))
      // The incoming frame body is the originator's raw msgpack bytes;
      // unpack once for the apply gate + index derivation. The raw
      // Buffer is what we write to local storage — no re-encoding.
      if (frame.body === null) {
        return
      }
      const decodedBody = safeDecodeBody(frame.body)
      const incomingCallGen = extractCallGen(decodedBody)
      if (
        localBodyRaw !== null &&
        Number.isFinite(localCallGen) &&
        Number.isFinite(incomingCallGen) &&
        incomingCallGen <= localCallGen
      ) {
        return
      }

      const derivedIndexes = callIndexKeysFromUnknown(decodedBody)
      const bodyTtlSec =
        frame.body_ttl_remaining_sec > 0
          ? frame.body_ttl_remaining_sec
          : config.bodyTtlSec
      // Body + indexes set ATOMICALLY (see applyReplicaUpdate rationale
      // in src/storage/KvBackend.ts — the SIP hot path's
      // `resolveFromSipKey` requires body and indexes to be visible
      // together). The bodyValue is the originator's bytes passed
      // through opaquely so the local copy is bit-for-bit identical to
      // the source.
      // Commit 2: the per-call callGen sidecar is now written alongside
      // the body. We extract callGen from the decoded body here as a
      // transitional measure — commit 4 will pull it from `frame.callGen`
      // and remove the body decode entirely.
      const sidecarCallGen = Number.isFinite(incomingCallGen)
        ? Math.max(0, incomingCallGen)
        : 0
      yield* config.localKv.applyReplicaUpdate({
        bodyKey: targetBodyKey,
        bodyValue: frame.body,
        bodyTtlSec,
        callGen: sidecarCallGen,
        indexes: derivedIndexes.map((k) => ({
          key: idxKey(k),
          value: frame.callRef,
          ttlSec: bodyTtlSec,
        })),
      })
      MutableHashMap.set(
        indexCache,
        cacheKeyOf(config.source, frame.callRef),
        derivedIndexes,
      )
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
