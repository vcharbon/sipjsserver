import { Data, Effect } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { exec } from "./exec.js"
import { execInPod, kubectlCp } from "./kubectl.js"

export class SippJobError extends Data.TaggedError("SippJobError")<{
  readonly job: string
  readonly reason: string
  readonly logs?: string
}> {
  override get message(): string {
    return `SIPp job '${this.job}' ${this.reason}${this.logs ? `\n${this.logs}` : ""}`
  }
}

export interface SippStats {
  readonly successful: number
  readonly failed: number
  readonly created: number
}

export interface SippTracePaths {
  readonly msgLog?: string
  readonly statCsv?: string
  readonly screenLog?: string
  readonly rttCsv?: string
}

export interface SippRunResult {
  readonly stats: SippStats
  readonly logs: string
  readonly jobStatus: "succeeded" | "failed"
  /**
   * Filled when `captureTraces: true` AND `archiveDir` is supplied —
   * absolute paths on the host where each sipp trace file landed after
   * `kubectl cp`. Files that sipp didn't actually write (e.g. `rttCsv`
   * when the scenario has no `rtd` markers) are omitted.
   */
  readonly tracePaths?: SippTracePaths
}

export interface SippRunOpts {
  readonly namespace: string
  /** Job name. Must be unique per namespace. */
  readonly name: string
  /** SIPp scenario file mounted from the `sipp-scenarios` ConfigMap. */
  readonly scenario: string
  /**
   * Target SIP URI host (and optional :port). Use the
   * `FRONT_PROXY_VIP_TARGET` constant from
   * `tests/k8s/fixtures/frontProxyTarget.ts` to reach the front-proxy
   * — with `sip-front-proxy.vip.enabled` (the test default), the
   * Service DNS does not work because the proxy listener binds the
   * VIP only.
   */
  readonly target: string
  /** R-URI service name (`sip:[service]@target`). */
  readonly service?: string
  readonly calls: number
  /** Calls per second. */
  readonly callsPerSecond?: number
  /** Hard timeout for the SIPp process in seconds. */
  readonly timeoutSec?: number
  /** Wait at most this many seconds for the Job to terminate. */
  readonly waitTimeoutSec?: number
  /** Extra raw args appended to the SIPp invocation. */
  readonly extraArgs?: ReadonlyArray<string>
  /**
   * When true, sipp is launched with `-trace_msg`, `-trace_stat`,
   * `-trace_screen`, and `-trace_rtt`, all writing into a pod-local
   * `emptyDir` mounted at `/out`. The container then idles in `sleep`
   * after sipp exits so we can `kubectl cp` the files out before the
   * Job is reaped. Default false.
   */
  readonly captureTraces?: boolean
  /**
   * Required when `captureTraces` is true. Trace files land under
   * `<archiveDir>/sipp-traces/`. The directory is created if missing.
   */
  readonly archiveDir?: string
}

/**
 * Render a one-shot SIPp UAC Job, apply it, wait for completion (or
 * failure), fetch logs, and parse the cumulative success/failure
 * counters from SIPp's statistics output.
 *
 * Resolves with `jobStatus: "succeeded" | "failed"`. Tests choose
 * whether to assert on jobStatus or on `stats.successful` /
 * `stats.failed` directly — chaos tests typically tolerate non-zero
 * failed counts.
 */
export const runSippJob = (opts: SippRunOpts): Effect.Effect<SippRunResult, SippJobError> =>
  Effect.gen(function* () {
    const captureTraces = opts.captureTraces === true
    if (captureTraces && !opts.archiveDir) {
      return yield* new SippJobError({
        job: opts.name,
        reason: "captureTraces=true requires archiveDir",
      })
    }

    const args: Array<string> = [opts.target]
    if (opts.service) args.push("-s", opts.service)
    args.push("-sf", `/scenarios/${opts.scenario}`)
    args.push("-m", String(opts.calls))
    if (opts.callsPerSecond !== undefined) {
      args.push("-r", String(opts.callsPerSecond))
    }
    if (opts.timeoutSec !== undefined) {
      args.push("-timeout", `${opts.timeoutSec}s`)
    }
    if (captureTraces) {
      args.push(
        "-trace_msg",
        "-message_file",
        "/out/msg.log",
        "-trace_stat",
        "-stf",
        "/out/stat.csv",
        "-trace_screen",
        "-screen_file",
        "/out/screen.log",
        "-trace_rtt",
        "-trace_err",
        "-error_file",
        "/out/err.log",
      )
    } else {
      args.push("-trace_err", "-error_file", "/tmp/uac-err.log")
    }
    if (opts.extraArgs) args.push(...opts.extraArgs)

    const manifest = captureTraces
      ? renderJobManifestWithTraces(opts.namespace, opts.name, args)
      : renderJobManifest(opts.namespace, opts.name, args)
    yield* applyManifest(manifest)

    const waitTimeoutSec = opts.waitTimeoutSec ?? 60

    let tracePaths: SippTracePaths | undefined
    let status: "succeeded" | "failed" | "timeout"

    if (captureTraces) {
      // The container runs sipp then idles in `sleep` so we can `kubectl
      // cp` the trace files out while the pod is still in `Running`
      // phase. We poll for the `/out/.done` sentinel sipp's wrapper
      // touches on exit, then read the exit code, copy traces, then
      // delete the pod to release the Job.
      const podName = yield* findJobPod(opts.namespace, opts.name, waitTimeoutSec)
      const exitCode = yield* waitForSippExit(
        opts.namespace,
        podName,
        waitTimeoutSec,
      )
      // Always attempt the cp before tearing the pod down; even on a
      // sipp-side failure the trace files are useful for diagnosis.
      tracePaths = yield* copyTraces(
        opts.namespace,
        podName,
        opts.archiveDir as string,
      )
      // Release the sleeping wrapper so the Job's `.status` flips.
      yield* exec(
        "kubectl",
        ["-n", opts.namespace, "delete", "pod", podName, "--grace-period=0", "--force", "--ignore-not-found"],
        { timeoutMs: 30_000 },
      ).pipe(Effect.ignore)
      if (exitCode === undefined) {
        status = "timeout"
      } else if (exitCode === 0) {
        status = "succeeded"
      } else {
        status = "failed"
      }
    } else {
      status = yield* waitForJobTermination(opts.namespace, opts.name, waitTimeoutSec)
    }

    const logsResult = yield* exec("kubectl", [
      "-n",
      opts.namespace,
      "logs",
      `job/${opts.name}`,
    ]).pipe(
      Effect.catchTag("ExecError", (e) =>
        Effect.succeed({ stdout: e.stdout, stderr: e.stderr }),
      ),
    )
    const logs = logsResult.stdout

    if (status === "timeout") {
      return yield* new SippJobError({
        job: opts.name,
        reason: `did not terminate within ${waitTimeoutSec}s`,
        logs,
      })
    }

    // When capturing traces sipp's screen output is in `screen.log`
    // rather than the kubectl logs (which only show our wrapper's
    // echo). Prefer the on-disk screen log for stat parsing.
    let parseSource = logs
    if (captureTraces && tracePaths?.screenLog) {
      const screenContent = yield* Effect.tryPromise(() =>
        fs.readFile(tracePaths!.screenLog!, "utf8"),
      ).pipe(Effect.orElseSucceed(() => ""))
      if (screenContent.length > 0) parseSource = screenContent
    }

    const stats = parseSippStats(parseSource)
    if (stats === null) {
      return yield* new SippJobError({
        job: opts.name,
        reason: "could not parse SIPp statistics from logs",
        logs,
      })
    }

    if (tracePaths === undefined) {
      return { stats, logs, jobStatus: status }
    }
    return { stats, logs, jobStatus: status, tracePaths }
  })

const renderJobManifest = (namespace: string, name: string, args: ReadonlyArray<string>) =>
  `apiVersion: batch/v1
kind: Job
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: sipp-uac
    sipp-job-name: ${name}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  template:
    metadata:
      labels:
        app.kubernetes.io/name: sipp-uac
        sipp-job-name: ${name}
    spec:
      restartPolicy: Never
      nodeSelector:
        tier: load
      containers:
        - name: uac
          image: sipp:dev
          imagePullPolicy: IfNotPresent
          args: ${JSON.stringify(args)}
          volumeMounts:
            - name: scenarios
              mountPath: /scenarios
      volumes:
        - name: scenarios
          configMap:
            name: sipp-scenarios
`

/**
 * Variant of `renderJobManifest` for `captureTraces: true`. Differs in
 * three ways:
 *
 *   1. The container's command is `/bin/sh -c` and it runs sipp as a
 *      subcommand. After sipp exits, the wrapper writes the exit code
 *      to `/out/.exit`, touches `/out/.done`, then idles in `sleep`.
 *      That keeps the pod in `Running` so the test driver can
 *      `kubectl cp` the trace files out before tearing the pod down.
 *
 *   2. An `emptyDir` volume named `out` is mounted at `/out`.
 *
 *   3. The `tini`-style sleep loop respects SIGTERM so a `kubectl
 *      delete pod` after the cp completes flips the Job into a
 *      terminal state quickly.
 */
const renderJobManifestWithTraces = (
  namespace: string,
  name: string,
  args: ReadonlyArray<string>,
) => {
  const sippCmd = ["sipp", ...args].map(shellQuote).join(" ")
  // The wrapper preserves sipp's exit code and exits with it once the
  // sleep is interrupted (SIGTERM from `kubectl delete pod`).
  const wrapper =
    `${sippCmd}; ec=$?; ` +
    `echo "$ec" > /out/.exit; touch /out/.done; ` +
    `trap 'exit $ec' TERM INT; ` +
    `sleep 600 & wait $!; ` +
    `exit $ec`
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: sipp-uac
    sipp-job-name: ${name}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  template:
    metadata:
      labels:
        app.kubernetes.io/name: sipp-uac
        sipp-job-name: ${name}
    spec:
      restartPolicy: Never
      nodeSelector:
        tier: load
      containers:
        - name: uac
          image: sipp:dev
          imagePullPolicy: IfNotPresent
          command: ["/bin/sh", "-c"]
          args: [${JSON.stringify(wrapper)}]
          workingDir: /out
          volumeMounts:
            - name: scenarios
              mountPath: /scenarios
            - name: out
              mountPath: /out
      volumes:
        - name: scenarios
          configMap:
            name: sipp-scenarios
        - name: out
          emptyDir: {}
`
}

/**
 * Minimal POSIX-shell single-quote escape — wrap in single quotes,
 * replacing any embedded single quote with `'\''`. We only need this
 * because the wrapper joins the sipp args into one shell command.
 */
const shellQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"

/**
 * Resolve the sipp Job's pod name via label selector. The Job creates
 * exactly one pod (backoffLimit=0); we wait until that pod exists and
 * is in `Running` (or any phase) before returning.
 */
const findJobPod = (
  namespace: string,
  jobName: string,
  timeoutSec: number,
): Effect.Effect<string, SippJobError> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutSec * 1000
    while (Date.now() < deadline) {
      const result = yield* exec(
        "kubectl",
        [
          "-n",
          namespace,
          "get",
          "pods",
          "-l",
          `sipp-job-name=${jobName}`,
          "-o",
          "jsonpath={.items[0].metadata.name}",
        ],
        { timeoutMs: 10_000 },
      ).pipe(
        Effect.matchEffect({
          onSuccess: (r) => Effect.succeed(r.stdout.trim()),
          onFailure: () => Effect.succeed(""),
        }),
      )
      if (result.length > 0) return result
      yield* Effect.sleep("500 millis")
    }
    return yield* new SippJobError({
      job: jobName,
      reason: `pod for job not visible within ${timeoutSec}s`,
    })
  })

/**
 * Wait for sipp to exit by polling for the `/out/.done` sentinel the
 * wrapper touches. Returns the parsed exit code (0..255), or
 * `undefined` if the timeout fires first.
 */
const waitForSippExit = (
  namespace: string,
  podName: string,
  timeoutSec: number,
): Effect.Effect<number | undefined, never> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutSec * 1000
    while (Date.now() < deadline) {
      const seen = yield* execInPod(namespace, podName, "uac", [
        "sh",
        "-c",
        "[ -f /out/.done ] && cat /out/.exit || echo PENDING",
      ]).pipe(
        Effect.matchEffect({
          onSuccess: (r) => Effect.succeed(r.stdout.trim()),
          onFailure: () => Effect.succeed(""),
        }),
      )
      if (seen !== "" && seen !== "PENDING") {
        const code = parseInt(seen, 10)
        if (Number.isFinite(code)) return code
      }
      yield* Effect.sleep("1 second")
    }
    return undefined
  })

/**
 * Copy `/out/<file>` from the sipp pod to
 * `<archiveDir>/sipp-traces/<file>` for each known trace file. Files
 * sipp didn't actually write are simply skipped — `kubectl cp` would
 * fail with "no such file" but we ignore that and only return paths
 * for files that did make it.
 */
const copyTraces = (
  namespace: string,
  podName: string,
  archiveDir: string,
): Effect.Effect<SippTracePaths, never> =>
  Effect.gen(function* () {
    const dir = path.join(archiveDir, "sipp-traces")
    yield* Effect.tryPromise(() => fs.mkdir(dir, { recursive: true })).pipe(
      Effect.orDie,
    )
    const candidates: ReadonlyArray<{
      readonly key: keyof SippTracePaths
      readonly remote: string
      readonly local: string
    }> = [
      { key: "msgLog", remote: "/out/msg.log", local: path.join(dir, "msg.log") },
      { key: "statCsv", remote: "/out/stat.csv", local: path.join(dir, "stat.csv") },
      {
        key: "screenLog",
        remote: "/out/screen.log",
        local: path.join(dir, "screen.log"),
      },
      // sipp auto-names rtt files; cp the whole /out and then promote
      // the rtt csv if it exists.
    ]
    const out: { -readonly [K in keyof SippTracePaths]: SippTracePaths[K] } = {}
    for (const c of candidates) {
      const ok = yield* kubectlCp(namespace, podName, c.remote, c.local).pipe(
        Effect.match({ onSuccess: () => true, onFailure: () => false }),
      )
      if (ok) {
        const exists = yield* Effect.tryPromise(() => fs.stat(c.local)).pipe(
          Effect.match({ onSuccess: () => true, onFailure: () => false }),
        )
        if (exists) (out as Record<string, string>)[c.key] = c.local
      }
    }
    // RTT — sipp names the file `<scenario>_<pid>_rtt.csv`. Discover it.
    const rttList = yield* execInPod(namespace, podName, "uac", [
      "sh",
      "-c",
      "ls /out/*_rtt.csv 2>/dev/null | head -n1",
    ]).pipe(
      Effect.matchEffect({
        onSuccess: (r) => Effect.succeed(r.stdout.trim()),
        onFailure: () => Effect.succeed(""),
      }),
    )
    if (rttList.length > 0) {
      const rttLocal = path.join(dir, "rtt.csv")
      const ok = yield* kubectlCp(namespace, podName, rttList, rttLocal).pipe(
        Effect.match({ onSuccess: () => true, onFailure: () => false }),
      )
      if (ok) out.rttCsv = rttLocal
    }
    return out
  })

const applyManifest = (yaml: string) =>
  Effect.gen(function* () {
    const tmp = path.join(os.tmpdir(), `sipp-job-${process.pid}-${Date.now()}.yaml`)
    yield* Effect.tryPromise(() => fs.writeFile(tmp, yaml, "utf8")).pipe(Effect.orDie)
    try {
      yield* exec("kubectl", ["apply", "-f", tmp]).pipe(
        Effect.mapError(
          (e) =>
            new SippJobError({
              job: "kubectl-apply",
              reason: "kubectl apply failed",
              logs: e.stderr || e.stdout,
            }),
        ),
      )
    } finally {
      yield* Effect.tryPromise(() => fs.unlink(tmp)).pipe(Effect.ignore)
    }
  })

/**
 * Poll the Job's `.status` until either `succeeded >= 1` or
 * `failed >= 1`. Returns "timeout" if neither happens within the bound.
 */
const waitForJobTermination = (
  namespace: string,
  name: string,
  timeoutSec: number,
): Effect.Effect<"succeeded" | "failed" | "timeout", never> =>
  Effect.gen(function* () {
    const start = Date.now()
    const deadline = start + timeoutSec * 1000
    while (Date.now() < deadline) {
      const result = yield* exec(
        "kubectl",
        [
          "-n",
          namespace,
          "get",
          "job",
          name,
          "-o",
          "jsonpath={.status.succeeded}|{.status.failed}",
        ],
        { timeoutMs: 10_000 },
      ).pipe(
        Effect.matchEffect({
          onSuccess: (r) => Effect.succeed(r.stdout.trim()),
          onFailure: () => Effect.succeed(""),
        }),
      )
      const [succeededRaw, failedRaw] = result.split("|")
      if (succeededRaw && parseInt(succeededRaw, 10) >= 1) return "succeeded" as const
      if (failedRaw && parseInt(failedRaw, 10) >= 1) return "failed" as const
      yield* Effect.sleep("1 second")
    }
    return "timeout" as const
  })

/**
 * Parse cumulative call counters from SIPp's terminal stats. Returns
 * null if the section is missing (SIPp died before printing stats).
 */
export const parseSippStats = (logs: string): SippStats | null => {
  const successful = matchCumulative(logs, /Successful call\s+\|\s+\S+\s+\|\s+(\d+)/)
  const failed = matchCumulative(logs, /Failed call\s+\|\s+\S+\s+\|\s+(\d+)/)
  const created = matchCumulative(
    logs,
    /Outgoing calls created\s+\|\s+\S+\s+\|\s+(\d+)/,
  )
  if (successful === null || failed === null || created === null) {
    return null
  }
  return { successful, failed, created }
}

const matchCumulative = (logs: string, re: RegExp): number | null => {
  const m = re.exec(logs)
  if (!m || m[1] === undefined) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

export const deleteSippJob = (namespace: string, name: string) =>
  exec(
    "kubectl",
    ["-n", namespace, "delete", "job", name, "--ignore-not-found", "--wait=false"],
    { timeoutMs: 30_000 },
  )
