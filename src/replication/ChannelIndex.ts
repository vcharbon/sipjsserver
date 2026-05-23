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
  /**
   * Per Story 7d: the bucket this entry goes into. PRS originating
   * writes pass `config.gen` (the worker's incarnation gen); the
   * puller's apply path passes `0` (mirror sentinel). Lex-ordering
   * on `(entryGen, counter)` is the cycle-break.
   */
  readonly entryGen: number
  readonly partition: Partition
  readonly callRef: string
  /**
   * The body to store as raw bytes (msgpack-encoded by `CallCodec.mpPack`
   * on the originating write path). Caller is responsible for embedding
   * any per-call metadata (e.g. `_topology.gen`) into the encoded body —
   * `ChannelIndex` does not parse or rewrite it.
   */
  readonly bodyValue: Buffer
  readonly bodyTtlSec: number
  /**
   * Per-call content version — `_topology.gen` at flush time. Stored
   * in the body's `:gen` sidecar so peers can gate apply without
   * decoding the body. Forwarded into `KvBackend.channelWriteUpdate`.
   */
  readonly callGen: number
  readonly indexes: ReadonlyArray<{
    readonly key: string
    readonly value: string
    readonly ttlSec: number
  }>
}

export interface ChannelTombstoneArgs {
  /** Same semantics as `ChannelWriteArgs.entryGen`. */
  readonly entryGen: number
  readonly partition: Partition
  readonly callRef: string
  readonly indexesToRemove: ReadonlyArray<string>
}

export interface ChannelIndexApi {
  /**
   * Atomic write into the `(channel, entryGen)` bucket: body + indexes
   * + bucket counter+1 + ZADD U-member into the bucket-scoped sorted
   * set. Re-writing the same `member` within the same bucket replaces
   * its score (sorted-set semantics).
   */
  readonly write: (
    args: ChannelWriteArgs
  ) => Effect.Effect<{ readonly counter: number }, KvError>

  /**
   * Atomic tombstone in the `(channel, entryGen)` bucket: hard-DEL
   * body + DEL indexes + bucket counter+1 + ZADD D-member. The wire
   * signal of "this call was deleted" is the D-member alone — pullers
   * fetching the D-member's body see `null` (mapped to `op="delete"`
   * in `EchoApply`).
   */
  readonly tombstone: (
    args: ChannelTombstoneArgs
  ) => Effect.Effect<{ readonly counter: number }, KvError>

  /** Atomic pull-batch across all buckets, lex-ordered on `(entryGen, counter)`. */
  readonly pullBatch: (
    since: { readonly gen: number; readonly counter: number },
    limit: number
  ) => Effect.Effect<ChannelPullResult, KvError>

  /** This worker's incarnation gen — used by callers as the originating `entryGen`. */
  readonly gen: number
}

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

  const write: ChannelIndexApi["write"] = (args) => {
    const bodyKey = bodyKeyOf(args.partition, args.callRef)
    return kv.channelWriteUpdate({
      channel,
      counterKey,
      entryGen: args.entryGen,
      member: KvBackend.memberOf("U", bodyKey),
      bodyKey,
      bodyValue: args.bodyValue,
      bodyTtlSec: args.bodyTtlSec,
      callGen: args.callGen,
      indexes: args.indexes,
    })
  }

  const tombstone: ChannelIndexApi["tombstone"] = (args) => {
    const bodyKey = bodyKeyOf(args.partition, args.callRef)
    return kv.channelWriteTombstone({
      channel,
      counterKey,
      entryGen: args.entryGen,
      member: KvBackend.memberOf("D", bodyKey),
      bodyKey,
      indexesToRemove: args.indexesToRemove,
    })
  }

  const pullBatch: ChannelIndexApi["pullBatch"] = (since, limit) =>
    kv.channelPullBatch({ channel, counterKey, since, limit })

  return { write, tombstone, pullBatch, gen: config.gen }
}
