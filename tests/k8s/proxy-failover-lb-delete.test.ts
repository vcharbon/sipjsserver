import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { deleteSippJob, runSippJob } from "./fixtures/sippJob.js"
import {
  fetchRoutingDecisions,
  workerIpToName,
} from "./fixtures/proxyLogs.js"
import {
  listPods,
  podLogs,
  waitForDeploymentSteady,
} from "./fixtures/kubectl.js"
import { killPod } from "./fixtures/podKill.js"
import { parseSippMessageTrace } from "./fixtures/sippOutcomes.js"
import { classifyCalls } from "./fixtures/callLifecycle.js"
import { summarize, writeFailoverReport } from "./fixtures/failoverReport.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"
const PROXY_LABEL = "app.kubernetes.io/name=sip-front-proxy"
const PROXY_DEPLOYMENT = "sip-front-proxy"
const PROXY_REPLICAS = 2

const CPS = parseInt(process.env.K8S_FAILOVER_CPS ?? "20", 10)
const RAMP_S = parseInt(process.env.K8S_FAILOVER_RAMP_S ?? "5", 10)
const POSTKILL_S = parseInt(process.env.K8S_FAILOVER_POSTKILL_S ?? "10", 10)
const TOTAL_CALLS = CPS * (RAMP_S + POSTKILL_S)

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
        const tTestStart = new Date()
        const runId = `lb-delete-${tTestStart.getTime().toString(36)}`
        const archiveDir = path.resolve(
          "test-results",
          "k8s-failover",
          runId,
        )
        yield* Effect.tryPromise(() => fs.mkdir(archiveDir, { recursive: true })).pipe(
          Effect.orDie,
        )
        const tracePathsDir = path.join(archiveDir, "sipp-traces")
        const proxyLogsDir = path.join(archiveDir, "proxy-logs")
        const workerLogsDir = path.join(archiveDir, "worker-logs")

        const loadJobName = `lb-delete-${tTestStart.getTime().toString(36)}`
        const smokeJobName = `lb-delete-smoke-${tTestStart.getTime().toString(36)}`
        const cidStr = `${loadJobName}-%u@det`
        const cidPrefix = `${loadJobName}-`

        try {
          // (1) Fork the sustained load Job in the background.
          const loadFiber = yield* Effect.forkChild(
            runSippJob({
              namespace: NAMESPACE,
              name: loadJobName,
              scenario: "uac-basic.xml",
              target: "sip-front-proxy:5060",
              service: "test",
              calls: TOTAL_CALLS,
              callsPerSecond: CPS,
              timeoutSec: 60,
              waitTimeoutSec: 90,
              captureTraces: true,
              archiveDir,
              extraArgs: ["-cid_str", cidStr],
            }),
          )

          // (2) Wait for the ramp window so all proxy pods see traffic.
          yield* Effect.sleep(`${RAMP_S} seconds`)

          // (3) Pick the proxy pod handling the most INVITEs.
          const since = `${RAMP_S + 30}s`
          const decisionsEarly = yield* fetchRoutingDecisions(NAMESPACE, { since })
          const earlyInvites = decisionsEarly.filter(
            (d) => d.callId.startsWith(cidPrefix) && d.method === "INVITE",
          )
          expect(
            earlyInvites.length,
            "expected proxy to have routed INVITEs before kill",
          ).toBeGreaterThanOrEqual(Math.floor(CPS * RAMP_S * 0.5))

          const counts = new Map<string, number>()
          for (const d of earlyInvites) {
            const proxy = d.proxyPod ?? "unknown"
            counts.set(proxy, (counts.get(proxy) ?? 0) + 1)
          }
          const sorted = Array.from(counts.entries())
            .filter(([p]) => p !== "unknown")
            .sort((a, b) => b[1] - a[1])
          expect(
            sorted.length,
            "expected proxy log lines to carry --prefix pod identifiers",
          ).toBeGreaterThanOrEqual(2)

          const killedProxyPod = sorted[0]?.[0] ?? ""
          expect(killedProxyPod).not.toBe("")

          yield* Effect.logInfo(
            `Phase 2a: killing busiest proxy pod ${killedProxyPod}` +
              ` (${sorted[0]?.[1]} INVITEs);` +
              ` other pods: ${sorted
                .slice(1)
                .map(([p, n]) => `${p}=${n}`)
                .join(", ")}`,
          )

          // (4) Kill it. Returns the Date used as T_kill for
          //     classification.
          const tKill = yield* killPod(NAMESPACE, killedProxyPod, "delete-grace0")

          // (5) Wait for the load Job to complete. It should run for
          //     ~RAMP+POSTKILL seconds plus any sipp drain.
          const loadResult = yield* Fiber.join(loadFiber).pipe(
            Effect.catchTag("SippJobError", (e) =>
              Effect.succeed({
                jobStatus: "failed" as const,
                stats: { successful: 0, failed: 0, created: 0 },
                logs: e.message,
                tracePaths: undefined as
                  | { msgLog?: string; statCsv?: string; screenLog?: string; rttCsv?: string }
                  | undefined,
              }),
            ),
          )

          // (6) Wait for the proxy Deployment to recreate the killed
          //     pod within 30s (plan asserts this).
          const tBeforeRecover = Date.now()
          yield* waitForDeploymentSteady(NAMESPACE, PROXY_DEPLOYMENT, PROXY_REPLICAS, 30)
          const tAfterRecover = Date.now()
          yield* Effect.logInfo(
            `Phase 2a: proxy Deployment back to ${PROXY_REPLICAS} replicas in` +
              ` ${tAfterRecover - tBeforeRecover}ms`,
          )

          // (7) Post-test smoke INVITE — proves the surviving proxy is
          //     still routable end-to-end.
          const smokeResult = yield* runSippJob({
            namespace: NAMESPACE,
            name: smokeJobName,
            scenario: "uac-basic.xml",
            target: "sip-front-proxy:5060",
            service: "test",
            calls: 5,
            callsPerSecond: 5,
            timeoutSec: 20,
            waitTimeoutSec: 40,
          })

          // (8) Build the per-call classification + matrix.
          const decisionsFinal = yield* fetchRoutingDecisions(NAMESPACE, {
            since: `${Math.ceil((Date.now() - tTestStart.getTime()) / 1000) + 30}s`,
          })
          const loadDecisions = decisionsFinal.filter((d) =>
            d.callId.startsWith(cidPrefix),
          )
          const tFirstInvite = loadDecisions.find((d) => d.method === "INVITE")?.tDecided
          const tLastInvite = [...loadDecisions]
            .reverse()
            .find((d) => d.method === "INVITE")?.tDecided

          // Parse sipp message trace if it landed on disk.
          let outcomes = new Map<string, ReturnType<typeof parseSippMessageTrace> extends Map<string, infer V> ? V : never>()
          if (loadResult.tracePaths?.msgLog !== undefined) {
            const msg = yield* Effect.tryPromise(() =>
              fs.readFile(loadResult.tracePaths!.msgLog!, "utf8"),
            ).pipe(Effect.orDie)
            outcomes = parseSippMessageTrace(msg)
          }

          const classifications = classifyCalls({
            decisions: loadDecisions,
            outcomes,
            killedProxyPod,
            tKill,
          })

          // Archive routing decisions as NDJSON.
          const ndjson = loadDecisions
            .map((d) => JSON.stringify(d))
            .join("\n")
          yield* Effect.tryPromise(() =>
            fs.writeFile(path.join(archiveDir, "routing-decisions.ndjson"), ndjson, "utf8"),
          ).pipe(Effect.orDie)

          // Archive proxy and worker logs (current; --previous handled
          // by the killed pod whose logs are in `kubectl logs --previous`
          // for any pod still in the namespace — but with --grace=0
          // --force the pod is gone, so previous logs are unavailable).
          yield* Effect.tryPromise(() => fs.mkdir(proxyLogsDir, { recursive: true })).pipe(
            Effect.orDie,
          )
          yield* Effect.tryPromise(() => fs.mkdir(workerLogsDir, { recursive: true })).pipe(
            Effect.orDie,
          )
          const proxyLogText = yield* podLogs(
            NAMESPACE,
            { labelSelector: PROXY_LABEL },
            { since: `${Math.ceil((Date.now() - tTestStart.getTime()) / 1000) + 30}s` },
          ).pipe(Effect.catchAll(() => Effect.succeed("")))
          yield* Effect.tryPromise(() =>
            fs.writeFile(path.join(proxyLogsDir, "all.log"), proxyLogText, "utf8"),
          ).pipe(Effect.orDie)
          const workerLogText = yield* podLogs(
            NAMESPACE,
            { labelSelector: "app.kubernetes.io/name=b2bua-worker" },
            { since: `${Math.ceil((Date.now() - tTestStart.getTime()) / 1000) + 30}s` },
          ).pipe(Effect.catchAll(() => Effect.succeed("")))
          yield* Effect.tryPromise(() =>
            fs.writeFile(path.join(workerLogsDir, "all.log"), workerLogText, "utf8"),
          ).pipe(Effect.orDie)

          yield* writeFailoverReport({
            archiveDir,
            classifications,
            scenarioName: "phase-2a-lb-delete",
            killTimeline: {
              tInviteFirst: tFirstInvite?.toISOString(),
              tKillIssued: tKill.toISOString(),
              tInviteLast: tLastInvite?.toISOString(),
              killedProxyPod,
              proxyRecoveredMs: tAfterRecover - tBeforeRecover,
              loadJobStatus: loadResult.jobStatus,
              loadStats: loadResult.stats,
              smokeJobStatus: smokeResult.jobStatus,
              smokeStats: smokeResult.stats,
              archive: { tracePathsDir, proxyLogsDir, workerLogsDir },
              counters: summarize(classifications),
            },
          })

          // (9) Hard asserts.
          const unaffectedFailed = classifications.filter(
            (c) =>
              c.state === "unaffected" &&
              (c.outcome === "establish-failed" ||
                c.outcome === "bye-timeout" ||
                c.outcome === "mid-dialog-error"),
          )
          expect(
            unaffectedFailed.length,
            `unaffected calls must not fail; failures: ${unaffectedFailed
              .slice(0, 5)
              .map((c) => `${c.callId}:${c.outcome}`)
              .join(", ")}`,
          ).toBe(0)

          expect(
            smokeResult.jobStatus,
            `post-kill smoke INVITE failed: ${smokeResult.logs.slice(-500)}`,
          ).toBe("succeeded")
          expect(smokeResult.stats.successful).toBe(5)

          expect(
            tAfterRecover - tBeforeRecover,
            `proxy Deployment took too long to recover: ${tAfterRecover - tBeforeRecover}ms`,
          ).toBeLessThan(30_000)

          const counters = summarize(classifications)
          yield* Effect.logInfo(
            `Phase 2a counters: re-emissions=${counters.reEmissions},` +
              ` establish-failures=${counters.establishFailures},` +
              ` badly-treated=${counters.badlyTreated},` +
              ` total-classified=${classifications.length}`,
          )
        } finally {
          yield* deleteSippJob(NAMESPACE, loadJobName).pipe(Effect.ignore)
          yield* deleteSippJob(NAMESPACE, smokeJobName).pipe(Effect.ignore)
          // Read worker IP map for log diagnostics — best-effort.
          yield* workerIpToName(NAMESPACE).pipe(Effect.ignore)
        }
      }),
    { timeout: 240_000 },
  )
})
