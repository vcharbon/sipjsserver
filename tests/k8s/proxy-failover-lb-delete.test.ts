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
 * Phase 2a — LB failover via `kubectl delete --grace-period=0 --force`.
 *
 * Plan: docs/plan/proper-end-to-end-cheerful-lobster.md
 *
 * The sip-front-proxy runs at replicaCount=2 behind a NodePort Service.
 * Both pods share the same HMAC keys via Secret and watch the same
 * worker StatefulSet, so each is functionally interchangeable for
 * routing — there is no per-call state pinned to one proxy pod beyond
 * UDP conntrack at the kube-proxy layer.
 *
 * We launch a 20cps sipp load through the proxy, wait for it to ramp,
 * then API-delete the pod that's handling the most INVITEs. Surviving
 * proxy must continue to route; sipp's per-call results plus the proxy
 * routing log are joined into a 5×4 matrix written under
 * test-results/k8s-failover/<runId>/.
 *
 * Hard asserts:
 *   - unaffected.failed == 0   (calls whose INVITE never traversed the
 *                               killed proxy must complete successfully)
 *   - post-kill smoke INVITE round-trip succeeds
 *   - killed proxy pod recreated by the Deployment within 30s
 *
 * Survival of established-on-dying / in-flight-on-dying / pre-routed-
 * on-dying is logged in the matrix but not asserted (see plan for why).
 */
describe("k8s/proxy-failover-lb-delete — Phase 2a: LB pod kill via delete --grace=0", () => {
  it.live(
    "API-delete a proxy pod under load; surviving proxy keeps serving",
    () =>
      Effect.gen(function* () {
        const result = yield* runLbFailoverScenario({
          namespace: NAMESPACE,
          killMode: "delete-grace0",
          runIdPrefix: "lb-delete",
          scenarioName: "phase-2a-lb-delete",
          cps: CPS,
          rampSec: RAMP_S,
          postKillSec: POSTKILL_S,
        })

        // Sanity: the kill picked a real pod and we routed enough
        // INVITEs to that pod to make the kill meaningful.
        //
        // Note: kube-proxy UDP conntrack pins flows from a single
        // sipp src-port to ONE Service endpoint, so all 300 INVITEs
        // typically end up on a single proxy pod. We therefore do
        // NOT assert `>= 2 pods saw traffic` — that would be a
        // common false negative. The kill picks "the busiest" which
        // is "the one with all the traffic", which is the
        // interesting case anyway.
        expect(result.killedProxyPod).not.toBe("")
        expect(
          result.preKillCounts?.[0]?.[1] ?? 0,
          "expected the targeted proxy pod to have routed at least RAMP*CPS/2 INVITEs",
        ).toBeGreaterThanOrEqual(Math.floor(CPS * RAMP_S * 0.5))

        // Hard gate: unaffected calls must not fail.
        const failed = unaffectedFailures(result.classifications)
        expect(
          failed.length,
          `unaffected calls failed; samples: ${failed
            .slice(0, 5)
            .map((c) => `${c.callId}:${c.outcome}`)
            .join(", ")}`,
        ).toBe(0)

        // Post-kill smoke INVITE: surviving proxy still routable.
        expect(result.smokeJobStatus).toBe("succeeded")
        expect(result.smokeStats.successful).toBe(5)

        // Recovery budget.
        expect(
          result.proxyRecoveredMs,
          `proxy Deployment took ${result.proxyRecoveredMs}ms to recover`,
        ).toBeLessThan(30_000)
      }),
    { timeout: 240_000 },
  )
})
