/**
 * Bridge OpenTelemetry SDK diagnostics into the Effect logger and the
 * BSP drop counter (Slice 5.2 of
 * docs/plan/endurance-stuck-terminating-and-overload-hardening.md).
 *
 * Without this, the BSP's "Dropping span because buffer is full"
 * warning lands in stderr unobserved — operators can't see that the
 * pipeline is shedding load. Wiring `diag.setLogger` once at process
 * boot routes every SDK warning/error through our structured logger
 * AND increments the BSP decorator's drop counter when the upstream
 * BSP signals a buffer-full drop.
 *
 * The function is idempotent — calling it twice replaces the prior
 * registration. Callers only need to invoke it once at startup, but
 * tests that re-launch a fresh OTel SDK call it again with a fresh
 * counter sink.
 */

import { diag, DiagLogLevel, type DiagLogger } from "@opentelemetry/api"
import { Effect } from "effect"
import type { MeasuredBatchSpanProcessor } from "./bsp-measured.js"

const DROP_MARKERS = [
  // BatchSpanProcessorBase emits this when its buffer is full.
  "Dropping span",
  // OTLP exporter emits these on collector unreachability.
  "Items were not delivered",
]

const looksLikeDrop = (message: string): boolean =>
  DROP_MARKERS.some((m) => message.includes(m))

export const installOtelDiagBridge = (
  bsp: MeasuredBatchSpanProcessor,
): void => {
  const logger: DiagLogger = {
    error: (msg, ..._args) => {
      if (looksLikeDrop(msg)) bsp.recordDrop()
      Effect.runFork(Effect.logError(`[otel] ${msg}`))
    },
    warn: (msg, ..._args) => {
      if (looksLikeDrop(msg)) bsp.recordDrop()
      Effect.runFork(Effect.logWarning(`[otel] ${msg}`))
    },
    info: (msg, ..._args) => {
      Effect.runFork(Effect.logInfo(`[otel] ${msg}`))
    },
    debug: (msg, ..._args) => {
      Effect.runFork(Effect.logDebug(`[otel] ${msg}`))
    },
    verbose: (msg, ..._args) => {
      Effect.runFork(Effect.logTrace(`[otel] ${msg}`))
    },
  }
  diag.setLogger(logger, DiagLogLevel.WARN)
}
