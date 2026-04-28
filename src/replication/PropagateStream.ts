/**
 * PropagateStream — read API for the `propagate:{peer}` sorted set on a
 * worker's local sidecar.
 *
 * Slice 2 deliverable. Writes to the propagate set happen inside the
 * AtomicWriter Lua script (per-write fan-in into the same atomic
 * boundary). This service handles the **read side**: enumerating
 * entries above a since-seq watermark, getting the current head seq
 * (used by the long-poll `hello` frame's `head_at_open` field), and
 * the periodic GC that prunes stale (call-key-gone) entries.
 *
 * Spec: [docs/replication/call-cache-backup.md §6](../../docs/replication/call-cache-backup.md).
 *
 * Layer composition mirrors AtomicWriter:
 *   - `redisLayer` requires RedisClient.
 *   - `memoryLayerFromStore(store)` shares a MutableHashMap with
 *     AtomicWriter and PartitionedRelayStorage so tests can observe
 *     writes through this read API.
 */

import {
  Clock,
  Data,
  Effect,
  Layer,
  MutableHashMap,
  Option,
  ServiceMap,
} from "effect"
import { RedisClient } from "../redis/RedisClient.js"
import {
  AtomicWriter,
  type MemoryStore,
} from "./AtomicWriter.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export class PropagateStreamError extends Data.TaggedError(
  "PropagateStreamError"
)<{
  readonly reason: string
}> {}

/** One entry in the sorted set, returned in seq-ascending order. */
export interface PropagateEntry {
  readonly callRef: string
  readonly seq: number
}

export interface PropagateStreamApi {
  /**
   * List entries in `propagate:{peer}` whose seq is strictly greater
   * than `sinceSeq`, in ascending seq order. Bounded by `limit` if
   * supplied (default unbounded — callers are expected to bound this
   * by their own backpressure: long-poll handlers stream at most
   * `head_at_open` entries before the catch_up frame).
   */
  readonly read: (
    peer: string,
    sinceSeq: number,
    limit?: number
  ) => Effect.Effect<ReadonlyArray<PropagateEntry>, PropagateStreamError>

  /** Current head seq for `propagate:{peer}` (largest score), or 0 if empty. */
  readonly head: (
    peer: string
  ) => Effect.Effect<number, PropagateStreamError>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PropagateStream extends ServiceMap.Service<
  PropagateStream,
  PropagateStreamApi
>()("@sipjsserver/replication/PropagateStream") {
  /** Production: backed by RedisClient sorted-set commands. */
  static readonly redisLayer = Layer.effect(
    PropagateStream,
    Effect.gen(function* () {
      const redis = yield* RedisClient

      const wrapErr = (err: { reason: string }): PropagateStreamError =>
        new PropagateStreamError({ reason: err.reason })

      const read = (
        peer: string,
        sinceSeq: number,
        limit?: number
      ): Effect.Effect<ReadonlyArray<PropagateEntry>, PropagateStreamError> =>
        Effect.tryPromise({
          try: async () => {
            const key = AtomicWriter.propagateSetKey(peer)
            // ZRANGEBYSCORE with WITHSCORES, exclusive lower bound.
            const args: Array<string | number> = [
              `(${sinceSeq}`,
              "+inf",
              "WITHSCORES",
            ]
            if (limit !== undefined && limit > 0) {
              args.push("LIMIT", 0, limit)
            }
            // Use raw ioredis here so we can batch the prefix correctly;
            // the underlying call-shape is identical to redis.eval which
            // already prefixes via `pk()`. We mirror the prefix lookup
            // through a small SCAN-style helper.
            const prefix = redis.raw.options?.keyPrefix ?? ""
            const fullKey = `${prefix}${key}`
            const flat = await (redis.raw as unknown as {
              zrangebyscore: (
                k: string,
                ...rest: Array<string | number>
              ) => Promise<Array<string>>
            }).zrangebyscore(fullKey, ...args)
            const out: Array<PropagateEntry> = []
            for (let i = 0; i < flat.length; i += 2) {
              const callRef = flat[i]!
              const seq = Number(flat[i + 1])
              out.push({ callRef, seq })
            }
            return out
          },
          catch: (err) =>
            wrapErr({
              reason: err instanceof Error ? err.message : String(err),
            }),
        })

      const head = (peer: string): Effect.Effect<number, PropagateStreamError> =>
        Effect.tryPromise({
          try: async () => {
            const key = AtomicWriter.propagateSetKey(peer)
            const prefix = redis.raw.options?.keyPrefix ?? ""
            const fullKey = `${prefix}${key}`
            const result = await (redis.raw as unknown as {
              zrevrange: (
                k: string,
                start: number,
                stop: number,
                withscores: "WITHSCORES"
              ) => Promise<Array<string>>
            }).zrevrange(fullKey, 0, 0, "WITHSCORES")
            if (result.length < 2) return 0
            return Number(result[1]) || 0
          },
          catch: (err) =>
            wrapErr({
              reason: err instanceof Error ? err.message : String(err),
            }),
        })

      return { read, head }
    })
  )

  /** Tests: read directly from the shared in-memory store. */
  static readonly memoryLayerFromStore = (
    store: MemoryStore
  ): Layer.Layer<PropagateStream> =>
    Layer.sync(PropagateStream, () => makeMemoryUnsafe(store))
}

// ---------------------------------------------------------------------------
// Memory backend
// ---------------------------------------------------------------------------

const liveSet = (
  store: MemoryStore,
  peer: string,
  nowMs: number
): Record<string, number> => {
  const key = AtomicWriter.propagateSetKey(peer)
  const opt = MutableHashMap.get(store, key)
  if (Option.isNone(opt)) return {}
  if (opt.value.expiresAtMs <= nowMs) {
    MutableHashMap.remove(store, key)
    return {}
  }
  try {
    const parsed = JSON.parse(opt.value.value) as {
      entries?: Record<string, number>
    }
    if (parsed && typeof parsed === "object" && parsed.entries) {
      return parsed.entries
    }
  } catch {
    // Corrupted entry — treat as empty.
  }
  return {}
}

const makeMemoryUnsafe = (store: MemoryStore): PropagateStreamApi => {
  const read = (
    peer: string,
    sinceSeq: number,
    limit?: number
  ): Effect.Effect<ReadonlyArray<PropagateEntry>, PropagateStreamError> =>
    Effect.gen(function* () {
      const ms = yield* Clock.currentTimeMillis
      return yield* Effect.sync(() => {
        const set = liveSet(store, peer, ms)
        const all: Array<PropagateEntry> = []
        for (const [callRef, seq] of Object.entries(set)) {
          if (seq > sinceSeq) all.push({ callRef, seq })
        }
        all.sort((a, b) => a.seq - b.seq)
        if (limit !== undefined && limit > 0 && all.length > limit) {
          return all.slice(0, limit)
        }
        return all
      })
    })

  const head = (peer: string): Effect.Effect<number, PropagateStreamError> =>
    Effect.gen(function* () {
      const ms = yield* Clock.currentTimeMillis
      return yield* Effect.sync(() => {
        const set = liveSet(store, peer, ms)
        let max = 0
        for (const seq of Object.values(set)) {
          if (seq > max) max = seq
        }
        return max
      })
    })

  return { read, head }
}
