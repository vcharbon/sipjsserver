/**
 * PR6 — MetricsServer serves Prometheus exposition.
 *
 * Boots the server on port 0 (OS picks free), tickles a counter, GETs
 * `/metrics`, and asserts the body is valid Prometheus text containing
 * the expected `# TYPE` and `# HELP` lines for our own metrics.
 *
 * No `it.effect` here — we want the *real* HTTP runtime, not TestClock.
 * Vitest's plain `it` is fine; we run a small Effect program via
 * `Effect.runPromise` and tear down on completion.
 */

import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import {
  MetricsServer,
  ProxyMetrics,
} from "../../../src/sip-front-proxy/index.js"

const fetchText = async (url: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(url)
  const body = await res.text()
  return { status: res.status, body }
}

describe("sip-front-proxy/observability — MetricsServer", () => {
  it("serves Prometheus exposition with our metric names", async () => {
    const program = Effect.gen(function* () {
      const metrics = yield* ProxyMetrics
      // Move several distinct metric families so the snapshot has
      // counters, gauges, and histograms to render.
      yield* metrics.recordMessage({
        direction: "inbound",
        methodOrStatus: "INVITE",
        result: "forwarded",
      })
      yield* metrics.recordRoutingDecision({
        strategy: "TestStrategy",
        kind: "select_new",
      })
      yield* metrics.observeRoutingDuration({
        strategy: "TestStrategy",
        decision: "select_new",
        durationSeconds: 0.0008,
      })
      yield* metrics.setWorkerHealth({ workerId: "w-srv-test", health: "alive" })

      const server = yield* MetricsServer
      const { host, port } = server.address
      // The OS resolves "0.0.0.0" → listen on every interface; tests
      // hit it on 127.0.0.1.
      const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/metrics`

      // We're inside Effect but fetch is fine to call as a Promise.
      const res = yield* Effect.promise(() => fetchText(url))
      return res
    })

    const layer = Layer.mergeAll(
      ProxyMetrics.Default,
      MetricsServer.layer({ host: "127.0.0.1", port: 0 })
    )

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.scoped)
    )

    expect(result.status).toBe(200)
    expect(result.body).toContain("# TYPE sip_messages_total counter")
    expect(result.body).toContain("# TYPE sip_routing_decision_total counter")
    expect(result.body).toContain("# TYPE sip_routing_duration_seconds histogram")
    expect(result.body).toContain("# TYPE sip_worker_health gauge")
    // At least one metric line ends with a number after a labelled name.
    expect(result.body).toMatch(/sip_messages_total\{[^}]+\}\s+\d+/)
    // Histogram suffixes present.
    expect(result.body).toMatch(/sip_routing_duration_seconds_bucket\{[^}]+\}\s+\d+/)
    expect(result.body).toMatch(/sip_routing_duration_seconds_sum\{[^}]+\}/)
    expect(result.body).toMatch(/sip_routing_duration_seconds_count\{[^}]+\}/)
  })

  it("returns 404 for non-/metrics URLs", async () => {
    const program = Effect.gen(function* () {
      const server = yield* MetricsServer
      const { host, port } = server.address
      const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/healthz`
      return yield* Effect.promise(() => fetchText(url))
    })

    const layer = Layer.mergeAll(
      ProxyMetrics.Default,
      MetricsServer.layer({ host: "127.0.0.1", port: 0 })
    )

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.scoped)
    )
    expect(result.status).toBe(404)
  })
})
