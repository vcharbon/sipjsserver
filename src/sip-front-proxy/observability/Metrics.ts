/**
 * Proxy metrics — PR6.
 *
 * Wraps Effect's built-in `Metric` module (from `effect`) to expose a small,
 * typed surface for the proxy hot-path call sites. The metric names and label
 * sets follow `docs/todos/SIP-Front-Proxy.md` PR6 spec §3.4 and the spec's
 * Prometheus naming conventions.
 *
 * Why not use `src/observability/MetricsRegistry.ts`? The proxy package's
 * ESLint `no-restricted-imports` rule (constraint #1 in the plan) bans any
 * import from `src/observability/**`. Rather than widen the allowlist or
 * relocate shared types, we wrap Effect's first-party `Metric` API — which
 * is already an allowed import (`effect`). The MetricsServer in this same
 * directory uses `Metric.snapshot` to render Prometheus exposition without
 * any cross-package coupling.
 *
 * Metric inventory:
 *
 *   sip_messages_total{direction,method_or_status,result}
 *     counter — every inbound and outbound packet the proxy handles.
 *     direction ∈ {inbound, outbound}; result ∈ {forwarded, rejected, dropped}.
 *
 *   sip_routing_duration_seconds{strategy,decision}
 *     histogram — wall time spent inside `handleRequestImpl` per inbound
 *     request, classified by the resolved decision.
 *
 *   sip_routing_decision_total{strategy,kind}
 *     counter — one tick per routing decision the core takes. `kind` covers
 *     stickiness decode outcomes plus CANCEL LRU outcomes.
 *
 *   sip_routing_hmac_failure_total{reason}
 *     counter — incremented from `LoadBalancerStrategy.decodeStickiness`
 *     when the cookie is missing, malformed, mismatched, or names an
 *     unknown kid.
 *
 *   sip_worker_health{worker_id,health}
 *     gauge — 1 for the worker's current state, 0 for the others. Updated
 *     by `HealthProbe` on every health flip.
 *
 *   sip_cancel_lookup_total{outcome}
 *     counter — `hit` / `miss` / `expired_sweep`. The first two come from
 *     `CancelBranchLru.lookup`, the last from the periodic sweep fiber.
 *
 *   sip_active_dialogs_estimate
 *     gauge — best-effort estimate. We back this off the LRU size: it's
 *     not a true dialog counter (the LRU expires entries after the CANCEL
 *     window, ~32 s), so it underestimates long-running dialogs and
 *     overestimates briefly-cancelled ones. Documented as such on the
 *     metric `description`.
 *
 * Hot-path discipline:
 *   - Every metric update is a single `Metric.update` call. No fiber
 *     suspension, no I/O.
 *   - Histogram boundaries are coarse Prometheus defaults expanded down
 *     to microseconds (proxy routing is sub-millisecond) so the p99 bucket
 *     is meaningful at AC-6's 2 ms target.
 */

import { Effect, Layer, Metric, ServiceMap } from "effect"

// ---------------------------------------------------------------------------
// Histogram boundaries
// ---------------------------------------------------------------------------

/**
 * Routing-duration buckets (seconds). Tuned for the AC-6 P99 < 2 ms SLO:
 * we want fine granularity from 50 µs through 5 ms, then coarser tails up
 * to 1 s for the unhappy path. 12 buckets keeps cardinality reasonable.
 */
const ROUTING_DURATION_BUCKETS: ReadonlyArray<number> = [
  0.000_05,
  0.000_1,
  0.000_25,
  0.000_5,
  0.001,
  0.002,
  0.005,
  0.01,
  0.025,
  0.1,
  0.5,
  1,
]

// ---------------------------------------------------------------------------
// Untagged base metrics (we attach attributes via `withAttributes`).
// ---------------------------------------------------------------------------

const baseMessages = Metric.counter("sip_messages_total", {
  description: "SIP messages handled by the front proxy.",
  incremental: true,
})

const baseRoutingDuration = Metric.histogram("sip_routing_duration_seconds", {
  description: "Time spent inside the proxy routing core, per inbound request.",
  boundaries: ROUTING_DURATION_BUCKETS,
})

const baseRoutingDecision = Metric.counter("sip_routing_decision_total", {
  description:
    "Routing decisions taken by the core: select_new / decode_forward / decode_forward_backup / decode_reject / decode_unknown / cancel_lookup_hit / cancel_lookup_miss / worker_outbound.",
  incremental: true,
})

const baseHmacFailure = Metric.counter("sip_routing_hmac_failure_total", {
  description:
    "Stickiness HMAC verification failures, broken down by reason (missing / decode / mismatch / unknown_kid).",
  incremental: true,
})

const baseWorkerHealth = Metric.gauge("sip_worker_health", {
  description:
    "Per-worker health, 1 for the current state and 0 for the others (worker_id, health labels).",
})

const baseCancelLookup = Metric.counter("sip_cancel_lookup_total", {
  description:
    "CancelBranchLru outcomes: hit / miss / expired_sweep. The first two come from lookups, the last from the sweep fiber.",
  incremental: true,
})

const activeDialogsEstimate = Metric.gauge("sip_active_dialogs_estimate", {
  description:
    "Best-effort active-dialog gauge. Approximated by the CancelBranchLru size — undercounts long-running dialogs (LRU TTL ~32 s) and overcounts briefly-cancelled ones.",
})

// ---------------------------------------------------------------------------
// Label types
// ---------------------------------------------------------------------------

export type MessageDirection = "inbound" | "outbound"
export type MessageResult = "forwarded" | "rejected" | "dropped"

/** Coarse decision class — keeps the cardinality bounded across strategies. */
export type RoutingDecisionKind =
  | "select_new"
  | "decode_forward"
  | "decode_forward_backup"
  | "decode_reject"
  | "decode_unknown"
  | "cancel_lookup_hit"
  | "cancel_lookup_miss"
  | "worker_outbound"

export type HmacFailureReason = "missing" | "decode" | "mismatch" | "unknown_kid"

export type WorkerHealthLabel = "unknown" | "alive" | "draining" | "dead"

export type CancelLookupOutcome = "hit" | "miss" | "expired_sweep"

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface ProxyMetricsApi {
  /**
   * Record one inbound or outbound message. `methodOrStatus` carries the
   * SIP method (uppercased) for requests and the numeric status code for
   * responses. We coalesce them into one label dimension to keep the
   * metric family flat.
   */
  readonly recordMessage: (opts: {
    readonly direction: MessageDirection
    readonly methodOrStatus: string
    readonly result: MessageResult
  }) => Effect.Effect<void>

  /**
   * Record one routing-duration observation.
   * `durationSeconds` is the wall-clock interval the request spent in the
   * core. The caller measures it (Effect's `Clock.currentTimeMillis` /
   * `process.hrtime.bigint()`).
   */
  readonly observeRoutingDuration: (opts: {
    readonly strategy: string
    readonly decision: RoutingDecisionKind
    readonly durationSeconds: number
  }) => Effect.Effect<void>

  /** Increment the routing-decision counter. */
  readonly recordRoutingDecision: (opts: {
    readonly strategy: string
    readonly kind: RoutingDecisionKind
  }) => Effect.Effect<void>

  /** Increment the HMAC-failure counter. */
  readonly recordHmacFailure: (
    reason: HmacFailureReason
  ) => Effect.Effect<void>

  /**
   * Set the worker-health gauges. Writes 1 for `health` and 0 for the
   * other two states so Prometheus point-in-time queries are sound.
   */
  readonly setWorkerHealth: (opts: {
    readonly workerId: string
    readonly health: WorkerHealthLabel
  }) => Effect.Effect<void>

  /** Increment the cancel-lookup outcome counter. */
  readonly recordCancelLookup: (
    outcome: CancelLookupOutcome
  ) => Effect.Effect<void>

  /** Update the active-dialogs estimate. */
  readonly setActiveDialogsEstimate: (count: number) => Effect.Effect<void>
}

export class ProxyMetrics extends ServiceMap.Service<ProxyMetrics, ProxyMetricsApi>()(
  "@sipjsserver/sip-front-proxy/ProxyMetrics"
) {
  /**
   * Default Layer. Every method is a thin call into `Metric.update` —
   * Effect's metric runtime uses a process-global `MetricRegistry`
   * `ServiceMap.Reference`, so multiple `ProxyMetrics` layer instantiations
   * still share the same underlying counters (which is what we want for
   * Prometheus exposition).
   */
  static readonly Default: Layer.Layer<ProxyMetrics> = Layer.sync(
    ProxyMetrics,
    () => buildApi()
  )
}

const HEALTH_VALUES: ReadonlyArray<WorkerHealthLabel> = ["unknown", "alive", "draining", "dead"]

function buildApi(): ProxyMetricsApi {
  const recordMessage = (opts: {
    direction: MessageDirection
    methodOrStatus: string
    result: MessageResult
  }): Effect.Effect<void> =>
    Metric.update(
      Metric.withAttributes(baseMessages, {
        direction: opts.direction,
        method_or_status: opts.methodOrStatus,
        result: opts.result,
      }),
      1
    )

  const observeRoutingDuration = (opts: {
    strategy: string
    decision: RoutingDecisionKind
    durationSeconds: number
  }): Effect.Effect<void> =>
    Metric.update(
      Metric.withAttributes(baseRoutingDuration, {
        strategy: opts.strategy,
        decision: opts.decision,
      }),
      opts.durationSeconds
    )

  const recordRoutingDecision = (opts: {
    strategy: string
    kind: RoutingDecisionKind
  }): Effect.Effect<void> =>
    Metric.update(
      Metric.withAttributes(baseRoutingDecision, {
        strategy: opts.strategy,
        kind: opts.kind,
      }),
      1
    )

  const recordHmacFailure = (reason: HmacFailureReason): Effect.Effect<void> =>
    Metric.update(
      Metric.withAttributes(baseHmacFailure, { reason }),
      1
    )

  const setWorkerHealth = (opts: {
    workerId: string
    health: WorkerHealthLabel
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      // Set 1 for the active state, 0 for the others, so Prometheus
      // queries like `sum by (health) (sip_worker_health)` are correct.
      for (const h of HEALTH_VALUES) {
        yield* Metric.update(
          Metric.withAttributes(baseWorkerHealth, {
            worker_id: opts.workerId,
            health: h,
          }),
          h === opts.health ? 1 : 0
        )
      }
    })

  const recordCancelLookup = (outcome: CancelLookupOutcome): Effect.Effect<void> =>
    Metric.update(
      Metric.withAttributes(baseCancelLookup, { outcome }),
      1
    )

  const setActiveDialogsEstimate = (count: number): Effect.Effect<void> =>
    Metric.update(activeDialogsEstimate, count)

  return {
    recordMessage,
    observeRoutingDuration,
    recordRoutingDecision,
    recordHmacFailure,
    setWorkerHealth,
    recordCancelLookup,
    setActiveDialogsEstimate,
  }
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Convenience re-export so MetricsServer (and tests) don't have to import
 * `Metric` from `effect` directly. Effect's snapshot covers EVERY metric
 * registered process-wide; the MetricsServer filters by name prefix.
 */
export const snapshot = Metric.snapshot
