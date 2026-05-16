/**
 * Circuit-breaker wrapper for an OTel `SpanExporter`.
 *
 * Motivation: when the OTLP collector is unreachable, the BSP wakes
 * every `scheduledDelayMillis` (1 s in our config) and hands the
 * exporter a fresh batch. The OTLP HTTP exporter resolves
 * transport-level failures (e.g. ECONNREFUSED) immediately as a
 * non-retryable failure, so each tick produces one diag log line
 * forever. On the worker pods that's measurable CPU spent on a hot
 * loop that produces no useful telemetry.
 *
 * This wrapper imposes a self-healing two-state policy in front of
 * the inner exporter:
 *
 *   CLOSED      — pass spans straight through.
 *                 success → stay CLOSED.
 *                 failure → OPEN, cooldown = baseCooldownMs.
 *
 *   OPEN        — drop spans (callback SUCCESS so BSP buffer drains)
 *                 until `cooldown` has elapsed; the next export call
 *                 then tries the inner exporter exactly once (a probe).
 *                 probe success → CLOSED, cooldown reset to base.
 *                 probe failure → stay OPEN, cooldown doubled up to
 *                                 maxCooldownMs.
 *
 * Net behaviour with a permanently dead collector: probes are spaced
 * 30s, 60s, 120s, 240s, 300s, 300s, … so roughly 8 HTTP attempts in
 * the first hour and ~4/hour after — significantly cheaper than the
 * BSP's natural 1 Hz attempt rate. A single probe success closes the
 * circuit and resumes pass-through with no operator action, fixing
 * the 2026-05-15 endurance failure where a transient collector blip
 * left one worker tracing-dark for the rest of the run.
 *
 * Returning `SUCCESS` for dropped batches is intentional: the BSP
 * uses the result code to decide whether to re-enqueue / log a
 * "Dropping span" warning, and we want neither while open — we'd
 * rather the BSP queue drain quickly. The `MeasuredSpanExporter`
 * wrapping us still records `exportedTotal` for those batches (they
 * did leave the BSP), and we publish our own `droppedBySwitch` and
 * `probeFailures` counters for ground truth.
 */

import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { Effect } from "effect"

export type CircuitState = "closed" | "open"

export interface CircuitBreakerOptions {
  /**
   * Base cooldown after the first failure, and the value the cooldown
   * resets to after a probe success. Default: 30 s — long enough to
   * avoid retry chatter, short enough to recover from a brief
   * collector outage automatically.
   */
  readonly baseCooldownMs?: number
  /**
   * Upper bound on the exponentially-growing cooldown for a
   * permanently-failing inner exporter. Default: 300 s (5 min).
   */
  readonly maxCooldownMs?: number
  /**
   * Optional logger. Default: route through the Effect logger so the
   * two state transitions (open / re-closed) appear in the same pod-
   * log stream as the rest of the OTel diagnostics.
   */
  readonly log?: (
    level: "info" | "warn",
    message: string,
  ) => void
  /**
   * Clock injection for tests. Defaults to `Date.now`.
   */
  readonly now?: () => number
}

const defaultLog = (level: "info" | "warn", message: string): void => {
  if (level === "warn") Effect.runFork(Effect.logWarning(message))
  else Effect.runFork(Effect.logInfo(message))
}

export class CircuitBreakerSpanExporter implements SpanExporter {
  private _state: CircuitState = "closed"
  private _openedAt = 0
  private readonly _baseCooldownMs: number
  private readonly _maxCooldownMs: number
  private _cooldownMs: number
  private _log: NonNullable<CircuitBreakerOptions["log"]>
  private _now: NonNullable<CircuitBreakerOptions["now"]>
  private _droppedBySwitch = 0
  private _attempts = 0
  private _probeFailures = 0
  private _consecutiveFailures = 0

  constructor(
    private readonly inner: SpanExporter,
    opts: CircuitBreakerOptions = {},
  ) {
    this._baseCooldownMs = opts.baseCooldownMs ?? 30_000
    this._maxCooldownMs = opts.maxCooldownMs ?? 300_000
    this._cooldownMs = this._baseCooldownMs
    this._log = opts.log ?? defaultLog
    this._now = opts.now ?? Date.now
  }

  state(): CircuitState {
    return this._state
  }

  /** Spans this wrapper short-circuited (i.e. did not hand to inner). */
  droppedBySwitch(): number {
    return this._droppedBySwitch
  }

  /** Total inner-exporter calls (initial export + every probe). */
  attempts(): number {
    return this._attempts
  }

  /** Probe attempts that failed (while already OPEN). */
  probeFailures(): number {
    return this._probeFailures
  }

  /** Current cooldown window, in ms. Resets to base on recovery. */
  currentCooldownMs(): number {
    return this._cooldownMs
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const now = this._now()
    if (this._state === "open" && now - this._openedAt < this._cooldownMs) {
      this._droppedBySwitch += spans.length
      resultCallback({ code: ExportResultCode.SUCCESS })
      return
    }
    // CLOSED, or OPEN past cooldown (probe attempt).
    const wasProbe = this._state === "open"
    this._attempts++
    this.inner.export(spans, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        this._consecutiveFailures = 0
        if (this._state !== "closed") {
          this._state = "closed"
          this._cooldownMs = this._baseCooldownMs
          this._log("info", "[otel] exporter circuit closed (collector reachable)")
        }
      } else {
        this._consecutiveFailures++
        if (wasProbe) {
          // Stay OPEN, back off further. Silent — log only on
          // transitions, not on repeated probe failures, to keep
          // the pod log clean during a multi-minute outage.
          this._probeFailures++
          this._cooldownMs = Math.min(this._cooldownMs * 2, this._maxCooldownMs)
          this._openedAt = now
        } else if (this._state === "closed") {
          this._state = "open"
          this._cooldownMs = this._baseCooldownMs
          this._openedAt = now
          this._log(
            "warn",
            `[otel] exporter circuit opened — collector unreachable; cooling down ${Math.round(this._cooldownMs / 1000)}s before probe (max ${Math.round(this._maxCooldownMs / 1000)}s)`,
          )
        }
      }
      resultCallback(result)
    })
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve()
  }
}
