import { Effect, Fiber } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { FRONT_PROXY_VIP_TARGET } from "./frontProxyTarget.js"
import { deleteSippJob, runSippJob, type SippRunResult } from "./sippJob.js"
import { fetchRoutingDecisions, waitForInvites } from "./proxyLogs.js"
import { podLogs, waitForDeploymentSteady } from "./kubectl.js"
import { killPod, type KillMode } from "./podKill.js"
import { parseSippMessageTrace, type CallOutcome } from "./sippOutcomes.js"
import { classifyCalls, type ClassifiedCall } from "./callLifecycle.js"
import { summarize, writeFailoverReport } from "./failoverReport.js"

const PROXY_LABEL = "app.kubernetes.io/name=sip-front-proxy"
const WORKER_LABEL = "app.kubernetes.io/name=b2bua-worker"
const PROXY_DEPLOYMENT = "sip-front-proxy"
const PROXY_REPLICAS = 2

export interface LbFailoverHarnessOpts {
  /** Kubernetes namespace where the stack is installed. */
  readonly namespace: string
  /** Kill strategy. Drives the failure mode under test. */
  readonly killMode: KillMode
  /**
   * Stable prefix for the runId / sipp Job names. Used to disambiguate
   * archive directories across the 2a / 2b kill-mode variants.
   * Recommended: `"lb-delete"` for 2a, `"lb-killdash9"` for 2b.
   */
  readonly runIdPrefix: string
  /** Sustained CPS during the load window. */
  readonly cps: number
  /** Seconds before the kill — sipp ramps to steady state. */
  readonly rampSec: number
  /** Seconds after the kill — sipp keeps sending so post-kill state is observable. */
  readonly postKillSec: number
  /** Human-readable scenario name written to summary.txt. */
  readonly scenarioName: string
}

/**
 * Drive a single LB-failover scenario end-to-end:
 *
 *  1. Fork a sustained-load sipp Job through the proxy (UDP/5060).
 *  2. After `rampSec`, pick the busiest proxy pod from the routing log
 *     and kill it via `killMode`.
 *  3. Join the load Fiber, wait for the proxy Deployment to go steady
 *     again, run a small post-kill smoke INVITE.
 *  4. Build the per-call lifecycle classification (using
 *     `killedProxyPod` as the discriminator), write the 5x4 matrix +
 *     supporting artefacts under `test-results/k8s-failover/<runId>/`.
 *  5. Apply hard asserts via the supplied `expect`-style hooks; survival
 *     of established/in-flight/pre-routed populations is reported in
 *     the matrix but not asserted (per plan — measurement-first).
 *
 * The function is intentionally side-effecting on disk + cluster — it is
 * the test's effect graph; vitest's `it.live` orchestrates its lifetime.
 */
export const runLbFailoverScenario = (opts: LbFailoverHarnessOpts) =>
  Effect.gen(function* () {
    const tTestStart = new Date()
    const totalCalls = opts.cps * (opts.rampSec + opts.postKillSec)
    const runId = `${opts.runIdPrefix}-${tTestStart.getTime().toString(36)}`
    const archiveDir = path.resolve("test-results", "k8s-failover", runId)
    yield* Effect.tryPromise(() => fs.mkdir(archiveDir, { recursive: true })).pipe(
      Effect.orDie,
    )
    const proxyLogsDir = path.join(archiveDir, "proxy-logs")
    const workerLogsDir = path.join(archiveDir, "worker-logs")

    const loadJobName = `${opts.runIdPrefix}-${tTestStart.getTime().toString(36)}`
    const smokeJobName = `${opts.runIdPrefix}-smoke-${tTestStart.getTime().toString(36)}`
    const cidStr = `${loadJobName}-%u@det`
    const cidPrefix = `${loadJobName}-`

    const result: HarnessResult = {
      archiveDir,
      runId,
      classifications: [],
      counters: { reEmissions: 0, establishFailures: 0, badlyTreated: 0 },
      proxyRecoveredMs: -1,
      smokeJobStatus: "failed",
      smokeStats: { successful: 0, failed: 0, created: 0 },
      killedProxyPod: "",
      loadJobStatus: "failed",
      loadStats: { successful: 0, failed: 0, created: 0 },
    }

    try {
      // (1) Fork the sustained load Job.
      const loadFiber = yield* Effect.forkChild(
        runSippJob({
          namespace: opts.namespace,
          name: loadJobName,
          scenario: "uac-basic.xml",
          target: FRONT_PROXY_VIP_TARGET,
          service: "test",
          calls: totalCalls,
          callsPerSecond: opts.cps,
          timeoutSec: 60,
          waitTimeoutSec: 90,
          captureTraces: true,
          archiveDir,
          extraArgs: ["-cid_str", cidStr],
        }),
      )

      // (2) Wait for the ramp window. Sleep first so steady-state is
      //     reached, then poll up to a hard cap for INVITEs to appear
      //     in the routing log — important after a prior test killed
      //     pods and Service endpoints / kube-proxy conntrack are
      //     still settling.
      yield* Effect.sleep(`${opts.rampSec} seconds`)
      const minInvites = Math.max(Math.floor((opts.cps * opts.rampSec) / 4), 5)
      // Same 60s cap as workerFailoverHarness — see comment there.
      const waitDeadlineMs = Date.now() + 60_000
      const wait = yield* waitForInvites(opts.namespace, {
        cidPrefix,
        minCount: minInvites,
        since: `${opts.rampSec + 60}s`,
        deadlineMs: waitDeadlineMs,
      })
      const earlyDecisions = wait.decisions
      const earlyInvites = wait.invites
      const counts = new Map<string, number>()
      for (const d of earlyInvites) {
        const proxy = d.proxyPod ?? "unknown"
        counts.set(proxy, (counts.get(proxy) ?? 0) + 1)
      }
      const sorted = Array.from(counts.entries())
        .filter(([p]) => p !== "unknown")
        .sort((a, b) => b[1] - a[1])
      const killedProxyPod = sorted[0]?.[0] ?? ""
      result.killedProxyPod = killedProxyPod
      result.preKillCounts = sorted

      // Fail-fast: empty routing log means sipp didn't ramp in time
      // (pod scheduling overhead, image pull, etc.) or the namespace
      // is being polluted by concurrent traffic. Surface the cause
      // here rather than letting kubectl reject `delete pod ""`.
      if (killedProxyPod === "" || sorted.length === 0) {
        return yield* Effect.die(
          new Error(
            `LB-failover[${opts.killMode}]: no INVITEs visible for cidPrefix=${cidPrefix}` +
              ` after ${opts.rampSec}s ramp. earlyDecisions=${earlyDecisions.length},` +
              ` earlyInvites=${earlyInvites.length}. Sipp Job may not have started in time` +
              ` (pod scheduling + image pull). Bump rampSec or pre-warm the cluster.`,
          ),
        )
      }

      yield* Effect.logInfo(
        `LB-failover[${opts.killMode}]: killing busiest proxy pod ${killedProxyPod}` +
          ` (${sorted[0]?.[1]} INVITEs);` +
          ` other pods: ${sorted
            .slice(1)
            .map(([p, n]) => `${p}=${n}`)
            .join(", ")}`,
      )

      // (4) Issue the kill.
      const tKill = yield* killPod(opts.namespace, killedProxyPod, opts.killMode)

      // (5) Wait for the load Job to drain.
      const loadResult = yield* Fiber.join(loadFiber).pipe(
        Effect.catchTag("SippJobError", (e) =>
          Effect.succeed({
            jobStatus: "failed" as const,
            stats: { successful: 0, failed: 0, created: 0 },
            logs: e.message,
          } satisfies SippRunResult),
        ),
      )
      result.loadJobStatus = loadResult.jobStatus
      result.loadStats = loadResult.stats

      // (6) Wait for the proxy Deployment to recover. For
      //     `delete-grace0` the killed pod is gone and a fresh
      //     replacement is rolled in; for `exec-kill-9` the same pod's
      //     container restarts in place.
      const tBeforeRecover = Date.now()
      yield* waitForDeploymentSteady(
        opts.namespace,
        PROXY_DEPLOYMENT,
        PROXY_REPLICAS,
        30,
      )
      const tAfterRecover = Date.now()
      result.proxyRecoveredMs = tAfterRecover - tBeforeRecover
      yield* Effect.logInfo(
        `LB-failover[${opts.killMode}]: proxy Deployment back to ${PROXY_REPLICAS}` +
          ` replicas in ${tAfterRecover - tBeforeRecover}ms`,
      )

      // (7) Post-kill smoke INVITE — proves end-to-end routability.
      const smokeResult = yield* runSippJob({
        namespace: opts.namespace,
        name: smokeJobName,
        scenario: "uac-basic.xml",
        target: FRONT_PROXY_VIP_TARGET,
        service: "test",
        calls: 5,
        callsPerSecond: 5,
        timeoutSec: 20,
        waitTimeoutSec: 40,
      })
      result.smokeJobStatus = smokeResult.jobStatus
      result.smokeStats = smokeResult.stats

      // (8) Per-call classification + report.
      const elapsedSec = Math.ceil((Date.now() - tTestStart.getTime()) / 1000) + 30
      const decisionsFinal = yield* fetchRoutingDecisions(opts.namespace, {
        since: `${elapsedSec}s`,
      })
      const loadDecisions = decisionsFinal.filter((d) => d.callId.startsWith(cidPrefix))
      const tFirstInvite = loadDecisions.find((d) => d.method === "INVITE")?.tDecided
      const tLastInvite = [...loadDecisions]
        .reverse()
        .find((d) => d.method === "INVITE")?.tDecided

      let outcomes = new Map<string, CallOutcome>()
      const tracePaths = "tracePaths" in loadResult ? loadResult.tracePaths : undefined
      if (tracePaths?.msgLog !== undefined) {
        const msg = yield* Effect.tryPromise(() =>
          fs.readFile(tracePaths.msgLog!, "utf8"),
        ).pipe(Effect.orDie)
        outcomes = parseSippMessageTrace(msg)
      }

      const classifications = classifyCalls({
        decisions: loadDecisions,
        outcomes,
        killedProxyPod,
        tKill,
      })
      result.classifications = classifications
      result.counters = summarize(classifications)

      // Archive routing decisions and pod logs.
      yield* Effect.tryPromise(() =>
        fs.writeFile(
          path.join(archiveDir, "routing-decisions.ndjson"),
          loadDecisions.map((d) => JSON.stringify(d)).join("\n"),
          "utf8",
        ),
      ).pipe(Effect.orDie)
      yield* Effect.tryPromise(() => fs.mkdir(proxyLogsDir, { recursive: true })).pipe(
        Effect.orDie,
      )
      yield* Effect.tryPromise(() => fs.mkdir(workerLogsDir, { recursive: true })).pipe(
        Effect.orDie,
      )
      const proxyLogText = yield* podLogs(
        opts.namespace,
        { labelSelector: PROXY_LABEL },
        { since: `${elapsedSec}s` },
      ).pipe(Effect.catchTag("ExecError", () => Effect.succeed("")))
      yield* Effect.tryPromise(() =>
        fs.writeFile(path.join(proxyLogsDir, "all.log"), proxyLogText, "utf8"),
      ).pipe(Effect.orDie)
      const workerLogText = yield* podLogs(
        opts.namespace,
        { labelSelector: WORKER_LABEL },
        { since: `${elapsedSec}s` },
      ).pipe(Effect.catchTag("ExecError", () => Effect.succeed("")))
      yield* Effect.tryPromise(() =>
        fs.writeFile(path.join(workerLogsDir, "all.log"), workerLogText, "utf8"),
      ).pipe(Effect.orDie)

      yield* writeFailoverReport({
        archiveDir,
        classifications,
        scenarioName: opts.scenarioName,
        killTimeline: {
          ...(tFirstInvite !== undefined ? { tInviteFirst: tFirstInvite.toISOString() } : {}),
          tKillIssued: tKill.toISOString(),
          ...(tLastInvite !== undefined ? { tInviteLast: tLastInvite.toISOString() } : {}),
          killedProxyPod,
          killMode: opts.killMode,
          proxyRecoveredMs: result.proxyRecoveredMs,
          loadJobStatus: result.loadJobStatus,
          loadStats: result.loadStats,
          smokeJobStatus: result.smokeJobStatus,
          smokeStats: result.smokeStats,
          counters: result.counters,
        },
      })

      yield* Effect.logInfo(
        `LB-failover[${opts.killMode}] counters: re-emissions=${result.counters.reEmissions},` +
          ` establish-failures=${result.counters.establishFailures},` +
          ` badly-treated=${result.counters.badlyTreated},` +
          ` total-classified=${classifications.length}`,
      )

      return result
    } finally {
      yield* deleteSippJob(opts.namespace, loadJobName).pipe(Effect.ignore)
      yield* deleteSippJob(opts.namespace, smokeJobName).pipe(Effect.ignore)
    }
  })

export interface HarnessResult {
  readonly archiveDir: string
  readonly runId: string
  classifications: ReadonlyArray<ClassifiedCall>
  counters: { reEmissions: number; establishFailures: number; badlyTreated: number }
  proxyRecoveredMs: number
  smokeJobStatus: "succeeded" | "failed"
  smokeStats: { successful: number; failed: number; created: number }
  killedProxyPod: string
  loadJobStatus: "succeeded" | "failed"
  loadStats: { successful: number; failed: number; created: number }
  preKillCounts?: ReadonlyArray<readonly [string, number]>
}

/**
 * Count `unaffected` calls whose outcome is one of the failure
 * sippOutcomes. The Phase 2 hard gate: this MUST be zero.
 */
export const unaffectedFailures = (
  classifications: ReadonlyArray<ClassifiedCall>,
): ReadonlyArray<ClassifiedCall> =>
  classifications.filter(
    (c) =>
      c.state === "unaffected" &&
      (c.outcome === "establish-failed" ||
        c.outcome === "bye-timeout" ||
        c.outcome === "mid-dialog-error"),
  )
