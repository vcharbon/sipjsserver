/**
 * CallLimiter service — windowed concurrent call counters.
 *
 * Two impl shapes live in sibling modules:
 *   - `CallLimiter.memory.ts` — `MutableHashMap`-backed; deterministic
 *     under `TestClock`. Two layers: `memoryLayer` (per-instance) and
 *     `sharedMemoryLayer(store)` (cluster-shared across simulated
 *     workers in fake-stack tests).
 *   - `CallLimiter.redis.ts`  — atomic Lua scripts over `LimiterRedisClient`,
 *     used in live tests and production.
 *
 * This file declares only the Tag class + thin static layer
 * re-exports. All implementation logic lives in the sibling modules so
 * the contracts wrapper (`CallLimiter.contracts.ts`) can compose without
 * pulling impl code into the Tag definition.
 *
 * The static layer fields delegate via `Layer.suspend` inside each
 * impl module so the `Layer.effect(CallLimiter, ...)` call doesn't
 * capture the Tag before this class's static initialiser runs.
 *
 * ADR-0004 ("Strong INCR ↔ DECR invariant") is the canonical contract:
 * every successful `checkAndIncrement` must be matched by exactly one
 * `decrement`. The scope-close audit in `CallLimiter.contracts.ts`
 * enforces this structurally — sum of `+1`/`-1` per `(limiterId,
 * originWindow)` net deltas must reconcile.
 */

import { Effect, Layer, Schema, ServiceMap } from "effect"
import * as memoryImpl from "./CallLimiter.memory.js"
import * as redisImpl from "./CallLimiter.redis.js"
import type { LimiterRedisClient } from "../redis/LimiterRedisClient.js"
import type { MetricsRegistry } from "../observability/MetricsRegistry.js"
import type { RedisError } from "../redis/RedisClient.js"
import type { AppConfig } from "../config/AppConfig.js"
import type { Recorder } from "../test-harness/framework/report-recorder/Recorder.js"

// ---------------------------------------------------------------------------
// Service-level types: typed decision + typed backend error
// ---------------------------------------------------------------------------

/**
 * Typed admission decision returned by `checkAndIncrement` on a healthy
 * limiter. `Rejected` is a success-channel outcome (the caller sends
 * 486/failover) — only the absence of a decision lives in the error
 * channel.
 */
export type LimiterDecision =
  | { readonly _tag: "Allowed"; readonly currentWindow: number }
  | { readonly _tag: "Rejected" }

/**
 * Typed backend failure for `checkAndIncrement`. Caller is expected to
 * `catchTag` both arms and synthesize an "admit-no-tag" admission that
 * skips the matching `DECR` on cleanup.
 */
export class LimiterTimeout extends Schema.TaggedErrorClass<LimiterTimeout>()(
  "LimiterTimeout",
  { budgetMs: Schema.Int },
) {}

export type LimiterBackendError = RedisError | LimiterTimeout

// ---------------------------------------------------------------------------
// Re-export memory store helpers from the memory impl module
// ---------------------------------------------------------------------------

export type { LimiterMemoryEntry, LimiterMemoryStore } from "./CallLimiter.memory.js"
export { makeLimiterMemoryStore } from "./CallLimiter.memory.js"

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CallLimiter extends ServiceMap.Service<
  CallLimiter,
  {
    /**
     * Atomic check-and-increment, bounded to a wall-clock budget on the
     * Redis impl.
     *
     * - Success channel: `LimiterDecision` — `Allowed` or `Rejected`.
     *   Both are normal outcomes (`Rejected` means cap hit; caller sends
     *   486 / tries failover).
     * - Error channel: `RedisError` (ioredis surfaced an error within
     *   the commandTimeout) or `LimiterTimeout` (outer Effect-level
     *   safety net fired). The caller is expected to `catchTags` both
     *   arms and synthesize a fail-open admission with
     *   `incrementSucceeded: false`.
     */
    readonly checkAndIncrement: (
      limiterId: string,
      limit: number,
    ) => Effect.Effect<LimiterDecision, LimiterBackendError>
    /** Decrement the counter for a call that used the given origin window. */
    readonly decrement: (
      limiterId: string,
      originWindow: number,
    ) => Effect.Effect<void, RedisError>
    /** Refresh: migrate count from origin window to current window. */
    readonly refresh: (
      limiterId: string,
      originWindow: number,
    ) => Effect.Effect<number, RedisError>
    /** Compute the current window timestamp (rounded). */
    readonly currentWindow: Effect.Effect<number>
  }
>()("@sipjsserver/CallLimiter") {
  /** Per-instance memory layer — see `./CallLimiter.memory.ts`. */
  static readonly memoryLayer: Layer.Layer<CallLimiter, never, AppConfig> = memoryImpl.memoryLayer

  /**
   * Shared-store memory layer — see `./CallLimiter.memory.ts`. Pass a
   * `MutableHashMap` (from `makeLimiterMemoryStore()`) shared across
   * every simulated worker in a multi-worker SUT.
   */
  static readonly sharedMemoryLayer = (
    store: memoryImpl.LimiterMemoryStore,
  ): Layer.Layer<CallLimiter, never, AppConfig> => memoryImpl.sharedMemoryLayer(store)

  /** Redis-backed implementation — see `./CallLimiter.redis.ts`. */
  static readonly redisLayer: Layer.Layer<
    CallLimiter,
    never,
    AppConfig | LimiterRedisClient | MetricsRegistry
  > = redisImpl.redisLayer

  /**
   * Parity wrapper — compares memory vs redis on every Effect-returning
   * method. Bolted on at runtime by `./CallLimiter.contracts.ts`'s
   * side-effect Object.assign (mirrors the `CallBodyCodec.parity`
   * shape). Consumers that call this MUST import the contracts module
   * first (the `testLayers` bundle does, transitively).
   *
   * Declared on the class so TS knows the call shape; the
   * implementation is wired in `CallLimiter.contracts.ts`.
   */
  static parity: (
    blue: Layer.Layer<CallLimiter>,
    green: Layer.Layer<CallLimiter>,
    options?: { readonly returnSide?: "blue" | "green" },
  ) => Layer.Layer<CallLimiter, never, Recorder> = (() => {
    // Stub thrown at call time if contracts module wasn't imported. Real
    // impl assigned by `Object.assign(CallLimiter, { parity })` at the
    // bottom of CallLimiter.contracts.ts.
    return (() => {
      throw new Error(
        "CallLimiter.parity: contracts module not loaded — import 'src/call/CallLimiter.contracts.js' first",
      )
    }) as never
  })()
}
