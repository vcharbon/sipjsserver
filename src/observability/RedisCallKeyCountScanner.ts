/**
 * RedisCallKeyCountScanner — periodic SCAN over `pri:{self}:call:*` and
 * `bak:*:call:*` to surface the per-partition call-key counts as
 * Prometheus gauges. Runs on a forked scope-bound fiber so the SIP
 * hot path never pays a SCAN.
 *
 * Why a periodic scan rather than write-path counters: deletions can
 * be driven by Redis TTL expiry which never notifies the writer, so a
 * write-path counter would drift. SCAN at 30 s cadence is cheap (per-pod
 * keyspace is bounded by partition size) and gives an authoritative
 * snapshot.
 *
 * Errors are logged at WARN and the previous snapshot is kept — a
 * single failed scan never zeros the gauge.
 */

import { Clock, Data, Effect, MutableRef, Result, Scope } from "effect"
import type { MetricsRegistryState, RedisCallKeyCountMetrics } from "./MetricsRegistry.js"
import type { RedisOps } from "../redis/RedisClient.js"

const DEFAULT_INTERVAL_MS = 30_000
const SCAN_BATCH = 500

class RedisScanError extends Data.TaggedError("RedisScanError")<{
  readonly message: string
}> {}

interface Snapshot {
  readonly nominalCount: number
  readonly backupCountsByPrimary: Record<string, number>
  readonly lastScanTimestampMs: number
}

const EMPTY_SNAPSHOT: Snapshot = {
  nominalCount: 0,
  backupCountsByPrimary: {},
  lastScanTimestampMs: 0,
}

/**
 * Walk `pattern` against the prefixed keyspace, returning every
 * matching key (without the global Redis key prefix). Bounded by
 * `SCAN_BATCH` per round-trip; yields between batches so a large
 * keyspace doesn't starve other Redis traffic.
 */
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
            new RedisScanError({
              message: err instanceof Error ? err.message : String(err),
            }),
        }),
      )
      if (Result.isFailure(result)) {
        yield* Effect.logWarning(
          `RedisCallKeyCountScanner: SCAN failed for pattern=${pattern}: ${result.failure.message}`,
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

const parseBackupPrimary = (key: string): string | undefined => {
  // `bak:{primary}:call:{ref}` — extract `{primary}`.
  const head = "bak:"
  if (!key.startsWith(head)) return undefined
  const rest = key.slice(head.length)
  const colon = rest.indexOf(":")
  return colon < 0 ? undefined : rest.slice(0, colon)
}

const refreshSnapshot = (
  redis: RedisOps,
  self: string,
): Effect.Effect<Snapshot, never> =>
  Effect.gen(function* () {
    const nominalKeys = yield* scanAll(redis, `pri:${self}:call:*`)
    const backupKeys = yield* scanAll(redis, `bak:*:call:*`)
    const backupCountsByPrimary: Record<string, number> = {}
    for (const k of backupKeys) {
      const primary = parseBackupPrimary(k)
      if (primary === undefined) continue
      backupCountsByPrimary[primary] = (backupCountsByPrimary[primary] ?? 0) + 1
    }
    const nowMs = yield* Clock.currentTimeMillis
    return {
      nominalCount: nominalKeys.length,
      backupCountsByPrimary,
      lastScanTimestampMs: nowMs,
    }
  })

/**
 * Build the scanner API + the periodic refresh fiber. The fiber is
 * scope-bound — torn down on scope close.
 */
export const runRedisCallKeyCountScanner = (opts: {
  readonly redis: RedisOps
  readonly self: string
  readonly registry: MetricsRegistryState
  readonly intervalMs?: number
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    const ref = MutableRef.make<Snapshot>(EMPTY_SNAPSHOT)

    const api: RedisCallKeyCountMetrics = {
      nominalCount: () => MutableRef.get(ref).nominalCount,
      backupCountsByPrimary: () => MutableRef.get(ref).backupCountsByPrimary,
      lastScanTimestampMs: () => MutableRef.get(ref).lastScanTimestampMs,
    }
    opts.registry.redisCallKeyCounts = api

    const tick = Effect.gen(function* () {
      const snap = yield* refreshSnapshot(opts.redis, opts.self)
      MutableRef.set(ref, snap)
    })

    // Prime the snapshot once before the interval kicks in so /metrics
    // returns something other than zero on the first scrape.
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
