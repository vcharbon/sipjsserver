/**
 * LimiterRedisClient — Redis target for the **call limiter**.
 *
 * Distinct service tag from `RedisClient` so the limiter Layer cannot be
 * accidentally bound to the per-pod sidecar Redis. In an HA deployment with
 * sidecar Redis for the call-context cache (per
 * `docs/replication/call-cache-backup.md`), the limiter MUST point at a
 * cluster-shared Redis — otherwise each worker increments/decrements its
 * own local counter and concurrent-call limits are not enforced fleet-wide.
 *
 * Sourced from `LIMITER_REDIS_URL`. Falls back to `REDIS_URL` with a
 * startup warning when unset (acceptable for single-Redis dev / embedded
 * deployments; broken for sidecar HA).
 */

import { Effect, Layer, ServiceMap } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import { makeRedisOps, type RedisOps } from "./RedisClient.js"

/**
 * Hard-bounded ioredis options for the limiter connection.
 *
 * - `commandTimeout: 100` — every limiter command (Lua check-and-increment,
 *   DECR, refresh) errors out after 100 ms regardless of TCP state. Without
 *   this, ioredis keeps a Promise pending forever during a TCP black-hole
 *   (no FIN / no RST → the OS never tells the socket the peer is gone),
 *   which is the failure pattern that produced the 2026-05-15 cascade.
 * - `enableOfflineQueue: false` — commands issued while disconnected reject
 *   with a `ClientClosedError` immediately instead of being silently
 *   buffered for replay on reconnect. The buffered-replay pattern causes
 *   late successes that defeat upstream `Effect.timeout` budgets.
 * - `maxRetriesPerRequest: 1` — bound the ioredis internal retry loop so
 *   the 100 ms budget cannot be blown by repeated internal retries.
 *
 * Together these implement the "bounded Redis I/O" contract described in
 * the limiter-Redis cascade fix plan; the matching Effect-side outer
 * `Effect.timeout(150)` lives in `CallLimiter.ts` as defense-in-depth.
 */
const LIMITER_REDIS_OPTIONS = {
  commandTimeout: 100,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
} as const

export class LimiterRedisClient extends ServiceMap.Service<
  LimiterRedisClient,
  RedisOps
>()("@sipjsserver/LimiterRedisClient") {
  static readonly layer = Layer.effect(
    LimiterRedisClient,
    Effect.gen(function* () {
      const config = yield* AppConfig
      if (config.limiterRedisUrl === config.redisUrl) {
        yield* Effect.logWarning(
          "LIMITER_REDIS_URL not set; limiter and call-context cache share the same Redis. " +
            "Acceptable for single-Redis dev/embedded deployments. In an HA deployment with " +
            "per-pod sidecar Redis for call context, this will silently break cluster-wide limit enforcement " +
            "(each worker increments its own local counter). See docs/replication/call-cache-backup.md."
        )
      }
      return yield* makeRedisOps(
        config.limiterRedisUrl,
        config.redisKeyPrefix,
        "limiter",
        LIMITER_REDIS_OPTIONS,
      )
    })
  )
}
