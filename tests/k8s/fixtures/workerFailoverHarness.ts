import { Effect, Fiber } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { deleteSippJob, runSippJob, type SippRunResult } from "./sippJob.js"
import {
  fetchRoutingDecisions,
  waitForInvites,
  workerIpToName,
  type RoutingDecision,
} from "./proxyLogs.js"
import {
  listPods,
  podLogs,
  waitForStatefulSetSteady,
} from "./kubectl.js"
import { killPod, type KillMode } from "./podKill.js"
import { parseSippMessageTrace, type CallOutcome } from "./sippOutcomes.js"
import { classifyCalls, type ClassifiedCall } from "./callLifecycle.js"
import { summarize, writeFailoverReport } from "./failoverReport.js"

const PROXY_LABEL = "app.kubernetes.io/name=sip-front-proxy"
const WORKER_LABEL = "app.kubernetes.io/name=b2bua-worker"
const WORKER_STATEFULSET = "b2bua-worker"
const WORKER_REPLICAS = 2

export interface WorkerFailoverHarnessOpts {
  /** Kubernetes namespace where the stack is installed. */
  readonly namespace: string
  /** Kill strategy. Drives the failure mode under test. */
  readonly killMode: KillMode
  /**
   * Stable prefix for the runId / sipp Job names. Used to disambiguate
   * archive directories across the 3a-B / 3b-B / 3a-C / 3b-C variants.
   * Recommended: `"worker-delete-hold"`, `"worker-killdash9-pingpong"`, etc.
   */
  readonly runIdPrefix: string
  /** Sustained CPS during the load window. */
  readonly cps: number
  /** Seconds before the kill — sipp ramps to steady state. */
  readonly rampSec: number
  /** Seconds after the kill — sipp keeps sending so post-kill state is observable. */
  readonly postKillSec: number
  /** Scenario file name on the sipp ConfigMap (e.g. "uac-hold-failover.xml"). */
  readonly scenario: string
  /** Human-readable scenario name written to summary.txt. */
  readonly scenarioName: string
  /** Hard timeout for the sipp Job (seconds). */
  readonly sippTimeoutSec?: number
  /** Wait timeout for the sipp Job (seconds). */
  readonly sippWaitTimeoutSec?: number
}

export interface WorkerHarnessResult {
  readonly archiveDir: string
  readonly runId: string
  classifications: ReadonlyArray<ClassifiedCall>
  counters: { reEmissions: number; establishFailures: number; badlyTreated: number }
  workerRecoveredMs: number
  smokeJobStatus: "succeeded" | "failed"
  smokeStats: { successful: number; failed: number; created: number }
  killedWorkerPod: string
  killedWorkerIp: string
  loadJobStatus: "succeeded" | "failed"
  loadStats: { successful: number; failed: number; created: number }
  preKillCounts?: ReadonlyArray<readonly [string, number]>
  /** Number of calls that were `established-on-dying` per the matrix. */
  establishedOnDyingCount: number
  /** Routing decisions for the load-Job calls, post-test, in chronological order. */
  decisions: ReadonlyArray<RoutingDecision>
  /** Wall-clock instant the kill was issued. */
  tKill?: Date
  /** Per-Call-ID outcome map produced by the sipp trace parser. */
  outcomes: ReadonlyMap<string, CallOutcome>
  /**
   * Worker IP → pod-name map read AFTER the StatefulSet recovered.
   * For `delete-grace0` the killed StatefulSet ordinal returns with a
   * fresh IP, so the only way to identify "this packet was routed to
   * the returned primary pod" is to look the IP up in this map and
   * compare the pod name to `killedWorkerPod`. Empty when recovery
   * timed out.
   */
  postRecoveryIpMap: ReadonlyMap<string, string>
}

/**
 * Drive a single worker-failover scenario end-to-end. Mirrors
 * `lbFailoverHarness.runLbFailoverScenario` but kills a b2bua-worker
 * StatefulSet pod rather than a sip-front-proxy Deployment pod.
 *
 * Steps:
 *  1. Fork a sustained-load sipp Job through the proxy.
 *  2. After `rampSec`, pick the worker pod handling the most INVITEs
 *     (by routing decision worker IP), resolve to the pod name, kill it.
 *  3. Join the load Fiber, wait for the StatefulSet to come back to
 *     `WORKER_REPLICAS` ready replicas, run a small post-kill smoke INVITE.
 *  4. Build the per-call lifecycle classification using `killedWorkerIp`,
 *     write the 5x4 matrix + supporting artefacts.
 *
 * The `unaffected.failed == 0` hard gate is enforced by the test
 * wrapper, not here. Survival of established / in-flight / pre-routed
 * populations on the dying worker is reported in the matrix only.
 */
export const runWorkerFailoverScenario = (opts: WorkerFailoverHarnessOpts) =>
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

    const result: WorkerHarnessResult = {
      archiveDir,
      runId,
      classifications: [],
      counters: { reEmissions: 0, establishFailures: 0, badlyTreated: 0 },
      workerRecoveredMs: -1,
      smokeJobStatus: "failed",
      smokeStats: { successful: 0, failed: 0, created: 0 },
      killedWorkerPod: "",
      killedWorkerIp: "",
      loadJobStatus: "failed",
      loadStats: { successful: 0, failed: 0, created: 0 },
      establishedOnDyingCount: 0,
      decisions: [],
      outcomes: new Map(),
      postRecoveryIpMap: new Map(),
    }

    try {
      // (1) Fork the sustained load Job.
      const loadFiber = yield* Effect.forkChild(
        runSippJob({
          namespace: opts.namespace,
          name: loadJobName,
          scenario: opts.scenario,
          target: "sip-front-proxy:5060",
          service: "test",
          calls: totalCalls,
          callsPerSecond: opts.cps,
          timeoutSec: opts.sippTimeoutSec ?? 120,
          waitTimeoutSec: opts.sippWaitTimeoutSec ?? 180,
          captureTraces: true,
          archiveDir,
          extraArgs: ["-cid_str", cidStr],
        }),
      )

      // (2) Wait for the ramp window. Sleep first so steady-state is
      //     reached, then poll up to a hard cap for INVITEs to appear
      //     — important after a prior test killed pods and Service
      //     endpoints / kube-proxy conntrack are still settling.
      yield* Effect.sleep(`${opts.rampSec} seconds`)
      const minInvites = Math.max(Math.floor((opts.cps * opts.rampSec) / 4), 5)
      // 60s polling cap absorbs sipp Job cold-start latency (image
      // pull + pod scheduling + Service endpoints reconcile) after the
      // earlier LB-failover suite has churned proxy pods. The previous
      // 30s cap fits when sipp images are hot from `npm run build`
      // (LB suite case) but is regularly under-budgeted for the
      // worker-failover tests that run later in the file order.
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
        counts.set(d.workerIp, (counts.get(d.workerIp) ?? 0) + 1)
      }
      const sorted = Array.from(counts.entries())
        .filter(([ip]) => ip !== "")
        .sort((a, b) => b[1] - a[1])
      const killedWorkerIp = sorted[0]?.[0] ?? ""
      result.killedWorkerIp = killedWorkerIp

      // Fail-fast: empty routing log means sipp didn't ramp in time
      // or the namespace is being polluted by concurrent traffic.
      // Surface the cause here rather than letting kubectl reject
      // `delete pod ""`.
      if (killedWorkerIp === "" || sorted.length === 0) {
        return yield* Effect.die(
          new Error(
            `worker-failover[${opts.killMode}]: no INVITEs visible for cidPrefix=${cidPrefix}` +
              ` after ${opts.rampSec}s ramp. earlyDecisions=${earlyDecisions.length},` +
              ` earlyInvites=${earlyInvites.length}. Sipp Job may not have started in time` +
              ` (pod scheduling + image pull). Bump rampSec or pre-warm the cluster.`,
          ),
        )
      }
      result.preKillCounts = sorted

      const ipMap = yield* workerIpToName(opts.namespace)
      const killedWorkerPod = ipMap.get(killedWorkerIp) ?? ""
      result.killedWorkerPod = killedWorkerPod

      yield* Effect.logInfo(
        `worker-failover[${opts.killMode}]: killing busiest worker ${killedWorkerPod}` +
          ` (ip=${killedWorkerIp}, ${sorted[0]?.[1]} INVITEs);` +
          ` other workers: ${sorted
            .slice(1)
            .map(([ip, n]) => `${ipMap.get(ip) ?? ip}=${n}`)
            .join(", ")}`,
      )

      // (4) Issue the kill.
      const tKill = yield* killPod(opts.namespace, killedWorkerPod, opts.killMode)
      result.tKill = tKill

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

      // (6) Wait for the StatefulSet to recover. For `delete-grace0` the
      //     killed pod's name is reused with a fresh IP; for `exec-kill-9`
      //     the same pod's container restarts in place (same IP).
      const tBeforeRecover = Date.now()
      yield* waitForStatefulSetSteady(
        opts.namespace,
        WORKER_STATEFULSET,
        WORKER_REPLICAS,
        60,
      )
      const tAfterRecover = Date.now()
      result.workerRecoveredMs = tAfterRecover - tBeforeRecover
      yield* Effect.logInfo(
        `worker-failover[${opts.killMode}]: StatefulSet back to ${WORKER_REPLICAS}` +
          ` replicas in ${tAfterRecover - tBeforeRecover}ms`,
      )
      // Capture the post-recovery IP→pod-name map. After
      // `delete-grace0` the killed StatefulSet ordinal comes back with
      // a different IP, so post-kill routing decisions need this map
      // (not the pre-kill `killedWorkerIp`) to identify packets that
      // landed on the *returned* primary pod. See
      // `postKillReinviteServedByReturnedPrimary` below.
      // workerIpToName returns Effect<…, never> — listPods absorbs
      // kubectl errors internally and returns an empty list, so a bare
      // `yield*` is safe (no catchAll needed; v4 forbids the pattern).
      result.postRecoveryIpMap = yield* workerIpToName(opts.namespace)

      // (7) Post-kill smoke INVITE — proves end-to-end routability.
      const smokeResult = yield* runSippJob({
        namespace: opts.namespace,
        name: smokeJobName,
        scenario: "uac-basic.xml",
        target: "sip-front-proxy:5060",
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
      if (loadResult.tracePaths?.msgLog !== undefined) {
        const msg = yield* Effect.tryPromise(() =>
          fs.readFile(loadResult.tracePaths!.msgLog!, "utf8"),
        ).pipe(Effect.orDie)
        outcomes = parseSippMessageTrace(msg)
      }

      const classifications = classifyCalls({
        decisions: loadDecisions,
        outcomes,
        killedWorkerIp,
        tKill,
      })
      result.classifications = classifications
      result.counters = summarize(classifications)
      result.establishedOnDyingCount = classifications.filter(
        (c) => c.state === "established-on-dying",
      ).length
      result.decisions = loadDecisions
      result.outcomes = outcomes

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

      // Best-effort: capture --previous logs for the killed pod
      // (delete-grace0 → previous pod is gone; kill-9 → same name, will work).
      if (opts.killMode === "exec-kill-9") {
        const prev = yield* podLogs(
          opts.namespace,
          { pod: killedWorkerPod },
          { previous: true },
        ).pipe(Effect.catchTag("ExecError", () => Effect.succeed("")))
        if (prev.length > 0) {
          yield* Effect.tryPromise(() =>
            fs.writeFile(
              path.join(workerLogsDir, `${killedWorkerPod}.previous.log`),
              prev,
              "utf8",
            ),
          ).pipe(Effect.orDie)
        }
      }

      yield* writeFailoverReport({
        archiveDir,
        classifications,
        scenarioName: opts.scenarioName,
        killTimeline: {
          tInviteFirst: tFirstInvite?.toISOString(),
          tKillIssued: tKill.toISOString(),
          tInviteLast: tLastInvite?.toISOString(),
          killedWorkerPod,
          killedWorkerIp,
          killMode: opts.killMode,
          workerRecoveredMs: result.workerRecoveredMs,
          loadJobStatus: result.loadJobStatus,
          loadStats: result.loadStats,
          smokeJobStatus: result.smokeJobStatus,
          smokeStats: result.smokeStats,
          counters: result.counters,
          establishedOnDyingCount: result.establishedOnDyingCount,
        },
      })

      yield* Effect.logInfo(
        `worker-failover[${opts.killMode}] counters:` +
          ` re-emissions=${result.counters.reEmissions},` +
          ` establish-failures=${result.counters.establishFailures},` +
          ` badly-treated=${result.counters.badlyTreated},` +
          ` established-on-dying=${result.establishedOnDyingCount},` +
          ` total-classified=${classifications.length}`,
      )

      // Best-effort: peek at how many backup keys ended up on the
      // surviving worker's sidecar — useful diagnostic in archives,
      // not asserted (the keys are TTL'd, may have expired by now).
      const survivors = (yield* listPods(opts.namespace, WORKER_LABEL)).filter(
        (p) => p.name !== killedWorkerPod,
      )
      if (survivors.length > 0) {
        const survivor = survivors[0]!
        yield* Effect.logInfo(
          `worker-failover[${opts.killMode}]: surviving worker ${survivor.name}` +
            ` (ip=${survivor.ip}) is ready=${survivor.ready}; bak: keys count` +
            ` deferred to manual inspection`,
        )
      }

      return result
    } finally {
      yield* deleteSippJob(opts.namespace, loadJobName).pipe(Effect.ignore)
      yield* deleteSippJob(opts.namespace, smokeJobName).pipe(Effect.ignore)
    }
  })

/**
 * Count `unaffected` calls whose outcome is one of the failure
 * sippOutcomes. The Phase 3 hard gate: this MUST be zero.
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

/**
 * Count Call-IDs whose THIRD INVITE in the proxy routing log was
 * decided AFTER `tKill` AND whose final sipp outcome is `clean` or
 * `retransmitted`. This is the Phase 3 §C sanity check: it proves at
 * least one ping-pong call exercised the failover path between
 * re-INVITE(1) (pre-kill) and re-INVITE(2) (post-kill) and still
 * succeeded end-to-end.
 *
 * In the uac-pingpong.xml scenario each call has 3 INVITE messages:
 * the initial INVITE (CSeq 1), re-INVITE(1) (CSeq 2), and re-INVITE(2)
 * (CSeq 3). We rely on temporal ordering of the proxy routing log
 * lines rather than parsing CSeq, because the log line format does
 * not expose CSeq directly.
 */
export const postKillReinviteSuccesses = (
  result: WorkerHarnessResult,
): number => {
  if (result.tKill === undefined) return 0
  const tKillMs = result.tKill.getTime()
  const inviteTimesByCallId = new Map<string, Array<number>>()
  for (const d of result.decisions) {
    if (d.method !== "INVITE" || d.tDecided === undefined) continue
    const arr = inviteTimesByCallId.get(d.callId)
    const t = d.tDecided.getTime()
    if (arr) arr.push(t)
    else inviteTimesByCallId.set(d.callId, [t])
  }
  let count = 0
  for (const [callId, times] of inviteTimesByCallId) {
    if (times.length < 3) continue
    times.sort((a, b) => a - b)
    const thirdInvite = times[2]!
    if (thirdInvite < tKillMs) continue
    const outcome = result.outcomes.get(callId)?.outcome
    if (outcome === "clean" || outcome === "retransmitted") count++
  }
  return count
}

/**
 * Slice C of `docs/plan/bye-takeover-replicated-indexes-fix.md`:
 * how many calls had their 3rd INVITE (re-INVITE 2 in `uac-pingpong.xml`)
 * decided post-kill AND routed back to the *returned* primary pod
 * (same StatefulSet ordinal as the killed one — proves the rehydration
 * path was exercised, not just the in-flight backup hand-off).
 *
 * "Returned primary" is detected by resolving the decision's worker IP
 * through `result.postRecoveryIpMap` (captured AFTER the StatefulSet
 * recovered) and matching the pod name to `result.killedWorkerPod`.
 * Under `delete-grace0` the IP changes; under `exec-kill-9` the IP
 * stays the same. Either way, the pod *name* is preserved by the
 * StatefulSet, so name-based comparison is the right pivot.
 *
 * Calls whose final outcome is not `clean`/`retransmitted` are
 * excluded — a 3rd-INVITE decision alone doesn't prove rehydration
 * worked end-to-end; the BYE must also have completed.
 */
export const postKillReinviteServedByReturnedPrimary = (
  result: WorkerHarnessResult,
): number => {
  if (result.tKill === undefined) return 0
  if (result.killedWorkerPod === "") return 0
  const tKillMs = result.tKill.getTime()
  const invitesByCallId = new Map<
    string,
    Array<{ readonly tMs: number; readonly workerIp: string }>
  >()
  for (const d of result.decisions) {
    if (d.method !== "INVITE" || d.tDecided === undefined) continue
    const arr = invitesByCallId.get(d.callId)
    const entry = { tMs: d.tDecided.getTime(), workerIp: d.workerIp }
    if (arr) arr.push(entry)
    else invitesByCallId.set(d.callId, [entry])
  }
  let count = 0
  for (const [callId, invites] of invitesByCallId) {
    if (invites.length < 3) continue
    invites.sort((a, b) => a.tMs - b.tMs)
    const third = invites[2]!
    if (third.tMs < tKillMs) continue
    const outcome = result.outcomes.get(callId)?.outcome
    if (outcome !== "clean" && outcome !== "retransmitted") continue
    const podName = result.postRecoveryIpMap.get(third.workerIp)
    if (podName === result.killedWorkerPod) count++
  }
  return count
}
