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
 * Phase 3a-B — Worker failover via `kubectl delete --grace-period=0
 *              --force`, hold-then-BYE lifecycle.
 *
 * Plan: docs/plan/proper-end-to-end-cheerful-lobster.md (Phase 3 §B).
 *
 * Headline test for the data-replication slices (3-7). The b2bua-worker
 * StatefulSet runs replicaCount=2 with per-pod Redis sidecars and
 * production HTTP wiring of `ReplPuller` + `ReadyGate`. Calls landing
 * on worker-N are dual-written: pri:N:call:* on N's sidecar, bak:N:
 * call:* on the backup peer's sidecar. When N is API-deleted, the proxy
 * detects the loss via OPTIONS keepalive (3 × 2s ≈ 6s) and reroutes
 * in-dialog packets to the cookie's `w_bak`, which the backup hydrates
 * from its bak: partition.
 *
 * Sipp scenario: uac-hold-failover.xml — INVITE → ACK → 10s pause → BYE.
 * The 10s pause spans the OPTIONS detection window, the kubelet kill
 * window, and the proxy's hand-off to the backup, so most established
 * calls have their BYE arrive on the backup with hydrated dialog state.
 *
 * Hard asserts:
 *  - unaffected.failed == 0 (regression net for the surviving worker)
 *  - established-on-dying > 0 (sanity: kill actually hit calls in flight)
 *  - post-kill smoke INVITE round-trip succeeds
 *  - StatefulSet back to replicaCount within 60s
 *
 * Survival rate of established-on-dying / in-flight-on-dying /
 * pre-routed-on-dying populations is logged in the matrix but not
 * asserted (per plan — measurement-first).
 */
describe("k8s/proxy-failover-worker-delete-hold — Phase 3a-B", () => {
  it.live(
    "delete --grace=0 a worker mid-hold; backup must serve BYE",
    () =>
      Effect.gen(function* () {
        const result = yield* runWorkerFailoverScenario({
          namespace: NAMESPACE,
          killMode: "delete-grace0",
          runIdPrefix: "worker-delete-hold",
          scenario: "uac-hold-failover.xml",
          scenarioName: "phase-3a-B-worker-delete-hold",
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

        // Sanity: kill must have hit calls actually established.
        // If 0, the test's pacing is wrong.
        expect(
          result.establishedOnDyingCount,
          "expected at least one established-on-dying call",
        ).toBeGreaterThan(0)

        // Hard gate.
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
