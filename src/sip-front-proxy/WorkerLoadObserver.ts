/**
 * WorkerLoadObserver — per-(LB, worker) AIMD state machine.
 *
 * The LB-side spine of the overload rework (slice 3). Each LB
 * maintains one observer holding one bucket per worker:
 *
 *   - Eats `X-Overload` payloads handed in by `HealthProbe` and by the
 *     503-reply fast path.
 *   - Runs AIMD on each payload: additive increase on cool workers,
 *     multiplicative decrease on hot ones, multiplicative decrease
 *     when `ELU > CRITICAL` (locked to `capFloorCps`).
 *   - Implements hysteresis on band boundaries so a worker oscillating
 *     around `0.80` does not flap.
 *   - Cooldown after every decrease so the worker has time to shed in-
 *     flight load before we start increasing again.
 *   - Exposes `tryConsumeFor(workerId)` for the new-dialog admit path
 *     and `bandFor(workerId)` for the CRITICAL filter.
 *   - Stale payloads (> `payloadStaleMs`) trigger a conservative
 *     decrease on the next `sweepStale` tick.
 *
 * Slice 3 ships the state machine in isolation; slice 4 wires
 * HealthProbe; slice 5 wires LoadBalancerStrategy. The observer is
 * deliberately decoupled from SIP and from Effect's Clock — every
 * method that needs the current time takes `nowMs` explicitly so the
 * unit tests can drive the AIMD ladder without TestClock interaction.
 */

import { Effect, Layer, Metric, MutableHashMap, Option, ServiceMap } from "effect"

// Module-level helper so the plugin's `runEffectInsideEffect` check
// doesn't flag every metric push inside the layer body. Metric updates
// take no services.
const pushMetric = (eff: Effect.Effect<void, never, never>): void => {
  Effect.runSync(eff)
}

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

const aimdCapGauge = Metric.gauge("sip_proxy_worker_aimd_cap_cps", {
  description: "Per-(LB,worker) AIMD-tuned admission cap (cps).",
})
const aimdTokensGauge = Metric.gauge("sip_proxy_worker_aimd_tokens", {
  description: "Per-(LB,worker) AIMD bucket tokens remaining.",
})
const eluObservedGauge = Metric.gauge("sip_proxy_worker_elu_observed", {
  description: "Worker-reported ELU EWMA, latest observation.",
})
const gcObservedGauge = Metric.gauge("sip_proxy_worker_gc_observed", {
  description: "Worker-reported GC fraction, latest observation.",
})
const eluBandGauge = Metric.gauge("sip_proxy_worker_elu_band", {
  description:
    "Worker AIMD band — 0=below_soft, 1=soft_to_hard, 2=hard_to_critical, 3=above_critical (filtered out).",
})
const workerTreatedRateGauge = Metric.gauge(
  "sip_proxy_worker_treated_rate_observed_cps",
  { description: "Worker's reported `adm` counter rate (cps), diffed at the LB." },
)
const ownAdmittedRateGauge = Metric.gauge(
  "sip_proxy_worker_own_admitted_rate_cps",
  { description: "This LB's own admit rate to the worker (cps)." },
)
const shareGauge = Metric.gauge("sip_proxy_worker_share", {
  description: "own_admitted_rate / worker_treated_rate (0..1).",
})
const payloadAgeGauge = Metric.gauge("sip_proxy_worker_payload_age_ms", {
  description: "ms since last X-Overload payload from this worker.",
})
const cooldownMsRemainingGauge = Metric.gauge(
  "sip_proxy_worker_aimd_cooldown_ticks_remaining",
  {
    description:
      "ms remaining until AIMD increase is re-enabled for this worker. (Despite the `ticks` suffix the unit is ms — keeping for dashboard compat.)",
  },
)
const rejectionsCounter = Metric.counter("sip_proxy_overload_rejections_total", {
  description:
    "selectForNewDialog rejections classified by reason (bucket_empty / no_target_critical_filtered).",
  incremental: true,
})
const payloadMissingCounter = Metric.counter(
  "sip_proxy_overload_payload_missing_total",
  {
    description:
      "OPTIONS replies received without an X-Overload header (or with unparseable / unknown version).",
    incremental: true,
  },
)
const aimdLastActionGauge = Metric.gauge(
  "sip_proxy_worker_aimd_last_action",
  {
    description:
      "Last AIMD action — 0=init, 1=hold, 2=increase, 3=decrease, 4=decrease_critical, 5=cooldown, 6=stale_decrease.",
  },
)

const actionCode = (a: AimdAction): number => {
  switch (a) {
    case "init": return 0
    case "hold": return 1
    case "increase": return 2
    case "decrease": return 3
    case "decrease_critical": return 4
    case "cooldown": return 5
    case "stale_decrease": return 6
  }
}

const bandCode = (b: EluBand): number => {
  switch (b) {
    case "below_soft": return 0
    case "soft_to_hard": return 1
    case "hard_to_critical": return 2
    case "above_critical": return 3
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The `(elu, gc, adm)` triple parsed off an `X-Overload` header. */
export interface OverloadPayload {
  /** EWMA-smoothed Event Loop Utilization, 0..1. */
  readonly elu: number
  /** EWMA-smoothed GC pause fraction, 0..1. */
  readonly gc: number
  /** Worker's monotonic counter of non-emergency new-dialog admits. */
  readonly adm: number
}

/** AIMD band derived from `elu` with hysteresis on band transitions. */
export type EluBand =
  | "below_soft"
  | "soft_to_hard"
  | "hard_to_critical"
  | "above_critical"

/** The last AIMD action taken on a worker — for metrics + debug. */
export type AimdAction =
  | "init"
  | "hold"
  | "increase"
  | "decrease"
  | "decrease_critical"
  | "cooldown"
  | "stale_decrease"

export interface AimdSnapshot {
  readonly workerId: string
  readonly elu: number
  readonly gc: number
  readonly band: EluBand
  readonly capCps: number
  readonly tokens: number
  readonly cooldownMsRemaining: number
  readonly lastAction: AimdAction
  readonly workerTreatedRateCps: number
  readonly ownAdmittedRateCps: number
  readonly share: number
  readonly payloadAgeMs: number
  readonly payloadMissingCount: number
}

export interface WorkerLoadObserverConfigData {
  /** AIMD increase enabled while `elu <= eluSoft`. */
  readonly eluSoft: number
  /** Multiplicative decrease while `elu > eluHard`. */
  readonly eluHard: number
  /** Worker filtered out of new-dialog candidates while `elu > eluCritical`. */
  readonly eluCritical: number
  /** Hysteresis applied at every band boundary (exit threshold = enter − h). */
  readonly bandHysteresis: number
  /** Additive increase step per OPTIONS tick when below soft. */
  readonly aimdIncreaseStepCps: number
  /** Multiplicative decrease factor when above hard (e.g. 0.75 = ×0.75). */
  readonly aimdDecreaseFactor: number
  /** No increases for this many OPTIONS ticks after any decrease. */
  readonly aimdCooldownTicks: number
  /** Cap each worker starts at before any payload has arrived. */
  readonly capInitialCps: number
  /** Cap never decreases below this. */
  readonly capFloorCps: number
  /** Cap never increases above this. */
  readonly capCeilingCps: number
  /** Payload older than this is treated as stale; sweep conservatively decreases. */
  readonly payloadStaleMs: number
  /** Nominal OPTIONS interval (ms) — used for the cooldown clock. */
  readonly optionsIntervalMs: number
}

// Aggressive defaults — same calibration story as ProxySelfGate.
// At 2 workers × ~50 CAPS sustained, capInitialCps=30 means the LB
// admits 30 cps per worker initially and AIMDs UP from there as ELU
// stays low. A 200 CAPS burst against one worker drains its bucket
// in 1 s and the per-OPTIONS-tick decreases collapse it further.
// eluCritical=0.75 is the earliest filter-out threshold; eluHard=0.6
// triggers multiplicative decrease before the worker collapses.
export const defaultWorkerLoadObserverConfig: WorkerLoadObserverConfigData = {
  eluSoft: 0.4,
  eluHard: 0.6,
  eluCritical: 0.75,
  bandHysteresis: 0.05,
  aimdIncreaseStepCps: 2,
  aimdDecreaseFactor: 0.5,
  aimdCooldownTicks: 5,
  capInitialCps: 30,
  capFloorCps: 1,
  capCeilingCps: 200,
  payloadStaleMs: 3000,
  optionsIntervalMs: 1000,
}

export interface WorkerLoadObserverApi {
  /** Process an `X-Overload` payload from this worker (OPTIONS reply path). */
  readonly applyPayload: (
    workerId: string,
    payload: OverloadPayload,
    nowMs: number,
  ) => void

  /**
   * Fast path — process an `X-Overload` payload that rode a 503 reply
   * to a forwarded INVITE. Same AIMD step as `applyPayload`; exists as
   * a distinct entry point so metrics can label it separately and so
   * the call site is explicit about why it knows the worker is hot.
   */
  readonly noteRejectionPayload: (
    workerId: string,
    payload: OverloadPayload,
    nowMs: number,
  ) => void

  /**
   * Called by HealthProbe when an OPTIONS reply arrives without an
   * `X-Overload` header (or with an unparseable one) — tracked as a
   * metric but no AIMD step taken.
   */
  readonly notePayloadMissing: (workerId: string, nowMs: number) => void

  /**
   * The LB increments this when it has just forwarded a non-emergency
   * new-dialog INVITE to a worker — so we can derive `own_admitted_rate`
   * and the `share` metric independent of the worker's report.
   */
  readonly recordOwnAdmitted: (workerId: string) => void

  /**
   * Attempt to consume one token from the per-(LB, worker) bucket.
   * Returns `true` if admitted, `false` if the bucket is empty.
   * Unknown worker → admitted (we don't gate workers we haven't yet
   * observed a payload from; bootstrap-friendly).
   */
  readonly tryConsumeFor: (workerId: string, nowMs: number) => boolean

  /** Returns the current band; `undefined` if worker is unknown. */
  readonly bandFor: (workerId: string) => EluBand | undefined

  /**
   * Periodic sweep — call every ~`optionsIntervalMs`. Workers whose
   * last payload is older than `payloadStaleMs` get one conservative
   * decrease + `payloadMissingCount++`.
   */
  readonly sweepStale: (nowMs: number) => void

  /** Full per-worker snapshot (metrics, dashboards, tests). */
  readonly snapshot: (nowMs: number) => ReadonlyArray<AimdSnapshot>
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface WorkerState {
  cap: number
  tokens: number
  lastRefillAtMs: number
  cooldownUntilMs: number
  lastAction: AimdAction

  elu: number
  gc: number
  band: EluBand

  lastAdm: number
  lastAdmAtMs: number
  workerTreatedRateCps: number

  ownAdmittedSinceLastTick: number
  ownAdmittedRateCps: number
  lastOwnRateTickAtMs: number

  lastPayloadAtMs: number
  payloadMissingCount: number
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class WorkerLoadObserver extends ServiceMap.Service<
  WorkerLoadObserver,
  WorkerLoadObserverApi
>()("@sipjsserver/sip-front-proxy/WorkerLoadObserver") {
  static readonly layer = (
    config: WorkerLoadObserverConfigData = defaultWorkerLoadObserverConfig,
  ): Layer.Layer<WorkerLoadObserver> =>
    Layer.sync(WorkerLoadObserver, () => buildObserver(config))
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function buildObserver(
  config: WorkerLoadObserverConfigData,
): WorkerLoadObserverApi {
  const workers = MutableHashMap.empty<string, WorkerState>()
  const cooldownMs = config.aimdCooldownTicks * config.optionsIntervalMs

  const getOrInit = (workerId: string, nowMs: number): WorkerState => {
    const existing = MutableHashMap.get(workers, workerId)
    if (Option.isSome(existing)) return existing.value
    const fresh: WorkerState = {
      cap: config.capInitialCps,
      tokens: config.capInitialCps,
      lastRefillAtMs: nowMs,
      cooldownUntilMs: 0,
      lastAction: "init",
      elu: 0,
      gc: 0,
      band: "below_soft",
      lastAdm: 0,
      lastAdmAtMs: nowMs,
      workerTreatedRateCps: 0,
      ownAdmittedSinceLastTick: 0,
      ownAdmittedRateCps: 0,
      lastOwnRateTickAtMs: nowMs,
      lastPayloadAtMs: nowMs,
      payloadMissingCount: 0,
    }
    MutableHashMap.set(workers, workerId, fresh)
    return fresh
  }

  const computeBand = (elu: number, prev: EluBand): EluBand => {
    const h = config.bandHysteresis
    // Walk down the bands. Hysteresis: once IN a higher band, we
    // require elu to drop below `enter − h` before transitioning out.
    if (elu > config.eluCritical) return "above_critical"
    if (prev === "above_critical" && elu > config.eluCritical - h) {
      return "above_critical"
    }
    if (elu > config.eluHard) return "hard_to_critical"
    if (prev === "hard_to_critical" && elu > config.eluHard - h) {
      return "hard_to_critical"
    }
    if (elu > config.eluSoft) return "soft_to_hard"
    if (prev === "soft_to_hard" && elu > config.eluSoft - h) {
      return "soft_to_hard"
    }
    return "below_soft"
  }

  const refillBucket = (state: WorkerState, nowMs: number): void => {
    const dtSec = (nowMs - state.lastRefillAtMs) / 1000
    if (dtSec <= 0) return
    // Bucket capacity = cap; refill rate = cap tokens/sec.
    state.tokens = Math.min(state.cap, state.tokens + state.cap * dtSec)
    state.lastRefillAtMs = nowMs
  }

  const updateOwnRate = (state: WorkerState, nowMs: number): void => {
    const dtSec = (nowMs - state.lastOwnRateTickAtMs) / 1000
    if (dtSec <= 0) return
    const observed = state.ownAdmittedSinceLastTick / dtSec
    // EWMA-smooth so a single quiet tick doesn't crash the rate to 0.
    state.ownAdmittedRateCps = 0.7 * state.ownAdmittedRateCps + 0.3 * observed
    state.ownAdmittedSinceLastTick = 0
    state.lastOwnRateTickAtMs = nowMs
  }

  const applyAimdStep = (
    state: WorkerState,
    elu: number,
    nowMs: number,
  ): void => {
    const newBand = computeBand(elu, state.band)
    state.band = newBand

    if (newBand === "above_critical") {
      state.cap = config.capFloorCps
      state.cooldownUntilMs = nowMs + cooldownMs
      state.lastAction = "decrease_critical"
      return
    }
    if (newBand === "hard_to_critical") {
      state.cap = Math.max(
        config.capFloorCps,
        state.cap * config.aimdDecreaseFactor,
      )
      state.cooldownUntilMs = nowMs + cooldownMs
      state.lastAction = "decrease"
      return
    }
    if (newBand === "soft_to_hard") {
      state.lastAction = "hold"
      return
    }
    // below_soft — increase if cooldown has elapsed.
    if (nowMs < state.cooldownUntilMs) {
      state.lastAction = "cooldown"
      return
    }
    state.cap = Math.min(
      config.capCeilingCps,
      state.cap + config.aimdIncreaseStepCps,
    )
    state.lastAction = "increase"
  }

  const updateCounterRate = (
    state: WorkerState,
    adm: number,
    nowMs: number,
  ): void => {
    if (adm < state.lastAdm) {
      // Worker restarted (counter is per-process). Reset baseline.
      state.lastAdm = adm
      state.lastAdmAtMs = nowMs
      state.workerTreatedRateCps = 0
      return
    }
    const dtSec = (nowMs - state.lastAdmAtMs) / 1000
    if (dtSec > 0) {
      state.workerTreatedRateCps = (adm - state.lastAdm) / dtSec
    }
    state.lastAdm = adm
    state.lastAdmAtMs = nowMs
  }

  const exportMetricsFor = (workerId: string, state: WorkerState, nowMs: number): void => {
    const labels = { worker_id: workerId }
    const total = state.workerTreatedRateCps
    const share = total > 0 ? state.ownAdmittedRateCps / total : 0
    const ageMs = nowMs - state.lastPayloadAtMs
    const cooldownMsRemaining = Math.max(0, state.cooldownUntilMs - nowMs)
    pushMetric(
      Effect.all([
        aimdCapGauge.pipe(Metric.withAttributes(labels), Metric.update(state.cap)),
        aimdTokensGauge.pipe(Metric.withAttributes(labels), Metric.update(state.tokens)),
        eluObservedGauge.pipe(Metric.withAttributes(labels), Metric.update(state.elu)),
        gcObservedGauge.pipe(Metric.withAttributes(labels), Metric.update(state.gc)),
        eluBandGauge.pipe(Metric.withAttributes(labels), Metric.update(bandCode(state.band))),
        workerTreatedRateGauge.pipe(Metric.withAttributes(labels), Metric.update(total)),
        ownAdmittedRateGauge.pipe(Metric.withAttributes(labels), Metric.update(state.ownAdmittedRateCps)),
        shareGauge.pipe(Metric.withAttributes(labels), Metric.update(share)),
        payloadAgeGauge.pipe(Metric.withAttributes(labels), Metric.update(ageMs)),
        cooldownMsRemainingGauge.pipe(Metric.withAttributes(labels), Metric.update(cooldownMsRemaining)),
        aimdLastActionGauge.pipe(Metric.withAttributes(labels), Metric.update(actionCode(state.lastAction))),
      ], { discard: true }),
    )
  }

  // ── Public API ────────────────────────────────────────────────────

  const applyPayloadCommon = (
    workerId: string,
    payload: OverloadPayload,
    nowMs: number,
  ): void => {
    const state = getOrInit(workerId, nowMs)
    updateCounterRate(state, payload.adm, nowMs)
    updateOwnRate(state, nowMs)
    state.elu = payload.elu
    state.gc = payload.gc
    state.lastPayloadAtMs = nowMs
    applyAimdStep(state, payload.elu, nowMs)
    exportMetricsFor(workerId, state, nowMs)
  }

  const applyPayload: WorkerLoadObserverApi["applyPayload"] = (
    workerId,
    payload,
    nowMs,
  ) => applyPayloadCommon(workerId, payload, nowMs)

  const noteRejectionPayload: WorkerLoadObserverApi["noteRejectionPayload"] = (
    workerId,
    payload,
    nowMs,
  ) => applyPayloadCommon(workerId, payload, nowMs)

  const notePayloadMissing: WorkerLoadObserverApi["notePayloadMissing"] = (
    workerId,
    nowMs,
  ) => {
    const state = getOrInit(workerId, nowMs)
    state.payloadMissingCount++
    pushMetric(
      payloadMissingCounter.pipe(
        Metric.withAttributes({ worker_id: workerId }),
        Metric.update(1),
      ),
    )
    exportMetricsFor(workerId, state, nowMs)
  }

  const recordOwnAdmitted: WorkerLoadObserverApi["recordOwnAdmitted"] = (
    workerId,
  ) => {
    const optState = MutableHashMap.get(workers, workerId)
    if (Option.isNone(optState)) return
    optState.value.ownAdmittedSinceLastTick++
  }

  const tryConsumeFor: WorkerLoadObserverApi["tryConsumeFor"] = (
    workerId,
    nowMs,
  ) => {
    const optState = MutableHashMap.get(workers, workerId)
    if (Option.isNone(optState)) return true // bootstrap-friendly
    const state = optState.value
    refillBucket(state, nowMs)
    if (state.tokens >= 1) {
      state.tokens -= 1
      return true
    }
    // Bucket empty — record the rejection. The actual 503 happens at
    // the strategy boundary; we count here so the metric stays close
    // to the consume site (no rejection can escape uncounted).
    pushMetric(
      rejectionsCounter.pipe(
        Metric.withAttributes({ worker_id: workerId, reason: "bucket_empty" }),
        Metric.update(1),
      ),
    )
    return false
  }

  const bandFor: WorkerLoadObserverApi["bandFor"] = (workerId) => {
    const optState = MutableHashMap.get(workers, workerId)
    if (Option.isNone(optState)) return undefined
    return optState.value.band
  }

  const sweepStale: WorkerLoadObserverApi["sweepStale"] = (nowMs) => {
    for (const [, state] of workers) {
      const age = nowMs - state.lastPayloadAtMs
      if (age <= config.payloadStaleMs) continue
      state.cap = Math.max(
        config.capFloorCps,
        state.cap * config.aimdDecreaseFactor,
      )
      state.cooldownUntilMs = nowMs + cooldownMs
      state.lastAction = "stale_decrease"
      state.payloadMissingCount++
    }
  }

  const snapshot: WorkerLoadObserverApi["snapshot"] = (nowMs) => {
    const out: AimdSnapshot[] = []
    for (const [workerId, state] of workers) {
      // Reading the snapshot also triggers a virtual refill so the
      // `tokens` gauge isn't stale.
      refillBucket(state, nowMs)
      const total = state.workerTreatedRateCps
      const share = total > 0 ? state.ownAdmittedRateCps / total : 0
      out.push({
        workerId,
        elu: state.elu,
        gc: state.gc,
        band: state.band,
        capCps: state.cap,
        tokens: state.tokens,
        cooldownMsRemaining: Math.max(0, state.cooldownUntilMs - nowMs),
        lastAction: state.lastAction,
        workerTreatedRateCps: total,
        ownAdmittedRateCps: state.ownAdmittedRateCps,
        share,
        payloadAgeMs: nowMs - state.lastPayloadAtMs,
        payloadMissingCount: state.payloadMissingCount,
      })
    }
    return out
  }

  return {
    applyPayload,
    noteRejectionPayload,
    notePayloadMissing,
    recordOwnAdmitted,
    tryConsumeFor,
    bandFor,
    sweepStale,
    snapshot,
  }
}
