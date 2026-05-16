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
 *   sip_messages_total{direction,method_or_status,cseq_method,result}
 *     counter — every inbound and outbound packet the proxy handles.
 *     direction ∈ {inbound, outbound}; result ∈ {forwarded, rejected, dropped}.
 *     method_or_status carries the SIP method for requests and the
 *     numeric status code for responses. cseq_method carries the CSeq
 *     header method — for requests it equals method_or_status; for
 *     responses it identifies which transaction the response answers
 *     (e.g. `200`+`INVITE` vs `200`+`BYE` are functionally different).
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
 *   sip_pending_invite_lru_size
 *     gauge — size of the proxy-local pending-INVITE LRU. Each entry is
 *     a `(Call-ID, CSeq number) → (target, branch)` mapping kept so a
 *     matching CANCEL/ACK can be forwarded to the same downstream. TTL
 *     is the CANCEL window (~32 s), so this gauge has nothing to do
 *     with the cluster's dialog count — for that, see the B2BUA
 *     worker's `b2bua_active_dialogs` gauge. Published from both the
 *     INVITE-remember path (`ProxyCore.handleRequest`) and the sweep
 *     fiber (`CancelBranchLru`); the latter is what keeps the gauge
 *     decreasing after traffic stops.
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

/**
 * Slice E2: counts cookies whose `decode_forward` was promoted to
 * `decode_forward_backup` because the named primary was not-routable —
 * either `not-ready` (worker still draining boot replication) or absent
 * via the Slice E3 stale-pod guard (`unobserved-fresh-pod`). Without
 * this counter the promotion is invisible to operators (the cookie is
 * valid, the ordinal exists, the pod is Running — nothing else fires).
 */
const baseDecodeForwardPromoted = Metric.counter(
  "sipfp_decode_forward_promoted_total",
  {
    description:
      "Stickiness decisions promoted from decode_forward to decode_forward_backup because the cookie's primary was not-routable (from=not-ready / unobserved-fresh-pod).",
    incremental: true,
  }
)

/**
 * Counts every `decode_forward` to a primary whose `firstSeenAtMs` is
 * still inside the early-life window — bucketed by the pod's age in
 * seconds. The 0–20 s bucket should always be **zero** when the Slice
 * E3 fresh-pod guard is configured to ≥ 20 s; non-zero values there
 * mean a request slipped through the guard. The 20–60 s bucket
 * captures requests that the guard explicitly admitted; correlate
 * with downstream 481 spikes to decide whether the guard is too
 * permissive. See LoadBalancer.ts and
 * docs/plan/2026-05-14-post-proxy-graceful-481-wave-investigation.md §6.4.4.
 */
const baseFreshPodForward = Metric.counter(
  "sipfp_routing_fresh_pod_forward_total",
  {
    description:
      "decode_forward decisions targeting a primary whose age since the proxy first observed it is in the named bucket (age_bucket=0-20s/20-60s/60-300s/gte300s). Non-zero in the 0-20s bucket indicates the freshPodGuard window slipped a request through.",
    incremental: true,
  }
)

const baseCancelLookup = Metric.counter("sip_cancel_lookup_total", {
  description:
    "CancelBranchLru outcomes: hit / miss / expired_sweep. The first two come from lookups, the last from the sweep fiber.",
  incremental: true,
})

const pendingInviteLruSize = Metric.gauge("sip_pending_invite_lru_size", {
  description:
    "Size of the proxy's pending-INVITE LRU — `(Call-ID, CSeq number) → (target, branch)` entries kept until the CANCEL window (~32 s) elapses. NOT a dialog count; see the worker's `b2bua_active_dialogs` for the dialog gauge.",
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
  | "loose_route"

export type HmacFailureReason = "missing" | "decode" | "mismatch" | "unknown_kid"

export type WorkerHealthLabel =
  | "unknown"
  | "alive"
  | "not-ready"
  | "draining"
  | "dead"

export type CancelLookupOutcome = "hit" | "miss" | "expired_sweep"

/**
 * Reason that drove the proxy to promote a `decode_forward` to
 * `decode_forward_backup`. Kept as a closed union so a future reason can't
 * silently appear in dashboards.
 *
 *   - `not-ready`              — primary's OPTIONS reply was
 *                                `503 + Reason: not-ready (boot drain)`.
 *   - `unobserved-fresh-pod`   — Slice E3: primary is in the registry but
 *                                we haven't yet observed any positive
 *                                Ready signal from it (informer race).
 */
export type DecodeForwardPromotionReason =
  | "not-ready"
  | "unobserved-fresh-pod"

/**
 * Age bucket for `recordFreshPodForward`. Bounded to four buckets so
 * scrape cardinality stays trivial. The 0-20s bucket should never be
 * non-zero in production; 20-60s is the early-life window the guard
 * lets through; 60-300s is "first 5 min of pod life"; gte300s means
 * "pod has been around long enough that this is a normal forward".
 */
export type FreshPodAgeBucket = "0-20s" | "20-60s" | "60-300s" | "gte300s"

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface ProxyMetricsApi {
  /**
   * Record one inbound or outbound message. `methodOrStatus` carries the
   * SIP method (uppercased) for requests and the numeric status code for
   * responses. `cseqMethod` is the CSeq header method — for requests it
   * equals `methodOrStatus`; for responses it identifies the request
   * method the response is answering (so `200`+`INVITE` and `200`+`BYE`
   * resolve as distinct time series).
   */
  readonly recordMessage: (opts: {
    readonly direction: MessageDirection
    readonly methodOrStatus: string
    readonly cseqMethod: string
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

  /**
   * Slice E2: increment `sipfp_decode_forward_promoted_total{from=…}` when
   * a cookie's primary forced a promotion to `decode_forward_backup`.
   */
  readonly recordDecodeForwardPromoted: (
    from: DecodeForwardPromotionReason
  ) => Effect.Effect<void>

  /**
   * Increment `sipfp_routing_fresh_pod_forward_total{age_bucket=…}` when a
   * `decode_forward` lands on a primary inside the named age bucket. Always
   * incremented (regardless of bucket) so dashboards can compute a ratio of
   * fresh-pod forwards over all forwards.
   */
  readonly recordFreshPodForward: (
    bucket: FreshPodAgeBucket,
  ) => Effect.Effect<void>

  /** Publish the current size of the pending-INVITE LRU. */
  readonly setPendingInviteLruSize: (count: number) => Effect.Effect<void>
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

const HEALTH_VALUES: ReadonlyArray<WorkerHealthLabel> = [
  "unknown",
  "alive",
  "not-ready",
  "draining",
  "dead",
]

function buildApi(): ProxyMetricsApi {
  const recordMessage = (opts: {
    direction: MessageDirection
    methodOrStatus: string
    cseqMethod: string
    result: MessageResult
  }): Effect.Effect<void> =>
    Metric.update(
      Metric.withAttributes(baseMessages, {
        direction: opts.direction,
        method_or_status: opts.methodOrStatus,
        cseq_method: opts.cseqMethod,
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

  const recordDecodeForwardPromoted = (
    from: DecodeForwardPromotionReason
  ): Effect.Effect<void> =>
    Metric.update(
      Metric.withAttributes(baseDecodeForwardPromoted, { from }),
      1
    )

  const recordFreshPodForward = (
    bucket: FreshPodAgeBucket,
  ): Effect.Effect<void> =>
    Metric.update(
      Metric.withAttributes(baseFreshPodForward, { age_bucket: bucket }),
      1,
    )

  const setPendingInviteLruSize = (count: number): Effect.Effect<void> =>
    Metric.update(pendingInviteLruSize, count)

  return {
    recordMessage,
    observeRoutingDuration,
    recordRoutingDecision,
    recordHmacFailure,
    setWorkerHealth,
    recordCancelLookup,
    recordDecodeForwardPromoted,
    recordFreshPodForward,
    setPendingInviteLruSize,
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
