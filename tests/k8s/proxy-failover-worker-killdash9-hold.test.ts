import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import {
  runWorkerFailoverScenario,
  unaffectedFailures,
} from "./fixtures/workerFailoverHarness.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"
const CPS = parseInt(process.env.K8S_FAILOVER_CPS ?? "20", 10)
const RAMP_S = parseInt(process.env.K8S_FAILOVER_RAMP_S ?? "5", 10)
const POSTKILL_S = parseInt(process.env.K8S_FAILOVER_POSTKILL_S ?? "10", 10)

/**
 * Phase 3b-B — Worker failover via `kubectl exec -- kill -9 1`,
 *              hold-then-BYE lifecycle.
 *
 * Plan: docs/plan/proper-end-to-end-cheerful-lobster.md (Phase 3 §B).
 *
 * Companion to Phase 3a-B (delete --grace=0). Same scenario, same hard
 * gate. The difference is the kill mode: an in-pod `kill -9 1` simulates
 * a process crash where the kubelet sees the container exit on its own
 * with no API-level deletionTimestamp accelerant. The proxy's K8s watch
 * has nothing to react to; only OPTIONS keepalive timeout (3 × 2s ≈ 6s)
 * tells it the worker is dead.
 *
 * In practice the kubelet restarts the worker container in the same pod
 * (StatefulSet restartPolicy: Always); pod IP stays the same. The
 * sidecar Redis container is unaffected and keeps holding pri:/bak:
 * keys across the worker container's restart, so on restart the worker
 * does NOT need to drain its own primary keys from peers — only the
 * peer's bak: data needs no action (it's still a backup, plus its own
 * primary calls survive in its sidecar untouched).
 */
describe("k8s/proxy-failover-worker-killdash9-hold — Phase 3b-B", () => {
  it.live(
    "kill -9 a worker mid-hold; container restart + dual-write keep BYE alive",
    () =>
      Effect.gen(function* () {
        const result = yield* runWorkerFailoverScenario({
          namespace: NAMESPACE,
          killMode: "exec-kill-9",
          runIdPrefix: "worker-killdash9-hold",
          scenario: "uac-hold-failover.xml",
          scenarioName: "phase-3b-B-worker-killdash9-hold",
          cps: CPS,
          rampSec: RAMP_S,
          postKillSec: POSTKILL_S,
          sippTimeoutSec: 60,
          sippWaitTimeoutSec: 90,
        })

        expect(result.killedWorkerPod).not.toBe("")
        expect(result.killedWorkerIp).not.toBe("")
        expect(
          result.preKillCounts?.length ?? 0,
          "expected at least 2 worker IPs in routing log",
        ).toBeGreaterThanOrEqual(2)
        expect(
          result.preKillCounts?.[0]?.[1] ?? 0,
          "expected the busiest worker to have routed at least RAMP*CPS/2 INVITEs",
        ).toBeGreaterThanOrEqual(Math.floor(CPS * RAMP_S * 0.5))

        expect(
          result.establishedOnDyingCount,
          "expected at least one established-on-dying call",
        ).toBeGreaterThan(0)

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
          result.workerRecoveredMs,
          `worker StatefulSet took ${result.workerRecoveredMs}ms to recover`,
        ).toBeLessThan(60_000)
      }),
    { timeout: 240_000 },
  )
})
