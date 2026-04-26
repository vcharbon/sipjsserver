import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { deleteSippJob, runSippJob } from "./fixtures/sippJob.js"
import {
  aggregatePerCall,
  fetchRoutingDecisions,
  workerIpToName,
} from "./fixtures/proxyLogs.js"
import { listPods, scaleStatefulSet, waitForPodReady } from "./fixtures/kubectl.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"

/**
 * INV-4 — Pool growth doesn't disrupt in-flight; new INVITEs use the
 * larger pool.
 *
 * Method:
 *   1. Phase A: send N1 calls and let them complete on the original
 *      2-worker pool. Verify all completed cleanly (subset of INV-1).
 *   2. Scale `b2bua-worker` StatefulSet to 3 replicas. Wait for the
 *      new pod (`b2bua-worker-2`) to become Ready.
 *   3. Phase B: send N2 fresh calls. Parse the proxy's routing
 *      decisions and verify all 3 workers received at least one INVITE
 *      (HRW redistributes over the larger pool).
 *   4. Cleanup: scale back to 2 replicas.
 */
describe("k8s/proxy-scale — INV-4: pool growth doesn't disrupt", () => {
  it.live(
    "scaling worker StatefulSet from 2 to 3: new INVITEs use the 3-worker pool",
    () =>
      Effect.gen(function* () {
        const stamp = Date.now().toString(36)
        const beforeJob = `inv4-before-${stamp}`
        const afterJob = `inv4-after-${stamp}`
        const beforeCidStr = `inv4-before-${stamp}-%u@det`
        const afterCidStr = `inv4-after-${stamp}-%u@det`
        const beforeCidPrefix = `inv4-before-${stamp}-`
        const afterCidPrefix = `inv4-after-${stamp}-`
        const N_BEFORE = 12
        const N_AFTER = 30

        try {
          // (1) Phase A — original 2-worker pool.
          const r1 = yield* runSippJob({
            namespace: NAMESPACE,
            name: beforeJob,
            scenario: "uac-basic.xml",
            target: "sip-front-proxy:5060",
            service: "test",
            calls: N_BEFORE,
            callsPerSecond: 12,
            timeoutSec: 30,
            waitTimeoutSec: 60,
            extraArgs: ["-cid_str", beforeCidStr],
          })
          expect(r1.jobStatus).toBe("succeeded")
          expect(r1.stats.successful).toBe(N_BEFORE)

          // (2) Scale up. With OrderedReady + 2 existing replicas Ready,
          //     K8s creates b2bua-worker-2 immediately.
          yield* scaleStatefulSet(NAMESPACE, "b2bua-worker", 3)
          yield* waitForPodReady(NAMESPACE, "b2bua-worker-2", 60)

          // Give the proxy time to observe the new pod via its watch
          // and run an OPTIONS probe so health flips alive.
          yield* Effect.sleep("4 seconds")

          const podsAfterScale = yield* listPods(
            NAMESPACE,
            "app.kubernetes.io/name=b2bua-worker",
          )
          expect(podsAfterScale.length).toBe(3)
          expect(podsAfterScale.every((p) => p.ready)).toBe(true)

          // (3) Phase B — fresh INVITEs over the new pool.
          const r2 = yield* runSippJob({
            namespace: NAMESPACE,
            name: afterJob,
            scenario: "uac-basic.xml",
            target: "sip-front-proxy:5060",
            service: "test",
            calls: N_AFTER,
            callsPerSecond: 15,
            timeoutSec: 30,
            waitTimeoutSec: 60,
            extraArgs: ["-cid_str", afterCidStr],
          })
          expect(r2.jobStatus).toBe("succeeded")
          expect(r2.stats.successful).toBe(N_AFTER)

          const decisions = yield* fetchRoutingDecisions(NAMESPACE, { since: "180s" })
          const beforeInvites = decisions.filter(
            (d) => d.callId.startsWith(beforeCidPrefix) && d.method === "INVITE",
          )
          const afterInvites = decisions.filter(
            (d) => d.callId.startsWith(afterCidPrefix) && d.method === "INVITE",
          )

          // (a) All Phase-A calls maintained INV-1 (subset).
          const perCallBefore = aggregatePerCall(
            decisions.filter((d) => d.callId.startsWith(beforeCidPrefix)),
          )
          const beforeViolators = perCallBefore.filter((c) => c.workerIps.size !== 1)
          expect(
            beforeViolators,
            `INV-4(a) violation: pre-scale calls hit multiple workers:\n${JSON.stringify(beforeViolators, null, 2)}`,
          ).toEqual([])

          // (b) Phase-A calls should NOT have used worker-2 (it didn't
          //     exist yet during Phase A).
          const ipMap = yield* workerIpToName(NAMESPACE)
          const worker2Ip = Array.from(ipMap.entries()).find(
            ([, name]) => name === "b2bua-worker-2",
          )?.[0]
          expect(worker2Ip).toBeTruthy()
          const phaseALeak = beforeInvites.filter((d) => d.workerIp === worker2Ip)
          expect(
            phaseALeak,
            `INV-4 violation: Phase-A INVITE landed on worker-2 (which didn't exist):\n${JSON.stringify(phaseALeak, null, 2)}`,
          ).toEqual([])

          // (c) Phase-B INVITEs distributed across all 3 workers (each
          //     receives at least one — strict floor; with N_AFTER=30
          //     and uniform HRW, each worker should average 10).
          const phaseBPerWorker = new Map<string, number>()
          for (const d of afterInvites) {
            phaseBPerWorker.set(
              d.workerIp,
              (phaseBPerWorker.get(d.workerIp) ?? 0) + 1,
            )
          }
          const distributed = Array.from(phaseBPerWorker.entries()).map(
            ([ip, count]) => ({ worker: ipMap.get(ip) ?? ip, count }),
          )
          const workersUsed = distributed.length
          expect(
            workersUsed,
            `INV-4(c) violation: only ${workersUsed} workers received post-scale INVITEs (expected 3): ${JSON.stringify(distributed)}`,
          ).toBe(3)
          // Each worker received at least 1.
          for (const { worker, count } of distributed) {
            expect(count, `worker ${worker} received 0 post-scale INVITEs`).toBeGreaterThan(0)
          }

          yield* Effect.logInfo(
            `INV-4 distribution after scale: ${JSON.stringify(distributed)}`,
          )
        } finally {
          yield* deleteSippJob(NAMESPACE, beforeJob).pipe(Effect.ignore)
          yield* deleteSippJob(NAMESPACE, afterJob).pipe(Effect.ignore)
          // Always restore replica count for subsequent tests.
          yield* scaleStatefulSet(NAMESPACE, "b2bua-worker", 2).pipe(Effect.ignore)
        }
      }),
    { timeout: 240_000 },
  )
})
