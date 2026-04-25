/**
 * PR6 — proxy metrics increment as expected on the fake stack.
 *
 * Drives a few INVITEs through the proxy + load-balancer and asserts that
 * the relevant Effect-Metric counters / histograms move. We snapshot via
 * `proxyMetricsSnapshot` (re-exported by the proxy package) which reads
 * the process-global `MetricRegistry` Effect maintains.
 *
 * Why not assert on raw values? The metric registry is process-global so
 * other tests in the same `vitest run` will have left their own counts.
 * We assert deltas: snapshot before + after, then check the diff.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Metric } from "effect"
import {
  ProxyCore,
  ProxyMetrics,
  proxyMetricsSnapshot,
  WorkerId,
} from "../../../src/sip-front-proxy/index.js"
import { proxyFakeStack, pumpFor } from "../../support/proxy-fakeStack.js"

const PROXY = { host: "10.0.0.1", port: 5060 }
const ALICE = { host: "10.0.0.2", port: 5060 }
const W_A = WorkerId("worker-a")
const ADDR_A = { host: "10.0.1.10", port: 5060 }
const TRANSIT_MS = 1

const fx = proxyFakeStack({
  proxyAddr: PROXY,
  workers: [{ id: W_A, address: ADDR_A, health: "alive" }],
  transitDelayMs: TRANSIT_MS,
})

const buildInvite = (callId: string, idx: number): Buffer =>
  Buffer.from(
    [
      `INVITE sip:user@example.com SIP/2.0`,
      `Via: SIP/2.0/UDP ${ALICE.host}:${ALICE.port};branch=z9hG4bK-m-${idx};rport`,
      `Max-Forwards: 70`,
      `From: <sip:alice@${ALICE.host}>;tag=alice-${idx}`,
      `To: <sip:user@example.com>`,
      `Call-ID: ${callId}`,
      `CSeq: 1 INVITE`,
      `Contact: <sip:alice@${ALICE.host}:${ALICE.port}>`,
      `Content-Length: 0`,
      ``,
      ``,
    ].join("\r\n"),
    "utf-8"
  )

interface CountByLabel {
  readonly attrs: Readonly<Record<string, string>> | undefined
  readonly count: number
}

const countersFor = (
  snaps: ReadonlyArray<{ id: string; type: string; attributes: Readonly<Record<string, string>> | undefined; state: unknown }>,
  id: string
): ReadonlyArray<CountByLabel> => {
  const out: CountByLabel[] = []
  for (const s of snaps) {
    if (s.id !== id || s.type !== "Counter") continue
    const state = s.state as { count: number | bigint }
    const c = typeof state.count === "bigint" ? Number(state.count) : state.count
    out.push({ attrs: s.attributes, count: c })
  }
  return out
}

const sumCounter = (samples: ReadonlyArray<CountByLabel>): number =>
  samples.reduce((s, x) => s + x.count, 0)

describe("sip-front-proxy/observability — metrics increment on routing", () => {
  it.effect("INVITE increments inbound + select_new + outbound counters", () =>
    Effect.gen(function* () {
      const before = yield* proxyMetricsSnapshot
      const beforeIn = sumCounter(countersFor(before, "sip_messages_total"))
      const beforeDecisions = sumCounter(countersFor(before, "sip_routing_decision_total"))

      const proxy = yield* ProxyCore
      const alice = yield* fx.bindUac(ALICE)
      const aEp = yield* fx.bindUasFor(W_A)

      // Push 3 distinct INVITEs.
      for (let i = 0; i < 3; i++) {
        yield* alice.send(
          buildInvite(`metrics-call-${i}@alice`, i),
          proxy.localAddress.port,
          proxy.localAddress.ip
        )
      }
      yield* pumpFor(TRANSIT_MS, 4)

      // Drain at the worker so the receive-counter reflects the forward.
      for (let i = 0; i < 3; i++) yield* aEp.poll()

      const after = yield* proxyMetricsSnapshot
      const afterIn = sumCounter(countersFor(after, "sip_messages_total"))
      const afterDecisions = sumCounter(countersFor(after, "sip_routing_decision_total"))

      // 3 INVITEs in + 3 forwards out = at least 6 messages added.
      expect(afterIn - beforeIn).toBeGreaterThanOrEqual(6)
      // 3 routing decisions.
      expect(afterDecisions - beforeDecisions).toBeGreaterThanOrEqual(3)

      // Histogram for routing duration must have observed at least 3
      // points. Effect's HistogramState has a `.count` field.
      const histo = after.find(
        (s) => s.id === "sip_routing_duration_seconds" && s.type === "Histogram"
      )
      expect(histo).toBeDefined()
      const hCount = (histo!.state as { count: number }).count
      const beforeHisto = before.find(
        (s) =>
          s.id === "sip_routing_duration_seconds" &&
          s.type === "Histogram" &&
          JSON.stringify(s.attributes ?? {}) ===
            JSON.stringify(histo!.attributes ?? {})
      )
      const beforeHCount =
        beforeHisto !== undefined ? (beforeHisto.state as { count: number }).count : 0
      expect(hCount - beforeHCount).toBeGreaterThanOrEqual(3)
    }).pipe(Effect.provide(fx.layer))
  )

  it.effect("worker-health gauge gets set on setHealth", () =>
    Effect.gen(function* () {
      // Tick the gauge via the metrics service surface (HealthProbe
      // wraps it; we exercise the bare API here).
      const metrics = yield* ProxyMetrics
      yield* metrics.setWorkerHealth({ workerId: "w-gauge-test", health: "alive" })
      const snaps = yield* proxyMetricsSnapshot
      const gauges = snaps.filter(
        (s) =>
          s.id === "sip_worker_health" &&
          s.type === "Gauge" &&
          (s.attributes?.["worker_id"] ?? "") === "w-gauge-test"
      )
      // 3 entries (one per health state), only `alive` should be 1.
      expect(gauges.length).toBe(3)
      const alive = gauges.find((g) => g.attributes?.["health"] === "alive")
      expect(alive).toBeDefined()
      expect((alive!.state as { value: number }).value).toBe(1)
      const draining = gauges.find((g) => g.attributes?.["health"] === "draining")
      expect((draining!.state as { value: number }).value).toBe(0)
    }).pipe(Effect.provide(ProxyMetrics.Default))
  )
})

// Effect.Metric must be the same registry across all consumers — sanity
// check that `proxyMetricsSnapshot` and `Metric.snapshot` resolve to the
// same series. Helps catch a future refactor that accidentally creates
// per-process registry isolation.
describe("sip-front-proxy/observability — registry sharing", () => {
  it.effect("proxyMetricsSnapshot matches Metric.snapshot", () =>
    Effect.gen(function* () {
      const a = yield* proxyMetricsSnapshot
      const b = yield* Metric.snapshot
      // Snapshots are arrays of references, but the ids should fully overlap.
      const idsA = new Set(a.map((s) => `${s.id}|${JSON.stringify(s.attributes ?? {})}`))
      const idsB = new Set(b.map((s) => `${s.id}|${JSON.stringify(s.attributes ?? {})}`))
      for (const id of idsA) expect(idsB.has(id)).toBe(true)
    })
  )
})
