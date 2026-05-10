/**
 * Measured wrappers for the OTel `BatchSpanProcessor` + `SpanExporter`
 * pair (Slice 5 of
 * docs/plan/endurance-stuck-terminating-and-overload-hardening.md).
 *
 * The upstream BSP exposes neither its current queue depth nor its
 * dropped-span counter publicly — both are private fields. Rather than
 * peek at `(bsp as any)._finishedSpans`, this module wraps both ends:
 *
 *   - `MeasuredSpanExporter` counts spans that the BSP hands to the
 *     underlying exporter (i.e. spans that have left the BSP buffer).
 *   - `MeasuredBatchSpanProcessor` counts spans that enter the BSP via
 *     `onEnd`. The difference (`enqueued - exported`) is a tight
 *     upper-bound estimate of the BSP's internal queue depth.
 *
 * The decorator also publishes its own `dropped` counter — incremented
 * when the BSP itself signals "buffer full" via the `diag` channel
 * (see `src/observability/otel-diag.ts`). Plumbing the BSP error to
 * our counter without a custom span processor would mean parsing the
 * diag log line; instead we just expose the counter and surface the
 * BSP warning through `diag.setLogger` at boot.
 *
 * Construction is intentionally a thin facade — call sites build the
 * inner exporter, wrap it, build the BSP with the wrap, then wrap the
 * BSP. Both wrappers satisfy their respective OTel interfaces so the
 * NodeSdk wiring above is unchanged.
 */

import type { Context } from "@opentelemetry/api"
import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import type { Span } from "@opentelemetry/sdk-trace-base"
import type {
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base"

/**
 * Counts spans handed to the wrapped exporter. `exportedTotal()` is
 * monotonically increasing; the BSP decorator below subtracts this
 * from its enqueue count to estimate live queue depth.
 *
 * Failed exports still count toward the total — what matters for
 * heap-pressure tracking is "spans that left the BSP buffer", not
 * "spans that landed at the collector".
 */
export class MeasuredSpanExporter implements SpanExporter {
  private _exportedTotal = 0
  private _failedExports = 0

  constructor(private readonly inner: SpanExporter) {}

  exportedTotal(): number {
    return this._exportedTotal
  }

  failedExports(): number {
    return this._failedExports
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this._exportedTotal += spans.length
    this.inner.export(spans, (result) => {
      if (result.code !== ExportResultCode.SUCCESS) {
        this._failedExports++
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

/**
 * Wraps a `BatchSpanProcessor` (or any other `SpanProcessor`) and
 * tallies spans entering via `onEnd`. Combined with
 * `MeasuredSpanExporter.exportedTotal()`, this lets us estimate the
 * BSP's live queue depth without touching its private fields.
 *
 * `onStart` and `forceFlush` are pass-through. `onEnd` is also
 * pass-through — we deliberately do NOT impose our own bound here:
 * the BSP's own `maxQueueSize` is the heap-cap mechanism. Counting
 * is purely observational.
 */
export class MeasuredBatchSpanProcessor implements SpanProcessor {
  private _enqueuedTotal = 0
  private _droppedTotal = 0

  constructor(
    private readonly inner: SpanProcessor,
    private readonly exporter: MeasuredSpanExporter,
    /**
     * Static `maxQueueSize` of the wrapped BSP — needed so the kill
     * switch can compare depth to capacity without re-reading the
     * BSP's private config.
     */
    readonly maxQueueSize: number,
  ) {}

  enqueuedTotal(): number {
    return this._enqueuedTotal
  }

  droppedTotal(): number {
    return this._droppedTotal
  }

  /**
   * Bumped externally by the diag-bridge layer in `otel-diag.ts` when
   * the BSP logs a "Dropping span because buffer is full" warning.
   * Surfacing it here keeps the metric source-of-truth alongside the
   * other BSP counters.
   */
  recordDrop(): void {
    this._droppedTotal++
  }

  /**
   * Estimated current depth of the BSP buffer. Lower-bound:
   * `enqueued - exported`. This is exact when the inner BSP exports
   * lazily on a fixed schedule and never drops; it overshoots by
   * `droppedTotal` when the BSP has shed spans we still counted as
   * enqueued (the diag callback increments dropped *after* the BSP
   * decided to drop).
   */
  queueDepth(): number {
    const depth = this._enqueuedTotal - this.exporter.exportedTotal() - this._droppedTotal
    return depth < 0 ? 0 : depth
  }

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext)
  }

  onEnd(span: ReadableSpan): void {
    this._enqueuedTotal++
    this.inner.onEnd(span)
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush()
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }
}
