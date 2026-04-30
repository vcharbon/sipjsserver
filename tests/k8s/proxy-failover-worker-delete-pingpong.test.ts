import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import {
  postKillReinviteSuccesses,
  runWorkerFailoverScenario,
  unaffectedFailures,
} from "./fixtures/workerFailoverHarness.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"
const CPS = parseInt(process.env.K8S_FAILOVER_CPS_C ?? "10", 10)
const RAMP_S = parseInt(process.env.K8S_FAILOVER_RAMP_S_C ?? "15", 10)
const POSTKILL_S = parseInt(process.env.K8S_FAILOVER_POSTKILL_S_C ?? "30", 10)

/**
 * Phase 3a-C — Worker failover via `kubectl delete --grace-period=0
 *              --force`, ping-pong lifecycle.
 *
 * Plan: docs/plan/proper-end-to-end-cheerful-lobster.md (Phase 3 §C).
 *
 * Headline test for the data-replication slices PLUS the ReadyGate
 * boot drain. Sipp scenario: uac-pingpong.xml — INVITE → ACK → 10s →
 * re-INVITE(1) → ACK → 10s → re-INVITE(2) → ACK → 10s → BYE.
 *
 * With the kill timed during sustained 10cps load, the population of
 * in-flight calls is in mixed phases at T_kill. Some calls have
 * already passed re-INVITE(2) — their final BYE must survive. Some
 * are between re-INVITE(1) and re-INVITE(2) — their re-INVITE(2) AND
 * BYE must survive. Some haven't reached re-INVITE(1) — same as the
 * 3a-B hold case.
 *
 * Important: re-INVITE(2) after the kill may land on EITHER the
 * backup B (if the proxy hasn't seen the StatefulSet replacement yet)
 * OR the restored primary P (if the new pod is up and ReadyGate has
 * drained). The test does NOT pin which worker handles it — only
 * that the call survives end-to-end.
 *
 * Sizing: 10 cps × 15s ramp + kill at T=15s + 30s post-kill + 30s
 * drain ≈ 80s wall, ~450 calls. Lower cps than 3a-B because each call
 * lasts ~40s; 800 concurrent dialogs at 20 cps stresses kind.
 *
 * Hard asserts:
 *  - unaffected.failed == 0 (regression net for surviving worker)
 *  - established-on-dying > 0 (sanity: kill hit calls actually mid-call)
 *  - postKillReinviteSuccesses > 0 (sanity: the pingpong failover path
 *    was exercised, not just the simple case)
 *  - post-kill smoke INVITE round-trip succeeds
 *  - StatefulSet back to replicaCount within 60s
 */
describe("k8s/proxy-failover-worker-delete-pingpong — Phase 3a-C", () => {
  it.live(
    "delete --grace=0 a worker mid-pingpong; failover + restored-primary",
    () =>
      Effect.gen(function* () {
        const result = yield* runWorkerFailoverScenario({
          namespace: NAMESPACE,
          killMode: "delete-grace0",
          runIdPrefix: "worker-delete-pingpong",
          scenario: "uac-pingpong.xml",
          scenarioName: "phase-3a-C-worker-delete-pingpong",
          cps: CPS,
          rampSec: RAMP_S,
          postKillSec: POSTKILL_S,
          // Each call is ~40s; need enough headroom for sipp to drain.
          sippTimeoutSec: 180,
          sippWaitTimeoutSec: 240,
        })

        expect(result.killedWorkerPod).not.toBe("")
        expect(result.killedWorkerIp).not.toBe("")
        expect(
          result.preKillCounts?.length ?? 0,
          "expected at least 2 worker IPs in routing log",
        ).toBeGreaterThanOrEqual(2)

        expect(
          result.establishedOnDyingCount,
          "expected at least one established-on-dying call",
        ).toBeGreaterThan(0)

        const postKillReinvites = postKillReinviteSuccesses(result)
        expect(
          postKillReinvites,
          "expected at least one call to have its second re-INVITE land after T_kill" +
            " and still succeed end-to-end (the pingpong failover path)",
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
    { timeout: 360_000 },
  )
})
