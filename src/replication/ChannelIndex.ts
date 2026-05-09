/**
 * ChannelIndex — replication-specific facade over the `KvBackend` port.
 *
 * One `ChannelIndex` instance binds a single `(self, peer)` channel and
 * exposes write/tombstone/pullBatch operations that derive their channel
 * key, counter key, body keys, and member encoding from this binding.
 *
 * The class is a thin layer of NAMING on top of `KvBackend`:
 *   channel    = `propagate:${self}->${peer}`
 *   counterKey = `seq:${self}->${peer}`
 *   bodyKey    = `${partition}:${owner}:call:${callRef}`
 *      where owner = (partition === "pri" ? self : peer) by per-call peer
 *      stability invariant (D2).
 *   member     = `${"U"|"D"}:${bodyKey}` per `KvBackend.memberOf`.
 *
 * Design ref: [docs/plan/grill-me-on-the-spicy-lark.md](../../docs/plan/grill-me-on-the-spicy-lark.md) §D2, §D3.
 */

import type { Effect } from "effect"
import {
  KvBackend,
  type ChannelPullResult,
  type KvBackendApi,
  type KvError,
} from "../storage/KvBackend.js"

/** Which side of the partition a call body lives on, on this writer. */
export type Partition = "pri" | "bak"

/**
 * Per-channel binding: the writer's own id, the peer this channel
 * targets, and the writer's incarnation `gen` (used to stamp tombstones
 * and exposed as `gen` on the API for the wire-frame layer).
 */
export interface ChannelIndexConfig {
  readonly self: string
  readonly peer: string
  readonly gen: number
}

export interface ChannelWriteArgs {
  readonly partition: Partition
  readonly callRef: string
  /**
   * The body to store, encoded as a JSON string. Caller is responsible
   * for embedding any per-call metadata (e.g. `gen` field) into the
   * payload — `ChannelIndex` does not parse or rewrite the body.
   */
  readonly bodyValue: string
  readonly bodyTtlSec: number
  readonly indexes: ReadonlyArray<{
    readonly key: string
    readonly value: string
    readonly ttlSec: number
  }>
}

export interface ChannelTombstoneArgs {
  readonly partition: Partition
  readonly callRef: string
  readonly indexesToRemove: ReadonlyArray<string>
}

export interface ChannelIndexApi {
  /** Atomic write: body + indexes + counter+1 + ZADD U-member. */
  readonly write: (
    args: ChannelWriteArgs
  ) => Effect.Effect<{ readonly counter: number }, KvError>

  /** Atomic tombstone: body→tombstone (~3min TTL) + DEL indexes + counter+1 + ZADD D-member. */
  readonly tombstone: (
    args: ChannelTombstoneArgs
  ) => Effect.Effect<{ readonly counter: number }, KvError>

  /** Atomic pull-batch: ZRANGEBYSCORE + body MGET, one snapshot. */
  readonly pullBatch: (
    sinceScore: number,
    limit: number
  ) => Effect.Effect<ChannelPullResult, KvError>

  /** Read the channel's current counter (the head value the puller compares to). */
  readonly currentCounter: Effect.Effect<number, KvError>

  /** This worker's incarnation gen — exposed for the wire-frame layer. */
  readonly gen: number
}

/** Default tombstone body TTL — see D2. */
export const DEFAULT_TOMBSTONE_TTL_SEC = 180

export class ChannelIndex {
  static readonly channelKey = (self: string, peer: string): string =>
    `propagate:${self}->${peer}`

  static readonly counterKey = (self: string, peer: string): string =>
    `seq:${self}->${peer}`

  static readonly bodyKey = (
    partition: Partition,
    owner: string,
    callRef: string
  ): string => `${partition}:${owner}:call:${callRef}`

  static readonly ownerFor = (
    partition: Partition,
    self: string,
    peer: string
  ): string => (partition === "pri" ? self : peer)

  /**
   * Synchronous factory. Tests and supervisor wiring construct
   * `ChannelIndex` instances per (self, peer) pair on demand; there is
   * no service registration — the instance IS the API.
   */
  static readonly make = (
    config: ChannelIndexConfig,
    kv: KvBackendApi
  ): ChannelIndexApi => make(config, kv)
}

const make = (
  config: ChannelIndexConfig,
  kv: KvBackendApi
): ChannelIndexApi => {
  const channel = ChannelIndex.channelKey(config.self, config.peer)
  const counterKey = ChannelIndex.counterKey(config.self, config.peer)

  const bodyKeyOf = (partition: Partition, callRef: string): string =>
    ChannelIndex.bodyKey(
      partition,
      ChannelIndex.ownerFor(partition, config.self, config.peer),
      callRef
    )

  const tombstoneValue = encodeTombstone(config.gen)

  const write: ChannelIndexApi["write"] = (args) => {
    const bodyKey = bodyKeyOf(args.partition, args.callRef)
    return kv.channelWriteUpdate({
      channel,
      counterKey,
      member: KvBackend.memberOf("U", bodyKey),
      bodyKey,
      bodyValue: args.bodyValue,
      bodyTtlSec: args.bodyTtlSec,
      indexes: args.indexes,
    })
  }

  const tombstone: ChannelIndexApi["tombstone"] = (args) => {
    const bodyKey = bodyKeyOf(args.partition, args.callRef)
    return kv.channelWriteTombstone({
      channel,
      counterKey,
      member: KvBackend.memberOf("D", bodyKey),
      bodyKey,
      tombstoneValue,
      tombstoneTtlSec: DEFAULT_TOMBSTONE_TTL_SEC,
      indexesToRemove: args.indexesToRemove,
    })
  }

  const pullBatch: ChannelIndexApi["pullBatch"] = (sinceScore, limit) =>
    kv.channelPullBatch({ channel, counterKey, sinceScore, limit })

  const currentCounter = kv.counterRead(counterKey)

  return { write, tombstone, pullBatch, currentCounter, gen: config.gen }
}

// Pure helper outside Effect.gen so the Effect plugin's preferSchemaOverJson
// rule does not fire — the tombstone payload is opaque pass-through.
const encodeTombstone = (gen: number): string =>
  JSON.stringify({ tombstone: true, gen })
