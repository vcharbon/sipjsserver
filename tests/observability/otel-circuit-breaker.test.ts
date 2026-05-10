/**
 * CircuitBreakerSpanExporter — pin the 1-retry-then-abandon contract
 * that protects workers from a 1 Hz ECONNREFUSED loop when the OTLP
 * collector is unreachable.
 *
 * The wrapper sits between MeasuredSpanExporter and the OTLP HTTP
 * exporter in src/main.ts. With a permanently failing inner the
 * sequence is:
 *
 *   - 1st export        → tries inner (fails) → state OPEN
 *   - export during cooldown → dropped (success cb, no inner call)
 *   - export after cooldown  → probe attempt (fails) → state ABANDONED
 *   - any subsequent export  → dropped permanently
 *
 * Net: at most 2 inner attempts, regardless of how many BSP ticks
 * occur. With a permanently healthy inner the wrapper is a pass-
 * through. With an inner that recovers during the cooldown the
 * probe closes the circuit and operation resumes.
 */

import { describe, expect, it } from "vitest"
import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import { CircuitBreakerSpanExporter } from "../../src/observability/otel-circuit-breaker.js"

const fakeSpan = (): ReadableSpan => ({} as ReadableSpan)

class ScriptedExporter implements SpanExporter {
  callCount = 0
  constructor(private readonly outcomes: ReadonlyArray<"ok" | "fail">) {}
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    const idx = this.callCount
    this.callCount++
    const which = this.outcomes[idx] ?? this.outcomes[this.outcomes.length - 1]
    if (which === "ok") cb({ code: ExportResultCode.SUCCESS })
    else cb({ code: ExportResultCode.FAILED, error: new Error("boom") })
  }
  shutdown(): Promise<void> { return Promise.resolve() }
}

const exportSync = (
  cb: CircuitBreakerSpanExporter,
  n: number,
): ExportResultCode => {
  let code: ExportResultCode = ExportResultCode.SUCCESS
  cb.export(Array.from({ length: n }, fakeSpan), (r) => { code = r.code })
  return code
}

describe("CircuitBreakerSpanExporter", () => {
  it("CLOSED → OPEN on first failure; drops during cooldown without touching inner", () => {
    const inner = new ScriptedExporter(["fail"])
    const cb = new CircuitBreakerSpanExporter(inner, {
      cooldownMs: 60_000,
      log: () => undefined,
    })

    expect(cb.state()).toBe("closed")
    expect(exportSync(cb, 3)).toBe(ExportResultCode.FAILED)
    expect(cb.state()).toBe("open")
    expect(inner.callCount).toBe(1)

    // Subsequent exports during cooldown short-circuit with SUCCESS
    // and do NOT increment the inner-exporter call count.
    expect(exportSync(cb, 5)).toBe(ExportResultCode.SUCCESS)
    expect(exportSync(cb, 7)).toBe(ExportResultCode.SUCCESS)
    expect(inner.callCount).toBe(1)
    expect(cb.droppedBySwitch()).toBe(12)
    expect(cb.attempts()).toBe(1)
  })

  it("OPEN → ABANDONED after one failed probe; never touches inner again", () => {
    const inner = new ScriptedExporter(["fail", "fail"])
    const cb = new CircuitBreakerSpanExporter(inner, {
      cooldownMs: 0,
      log: () => undefined,
    })

    exportSync(cb, 1)
    expect(cb.state()).toBe("open")
    // cooldownMs = 0 means the next call is the probe.
    exportSync(cb, 1)
    expect(cb.state()).toBe("abandoned")
    expect(inner.callCount).toBe(2)
    expect(cb.attempts()).toBe(2)

    for (let i = 0; i < 100; i++) exportSync(cb, 4)
    expect(inner.callCount).toBe(2)
    expect(cb.droppedBySwitch()).toBe(400)
    expect(cb.state()).toBe("abandoned")
  })

  it("OPEN → CLOSED if the probe succeeds; resumes pass-through behaviour", () => {
    const inner = new ScriptedExporter(["fail", "ok", "ok"])
    const cb = new CircuitBreakerSpanExporter(inner, {
      cooldownMs: 0,
      log: () => undefined,
    })

    exportSync(cb, 1)               // CLOSED → OPEN (fail)
    exportSync(cb, 1)               // probe succeeds → CLOSED
    expect(cb.state()).toBe("closed")
    expect(inner.callCount).toBe(2)

    exportSync(cb, 1)               // pass-through
    expect(inner.callCount).toBe(3)
    expect(cb.droppedBySwitch()).toBe(0)
  })

  it("CLOSED stays CLOSED while inner keeps succeeding", () => {
    const inner = new ScriptedExporter(["ok", "ok", "ok"])
    const cb = new CircuitBreakerSpanExporter(inner, {
      cooldownMs: 60_000,
      log: () => undefined,
    })

    for (let i = 0; i < 3; i++) exportSync(cb, 2)
    expect(cb.state()).toBe("closed")
    expect(inner.callCount).toBe(3)
    expect(cb.droppedBySwitch()).toBe(0)
  })
})
