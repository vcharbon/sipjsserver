/**
 * PropagateZsetSizeScanner — periodic SCAN + ZCARD over
 * `propagate:{self}->{peer}:gen:*` keys in the local sidecar.
 *
 * The propagate ZSETs are the cross-worker replication channels: every
 * call mutation ZADDs a member here, and the peer's ReplPuller drains
 * it via long-poll. When a peer is dead the puller stops draining and
 * the ZSETs grow in local sidecar memory — bounded only by sidecar
 * maxmemory.
 *
 * This scanner is observation-only. It surfaces per-peer ZSET sizes so
 * operators can see replication backlog accumulating during a peer
 * outage. No enforcement — peer death must not throttle admission
 * (HA contract); the surviving worker keeps serving and the local
 * sidecar absorbs the propagate backlog until peer recovery (full
 * re-sync via PeerScanBootstrap).
 *
 * Errors are logged at WARN and the previous snapshot is kept — a
 * single failed scan never zeros the gauge.
 */

import { Clock, Data, Effect, MutableRef, Result, Scope } from "effect"
import type { MetricsRegistryState, PropagateZsetMetrics } from "./MetricsRegistry.js"
import type { RedisOps } from "../redis/RedisClient.js"

const DEFAULT_INTERVAL_MS = 30_000
const SCAN_BATCH = 500

class PropagateScanError extends Data.TaggedError("PropagateScanError")<{
  readonly message: string
}> {}

interface Snapshot {
  readonly sizesByPeer: Record<string, number>
  readonly lastScanTimestampMs: number
}

const EMPTY_SNAPSHOT: Snapshot = {
  sizesByPeer: {},
  lastScanTimestampMs: 0,
}

/** Walk `pattern` against the prefixed keyspace, returning keys without prefix. */
const scanAll = (
  redis: RedisOps,
  pattern: string,
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    const prefixWithColon = (redis.raw as { options?: { keyPrefix?: string } }).options?.keyPrefix ?? ""
    const fullPattern = `${prefixWithColon}${pattern}`
    const out: string[] = []
    let cursor = "0"
    do {
      const result = yield* Effect.result(
        Effect.tryPromise({
          try: () => redis.raw.scan(cursor, "MATCH", fullPattern, "COUNT", SCAN_BATCH),
          catch: (err) =>
            new PropagateScanError({
              message: err instanceof Error ? err.message : String(err),
            }),
        }),
      )
      if (Result.isFailure(result)) {
        yield* Effect.logWarning(
          `PropagateZsetSizeScanner: SCAN failed for pattern=${pattern}: ${result.failure.message}`,
        )
        return out
      }
      const [nextCursor, batch] = result.success as [string, ReadonlyArray<string>]
      for (const fullKey of batch) {
        out.push(
          prefixWithColon.length > 0 && fullKey.startsWith(prefixWithColon)
            ? fullKey.slice(prefixWithColon.length)
            : fullKey,
        )
      }
      cursor = nextCursor
      yield* Effect.yieldNow
    } while (cursor !== "0")
    return out
  })

/**
 * Extract the `{self}->{peer}` label from a bucket key.
 * Key shape: `propagate:{self}->{peer}:gen:{n}`
 */
const parsePeerLabel = (key: string): string | undefined => {
  const head = "propagate:"
  if (!key.startsWith(head)) return undefined
  const rest = key.slice(head.length)
  const genIdx = rest.indexOf(":gen:")
  return genIdx < 0 ? undefined : rest.slice(0, genIdx)
}

const zcard = (redis: RedisOps, key: string): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () => redis.raw.zcard(key),
        catch: (err) =>
          new PropagateScanError({
            message: err instanceof Error ? err.message : String(err),
          }),
      }),
    )
    if (Result.isFailure(result)) {
      yield* Effect.logWarning(
        `PropagateZsetSizeScanner: ZCARD failed for ${key}: ${result.failure.message}`,
      )
      return 0
    }
    return typeof result.success === "number" ? result.success : 0
  })

const refreshSnapshot = (
  redis: RedisOps,
  self: string,
): Effect.Effect<Snapshot, never> =>
  Effect.gen(function* () {
    const bucketKeys = yield* scanAll(redis, `propagate:${self}->*:gen:*`)
    const sizesByPeer: Record<string, number> = {}
    for (const key of bucketKeys) {
      const peerLabel = parsePeerLabel(key)
      if (peerLabel === undefined) continue
      const size = yield* zcard(redis, key)
      sizesByPeer[peerLabel] = (sizesByPeer[peerLabel] ?? 0) + size
      yield* Effect.yieldNow
    }
    const nowMs = yield* Clock.currentTimeMillis
    return { sizesByPeer, lastScanTimestampMs: nowMs }
  })

/**
 * Build the scanner API + the periodic refresh fiber. The fiber is
 * scope-bound — torn down on scope close.
 */
export const runPropagateZsetSizeScanner = (opts: {
  readonly redis: RedisOps
  readonly self: string
  readonly registry: MetricsRegistryState
  readonly intervalMs?: number
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    const ref = MutableRef.make<Snapshot>(EMPTY_SNAPSHOT)

    const api: PropagateZsetMetrics = {
      sizesByPeer: () => MutableRef.get(ref).sizesByPeer,
      lastScanTimestampMs: () => MutableRef.get(ref).lastScanTimestampMs,
    }
    opts.registry.propagateZset = api

    const tick = Effect.gen(function* () {
      const snap = yield* refreshSnapshot(opts.redis, opts.self)
      MutableRef.set(ref, snap)
    })

    yield* tick

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep(`${intervalMs} millis`)
          yield* tick
        }),
      ),
    )
  })
