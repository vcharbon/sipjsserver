/**
 * EpochCounter — produces the worker incarnation `gen` value used as
 * the high-order key of every replication tuple `(gen, counter)`.
 *
 * Two generations of API live side-by-side until Slice 7 cutover:
 *
 * 1. **Legacy** (`redisLayer`, `memoryLayerFromStore`) — Slice 2's
 *    INCR-the-Redis-key-on-boot mechanism. Caller reads `current`
 *    Effect-style. Consumed by `ReplLog`, `ReplMetrics`, and `main.ts`'s
 *    boot wiring; all three are slated for deletion in Slice 7.
 *
 * 2. **Redesign** (`fromKubernetesDownwardAPI`, `fromWallClock`,
 *    `fixedForTesting`) — Slice 6 mechanism. `gen` is computed once at
 *    process boot from a packed `(restartCount, UnixMillisAtBoot)` tuple
 *    and exposed as a synchronous `gen` field on the service value
 *    (no Effect wrapper). Survives sidecar Redis wipes — `restartCount`
 *    lives in the K8s API server, not in the local sidecar.
 *
 *    Bit layout (per design doc §D4):
 *      gen = (restartCount * 2^48) + (UnixMillisAtBoot & (2^48 - 1))
 *
 *    `2^48` is well within JS Number.MAX_SAFE_INTEGER (`2^53`); even at
 *    one restart per second this gives ~9e3 restarts before risking
 *    precision. UnixMillisAtBoot is taken modulo 2^48 (~8919 years)
 *    which is effectively unbounded.
 *
 *    The `current` Effect is preserved for shape compatibility with the
 *    legacy API; it just succeeds with the cached `gen`.
 *
 * Reference: [docs/plan/grill-me-on-the-spicy-lark.md](../../docs/plan/grill-me-on-the-spicy-lark.md) §D4.
 */

import { Clock, Data, Effect, Layer, ServiceMap } from "effect"

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EpochCounterError extends Data.TaggedError("EpochCounterError")<{
  readonly reason: string
}> {}

export interface EpochCounterApi {
  /**
   * The epoch / gen this worker incarnation booted with. Cached at
   * layer construction; never changes within the process lifetime.
   *
   * Effect-shaped for backward compat with legacy callers; new code
   * should prefer `gen` (synchronous value).
   */
  readonly current: Effect.Effect<number, EpochCounterError>

  /**
   * Synchronous gen value — the (gen, counter) high-order key used by
   * the redesigned replication protocol. Identical to the cached value
   * `current` resolves to; new code uses this field directly to avoid
   * the Effect indirection. Constant for the process lifetime.
   */
  readonly gen: number

  /**
   * The owner ordinal this counter is bumped against (the `epoch:{owner}`
   * key suffix). Exposed so the long-poll `hello` frame can label its
   * epoch with the correct owner without pulling in AppConfig.
   */
  readonly owner: string
}

// ---------------------------------------------------------------------------
// Gen packing helpers (Slice 6 redesign)
// ---------------------------------------------------------------------------

/**
 * 2^48 — the multiplier separating the `restartCount` high bits from
 * the `UnixMillisAtBoot` low bits in the packed gen value. Picked so
 * the low 48 bits comfortably hold a Unix-millis timestamp (good for
 * ~8919 years past 1970) and the high bits leave headroom for many
 * restarts before approaching `Number.MAX_SAFE_INTEGER`.
 */
export const GEN_RESTART_MULTIPLIER = 281_474_976_710_656 // 2^48

/**
 * Pack (restartCount, unixMillisAtBoot) into a single monotonic gen.
 *
 * Properties:
 *   - Higher `restartCount` → strictly higher gen, regardless of millis.
 *   - Same `restartCount`, later `unixMillisAtBoot` → higher gen.
 *   - `restartCount === 0` (cold pod, no prior restarts) still produces
 *     a unique gen via the millis tie-breaker.
 *
 * Negative inputs are clamped to 0 — the caller is responsible for
 * handling parse errors before reaching this helper, but the clamp
 * keeps the function total.
 */
export const packGen = (
  restartCount: number,
  unixMillisAtBoot: number
): number => {
  const rc = Number.isFinite(restartCount) && restartCount > 0
    ? Math.floor(restartCount)
    : 0
  const ms = Number.isFinite(unixMillisAtBoot) && unixMillisAtBoot > 0
    ? Math.floor(unixMillisAtBoot)
    : 0
  // Take ms mod 2^48 via (ms - floor(ms / 2^48) * 2^48) — JS bitwise is
  // 32-bit so we can't use & directly here.
  const masked = ms - Math.floor(ms / GEN_RESTART_MULTIPLIER) * GEN_RESTART_MULTIPLIER
  return rc * GEN_RESTART_MULTIPLIER + masked
}

/**
 * Inverse of `packGen` — extract the `(restartCount, unixMillisAtBoot)`
 * components for diagnostics / tests. The millis is the low 48 bits;
 * the restart count is the integer quotient by 2^48.
 */
export const unpackGen = (
  gen: number
): { readonly restartCount: number; readonly unixMillisAtBoot: number } => ({
  restartCount: Math.floor(gen / GEN_RESTART_MULTIPLIER),
  unixMillisAtBoot:
    gen - Math.floor(gen / GEN_RESTART_MULTIPLIER) * GEN_RESTART_MULTIPLIER,
})

/**
 * Env vars consulted by `fromKubernetesDownwardAPI`. The Helm chart
 * wires `RESTART_COUNT` from a sidecar/init-container that reads the
 * pod's `status.containerStatuses[*].restartCount` via the K8s API
 * (the downward API's `fieldRef` does not expose container-level
 * `restartCount` directly — it has to be read by an init step that
 * writes it to an env file).
 *
 * Open per design doc: the exact mechanism (init container vs
 * sidecar) is finalized in the helm chart change shipping with this
 * slice; the EpochCounter only requires the env var to exist.
 */
export const ENV_RESTART_COUNT = "RESTART_COUNT"

export class EpochCounter extends ServiceMap.Service<
  EpochCounter,
  EpochCounterApi
>()("@sipjsserver/replication/EpochCounter") {
  /**
   * Production for the redesign: reads `restartCount` from the env var
   * `RESTART_COUNT` (populated by the Helm chart's init step that
   * queries the K8s API) and packs it with `Date.now()` at boot time.
   *
   * If `RESTART_COUNT` is absent or malformed, falls back to
   * wall-clock-only and emits a WARN log. This keeps non-K8s envs
   * (kind / dev) working without configuration.
   */
  static readonly fromKubernetesDownwardAPI = (
    owner: string
  ): Layer.Layer<EpochCounter> =>
    Layer.effect(
      EpochCounter,
      Effect.gen(function* () {
        const ms = yield* Clock.currentTimeMillis
        const raw = process.env[ENV_RESTART_COUNT]
        let restartCount: number
        if (raw === undefined || raw === "") {
          yield* Effect.logWarning(
            `EpochCounter: ${ENV_RESTART_COUNT} env var unavailable — falling back to wall-clock-only gen for owner=${owner}`
          )
          restartCount = 0
        } else {
          const parsed = Number(raw)
          if (!Number.isFinite(parsed) || parsed < 0) {
            yield* Effect.logWarning(
              `EpochCounter: ${ENV_RESTART_COUNT}="${raw}" is not a non-negative integer — falling back to 0 for owner=${owner}`
            )
            restartCount = 0
          } else {
            restartCount = Math.floor(parsed)
          }
        }
        const gen = packGen(restartCount, ms)
        yield* Effect.logInfo(
          `EpochCounter: owner=${owner} restartCount=${restartCount} unixMillisAtBoot=${ms} gen=${gen}`
        )
        return {
          current: Effect.succeed(gen),
          gen,
          owner,
        }
      })
    )

  /**
   * Dev / kind / non-K8s: gen derives from `Date.now()` only. No env
   * var consulted. Two restarts within the same millisecond produce
   * the same gen — acceptable in dev because the fake stack uses
   * `fixedForTesting` instead, and a real-millis collision in prod
   * is functionally impossible.
   */
  static readonly fromWallClock = (
    owner: string
  ): Layer.Layer<EpochCounter> =>
    Layer.effect(
      EpochCounter,
      Effect.gen(function* () {
        const ms = yield* Clock.currentTimeMillis
        const gen = packGen(0, ms)
        return {
          current: Effect.succeed(gen),
          gen,
          owner,
        }
      })
    )

  /**
   * Tests: inject a known gen value. Lets a test scenario simulate
   * "pod restart with restartCount=N" by tearing down the layer and
   * rebuilding it with a higher fixed value.
   */
  static readonly fixedForTesting = (
    gen: number,
    owner: string
  ): Layer.Layer<EpochCounter> =>
    Layer.succeed(EpochCounter, {
      current: Effect.succeed(gen),
      gen,
      owner,
    })
}

