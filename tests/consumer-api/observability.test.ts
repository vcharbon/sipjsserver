/**
 * Consumer-API gate for `@vcharbon/sipjs/observability`.
 *
 * Verifies that the OTLP layer factory + MetricsRegistry are reachable
 * via the published subpath. Does not actually flush spans to a server —
 * that requires an OTLP collector and is out of scope for unit tests.
 */

import { describe, expect, it } from "vitest"

import {
  otlpHttpTracingLayer,
  MetricsRegistry,
} from "@vcharbon/sipjs/observability"
import type { OtlpHttpTracingOptions } from "@vcharbon/sipjs/observability"

describe("@vcharbon/sipjs/observability public surface", () => {
  it("otlpHttpTracingLayer accepts the documented options shape", () => {
    const opts: OtlpHttpTracingOptions = {
      tracesUrl: "http://localhost:4318/v1/traces",
      serviceName: "consumer-api-smoke",
      serviceVersion: "1.0.0",
      maxAttributeValueLength: 4096,
    }
    const layer = otlpHttpTracingLayer(opts)
    expect(layer).toBeDefined()
    expect(typeof (layer as { pipe?: unknown }).pipe).toBe("function")
  })

  it("re-exports MetricsRegistry", () => {
    expect(MetricsRegistry).toBeDefined()
    expect(typeof MetricsRegistry.layer).toBeDefined()
  })
})
