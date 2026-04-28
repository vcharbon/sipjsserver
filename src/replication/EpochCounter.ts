/**
 * EpochCounter — bumps the worker incarnation counter exactly once on
 * process boot, then hands out the current value to anyone who needs it.
 *
 * Slice 2 deliverable. Spec:
 * [docs/replication/call-cache-backup.md §8.1](../../docs/replication/call-cache-backup.md).
 *
 * Why a separate service
 * ----------------------
 * The Lua atomic-write script reads `epoch:{owner}` on every write to
 * stamp `_repl.writerEpoch`. We need *some* point in the worker's
 * lifecycle that performs the `INCR epoch:{owner}` so subsequent writes
 * see a fresh value. EpochCounter encapsulates that boot-time bump and
 * exposes the current epoch for the read side (long-poll consumers
 * comparing their stored epoch against the one in the `hello` frame).
 *
 * Memory layer is meant for tests that need to simulate worker reboots:
 * tearing down and rebuilding the layer increments the in-memory counter
 * stored in the shared MemoryStore, exactly as the Lua script does on
 * Redis. Multiple "boots" are observable in test scenarios.
 */

import { Clock, Data, Effect, Layer, MutableHashMap, Option, ServiceMap } from "effect"
import { RedisClient } from "../redis/RedisClient.js"
import {
  AtomicWriter,
  type MemoryStore,
} from "./AtomicWriter.js"

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EpochCounterError extends Data.TaggedError("EpochCounterError")<{
  readonly reason: string
}> {}

export interface EpochCounterApi {
  /**
   * The epoch this worker incarnation booted with. Cached at layer
   * construction; never changes within the process lifetime.
   */
  readonly current: Effect.Effect<number, EpochCounterError>

  /**
   * The owner ordinal this counter is bumped against (the `epoch:{owner}`
   * key suffix). Exposed so the long-poll `hello` frame can label its
   * epoch with the correct owner without pulling in AppConfig.
   */
  readonly owner: string
}

export class EpochCounter extends ServiceMap.Service<
  EpochCounter,
  EpochCounterApi
>()("@sipjsserver/replication/EpochCounter") {
  /**
   * Production: INCRs `epoch:{owner}` once on layer creation. Caches
   * the result; subsequent `current` reads are pure.
   */
  static readonly redisLayer = (
    owner: string
  ): Layer.Layer<EpochCounter, EpochCounterError, RedisClient> =>
    Layer.effect(
      EpochCounter,
      Effect.gen(function* () {
        const redis = yield* RedisClient
        const newEpoch = yield* redis.incr(AtomicWriter.epochKey(owner)).pipe(
          Effect.mapError(
            (e) => new EpochCounterError({ reason: e.reason })
          )
        )
        yield* Effect.logInfo(
          `EpochCounter: bumped epoch:${owner} → ${newEpoch}`
        )
        return {
          current: Effect.succeed(newEpoch),
          owner,
        }
      })
    )

  /**
   * Tests: bumps the in-memory `epoch:{owner}` entry stored in the
   * supplied MemoryStore. Each layer build = one simulated worker boot.
   */
  static readonly memoryLayerFromStore = (
    store: MemoryStore,
    owner: string
  ): Layer.Layer<EpochCounter> =>
    Layer.effect(
      EpochCounter,
      Effect.gen(function* () {
        const ms = yield* Clock.currentTimeMillis
        const newEpoch = yield* Effect.sync(() => bumpMemoryEpoch(store, owner, ms))
        return {
          current: Effect.succeed(newEpoch),
          owner,
        }
      })
    )
}

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

const bumpMemoryEpoch = (
  store: MemoryStore,
  owner: string,
  _nowMs: number
): number => {
  const key = AtomicWriter.epochKey(owner)
  const opt = MutableHashMap.get(store, key)
  const prev = Option.isSome(opt) ? Number(opt.value.value) : 0
  const next = Number.isFinite(prev) && prev > 0 ? prev + 1 : 1
  MutableHashMap.set(store, key, {
    value: String(next),
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  })
  return next
}
