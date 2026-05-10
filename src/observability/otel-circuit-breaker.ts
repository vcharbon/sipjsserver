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
 * This wrapper imposes a single-shot retry policy in front of the
 * inner exporter:
 *
 *   CLOSED      — pass spans straight through.
 *                 success → stay CLOSED.
 *                 failure → OPEN, schedule one probe at now+cooldown.
 *
 *   OPEN        — drop spans (callback SUCCESS so BSP buffer drains)
 *                 until `cooldown` has elapsed; the next export call
 *                 then tries the inner exporter exactly once.
 *                 probe success → CLOSED.
 *                 probe failure → ABANDONED.
 *
 *   ABANDONED   — drop spans permanently (callback SUCCESS) and never
 *                 touch the inner exporter again. `shutdown()` and
 *                 `forceFlush()` still pass through so process exit
 *                 still gets a chance to flush whatever the inner
 *                 exporter cached.
 *
 * Net behaviour with a dead collector:
 *   - 1 real export attempt + 1 probe attempt (= 2 HTTP attempts).
 *   - Then silent until process exit. No diag-bridge log spam, no
 *     wasted Node event-loop ticks attempting export.
 *
 * Returning `SUCCESS` for dropped batches is intentional: the BSP
 * uses the result code to decide whether to re-enqueue / log a
 * "Dropping span" warning, and we want neither — once we've decided
 * to abandon we'd rather the BSP queue drain quickly. The
 * `MeasuredSpanExporter` wrapping us still records `exportedTotal`
 * for those batches (which is fine — they did leave the BSP), and
 * we publish our own `droppedBySwitch` counter for ground truth.
 */

import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { Effect } from "effect"

export type CircuitState = "closed" | "open" | "abandoned"

export interface CircuitBreakerOptions {
  /**
   * How long to wait after the first failure before allowing the one
   * probe attempt that decides whether we close or abandon.
   *
   * Default: 30 s — long enough to avoid retry chatter, short enough
   * that a transient collector outage during deployment recovers
   * without operator intervention.
   */
  readonly cooldownMs?: number
  /**
   * Optional logger. Default: route through the Effect logger so the
   * three state transitions (open / abandoned / re-closed) appear in
   * the same pod-log stream as the rest of the OTel diagnostics.
   */
  readonly log?: (
    level: "info" | "warn",
    message: string,
  ) => void
}

const defaultLog = (level: "info" | "warn", message: string): void => {
  if (level === "warn") Effect.runFork(Effect.logWarning(message))
  else Effect.runFork(Effect.logInfo(message))
}

export class CircuitBreakerSpanExporter implements SpanExporter {
  private _state: CircuitState = "closed"
  private _openedAt = 0
  private _cooldownMs: number
  private _log: NonNullable<CircuitBreakerOptions["log"]>
  private _droppedBySwitch = 0
  private _attempts = 0
  private _consecutiveFailures = 0

  constructor(
    private readonly inner: SpanExporter,
    opts: CircuitBreakerOptions = {},
  ) {
    this._cooldownMs = opts.cooldownMs ?? 30_000
    this._log = opts.log ?? defaultLog
  }

  state(): CircuitState {
    return this._state
  }

  /** Spans this wrapper short-circuited (i.e. did not hand to inner). */
  droppedBySwitch(): number {
    return this._droppedBySwitch
  }

  /** Total inner-exporter calls (initial export + at most one probe). */
  attempts(): number {
    return this._attempts
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const now = Date.now()
    if (this._state === "abandoned") {
      this._droppedBySwitch += spans.length
      resultCallback({ code: ExportResultCode.SUCCESS })
      return
    }
    if (this._state === "open" && now - this._openedAt < this._cooldownMs) {
      this._droppedBySwitch += spans.length
      resultCallback({ code: ExportResultCode.SUCCESS })
      return
    }
    // CLOSED, or OPEN past cooldown (the one probe attempt).
    const wasProbe = this._state === "open"
    this._attempts++
    this.inner.export(spans, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        this._consecutiveFailures = 0
        if (this._state !== "closed") {
          this._state = "closed"
          this._log("info", "[otel] exporter circuit closed (collector reachable)")
        }
      } else {
        this._consecutiveFailures++
        if (wasProbe) {
          this._state = "abandoned"
          this._log(
            "warn",
            "[otel] exporter circuit ABANDONED — collector unreachable after probe; spans will be dropped silently for the rest of this process",
          )
        } else if (this._state === "closed") {
          this._state = "open"
          this._openedAt = now
          this._log(
            "warn",
            `[otel] exporter circuit opened — collector unreachable; cooling down ${Math.round(this._cooldownMs / 1000)}s before single probe attempt`,
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
