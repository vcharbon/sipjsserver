/**
 * Cross-component config validation for the SIP front proxy.
 *
 * Some invariants live BETWEEN components (HealthProbe ↔ WorkerLoadObserver)
 * and cannot be enforced by either component's schema in isolation —
 * by the time `WorkerLoadObserver.layer(cfg)` is built, the HealthProbe
 * timings have already been passed to `optionsKeepaliveLayer` and are
 * no longer visible.
 *
 * This module assembles the cross-cutting facts and rejects misconfigurations
 * that have caused real outages. It is deliberately:
 *   - **Pure**: no Effect, no logging, no I/O. Pure data in, structured
 *     result out. Trivial to unit-test.
 *   - **Throw-on-violation when called from `bin/`**: a misconfigured pod
 *     MUST not boot. Returning `{ ok: false }` silently and letting the
 *     cluster come up unhealthy is exactly what we are trying to prevent.
 *
 * Background: on 2026-05-25 the deployed Helm chart used
 * `intervalMs=2000 timeoutMs=1500` (cycle=3500 ms) but the
 * `WorkerLoadObserver` shipped with `payloadStaleMs=3000 ms`. The 1-second
 * sweep fiber caught `age > 3000` between probe-recv events on ~half of
 * cycles, halving the per-worker admit cap every time. Within ~20 s of
 * uptime the cap collapsed to `capFloorCps=1` and never recovered — the
 * cluster silently throttled every worker to 1 cps per LB. The check
 * `payloadStaleMs >= 2 × probeCycleMs` enforced below would have refused
 * to start that pod.
 */

import type { WorkerLoadObserverConfigData } from "./WorkerLoadObserver.js"

/**
 * Subset of HealthProbe options we need for cross-cutting validation.
 * Kept structural (not importing the full `OptionsKeepaliveOpts`) so the
 * validator stays decoupled from probe-layer construction.
 */
export interface ProbeTimingConfig {
  readonly intervalMs: number
  readonly timeoutMs: number
}

export type ProxyConfigValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: ReadonlyArray<string> }

/**
 * Cross-component invariants the deployed proxy MUST satisfy.
 *
 * Each rule is justified inline so a future operator who hits one knows
 * why we refuse to start, and so any rule we soften later is a deliberate
 * change rather than an accidental loosening.
 */
export const validateProxyConfig = (
  probe: ProbeTimingConfig,
  observer: WorkerLoadObserverConfigData,
): ProxyConfigValidationResult => {
  const violations: string[] = []

  // Each value individually positive — guards a typo (e.g. 0 ms timeout)
  // that would otherwise produce confusing downstream behaviour.
  if (!Number.isFinite(probe.intervalMs) || probe.intervalMs <= 0) {
    violations.push(
      `healthProbe.intervalMs must be a positive finite number (got ${probe.intervalMs}).`,
    )
  }
  if (!Number.isFinite(probe.timeoutMs) || probe.timeoutMs <= 0) {
    violations.push(
      `healthProbe.timeoutMs must be a positive finite number (got ${probe.timeoutMs}).`,
    )
  }
  if (!Number.isFinite(observer.payloadStaleMs) || observer.payloadStaleMs <= 0) {
    violations.push(
      `workerLoadObserver.payloadStaleMs must be positive (got ${observer.payloadStaleMs}).`,
    )
  }

  // PRIMARY INVARIANT — the bug from the 2026-05-25 RCA.
  //
  // `HealthProbe.tickLoop` runs:
  //   sleep(intervalMs) → fanOutOptions → sleep(timeoutMs) → reap
  // so successive OPTIONS replies arrive `intervalMs + timeoutMs` apart
  // (the worker's reply is typically <10 ms but the next probe doesn't
  // ship until the timeout sleep elapses).
  //
  // If `payloadStaleMs < probeCycle`, `sweepStale` fires during the gap,
  // halves the cap, and the next probe-recv overwrites `lastAction` so the
  // event is invisible. The cap collapses to `capFloorCps` in ~5 cycles.
  //
  // `2×` provides one full cycle of safety margin for probe jitter (event-
  // loop pressure, packet loss, retries). A `1.5×` margin still races with
  // sweep phase; `2×` is the smallest value that survives a single
  // dropped probe without triggering the floor cascade.
  const probeCycleMs = probe.intervalMs + probe.timeoutMs
  const minStale = 2 * probeCycleMs
  if (Number.isFinite(probeCycleMs) && observer.payloadStaleMs < minStale) {
    violations.push(
      `workerLoadObserver.payloadStaleMs (${observer.payloadStaleMs} ms) ` +
        `must be at least 2× the HealthProbe cycle ` +
        `(intervalMs + timeoutMs = ${probe.intervalMs} + ${probe.timeoutMs} = ${probeCycleMs} ms; ` +
        `minimum allowed payloadStaleMs = ${minStale} ms). ` +
        "Otherwise sweepStale halves the per-worker admit cap on most probe cycles " +
        "and the cluster silently throttles every worker to capFloorCps. " +
        "See src/sip-front-proxy/config-validation.ts for the calibration rationale.",
    )
  }

  // Cap-band sanity. Cheap typo guards.
  if (observer.capFloorCps <= 0) {
    violations.push(`capFloorCps must be > 0 (got ${observer.capFloorCps}).`)
  }
  if (observer.capFloorCps > observer.capInitialCps) {
    violations.push(
      `capFloorCps (${observer.capFloorCps}) must be <= capInitialCps (${observer.capInitialCps}).`,
    )
  }
  if (observer.capInitialCps > observer.capCeilingCps) {
    violations.push(
      `capInitialCps (${observer.capInitialCps}) must be <= capCeilingCps (${observer.capCeilingCps}).`,
    )
  }

  // ELU band ordering + hysteresis. A reversed band threshold turns the
  // controller inside-out (low ELU triggers `above_critical`). Hysteresis
  // wider than a band gap means `computeBand` cannot exit the higher band
  // even at zero ELU.
  if (!(observer.eluSoft < observer.eluHard && observer.eluHard < observer.eluCritical)) {
    violations.push(
      `ELU band thresholds must satisfy eluSoft < eluHard < eluCritical ` +
        `(got eluSoft=${observer.eluSoft}, eluHard=${observer.eluHard}, eluCritical=${observer.eluCritical}).`,
    )
  }
  const minBandGap = Math.min(
    observer.eluHard - observer.eluSoft,
    observer.eluCritical - observer.eluHard,
  )
  if (observer.bandHysteresis < 0 || observer.bandHysteresis >= minBandGap) {
    violations.push(
      `bandHysteresis (${observer.bandHysteresis}) must be in [0, min band gap) — ` +
        `min gap is ${minBandGap}. A hysteresis wider than a band traps the ` +
        "controller in the higher band even at zero ELU.",
    )
  }

  // Cooldown must outlast at least one probe cycle. A shorter cooldown
  // lets the AIMD ladder yo-yo on a single noisy probe; longer than one
  // cycle is what the cooldown is *for*.
  const cooldownMs = observer.aimdCooldownTicks * observer.optionsIntervalMs
  if (Number.isFinite(probeCycleMs) && cooldownMs < probeCycleMs) {
    violations.push(
      `aimd cooldown (${observer.aimdCooldownTicks} × ${observer.optionsIntervalMs} = ${cooldownMs} ms) ` +
        `must be >= one HealthProbe cycle (${probeCycleMs} ms) so a single decrease isn't ` +
        "immediately followed by an increase tick.",
    )
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

/**
 * Throwing variant. Use from `bin/` startup paths so a misconfigured pod
 * exits non-zero (CrashLoopBackOff) instead of booting unhealthy. The
 * error message is structured for log scraping: each violation is on its
 * own line after a fixed prefix.
 */
export const assertValidProxyConfig = (
  probe: ProbeTimingConfig,
  observer: WorkerLoadObserverConfigData,
): void => {
  const result = validateProxyConfig(probe, observer)
  if (result.ok) return
  const header = "sip-front-proxy: refusing to start — invalid configuration:"
  const bullets = result.violations.map((v) => `  - ${v}`).join("\n")
  throw new Error(`${header}\n${bullets}`)
}
