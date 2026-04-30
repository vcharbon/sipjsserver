import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import {
  postKillReinviteServedByReturnedPrimary,
  postKillReinviteSuccesses,
  runWorkerFailoverScenario,
  unaffectedFailures,
} from "./fixtures/workerFailoverHarness.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"
const CPS = parseInt(process.env.K8S_FAILOVER_CPS_C ?? "10", 10)
const RAMP_S = parseInt(process.env.K8S_FAILOVER_RAMP_S_C ?? "15", 10)
// Slice C needs a long enough post-kill window for both halves of the
// pingpong contract: re-INVITE(1) lands on the backup during drain, and
// re-INVITE(2) — 10s later in the scenario — lands on the *returned*
// primary after its ReadyGate has drained `propagate:N` from peers.
// 30s post-kill + 30s drain + 10s scenario re-INVITE pause ≈ 70s of
// real-clock budget; the harness already absorbs the StatefulSet
// recovery wait separately.
const POSTKILL_S = parseInt(process.env.K8S_FAILOVER_POSTKILL_S_C ?? "30", 10)

/**
 * Slice C of [docs/plan/bye-takeover-replicated-indexes-fix.md] —
 * primary-return rehydration end-to-end.
 *
 * After Slices A + B + D land, an in-dialog request issued during the
 * drain window must reach the backup R via `decode_forward_backup`,
 * AND a SUBSEQUENT in-dialog request issued AFTER the killed pod's
 * StatefulSet replacement comes back K8s-Ready must reach the returned
 * primary P (same StatefulSet ordinal). For that second hop to succeed
 * with a 200 OK, P's `ReadyGate` must have drained `propagate:P` from
 * R during boot and merged R's takeover writes into its own `pri:P:`
 * partition (spec §11.2). If rehydration is broken, P sees an empty
 * partition for the call → 481.
 *
 * The existing `proxy-failover-worker-delete-pingpong.test.ts` already
 * proves the call SURVIVES the kill, but its assertion is agnostic to
 * which worker served re-INVITE(2). This test pins that assertion:
 * at least one call's 3rd INVITE post-kill must be served by the
 * returned primary pod (resolved via the post-recovery IP→name map),
 * which only happens if rehydration works.
 *
 * Companion sipp scenario: `uac-pingpong.xml` (existing) — INVITE →
 * ACK → 10s → re-INVITE(1) → ACK → 10s → re-INVITE(2) → ACK → 10s →
 * BYE. The 10s pauses give the cluster time to (i) detect the kill
 * via OPTIONS keepalive, (ii) replace the StatefulSet pod, and
 * (iii) flip the new pod K8s-Ready via the `/ready` HTTP probe gated
 * on ReadyGate (Slice D) before re-INVITE(2) is sent.
 */
describe("k8s/proxy-failover-worker-return — Slice C primary-return rehydration", () => {
  it.live(
    "delete --grace=0 a worker mid-pingpong; re-INVITE(2) returns to the rehydrated primary",
    () =>
      Effect.gen(function* () {
        const result = yield* runWorkerFailoverScenario({
          namespace: NAMESPACE,
          killMode: "delete-grace0",
          runIdPrefix: "worker-return-pingpong",
          scenario: "uac-pingpong.xml",
          scenarioName: "slice-C-worker-return-rehydration",
          cps: CPS,
          rampSec: RAMP_S,
          postKillSec: POSTKILL_S,
          // Each pingpong call lasts ~40s (3 × 10s pauses + ramp); the
          // sipp Job timeout has to clear the load + drain window.
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

        // Sanity: the existing pingpong assertion (Phase 3a-C) still
        // holds — at least one call's 3rd INVITE was decided
        // post-kill and the call completed cleanly. Without this the
        // returned-primary assertion below has no population.
        const postKillReinvites = postKillReinviteSuccesses(result)
        expect(
          postKillReinvites,
          "expected at least one call to have its second re-INVITE land after T_kill" +
            " and still succeed end-to-end (the pingpong failover path)",
        ).toBeGreaterThan(0)

        // Slice C contract: at least one of those post-kill re-INVITEs
        // was routed to the RETURNED primary (resolved via the
        // post-recovery IP→pod-name map; the killed StatefulSet
        // ordinal comes back with a fresh IP under delete-grace0, so
        // pod-name comparison is the only correct pivot).
        //
        // A returned-primary hit requires the entire rehydration chain
        // to be intact:
        //   - Slice D: the new pod's `/ready` probe held kube-proxy
        //     out of the Endpoints list until ReadyGate finished, so
        //     no re-INVITE(2) was sent before drain completed.
        //   - Slice B: while the pod was gone, the backup R wrote
        //     takeover state into `propagate:P` on R's sidecar, so P
        //     had something to drain.
        //   - Slice A: the bak: index keys on R let R's BYE/re-INVITE
        //     handler resolve the call from the leg headers in the
        //     first place.
        //   - ReadyGate: P's boot handshake drained `propagate:P` and
        //     merged R's writes into P's own `pri:P:` partition.
        // If any of those chain links is broken, this assertion fails
        // before the call survival assertion (above) reports success.
        const returned = postKillReinviteServedByReturnedPrimary(result)
        expect(
          returned,
          `expected at least one post-kill re-INVITE to be served by the returned` +
            ` primary pod (${result.killedWorkerPod}); got ${returned}` +
            ` of ${postKillReinvites} successful post-kill re-INVITEs.` +
            ` This proves ReadyGate rehydrated takeover state via propagate:` +
            `${result.killedWorkerPod} from the surviving worker.`,
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
