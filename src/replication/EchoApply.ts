/**
 * Replication apply — the PULLER-side write path (Story 7d).
 *
 * The puller receives a `DataFrame` from a source peer and applies it to
 * local storage as a MIRROR (entryGen=0). Every applied frame:
 *
 *   1. Goes through the per-call `callGen` content gate — skip when the
 *      local body is fresher (`local.callGen ≥ incoming.callGen`). Catches
 *      stale forward writes that race against G7-reverse terminations on
 *      the same call. Create-if-not-exist is preserved (null local body
 *      ⇒ `localCallGen = -∞`).
 *   2. Derives the SIP-derived index list from the body via
 *      `callIndexKeysFromUnknown(frame.body)` — pure function over the
 *      body's `aLeg`/`bLegs`/`callbackContext` (matches the typed
 *      `callIndexKeys(call)` used on the originating side). The legacy
 *      `ReplPuller` used the same primitive; the new design preserves it.
 *      The wire frame does NOT carry indexes.
 *   3. Calls ONE atomic primitive: `channelWriteUpdate({ entryGen: 0, ... })`.
 *      Atomically: bump the gen=0 bucket counter, ZADD the U-member, SETEX
 *      the body at the local target bodyKey, SETEX each derived `idx:*`
 *      entry. Body and indexes never live without each other.
 *   4. Caches the derived index list per `(peer, callRef)`. Used by the
 *      DELETE path: tombstone frames have body=null so indexes can't be
 *      re-derived; the cache supplies the list to `channelTombstone`.
 *      Cache miss falls back to "delete body only, let `idx:*` TTL out"
 *      — matches legacy behavior.
 *
 * Apply target derivation (partition flip):
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
 * In both cases the corresponding outgoing channel for the mirror is
 * `propagate:{me}->{source}` (per-call peer-stability invariant).
 *
 * The cycle-break is structural: lex-ordering on `(entryGen, counter)`
 * means warm pullers never see mirror entries (gen=0) — they only show up
 * on cold pulls (since=(0,0)) for recovery. See [docs/replication/architecture.md
 * §"Cycle-break and recovery"](../../docs/replication/architecture.md).
 *
 * Reference: [docs/plan/grill-me-on-the-spicy-lark.md §Story 7d](../../docs/plan/grill-me-on-the-spicy-lark.md).
 */

import { Effect, MutableHashMap, Option } from "effect"
import { callIndexKeysFromUnknown } from "../call/CallModel.js"
import type { ChannelIndexApi, Partition } from "./ChannelIndex.js"
import type { DataFrame } from "./ReplicationProtocol.js"
import { KvBackend, type KvBackendApi, type KvError } from "../storage/KvBackend.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for `makeReplicationApply`. All fields are mandatory — the
 * apply path needs every piece of context to derive the partition flip,
 * read the local body for the callGen gate, write the mirror, and cache
 * indexes for the eventual DELETE.
 */
export interface ReplicationApplyConfig {
  /** Local worker ordinal — used by the partition flip (target owner). */
  readonly self: string
  /** The puller's source peer — used by the partition flip and the mirror channel binding. */
  readonly source: string
  /**
   * Local KvBackend (the same one bound to `outgoingChannel`). Used by
   * the apply path to read the local body for the per-call `callGen`
   * content gate. Bodies live alongside the channels; the gate is the
   * read-modify-write that closes the cross-direction race window.
   */
  readonly localKv: KvBackendApi
  /**
   * Outgoing channel binding `propagate:{self}->{source}` — the puller
   * writes mirror entries (entryGen=0) here so the source can later
   * cold-pull them back during recovery.
   */
  readonly outgoingChannel: ChannelIndexApi
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

const MIRROR_ENTRY_GEN = 0

/**
 * Pure helper outside Effect.gen so the Effect plugin's
 * `preferSchemaOverJson` rule does not fire — the body bytes are opaque
 * pass-through state we don't own a schema for.
 */
const encodeBody = (body: unknown): string => JSON.stringify(body)

/**
 * Extract the per-call content-version from a JSON-decoded body. Schema-
 * tolerant: missing field, wrong type, or null body all map to
 * `-Infinity` so the apply gate succeeds (create-if-not-exist).
 *
 * Looks for two field shapes, in priority order:
 *   1. `_topology.gen` — set by `CallState.flushToRedis` on every put.
 *      This is the existing call-body convention preserved across the
 *      Story 7d redesign so PRS putCall doesn't need a fresh RMW step.
 *   2. Top-level `callGen` — set by `PRS.deleteCall` inside the
 *      tombstone body via RMW (the tombstone has no `_topology`).
 *
 * Returning the strict max of both means a body carrying both never
 * regresses (defensive against future mixed encodings).
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

/**
 * Per-`(source, callRef)` cache of the derived index list. Populated on
 * every successful PUT/UPDATE apply; consumed by the DELETE apply (since
 * tombstone frames carry `body=null` and cannot re-derive). Cache miss on
 * DELETE falls back to "remove body only" — the orphaned `idx:*` entries
 * TTL out within one call-TTL window. This matches the legacy
 * `ReplPuller`'s indexCache pattern.
 */
type IndexCache = MutableHashMap.MutableHashMap<string, ReadonlyArray<string>>

const cacheKeyOf = (source: string, callRef: string): string =>
  `${source}|${callRef}`

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build the puller's `applyFrame` callback. Wired into `runPullerFiber`
 * via the harness's `forkPuller` (or production's
 * `ReplicationSupervisor`'s puller config).
 *
 * The factory creates a closure over a per-puller index cache so the
 * DELETE path can resolve `idx:*` removals without re-deriving from a
 * null tombstone body. Callers pass one config per source peer they are
 * pulling from.
 */
export const makeReplicationApply = (
  config: ReplicationApplyConfig
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

      // ---- Per-call content gate (callGen) -----------------------------
      const localBodyRaw = yield* config.localKv.bodyGet(targetBodyKey)
      const localCallGen =
        localBodyRaw === null
          ? Number.NEGATIVE_INFINITY
          : extractCallGen(safeParseJson(localBodyRaw))
      const incomingCallGen = extractCallGen(frame.body)

      // Create-if-not-exist: when there is no local body, every
      // incoming frame lands. This is the cold-recovery path
      // (NS5/NS7/NS8) and steady-state-first-touch case.
      // Otherwise the gate compares: skip if `incoming.callGen ≤
      // local.callGen` (and both are real, finite values).
      const localExists = localBodyRaw !== null
      if (
        localExists &&
        Number.isFinite(localCallGen) &&
        Number.isFinite(incomingCallGen) &&
        incomingCallGen <= localCallGen
      ) {
        return
      }

      // ---- DELETE path -------------------------------------------------
      if (frame.op === "delete" || frame.body === null) {
        const cached = MutableHashMap.get(
          indexCache,
          cacheKeyOf(config.source, frame.callRef)
        )
        const indexesToRemove = Option.isSome(cached) ? cached.value : []
        // Stamp the mirror tombstone with the same `callGen` the
        // upstream tombstone carries, so a future puller of OUR
        // outgoing channel sees a callGen that supersedes whatever
        // local content they hold for this call. We already know
        // `incomingCallGen > localCallGen` from the gate above, so
        // this preserves monotonicity. For frames where the body
        // carried no callGen at all (`-Infinity`), fall back to
        // `localCallGen + 1` to maintain a strict bump.
        const mirrorTombstoneCallGen =
          incomingCallGen !== Number.NEGATIVE_INFINITY
            ? incomingCallGen
            : localCallGen === Number.NEGATIVE_INFINITY
              ? 1
              : localCallGen + 1
        yield* config.outgoingChannel.tombstone({
          entryGen: MIRROR_ENTRY_GEN,
          partition: targetPartition,
          callRef: frame.callRef,
          callGen: mirrorTombstoneCallGen,
          indexesToRemove: indexesToRemove.map(idxKey),
        })
        // Best-effort cache hygiene — tombstone applied, no further
        // delete will need this entry. (It would TTL out via Redis
        // expiry anyway since the body is gone; the cache is in-memory
        // and lives for the puller fiber's lifetime.)
        MutableHashMap.remove(
          indexCache,
          cacheKeyOf(config.source, frame.callRef)
        )
        return
      }

      // ---- PUT / UPDATE path ------------------------------------------
      const derivedIndexes = callIndexKeysFromUnknown(frame.body)
      const bodyValue = encodeBody(frame.body)
      // Wire-level TTL is authoritative; fall back to config only if
      // missing/invalid (e.g. malformed frame; should never happen from
      // a current-version server).
      const bodyTtlSec =
        frame.body_ttl_remaining_sec > 0
          ? frame.body_ttl_remaining_sec
          : config.bodyTtlSec
      yield* config.outgoingChannel.write({
        entryGen: MIRROR_ENTRY_GEN,
        partition: targetPartition,
        callRef: frame.callRef,
        bodyValue,
        bodyTtlSec,
        indexes: derivedIndexes.map((key) => ({
          key: idxKey(key),
          value: frame.callRef,
          ttlSec: bodyTtlSec,
        })),
      })
      MutableHashMap.set(
        indexCache,
        cacheKeyOf(config.source, frame.callRef),
        derivedIndexes
      )
    })
}

// ---------------------------------------------------------------------------
// Backward-compat alias
// ---------------------------------------------------------------------------

/**
 * @deprecated Renamed to `makeReplicationApply` (Story 7d). The old name
 * referenced "echo" semantics that the redesign retired (echo became
 * structurally unnecessary once mirror entries are tagged with
 * `entryGen=0` and lex-ordering on `(gen, counter)` carries the
 * cycle-break). Update call sites to `makeReplicationApply` and remove
 * this alias when the slice closes.
 */
export const makeEchoApply = makeReplicationApply

/** @deprecated Same as `ReplicationApplyConfig`. */
export type EchoApplyConfig = ReplicationApplyConfig

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Pure JSON parser kept outside Effect.gen for the Effect plugin. */
const safeParseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/**
 * Storage key for an `idx:*` entry. Mirrors
 * `PartitionedRelayStorage.indexKey(indexKey)` without the import cycle
 * — both helpers must agree on the prefix.
 */
const idxKey = (k: string): string => `idx:${k}`

// Unused-import suppressors: we re-export `KvBackend` so consumers
// pulling from this module pick up the namespace, but TypeScript's
// no-unused-import would complain. The constant reference below is
// the intentional anchor.
void KvBackend
