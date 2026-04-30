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
 * Phase 3b-C — Worker failover via `kubectl exec -- kill -9 1`,
 *              ping-pong lifecycle.
 *
 * Plan: docs/plan/proper-end-to-end-cheerful-lobster.md (Phase 3 §C).
 *
 * Companion to Phase 3a-C (delete --grace=0). The kill mode here is
 * an in-pod `kill -9 1` — kubelet sees the worker container exit on
 * its own; same pod IP; container restarts in place. Sidecar Redis is
 * unaffected, so the restarted worker's primary calls survive in its
 * own sidecar (no need to re-hydrate from peers via ReadyGate full
 * resync — only the steady-state pull from peers' propagate streams).
 *
 * The pingpong failover path is the same: re-INVITE(2) for calls
 * that were pre-re-INVITE(1) at T_kill must succeed via the backup or
 * the restored primary. Because the pod doesn't change identity, the
 * proxy's K8s watch sees nothing, OPTIONS keepalive is the only
 * signal — same as 2b.
 *
 * Hard asserts: identical to 3a-C.
 */
describe("k8s/proxy-failover-worker-killdash9-pingpong — Phase 3b-C", () => {
  it.live(
    "kill -9 a worker mid-pingpong; container restart + dual-write keep calls alive",
    () =>
      Effect.gen(function* () {
        const result = yield* runWorkerFailoverScenario({
          namespace: NAMESPACE,
          killMode: "exec-kill-9",
          runIdPrefix: "worker-killdash9-pingpong",
          scenario: "uac-pingpong.xml",
          scenarioName: "phase-3b-C-worker-killdash9-pingpong",
          cps: CPS,
          rampSec: RAMP_S,
          postKillSec: POSTKILL_S,
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
