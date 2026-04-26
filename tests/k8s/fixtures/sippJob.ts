import { Data, Effect } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { exec } from "./exec.js"

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

export interface SippRunResult {
  readonly stats: SippStats
  readonly logs: string
  readonly jobStatus: "succeeded" | "failed"
}

export interface SippRunOpts {
  readonly namespace: string
  /** Job name. Must be unique per namespace. */
  readonly name: string
  /** SIPp scenario file mounted from the `sipp-scenarios` ConfigMap. */
  readonly scenario: string
  /** Target SIP URI host (and optional :port). E.g. `sip-front-proxy:5060`. */
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
    args.push("-trace_err", "-error_file", "/tmp/uac-err.log")
    if (opts.extraArgs) args.push(...opts.extraArgs)

    const manifest = renderJobManifest(opts.namespace, opts.name, args)
    yield* applyManifest(manifest)

    const waitTimeoutSec = opts.waitTimeoutSec ?? 60
    const status = yield* waitForJobTermination(opts.namespace, opts.name, waitTimeoutSec)

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
      return yield* Effect.fail(
        new SippJobError({
          job: opts.name,
          reason: `did not terminate within ${waitTimeoutSec}s`,
          logs,
        }),
      )
    }

    const stats = parseSippStats(logs)
    if (stats === null) {
      return yield* Effect.fail(
        new SippJobError({
          job: opts.name,
          reason: "could not parse SIPp statistics from logs",
          logs,
        }),
      )
    }

    return { stats, logs, jobStatus: status }
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
