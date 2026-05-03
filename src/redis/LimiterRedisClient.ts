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
      return yield* makeRedisOps(config.limiterRedisUrl, config.redisKeyPrefix, "limiter")
    })
  )
}
