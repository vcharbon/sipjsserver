import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import {
  runLbFailoverScenario,
  unaffectedFailures,
} from "./fixtures/lbFailoverHarness.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"
const CPS = parseInt(process.env.K8S_FAILOVER_CPS ?? "20", 10)
const RAMP_S = parseInt(process.env.K8S_FAILOVER_RAMP_S ?? "5", 10)
const POSTKILL_S = parseInt(process.env.K8S_FAILOVER_POSTKILL_S ?? "10", 10)

/**
 * Phase 2b — LB failover via `kubectl exec ... -- kill -9 1`.
 *
 * Plan: docs/plan/proper-end-to-end-cheerful-lobster.md
 *
 * Companion to Phase 2a (delete --grace=0). This variant simulates an
 * in-pod crash: the kubelet sees the container exit on its own without
 * an API delete, so the K8s `deletionTimestamp` accelerant is NOT
 * available. The proxy's K8s watch on its own pod has nothing to react
 * to — only the OPTIONS keepalive timeout (3 × 2s ≈ 6s) tells the
 * remaining proxy that traffic was being conntrack'd to a dead pod.
 * In practice the kubelet restarts the container in the same pod
 * (Deployment restartPolicy: Always); pod IP stays the same.
 *
 * Same hard gate as 2a:
 *   - unaffected.failed == 0
 *   - post-kill smoke INVITE round-trip succeeds
 *   - killed proxy back to ready within 30s (here: container restart
 *     in place, not pod replacement)
 *
 * The expected differences vs. 2a — visible in the 5x4 matrix and the
 * three rollup counters in `summary.txt`, but not asserted:
 *   - re-emissions slightly higher (kube-proxy conntrack → dead pod
 *     for a few packets until OPTIONS-probe-driven endpoint removal)
 *   - establish-failures slightly higher in the pre-routed-on-dying
 *     bucket
 */
describe("k8s/proxy-failover-lb-killdash9 — Phase 2b: LB pod kill via in-pod kill -9 1", () => {
  it.live(
    "kill -9 a proxy pod under load; container restart keeps service",
    () =>
      Effect.gen(function* () {
        const result = yield* runLbFailoverScenario({
          namespace: NAMESPACE,
          killMode: "exec-kill-9",
          runIdPrefix: "lb-killdash9",
          scenarioName: "phase-2b-lb-killdash9",
          cps: CPS,
          rampSec: RAMP_S,
          postKillSec: POSTKILL_S,
        })

        expect(result.killedProxyPod).not.toBe("")
        expect(
          result.preKillCounts?.length ?? 0,
          "expected proxy log lines to carry --prefix pod identifiers for ≥2 pods",
        ).toBeGreaterThanOrEqual(2)
        expect(
          result.preKillCounts?.[0]?.[1] ?? 0,
          "expected the busiest proxy pod to have routed at least RAMP*CPS/2 INVITEs",
        ).toBeGreaterThanOrEqual(Math.floor(CPS * RAMP_S * 0.5))

        const failed = unaffectedFailures(result.classifications)
        expect(
          failed.length,
          `unaffected calls failed; samples: ${failed
            .slice(0, 5)
            .map((c) => `${c.callId}:${c.outcome}`)
            .join(", ")}`,
        ).toBe(0)

        expect(result.smokeJobStatus).toBe("succeeded")
        expect(result.smokeStats.successful).toBe(5)

        expect(
          result.proxyRecoveredMs,
          `proxy Deployment took ${result.proxyRecoveredMs}ms to recover`,
        ).toBeLessThan(30_000)
      }),
    { timeout: 240_000 },
  )
})
