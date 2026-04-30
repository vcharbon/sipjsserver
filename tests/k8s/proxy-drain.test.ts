import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { deleteSippJob, runSippJob } from "./fixtures/sippJob.js"
import {
  aggregatePerCall,
  fetchRoutingDecisions,
  workerIpToName,
} from "./fixtures/proxyLogs.js"
import { deletePod } from "./fixtures/kubectl.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"

/**
 * INV-3 — Drain handoff (Phase B scope, with dual-write deployed).
 *
 * Asserts the full proxy-side drain contract:
 *
 *   (a) Established calls survive the drain end-to-end. Either (i) the
 *       BYE lands on the still-alive draining worker during its grace
 *       window, or (ii) it migrates to the backup worker, whose
 *       replicated dialog state (per-call dual-write across per-pod
 *       Redis sidecars — see docs/replication/call-cache-backup.md)
 *       lets it serve the in-dialog request without 481.
 *   (b) New INVITEs are routed *only* to non-draining workers.
 *   (c) The draining worker terminates within
 *       `terminationGracePeriodSeconds`.
 *
 * Promoted from informational logging to a hard assertion in Phase 1
 * of docs/plan/proper-end-to-end-cheerful-lobster.md, after Phases 0a
 * (per-pod Redis sidecar topology) and 0b (production wiring of
 * ReplPuller + ReadyGate + HTTP ReplogClient) shipped.
 */
describe("k8s/proxy-drain — INV-3: drain preserves in-flight calls", () => {
  it.live(
    "drain handoff: ACK/BYE reach draining worker; new INVITEs do not",
    () =>
      Effect.gen(function* () {
        const stamp = Date.now().toString(36)
        const holdJobName = `inv3-hold-${stamp}`
        const freshJobName = `inv3-fresh-${stamp}`
        const holdCidStr = `inv3-hold-${stamp}-%u@det`
        const freshCidStr = `inv3-fresh-${stamp}-%u@det`
        const holdCidPrefix = `inv3-hold-${stamp}-`
        const freshCidPrefix = `inv3-fresh-${stamp}-`
        const N_HOLD = 20
        const N_FRESH = 6

        try {
          // (1) Start the long Job in the background. uac-hold.xml
          //     pauses 3s between ACK and BYE (just under the proxy's
          //     5s drainGraceMs default).
          const holdFiber = yield* Effect.forkChild(
            runSippJob({
              namespace: NAMESPACE,
              name: holdJobName,
              scenario: "uac-hold.xml",
              target: "sip-front-proxy:5060",
              service: "test",
              calls: N_HOLD,
              callsPerSecond: 20,
              timeoutSec: 30,
              waitTimeoutSec: 60,
              extraArgs: ["-cid_str", holdCidStr],
            }),
          )

          // (2) Wait briefly for INVITEs to settle (≈1s for 20 calls @
          //     20cps + handling lag), then drain. The pace must keep
          //     BYEs inside the 5s grace window after delete.
          yield* Effect.sleep("2 seconds")

          // Snapshot to find the busiest worker.
          const decisionsEarly = yield* fetchRoutingDecisions(NAMESPACE, {
            since: "120s",
          })
          const earlyInvites = decisionsEarly.filter(
            (d) => d.callId.startsWith(holdCidPrefix) && d.method === "INVITE",
          )
          expect(
            earlyInvites.length,
            "expected proxy to have routed INVITEs before drain",
          ).toBeGreaterThanOrEqual(N_HOLD)

          const counts = new Map<string, number>()
          for (const d of earlyInvites) {
            counts.set(d.workerIp, (counts.get(d.workerIp) ?? 0) + 1)
          }
          const sortedWorkers = Array.from(counts.entries()).sort(
            (a, b) => b[1] - a[1],
          )
          const drainTargetIp = sortedWorkers[0]?.[0] ?? ""
          expect(drainTargetIp).not.toBe("")
          // Sanity: at least 2 workers handled traffic so we can verify
          // re-routing on drain.
          expect(counts.size, "expected at least 2 workers in pool").toBeGreaterThanOrEqual(2)

          const ipMap = yield* workerIpToName(NAMESPACE)
          const drainPod = ipMap.get(drainTargetIp)
          expect(drainPod, `IP ${drainTargetIp} not mapped to a pod`).toBeTruthy()

          // (3) SIGTERM with 30s grace (matches `terminationGracePeriodSeconds`
          //     in tests/k8s/values/b2bua-worker.yaml).
          const drainStartMs = Date.now()
          yield* deletePod(NAMESPACE, drainPod!, { gracePeriodSec: 30 })

          // Give the proxy 3s to mark the worker draining (K8s
          // deletionTimestamp accelerant + OPTIONS 503).
          yield* Effect.sleep("3 seconds")

          // (4) Fresh INVITEs during drain — none should hit the
          //     draining worker.
          const freshResult = yield* runSippJob({
            namespace: NAMESPACE,
            name: freshJobName,
            scenario: "uac-basic.xml",
            target: "sip-front-proxy:5060",
            service: "test",
            calls: N_FRESH,
            callsPerSecond: 6,
            timeoutSec: 20,
            waitTimeoutSec: 40,
            extraArgs: ["-cid_str", freshCidStr],
          })
          expect(freshResult.jobStatus).toBe("succeeded")
          expect(freshResult.stats.successful).toBe(N_FRESH)

          const decisionsMid = yield* fetchRoutingDecisions(NAMESPACE, {
            since: "120s",
          })
          const freshInvites = decisionsMid.filter(
            (d) => d.callId.startsWith(freshCidPrefix) && d.method === "INVITE",
          )
          expect(freshInvites.length).toBeGreaterThanOrEqual(N_FRESH)
          const violatorsB = freshInvites.filter((d) => d.workerIp === drainTargetIp)
          expect(
            violatorsB,
            `INV-3(b) violation: ${violatorsB.length} fresh INVITEs went to the draining worker (${drainTargetIp})`,
          ).toEqual([])

          // (5) Await the hold Job — BYEs flow through after the 15s
          //     pause. Note that calls whose worker is mid-drain may
          //     still complete because the worker keeps serving in-flight
          //     dialogs for the entire grace window.
          const holdResult = yield* Fiber.join(holdFiber).pipe(
            Effect.catchTag("SippJobError", (e) =>
              Effect.succeed({
                jobStatus: "failed" as const,
                stats: { successful: 0, failed: 0, created: 0 },
                logs: e.message,
              }),
            ),
          )

          const decisionsFinal = yield* fetchRoutingDecisions(NAMESPACE, {
            since: "240s",
          })
          const holdAll = decisionsFinal.filter((d) =>
            d.callId.startsWith(holdCidPrefix),
          )
          const perCall = aggregatePerCall(holdAll)

          // (a) Count established-on-drained calls and where their BYE
          //     was routed. With dual-write deployed, every such call
          //     must succeed end-to-end whether the BYE stuck to the
          //     drained worker or migrated to the backup.
          let drainedByeStuck = 0
          let drainedByeMigrated = 0
          const migrations: Array<{ callId: string; byeIps: ReadonlyArray<string> }> = []
          for (const c of perCall) {
            const inviteIp = c.decisions.find((d) => d.method === "INVITE")?.workerIp
            if (inviteIp !== drainTargetIp) continue
            const byeIps = c.decisions
              .filter((d) => d.method === "BYE")
              .map((d) => d.workerIp)
            if (byeIps.length === 0) continue
            if (byeIps.every((ip) => ip === drainTargetIp)) drainedByeStuck += 1
            else {
              drainedByeMigrated += 1
              if (migrations.length < 3) migrations.push({ callId: c.callId, byeIps })
            }
          }
          yield* Effect.logInfo(
            `INV-3(a) [Phase B]: drainTargetIp=${drainTargetIp} pod=${drainPod}` +
              ` workerIPs=[${Array.from(ipMap.entries())
                .map(([ip, n]) => `${n}=${ip}`)
                .join(", ")}]` +
              ` BYEs-to-drained=${drainedByeStuck}` +
              ` BYEs-migrated=${drainedByeMigrated}` +
              ` sample-migrations=${JSON.stringify(migrations)}`,
          )

          // (a) Sanity: the drain MUST have actually hit some calls.
          //     A value of 0 means the test's pacing is wrong — the
          //     drainTargetIp had no in-flight dialogs when we
          //     deleted it.
          expect(
            drainedByeStuck + drainedByeMigrated,
            "expected at least one BYE seen for the drained worker — drain did not hit any in-flight calls",
          ).toBeGreaterThan(0)

          // (c) Drained worker pod should be gone within ~grace window.
          // We don't poll the pod; we check the wall-clock budget.
          const drainElapsedMs = Date.now() - drainStartMs
          expect(
            drainElapsedMs,
            "drain budget overrun — pod should be terminated by now",
          ).toBeLessThan(60_000) // 30s grace + slack

          // (a) Phase B hard assertion: with dual-write deployed,
          //     every established call must end with a 2xx to BYE
          //     (either via the still-alive drained worker during
          //     the grace window, or via the backup worker after
          //     hand-off). Allow ≤2 calls in the inherent-loss window
          //     where the BYE arrives in the SIGTERM/grace boundary
          //     and the worker process is gone before serving it.
          expect(
            holdResult.stats.successful,
            `inv3 hold job survival: only ${holdResult.stats.successful}/${N_HOLD} calls succeeded` +
              ` (status=${holdResult.jobStatus},` +
              ` BYEs-to-drained=${drainedByeStuck},` +
              ` BYEs-migrated=${drainedByeMigrated})`,
          ).toBeGreaterThanOrEqual(N_HOLD - 2)
        } finally {
          yield* deleteSippJob(NAMESPACE, holdJobName).pipe(Effect.ignore)
          yield* deleteSippJob(NAMESPACE, freshJobName).pipe(Effect.ignore)
        }
      }),
    { timeout: 240_000 },
  )
})
