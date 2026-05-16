/**
 * CircuitBreakerSpanExporter — pin the self-healing two-state
 * contract that protects workers from a 1 Hz ECONNREFUSED loop when
 * the OTLP collector is unreachable, while letting them recover
 * automatically when the collector returns.
 *
 * The wrapper sits between MeasuredSpanExporter and the OTLP HTTP
 * exporter in src/main.ts. With a permanently failing inner the
 * sequence is:
 *
 *   - 1st export        → tries inner (fails) → OPEN, cooldown = base
 *   - export during cooldown → dropped (success cb, no inner call)
 *   - export after cooldown  → probe attempt (fails) → still OPEN,
 *                              cooldown doubled, up to max
 *   - probe success at any point → CLOSED, cooldown reset to base
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

/** Mutable clock for tests — start at a non-zero epoch to catch
 *  accidental zero-baseline bugs. */
const makeClock = (start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } => {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe("CircuitBreakerSpanExporter", () => {
  it("CLOSED stays CLOSED while inner keeps succeeding", () => {
    const inner = new ScriptedExporter(["ok", "ok", "ok"])
    const cb = new CircuitBreakerSpanExporter(inner, {
      baseCooldownMs: 60_000,
      log: () => undefined,
    })

    for (let i = 0; i < 3; i++) exportSync(cb, 2)
    expect(cb.state()).toBe("closed")
    expect(inner.callCount).toBe(3)
    expect(cb.droppedBySwitch()).toBe(0)
  })

  it("CLOSED → OPEN on first failure; drops during cooldown without touching inner", () => {
    const inner = new ScriptedExporter(["fail"])
    const cb = new CircuitBreakerSpanExporter(inner, {
      baseCooldownMs: 60_000,
      log: () => undefined,
    })

    expect(cb.state()).toBe("closed")
    expect(exportSync(cb, 3)).toBe(ExportResultCode.FAILED)
    expect(cb.state()).toBe("open")
    expect(cb.currentCooldownMs()).toBe(60_000)
    expect(inner.callCount).toBe(1)

    // Subsequent exports during cooldown short-circuit with SUCCESS
    // and do NOT increment the inner-exporter call count.
    expect(exportSync(cb, 5)).toBe(ExportResultCode.SUCCESS)
    expect(exportSync(cb, 7)).toBe(ExportResultCode.SUCCESS)
    expect(inner.callCount).toBe(1)
    expect(cb.droppedBySwitch()).toBe(12)
    expect(cb.attempts()).toBe(1)
  })

  it("OPEN stays OPEN on probe failure and doubles cooldown up to max", () => {
    const clock = makeClock()
    const inner = new ScriptedExporter(["fail"]) // all subsequent calls also fail
    const cb = new CircuitBreakerSpanExporter(inner, {
      baseCooldownMs: 1_000,
      maxCooldownMs: 8_000,
      log: () => undefined,
      now: clock.now,
    })

    // Initial failure → OPEN, cooldown = base.
    exportSync(cb, 1)
    expect(cb.state()).toBe("open")
    expect(cb.currentCooldownMs()).toBe(1_000)
    expect(cb.attempts()).toBe(1)

    // Advance past cooldown; the next export is the probe — also fails.
    // Schedule: 1s → 2s → 4s → 8s → 8s (clamped).
    const expected = [2_000, 4_000, 8_000, 8_000, 8_000]
    for (const want of expected) {
      clock.advance(cb.currentCooldownMs() + 1) // cross the cooldown boundary
      exportSync(cb, 1)
      expect(cb.state()).toBe("open")
      expect(cb.currentCooldownMs()).toBe(want)
    }
    expect(cb.probeFailures()).toBe(expected.length)
    // attempts = 1 initial + 5 probes.
    expect(cb.attempts()).toBe(1 + expected.length)
  })

  it("OPEN → CLOSED if the probe succeeds; cooldown resets to base", () => {
    const clock = makeClock()
    const inner = new ScriptedExporter(["fail", "fail", "ok", "ok"])
    const cb = new CircuitBreakerSpanExporter(inner, {
      baseCooldownMs: 1_000,
      maxCooldownMs: 8_000,
      log: () => undefined,
      now: clock.now,
    })

    exportSync(cb, 1)                          // CLOSED → OPEN (fail)
    expect(cb.state()).toBe("open")
    expect(cb.currentCooldownMs()).toBe(1_000)

    clock.advance(1_500)
    exportSync(cb, 1)                          // probe fails → cooldown doubles
    expect(cb.state()).toBe("open")
    expect(cb.currentCooldownMs()).toBe(2_000)

    clock.advance(2_500)
    exportSync(cb, 1)                          // probe succeeds → CLOSED
    expect(cb.state()).toBe("closed")
    expect(cb.currentCooldownMs()).toBe(1_000) // reset to base

    // Pass-through after recovery.
    exportSync(cb, 1)
    expect(cb.state()).toBe("closed")
    expect(inner.callCount).toBe(4)
    expect(cb.droppedBySwitch()).toBe(0)
  })

  it("probes during a long outage stay sparse (cap behaviour)", () => {
    // Simulated 1 hour outage with base=30s, max=300s — expected
    // probe count in the first hour: failures at 0s, 30s, 90s, 210s,
    // 450s, 750s, 1050s, 1350s, 1650s, 1950s, 2250s, 2550s, 2850s,
    // 3150s — i.e. ≤ 15 attempts including the initial. Loose
    // upper-bound assertion: well under the BSP's natural 3600/h.
    const clock = makeClock()
    const inner = new ScriptedExporter(["fail"])
    const cb = new CircuitBreakerSpanExporter(inner, {
      baseCooldownMs: 30_000,
      maxCooldownMs: 300_000,
      log: () => undefined,
      now: clock.now,
    })

    const start = clock.now()
    // Tick the BSP at 1 Hz for a simulated hour.
    while (clock.now() - start < 3_600_000) {
      exportSync(cb, 1)
      clock.advance(1_000)
    }

    expect(cb.attempts()).toBeLessThanOrEqual(20)
    expect(cb.state()).toBe("open")
    // Every BSP tick saw at least one span dropped or attempted.
    expect(cb.droppedBySwitch() + cb.attempts()).toBe(3_600)
  })
})
