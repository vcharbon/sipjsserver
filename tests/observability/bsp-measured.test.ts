/**
 * MeasuredBatchSpanProcessor / MeasuredSpanExporter — Slice 5.1/5.2
 * of docs/plan/endurance-stuck-terminating-and-overload-hardening.md.
 *
 * The measured wrappers exist to expose `bsp_queue_depth` and
 * `bsp_dropped_total` to the metrics registry without poking the
 * upstream BSP's private fields. The tests here pin the contract:
 *
 *   1. Spans entering the BSP via `onEnd` increment `enqueuedTotal()`.
 *   2. Spans handed by the BSP to the exporter increment
 *      `exportedTotal()`.
 *   3. `queueDepth() === enqueuedTotal - exportedTotal - droppedTotal`
 *      and clamps at zero.
 *   4. `recordDrop()` is the externally-driven hook the diag bridge
 *      calls when BSP signals "buffer full".
 *
 * No real `BatchSpanProcessor` is used — a tiny `SpanProcessor` stub
 * keeps the test focused on the wrapper contract.
 */

import { describe, expect, it } from "vitest"
import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import type {
  ReadableSpan,
  SpanExporter,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import {
  MeasuredBatchSpanProcessor,
  MeasuredSpanExporter,
} from "../../src/observability/bsp-measured.js"

// ── Minimal stubs ────────────────────────────────────────────────────────

const fakeSpan = (): ReadableSpan =>
  ({} as ReadableSpan)

const fakeContext: Parameters<SpanProcessor["onStart"]>[1] = {} as never

class StubInnerExporter implements SpanExporter {
  exports: ReadableSpan[][] = []
  export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    this.exports.push(spans)
    cb({ code: ExportResultCode.SUCCESS })
  }
  shutdown(): Promise<void> { return Promise.resolve() }
}

class StubInnerProcessor implements SpanProcessor {
  ended: ReadableSpan[] = []
  onStart(): void {}
  onEnd(span: ReadableSpan): void { this.ended.push(span) }
  forceFlush(): Promise<void> { return Promise.resolve() }
  shutdown(): Promise<void> { return Promise.resolve() }
}

describe("MeasuredSpanExporter", () => {
  it("counts spans handed to the inner exporter; preserves callback semantics", async () => {
    const inner = new StubInnerExporter()
    const exp = new MeasuredSpanExporter(inner)

    expect(exp.exportedTotal()).toBe(0)

    await new Promise<void>((resolve) => {
      exp.export([fakeSpan(), fakeSpan(), fakeSpan()], (result) => {
        expect(result.code).toBe(ExportResultCode.SUCCESS)
        resolve()
      })
    })
    expect(exp.exportedTotal()).toBe(3)
    expect(inner.exports.length).toBe(1)

    await new Promise<void>((resolve) => {
      exp.export([fakeSpan()], () => resolve())
    })
    expect(exp.exportedTotal()).toBe(4)
  })

  it("counts failed exports separately while still bumping exportedTotal", async () => {
    const failingInner: SpanExporter = {
      export(_spans, cb) {
        cb({ code: ExportResultCode.FAILED, error: new Error("collector down") })
      },
      shutdown() { return Promise.resolve() },
    }
    const exp = new MeasuredSpanExporter(failingInner)
    await new Promise<void>((resolve) => exp.export([fakeSpan(), fakeSpan()], () => resolve()))
    expect(exp.exportedTotal()).toBe(2)
    expect(exp.failedExports()).toBe(1)
  })
})

describe("MeasuredBatchSpanProcessor", () => {
  it("counts onEnd into enqueuedTotal; queueDepth() = enqueued - exported - dropped, clamped at 0", () => {
    const innerExp = new StubInnerExporter()
    const exp = new MeasuredSpanExporter(innerExp)
    const innerProc = new StubInnerProcessor()
    const wrapped = new MeasuredBatchSpanProcessor(innerProc, exp, 100)

    expect(wrapped.enqueuedTotal()).toBe(0)
    expect(wrapped.queueDepth()).toBe(0)

    // Five spans enter the BSP.
    for (let i = 0; i < 5; i++) wrapped.onEnd(fakeSpan())
    expect(wrapped.enqueuedTotal()).toBe(5)
    expect(innerProc.ended.length).toBe(5)
    expect(wrapped.queueDepth()).toBe(5)

    // Three are exported (simulate BSP exporting a batch).
    return new Promise<void>((resolve) => {
      exp.export([fakeSpan(), fakeSpan(), fakeSpan()], () => {
        expect(wrapped.queueDepth()).toBe(5 - 3)
        // A drop bumps the dropped counter and trims the depth.
        wrapped.recordDrop()
        expect(wrapped.droppedTotal()).toBe(1)
        expect(wrapped.queueDepth()).toBe(5 - 3 - 1)

        // Over-export shouldn't drive depth negative.
        exp.export([fakeSpan(), fakeSpan(), fakeSpan(), fakeSpan(), fakeSpan()], () => {
          expect(wrapped.queueDepth()).toBe(0)
          resolve()
        })
      })
    })
  })

  it("forceFlush + shutdown delegate to inner without bumping counters", async () => {
    const innerExp = new StubInnerExporter()
    const exp = new MeasuredSpanExporter(innerExp)
    const innerProc = new StubInnerProcessor()
    const wrapped = new MeasuredBatchSpanProcessor(innerProc, exp, 100)

    wrapped.onEnd(fakeSpan())
    const enqueued = wrapped.enqueuedTotal()
    await wrapped.forceFlush()
    await wrapped.shutdown()
    expect(wrapped.enqueuedTotal()).toBe(enqueued)
  })

  it("exposes the configured maxQueueSize for the kill-switch supervisor", () => {
    const innerExp = new StubInnerExporter()
    const exp = new MeasuredSpanExporter(innerExp)
    const innerProc = new StubInnerProcessor()
    const wrapped = new MeasuredBatchSpanProcessor(innerProc, exp, 1024)
    expect(wrapped.maxQueueSize).toBe(1024)
  })

  it("onStart pass-through leaves the counters untouched", () => {
    const innerExp = new StubInnerExporter()
    const exp = new MeasuredSpanExporter(innerExp)
    const innerProc = new StubInnerProcessor()
    const wrapped = new MeasuredBatchSpanProcessor(innerProc, exp, 100)
    wrapped.onStart({} as never, fakeContext)
    expect(wrapped.enqueuedTotal()).toBe(0)
  })
})
