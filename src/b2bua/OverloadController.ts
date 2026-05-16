/**
 * OverloadController — Tier 3 of the overload-protection model.
 *
 * Combines:
 *   - A token bucket (hard CPS gate, configured by CPS_BUCKET_SIZE / CPS_BUCKET_RATE)
 *   - A max-of-fractions adaptive shedder over:
 *       * event-loop lag (EWMA, sampled via setImmediate drift)
 *       * active-call count (gauge — set by callers)
 *       * in-dialog queue depth (gauge — set by callers)
 *       * routing-API new-call latency p95 (EWMA — fed by CallDecisionEngine adapters)
 *
 * Usage:
 *   const decision = controller.shouldAdmit({ isEmergency })
 *   if (decision.admit) { ...proceed... }
 *   else { ...send stateless 503 with decision.reason... }
 *
 * Emergency calls bypass the shedder entirely and never see a "reject" decision,
 * but they still consume one token from the bucket so the bucket reflects
 * actual CPS load (per design — see docs/overload-protection.md).
 *
 * State is per-worker, in-memory. Mutations on the bucket / EWMAs are wrapped
 * inside the public methods; the loop-lag sampler runs as a forkDetached fiber.
 */

import { Effect, Layer, ServiceMap } from "effect"
import { PerformanceObserver, constants as perfConstants } from "node:perf_hooks"
import { AppConfig } from "../config/AppConfig.js"
import { LoadSampler } from "../observability/LoadSampler.js"
import { MetricsRegistry } from "../observability/MetricsRegistry.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AdmitReason = "bucket_empty" | "shedder" | "panic_elu"

export interface AdmitDecision {
  readonly admit: boolean
  readonly reason: AdmitReason | undefined
  /** Suggested Retry-After value (seconds) when admit=false. */
  readonly retryAfterSec: number
}

export interface GcMetricsSnapshot {
  /** Total number of GC pauses since process start (counter). */
  totalCount: number
  /** Total GC pause time in ms since process start (counter). */
  totalPauseMs: number
  /** Max GC pause in ms within the current reporting window (gauge, reset each snapshot). */
  maxPauseMs: number
  /** GC pauses within the current reporting window (gauge, reset each snapshot). */
  windowCount: number
  /** Total GC pause time in ms within the current reporting window (gauge). */
  windowPauseMs: number
  /** Timestamp (epoch ms) of the most recent GC pause (0 = none yet). */
  lastPauseTimestamp: number
  /** Duration in ms of the most recent GC pause. */
  lastPauseDurationMs: number
  /** Kind of the most recent GC pause (minor/major/incremental/weak). */
  lastPauseKind: string
}

export interface OverloadControllerMetrics {
  admitTotal: number
  rejectTotal: { bucket_empty: number; shedder: number; panic_elu: number }
  shedProbability: number
  tokenBucketLevel: number
  loopLagMsP95: number
  routingApiP95Ms: { new_call: number; in_dialog: number }
  /** Per-signal shedding fractions (0.0–1.0). */
  fractionLoopLag: number
  fractionActiveCalls: number
  fractionInDialogQueue: number
  fractionRoutingLatency: number
  /** Token bucket fill ratio (0.0–1.0). */
  tokenBucketRatio: number
  /** GC pressure metrics. */
  gc: GcMetricsSnapshot
  /** EWMA-smoothed Event Loop Utilization, the value published on X-Overload. */
  eluEwma: number
  /** EWMA-smoothed GC pause fraction, the value published on X-Overload. */
  gcFractionEwma: number
  /** Monotonic count of non-emergency new-dialog INVITEs admitted by this worker. */
  nonEmergencyAdmittedTotal: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Slice 7 — the linear-ramp `fraction()` helper used by the probabilistic
// shedder was removed when the shedder was retired. AIMD lives at the LB
// side now (WorkerLoadObserver); the worker only does a binary panic-503.

/**
 * Simple EWMA. Alpha = 0.2 gives a moderate-smoothing window of ~5 samples.
 */
class Ewma {
  private value = 0
  private initialized = false
  constructor(private readonly alpha: number = 0.2) {}
  observe(sample: number): void {
    if (!this.initialized) {
      this.value = sample
      this.initialized = true
    } else {
      this.value = this.alpha * sample + (1 - this.alpha) * this.value
    }
  }
  get(): number {
    return this.value
  }
}

/**
 * Lazy-refill token bucket. Tokens accrue continuously at `rate` per second
 * up to `capacity`. `tryConsume` succeeds iff at least one token is available.
 */
class TokenBucket {
  private tokens: number
  private lastRefillMs: number
  constructor(
    private readonly capacity: number,
    private readonly ratePerSec: number
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
  /** Consume one token unconditionally (can go negative — used by emergency path). */
  consumeForced(): void {
    this.refill()
    this.tokens -= 1
  }
  /** Time until at least one token will be available, in seconds (0 if available now). */
  retryAfterSec(): number {
    this.refill()
    if (this.tokens >= 1) return 0
    if (this.ratePerSec <= 0) return 60
    return Math.ceil((1 - this.tokens) / this.ratePerSec)
  }
  level(): number {
    this.refill()
    return Math.max(0, this.tokens)
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface OverloadControllerApi {
  /**
   * Decide whether to admit a new INVITE.
   * Emergency callers MUST pass isEmergency=true.
   */
  readonly shouldAdmit: (opts: { readonly isEmergency: boolean }) => AdmitDecision

  /** Update the active-call count gauge (read by the shedder). */
  readonly setActiveCalls: (n: number) => void

  /** Update the in-dialog worker queue depth gauge (read by the shedder). */
  readonly setInDialogQueueDepth: (depth: number, bound: number) => void

  /** Feed a routing-API latency observation (CallDecisionEngine adapters call this). */
  readonly observeRoutingApiLatency: (stage: "new_call" | "in_dialog", ms: number) => void

  /**
   * Increment the monotonic counter of non-emergency new-dialog INVITEs
   * admitted by this worker. Caller must guarantee the request was both
   * (a) a new dialog (no To-tag) and (b) non-emergency. The counter is
   * published on every X-Overload header so LBs can derive the worker's
   * total treated rate by diffing successive samples.
   */
  readonly incrementNonEmergencyAdmitted: () => void

  /**
   * Build the value of the X-Overload header for this worker's current
   * state, e.g. `v=1; elu=0.732; gc=0.012; adm=12345`. EWMAs are read
   * directly — no parameters. Cheap (string concat); safe to call on
   * the OPTIONS-reply hot path.
   */
  readonly xOverloadHeaderValue: () => string

  /** Snapshot of metrics for /status and Prometheus. */
  readonly metrics: OverloadControllerMetrics
}

export class OverloadController extends ServiceMap.Service<OverloadController, OverloadControllerApi>()(
  "@sipjsserver/OverloadController"
) {
  static readonly layer: Layer.Layer<
    OverloadController,
    never,
    AppConfig | MetricsRegistry | LoadSampler
  > = Layer.effect(
    OverloadController,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const registry = yield* MetricsRegistry
      const sampler = yield* LoadSampler

      const bucket = new TokenBucket(config.cpsBucketSize, config.cpsBucketRate)
      const loopLagEwma = new Ewma(0.2)
      const routingNewCallEwma = new Ewma(0.2)
      const routingInDialogEwma = new Ewma(0.2)
      // Worker-side overload signal — slice 2 of the overload rework.
      // EWMA-smoothed alongside loopLag so a single sampler interval
      // updates everything in lock-step.
      const eluEwma = new Ewma(0.2)
      const gcFractionEwma = new Ewma(0.2)
      let nonEmergencyAdmittedTotal = 0

      // Slice 7: probabilistic shedder removed — `activeCallLimit`,
      // `inDialogQueueDepth`, `inDialogQueueBound` are no longer used by
      // admission. The corresponding setter methods stay as no-ops for
      // backwards-compat with callers that still pass a gauge.

      // ── GC pressure observer ──────────────────────────────────────────
      // Uses perf_hooks PerformanceObserver to capture every GC pause with
      // accurate timestamps. Window counters are reset each time the metrics
      // snapshot is read (via the WorkerEntry periodic reporter).
      const gcKindName = (kind: number): string => {
        switch (kind) {
          case perfConstants.NODE_PERFORMANCE_GC_MINOR: return "minor"
          case perfConstants.NODE_PERFORMANCE_GC_MAJOR: return "major"
          case perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL: return "incremental"
          case perfConstants.NODE_PERFORMANCE_GC_WEAKCB: return "weak"
          default: return `unknown(${kind})`
        }
      }

      const gcState = {
        totalCount: 0,
        totalPauseMs: 0,
        windowCount: 0,
        windowPauseMs: 0,
        maxPauseMs: 0,
        lastPauseTimestamp: 0,
        lastPauseDurationMs: 0,
        lastPauseKind: "",
      }

      const gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const durationMs = entry.duration
          // entry.startTime is relative to process start (performance.timeOrigin).
          // Convert to epoch ms for correct timestamping.
          const epochMs = performance.timeOrigin + entry.startTime
          gcState.totalCount++
          gcState.totalPauseMs += durationMs
          gcState.windowCount++
          gcState.windowPauseMs += durationMs
          if (durationMs > gcState.maxPauseMs) gcState.maxPauseMs = durationMs
          gcState.lastPauseTimestamp = epochMs
          gcState.lastPauseDurationMs = durationMs
          gcState.lastPauseKind = gcKindName((entry as { detail?: { kind?: number } }).detail?.kind ?? -1)
        }
      })
      gcObserver.observe({ type: "gc", buffered: true })
      yield* Effect.addFinalizer(() => Effect.sync(() => gcObserver.disconnect()))

      const metrics: OverloadControllerMetrics = {
        admitTotal: 0,
        rejectTotal: { bucket_empty: 0, shedder: 0, panic_elu: 0 },
        shedProbability: 0,
        tokenBucketLevel: bucket.level(),
        loopLagMsP95: 0,
        routingApiP95Ms: { new_call: 0, in_dialog: 0 },
        fractionLoopLag: 0,
        fractionActiveCalls: 0,
        fractionInDialogQueue: 0,
        fractionRoutingLatency: 0,
        tokenBucketRatio: 1,
        gc: gcState,
        eluEwma: 0,
        gcFractionEwma: 0,
        nonEmergencyAdmittedTotal: 0,
      }
      registry.overload = metrics

      // ── Loop-lag + ELU + GC sampler ──────────────────────────────────
      // Uses raw setInterval (not Effect.sleep) so it is independent of
      // TestClock — sampler is a pure side effect of the host runtime.
      // Samples three signals on each tick:
      //   - loop-lag (legacy, used by the soon-to-be-retired shedder)
      //   - ELU (new — published on X-Overload)
      //   - GC fraction (new — published on X-Overload)
      let lastSampleAt = Date.now()
      const samplerInterval = setInterval(() => {
        const now = Date.now()
        const lag = Math.max(0, now - lastSampleAt - 100)
        lastSampleAt = now
        loopLagEwma.observe(lag)
        metrics.loopLagMsP95 = loopLagEwma.get()
        eluEwma.observe(sampler.elu())
        gcFractionEwma.observe(sampler.gcFraction())
        metrics.eluEwma = eluEwma.get()
        metrics.gcFractionEwma = gcFractionEwma.get()
      }, 100)
      // Don't keep the Node event loop alive just for sampling.
      samplerInterval.unref()
      yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(samplerInterval)))

      // ── shouldAdmit ──────────────────────────────────────────────────
      const shouldAdmit = (opts: { readonly isEmergency: boolean }): AdmitDecision => {
        if (opts.isEmergency) {
          // Emergency: always admit, but still consume a token so the bucket
          // reflects true CPS load. Bucket can go negative; that just means
          // non-emergency callers will have to wait longer for refill.
          bucket.consumeForced()
          metrics.tokenBucketLevel = bucket.level()
          metrics.admitTotal++
          return { admit: true, reason: undefined, retryAfterSec: 0 }
        }

        // Hard CPS gate
        if (!bucket.tryConsume()) {
          metrics.tokenBucketLevel = bucket.level()
          metrics.rejectTotal.bucket_empty++
          return {
            admit: false,
            reason: "bucket_empty",
            retryAfterSec: bucket.retryAfterSec(),
          }
        }
        metrics.tokenBucketLevel = bucket.level()
        metrics.tokenBucketRatio =
          config.cpsBucketSize > 0 ? bucket.level() / config.cpsBucketSize : 1

        // Slice 7: panic-ELU backstop. The LB-side AIMD is the primary
        // control loop; this catches the cases where the LB is absent,
        // misconfigured, or itself overloaded. Threshold is intentionally
        // high (default 0.98) so it almost never fires in normal operation.
        if (eluEwma.get() > config.overloadPanicEluThreshold) {
          metrics.rejectTotal.panic_elu++
          return {
            admit: false,
            reason: "panic_elu",
            retryAfterSec: config.retryAfterBaseSec,
          }
        }

        metrics.admitTotal++
        return { admit: true, reason: undefined, retryAfterSec: 0 }
      }

      const setActiveCalls = (_n: number): void => {
        // No-op since slice 7 — kept for caller compatibility.
      }

      // Slice 7: probabilistic shedder removed — kept as no-op for callers
      // that still pass the gauge through. Signal is exported on metrics
      // via the X-Overload payload now, not via this setter.
      const setInDialogQueueDepth = (_depth: number, _bound: number): void => {
        // intentionally empty — see header comment
      }

      const observeRoutingApiLatency = (stage: "new_call" | "in_dialog", ms: number): void => {
        if (stage === "new_call") {
          routingNewCallEwma.observe(ms)
          metrics.routingApiP95Ms.new_call = routingNewCallEwma.get()
        } else {
          routingInDialogEwma.observe(ms)
          metrics.routingApiP95Ms.in_dialog = routingInDialogEwma.get()
        }
      }

      const incrementNonEmergencyAdmitted = (): void => {
        nonEmergencyAdmittedTotal++
        metrics.nonEmergencyAdmittedTotal = nonEmergencyAdmittedTotal
      }

      // Format published on the wire: `v=1; elu=0.732; gc=0.012; adm=12345`.
      // EWMAs are clamped to [0,1] by LoadSampler; counter is uint53-safe.
      const xOverloadHeaderValue = (): string => {
        const elu = eluEwma.get().toFixed(3)
        const gc = gcFractionEwma.get().toFixed(3)
        return `v=1; elu=${elu}; gc=${gc}; adm=${nonEmergencyAdmittedTotal}`
      }

      return {
        shouldAdmit,
        setActiveCalls,
        setInDialogQueueDepth,
        observeRoutingApiLatency,
        incrementNonEmergencyAdmitted,
        xOverloadHeaderValue,
        metrics,
      }
    })
  )
}
