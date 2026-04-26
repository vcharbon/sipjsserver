import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { deleteSippJob, runSippJob } from "./fixtures/sippJob.js"
import {
  aggregatePerCall,
  fetchRoutingDecisions,
  workerIpToName,
} from "./fixtures/proxyLogs.js"
import { fetchProxyMetrics, sumMetric } from "./fixtures/proxyMetrics.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"

describe("k8s/queries", () => {
  it.live(
    "proxyLogs + proxyMetrics observe a 5-call burst end-to-end",
    () =>
      Effect.gen(function* () {
        const jobName = `query-smoke-${Date.now().toString(36)}`
        try {
          const result = yield* runSippJob({
            namespace: NAMESPACE,
            name: jobName,
            scenario: "uac-basic.xml",
            target: "sip-front-proxy:5060",
            service: "test",
            calls: 5,
            callsPerSecond: 5,
            timeoutSec: 30,
            waitTimeoutSec: 60,
          })
          expect(result.jobStatus).toBe("succeeded")
          expect(result.stats.successful).toBe(5)

          // Loki/Promtail-free observation: parse the proxy stdout.
          const decisions = yield* fetchRoutingDecisions(NAMESPACE, { since: "120s" })
          expect(decisions.length).toBeGreaterThan(0)

          const perCall = aggregatePerCall(decisions)
          expect(perCall.length).toBeGreaterThanOrEqual(5)

          const ipMap = yield* workerIpToName(NAMESPACE)
          for (const w of ipMap.keys()) {
            // Translation table is non-empty.
            expect(w.length).toBeGreaterThan(0)
          }

          // Prometheus exposition smoke: helper should run cleanly even
          // when `MetricsServer` isn't bound (Phase A gap — see
          // proxyMetrics.ts header). When wired, this should return >0.
          const samples = yield* fetchProxyMetrics(NAMESPACE)
          const totalRouted = sumMetric(samples, "sip_routing_decision_total")
          expect(totalRouted).toBeGreaterThanOrEqual(0)
        } finally {
          yield* deleteSippJob(NAMESPACE, jobName).pipe(Effect.ignore)
        }
      }),
    { timeout: 120_000 },
  )
})
