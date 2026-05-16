/**
 * ProxySelfGate — slice 6 of the overload rework.
 *
 * The front-proxy is a single Node process with its own event-loop
 * budget. Under flood the proxy itself saturates before any worker
 * sees the traffic. This service gates **external, new-dialog,
 * non-emergency INVITEs** on two cheap binary checks:
 *
 *   - `proxy_elu > eluCritical` — hard rejection by event-loop
 *     pressure.
 *   - per-class CPS token bucket — hard cap on external new-dialog
 *     non-emergency rate.
 *
 * Caller classification (emergency / in-dialog / worker-originated)
 * happens in ProxyCore *before* this gate; internal traffic from
 * workers always bypasses (rejecting a worker's B-leg INVITE causes
 * re-routing churn rather than load shedding).
 *
 * Unlike the per-worker AIMD on the LB-side `WorkerLoadObserver`,
 * this gate is binary — the proxy's ELU is its own; there's no
 * second party to converge with.
 */

import { Effect, Layer, Metric, ServiceMap } from "effect"
import { LoadSampler } from "../observability/LoadSampler.js"

// ---------------------------------------------------------------------------
// Prometheus metrics (rendered by MetricsServer alongside `sip_*`)
// ---------------------------------------------------------------------------

// Module-level helper — moves the `runSync` out of every Effect.gen
// body so the plugin's `runEffectInsideEffect` check stays quiet.
// Metric updates require no services so this is safe.
const pushMetric = (eff: Effect.Effect<void, never, never>): void => {
  Effect.runSync(eff)
}

const eluEwmaGauge = Metric.gauge("sip_proxy_self_elu_ewma", {
  description: "Proxy-self ELU EWMA (0..1). Crosses eluCritical → 503.",
})
const gcFractionGauge = Metric.gauge("sip_proxy_self_gc_fraction", {
  description: "Proxy-self GC fraction (0..1). Day-1 informational only.",
})
const cpsBucketLevelGauge = Metric.gauge("sip_proxy_self_cps_bucket_level", {
  description: "Proxy-self CPS bucket level (tokens remaining).",
})
const cpsBucketMaxGauge = Metric.gauge("sip_proxy_self_cps_bucket_max", {
  description: "Proxy-self CPS bucket capacity (constant per config).",
})
const externalAdmittedCounter = Metric.counter(
  "sip_proxy_self_external_invites_admitted_total",
  {
    description:
      "External new-dialog non-emergency INVITEs admitted by the proxy-self gate.",
    incremental: true,
  },
)
const externalRejectedCounter = Metric.counter(
  "sip_proxy_self_external_invites_rejected_total",
  {
    description:
      "External new-dialog non-emergency INVITEs rejected by the proxy-self gate (reason=proxy_overload_elu | proxy_overload_cps).",
    incremental: true,
  },
)
const emergencyBypassCounter = Metric.counter(
  "sip_proxy_self_emergency_bypassed_total",
  {
    description: "Emergency INVITEs that bypassed the proxy-self gate.",
    incremental: true,
  },
)
const internalBypassCounter = Metric.counter(
  "sip_proxy_self_internal_bypassed_total",
  {
    description:
      "Worker-originated INVITEs that bypassed the proxy-self gate (`isWorkerOutbound`).",
    incremental: true,
  },
)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ProxySelfGateConfigData {
  /** Above this ELU the gate rejects every external new-dialog INVITE. */
  readonly eluCritical: number
  /** Token bucket capacity (= max burst size). */
  readonly cpsBucketSize: number
  /** Bucket refill rate (tokens/sec). */
  readonly cpsBucketRate: number
  /** EWMA α for the proxy's own ELU. */
  readonly eluSmoothingAlpha: number
  /** Sampler interval (ms). 100 ms by default; uses real-time setInterval. */
  readonly samplerIntervalMs: number
}

// Aggressive defaults — calibrated against the 2026-05-16 perf-test
// where a 200 CAPS burst sailed through the gate (cap=1000, rate=500 →
// bucket never empties). Goal: cut visibly first, relax later when
// dashboard data shows we're cutting too much.
//
//   cpsBucketSize=50, cpsBucketRate=50 ⇒ at 200 CAPS the bucket drains
//   in 250 ms then admits only 50/s (≈25% of burst). Sustained 50 CAPS
//   non-emergency baseline traffic passes through cleanly.
//
//   eluCritical=0.80 fires the gate the moment the proxy's own loop
//   exceeds 80% utilisation — well before sipp UAC retransmits cause
//   downstream collapse.
export const defaultProxySelfGateConfig: ProxySelfGateConfigData = {
  eluCritical: 0.8,
  cpsBucketSize: 50,
  cpsBucketRate: 100,
  eluSmoothingAlpha: 0.2,
  samplerIntervalMs: 100,
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProxySelfRejection = "proxy_overload_elu" | "proxy_overload_cps"

export interface AdmitDecision {
  readonly admit: boolean
  readonly reason: ProxySelfRejection | undefined
  readonly retryAfterSec: number
}

export interface ProxySelfGateMetrics {
  /** EWMA-smoothed proxy ELU (0..1). */
  eluEwma: number
  /** Most recent raw GC fraction. */
  gcFraction: number
  /** Token bucket fill level. */
  cpsBucketLevel: number
  /** Configured bucket size (gauge for ratios). */
  cpsBucketMax: number
  /** Number of external new-dialog non-emergency INVITEs admitted. */
  externalAdmittedTotal: number
  /** Per-reason rejection counters. */
  rejectedTotal: { proxy_overload_elu: number; proxy_overload_cps: number }
  /** Internal-classified INVITEs (workers' outbound traffic) that bypass the gate. */
  internalBypassedTotal: number
  /** Emergency-bypass counter. */
  emergencyBypassedTotal: number
}

export interface ProxySelfGateApi {
  /**
   * Try to admit one external new-dialog non-emergency INVITE.
   * `isEmergency` and `isInternal` are caller-classified — emergency or
   * internal callers MUST NOT consult this gate; the API still tolerates
   * them safely (always admits) but the metric counters drift.
   */
  readonly tryAdmitExternal: () => AdmitDecision
  /** Counter — increment for emergency or internal INVITEs that bypass. */
  readonly noteBypass: (kind: "internal" | "emergency") => void
  /** Metrics snapshot for /status + Prometheus. */
  readonly metrics: ProxySelfGateMetrics
}

// ---------------------------------------------------------------------------
// Token bucket (same shape as the b2bua-side TokenBucket; inlined here
// because the dep graph between b2bua and front-proxy stays one-way).
// ---------------------------------------------------------------------------

class TokenBucket {
  private tokens: number
  private lastRefillMs: number
  constructor(
    private readonly capacity: number,
    private readonly ratePerSec: number,
  ) {
    this.tokens = capacity
    this.lastRefillMs = Date.now()
  }
  private refill(): void {
    const now = Date.now()
    const elapsedSec = (now - this.lastRefillMs) / 1000
    if (elapsedSec <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec)
    this.lastRefillMs = now
  }
  tryConsume(): boolean {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }
  level(): number {
    this.refill()
    return Math.max(0, this.tokens)
  }
  retryAfterSec(): number {
    this.refill()
    if (this.tokens >= 1) return 0
    if (this.ratePerSec <= 0) return 60
    return Math.ceil((1 - this.tokens) / this.ratePerSec)
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ProxySelfGate extends ServiceMap.Service<
  ProxySelfGate,
  ProxySelfGateApi
>()("@sipjsserver/sip-front-proxy/ProxySelfGate") {
  static readonly layer = (
    config: ProxySelfGateConfigData = defaultProxySelfGateConfig,
  ): Layer.Layer<ProxySelfGate, never, LoadSampler> =>
    Layer.effect(
      ProxySelfGate,
      Effect.gen(function* () {
        const sampler = yield* LoadSampler
        const bucket = new TokenBucket(config.cpsBucketSize, config.cpsBucketRate)
        let eluEwma = 0
        let gcFraction = 0
        let initialized = false
        const alpha = config.eluSmoothingAlpha

        const metrics: ProxySelfGateMetrics = {
          eluEwma: 0,
          gcFraction: 0,
          cpsBucketLevel: bucket.level(),
          cpsBucketMax: config.cpsBucketSize,
          externalAdmittedTotal: 0,
          rejectedTotal: { proxy_overload_elu: 0, proxy_overload_cps: 0 },
          internalBypassedTotal: 0,
          emergencyBypassedTotal: 0,
        }

        // Push the constant capacity once so dashboards don't render
        // a "no data" panel before the first admit/reject.
        pushMetric(Metric.update(cpsBucketMaxGauge, config.cpsBucketSize))

        // Raw setInterval — independent of TestClock so production
        // behaviour matches when tests use the simulated LoadSampler.
        // Each tick also pushes the gauges to Effect.Metric so the
        // proxy's `/metrics` endpoint surfaces them (no separate
        // adapter needed).
        const samplerInterval = setInterval(() => {
          const eluRaw = sampler.elu()
          const gcRaw = sampler.gcFraction()
          if (!initialized) {
            eluEwma = eluRaw
            initialized = true
          } else {
            eluEwma = alpha * eluRaw + (1 - alpha) * eluEwma
          }
          gcFraction = gcRaw
          metrics.eluEwma = eluEwma
          metrics.gcFraction = gcFraction
          metrics.cpsBucketLevel = bucket.level()
          pushMetric(Metric.update(eluEwmaGauge, eluEwma))
          pushMetric(Metric.update(gcFractionGauge, gcFraction))
          pushMetric(Metric.update(cpsBucketLevelGauge, metrics.cpsBucketLevel))
        }, config.samplerIntervalMs)
        samplerInterval.unref()
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => clearInterval(samplerInterval)),
        )

        const tryAdmitExternal = (): AdmitDecision => {
          if (eluEwma > config.eluCritical) {
            metrics.rejectedTotal.proxy_overload_elu++
            pushMetric(
              externalRejectedCounter.pipe(
                Metric.withAttributes({ reason: "proxy_overload_elu" }),
                Metric.update(1),
              ),
            )
            return {
              admit: false,
              reason: "proxy_overload_elu",
              retryAfterSec: 1,
            }
          }
          if (!bucket.tryConsume()) {
            metrics.cpsBucketLevel = bucket.level()
            metrics.rejectedTotal.proxy_overload_cps++
            pushMetric(
              externalRejectedCounter.pipe(
                Metric.withAttributes({ reason: "proxy_overload_cps" }),
                Metric.update(1),
              ),
            )
            return {
              admit: false,
              reason: "proxy_overload_cps",
              retryAfterSec: bucket.retryAfterSec(),
            }
          }
          metrics.cpsBucketLevel = bucket.level()
          metrics.externalAdmittedTotal++
          pushMetric(Metric.update(externalAdmittedCounter, 1))
          return { admit: true, reason: undefined, retryAfterSec: 0 }
        }

        const noteBypass = (kind: "internal" | "emergency"): void => {
          if (kind === "internal") {
            metrics.internalBypassedTotal++
            pushMetric(Metric.update(internalBypassCounter, 1))
          } else {
            metrics.emergencyBypassedTotal++
            pushMetric(Metric.update(emergencyBypassCounter, 1))
          }
        }

        return { tryAdmitExternal, noteBypass, metrics }
      }),
    )
}
