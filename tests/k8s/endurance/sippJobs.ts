/**
 * Long-lived sipp Job orchestration for the endurance harness.
 *
 * Differs from `tests/k8s/fixtures/sippJob.ts` in two ways:
 *
 *   1. The sipp container runs without `-m` so it generates calls
 *      indefinitely (until SIGTERM). The orchestrator stops it during
 *      the DRAIN phase.
 *
 *   2. Trace logs land in an `emptyDir` and are gzipped + `kubectl cp`'d
 *      out at stop time. No live rotation: at moderate load the disk
 *      footprint stays under ~6 GB even for 24h, well within emptyDir
 *      tolerance on a default kind setup.
 *
 * The three streams (short-hold, long-options, limiter-probe) share
 * this single primitive — they differ only in scenario file and
 * `-set` parameter values.
 */

import { Data, Effect } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { exec } from "../fixtures/exec.js"
import { FRONT_PROXY_VIP_TARGET } from "../fixtures/frontProxyTarget.js"
import { execInPod, kubectlCp } from "../fixtures/kubectl.js"
import { parseSippStats, type SippStats } from "../fixtures/sippJob.js"
import { parseSippStat } from "../fixtures/sippOutcomes.js"

export class SippDaemonError extends Data.TaggedError("SippDaemonError")<{
  readonly job: string
  readonly reason: string
}> {
  override get message(): string {
    return `sipp daemon '${this.job}': ${this.reason}`
  }
}

export interface SippDaemonOpts {
  readonly namespace: string
  /** Job name (must be unique in namespace). */
  readonly name: string
  /** Scenario file in the sipp-scenarios ConfigMap (e.g. "uac-endurance-short.xml"). */
  readonly scenario: string
  /**
   * SIP target URI host[:port]. Default: the shared
   * `FRONT_PROXY_VIP_TARGET` constant
   * (`tests/k8s/fixtures/frontProxyTarget.ts`). With
   * `sip-front-proxy.vip.enabled` (the test default), the proxy
   * listener binds to the VIP only — the Service DNS
   * `sip-front-proxy:5060` DNATs to pod/node IPs where nothing is
   * listening, so sipp UDP retrans-times out. Targeting the VIP
   * directly avoids that.
   */
  readonly target?: string
  /** R-URI service user. Default: "test". */
  readonly service?: string
  /** Calls per second (sipp `-r`). Fractional CPS via callsPerPeriodMs. */
  readonly cps?: number
  /**
   * Alternative low-rate spec: 1 call every `callsPerPeriodMs`. Used by
   * the long-options stream where 0.4 CAPS would be expressed as 1 per
   * 2500 ms (`-r 1 -rp 2500`).
   */
  readonly callsPerPeriodMs?: { readonly count: number; readonly periodMs: number }
  /** Extra `-set name=value` entries for in-scenario substitution. */
  readonly setVars?: ReadonlyArray<readonly [string, string]>
  /**
   * `-key keyword value` entries. Used to pass values containing
   * `[`/`]` chars into the scenario without sipp re-parsing them as
   * built-in macros. Reference in scenario CDATA as `[keyword]`.
   */
  readonly keyVars?: ReadonlyArray<readonly [string, string]>
  /** Artifact dir; sipp traces land in `<artifactDir>/sipp/<name>/` on stop. */
  readonly artifactDir: string
}

export interface SippDaemonHandle {
  readonly name: string
  readonly stop: Effect.Effect<SippDaemonResult>
}

export interface SippDaemonResult {
  readonly name: string
  readonly stats: SippStats | null
  /** Path to the gzipped sipp message trace, or undefined if not collected. */
  readonly msgLogGz?: string
  /** Path to the screen log (sipp's stat output). */
  readonly screenLog?: string
  /** Path to the err log if sipp wrote one. */
  readonly errLog?: string
}

const MAX_CALLS = 2_000_000_000 // sipp `-m` upper bound; effectively unlimited.

/**
 * Apply the Job manifest, fork a watcher fiber that polls the sipp
 * pod until it disappears, and return a handle the orchestrator stops
 * later.
 */
export const startSippDaemon = (
  opts: SippDaemonOpts,
): Effect.Effect<SippDaemonHandle, SippDaemonError> =>
  Effect.gen(function* () {
    const target = opts.target ?? FRONT_PROXY_VIP_TARGET
    const service = opts.service ?? "test"
    const args: Array<string> = [target, "-s", service]
    args.push("-sf", `/scenarios/${opts.scenario}`)
    args.push("-m", String(MAX_CALLS))
    if (opts.callsPerPeriodMs) {
      args.push("-r", String(opts.callsPerPeriodMs.count))
      args.push("-rp", String(opts.callsPerPeriodMs.periodMs))
    } else if (opts.cps !== undefined) {
      args.push("-r", String(opts.cps))
    }
    // Inject the Job name as the Call-ID prefix so the analyzer can
    // identify which stream a call belongs to (specifically: the
    // limiter-probe stream needs its calls separated from STEADY).
    args.push("-cid_str", `${opts.name}-%u@det`)
    args.push(
      "-trace_msg",
      "-message_file",
      "/out/msg.log",
      // -trace_stat writes a CSV row every -fd seconds with cumulative
      // counters; the SOAK-START sanity gate reads this live (vs.
      // screen.log which sipp only flushes on exit).
      "-trace_stat",
      "-stf",
      "/out/stat.csv",
      "-trace_screen",
      "-screen_file",
      "/out/screen.log",
      "-trace_err",
      "-error_file",
      "/out/err.log",
    )
    for (const [k, v] of opts.setVars ?? []) {
      args.push("-set", `${k}=${v}`)
    }
    for (const [k, v] of opts.keyVars ?? []) {
      args.push("-key", k, v)
    }
    // sipp's stats refresh frequency. 10s gives the SOAK-START sanity
    // gate a chance to read at least one stat row at WARMUP=60s
    // (smoke). The analyzer doesn't depend on stat resolution for
    // per-call data — it parses msg.log directly.
    args.push("-fd", "10")

    // Pre-delete any existing Job with the same name (e.g. residual
    // from a previous --reuse-cluster run) so kubectl apply doesn't
    // hit "field is immutable" when the new spec differs.
    yield* exec(
      "kubectl",
      [
        "-n",
        opts.namespace,
        "delete",
        "job",
        opts.name,
        "--ignore-not-found",
        "--wait=true",
      ],
      { timeoutMs: 60_000 },
    ).pipe(Effect.ignore)

    const manifest = renderJobManifest(opts.namespace, opts.name, args)
    yield* applyManifest(manifest).pipe(
      Effect.mapError(
        (e) => new SippDaemonError({ job: opts.name, reason: e.message }),
      ),
    )

    const stop = Effect.gen(function* () {
      // 1. Find the pod (it may have died already).
      const pod = yield* findJobPod(opts.namespace, opts.name).pipe(
        Effect.orElseSucceed(() => ""),
      )
      const sippDir = path.join(opts.artifactDir, "sipp", opts.name)
      yield* Effect.tryPromise(() => fs.mkdir(sippDir, { recursive: true })).pipe(
        Effect.orDie,
      )
      let msgLogGz: string | undefined
      let screenLog: string | undefined
      let errLog: string | undefined
      let stats: SippStats | null = null

      if (pod !== "") {
        // 2. SIGTERM the sipp process so it flushes its trace files.
        //    sipp catches TERM and exits with stats; the wrapper
        //    preserves the exit code.
        yield* execInPod(opts.namespace, pod, "uac", [
          "sh",
          "-c",
          "pkill -TERM -x sipp || true",
        ]).pipe(Effect.ignore)
        // 3. Wait briefly for sipp to write the final trace bytes.
        yield* Effect.sleep("3 seconds")
        // 4. Gzip the on-pod files BEFORE cp to keep transfer size sane.
        yield* execInPod(opts.namespace, pod, "uac", [
          "sh",
          "-c",
          "gzip -f /out/msg.log 2>/dev/null || true",
        ]).pipe(Effect.ignore)
        // 5. Copy traces out.
        const msgGzLocal = path.join(sippDir, "msg.log.gz")
        const screenLocal = path.join(sippDir, "screen.log")
        const errLocal = path.join(sippDir, "err.log")
        const okGz = yield* kubectlCp(
          opts.namespace,
          pod,
          "/out/msg.log.gz",
          msgGzLocal,
        ).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }))
        if (okGz) msgLogGz = msgGzLocal
        const okScreen = yield* kubectlCp(
          opts.namespace,
          pod,
          "/out/screen.log",
          screenLocal,
        ).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }))
        if (okScreen) screenLog = screenLocal
        const okErr = yield* kubectlCp(
          opts.namespace,
          pod,
          "/out/err.log",
          errLocal,
        ).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }))
        if (okErr) errLog = errLocal
        // Sipp's `-trace_screen` output is only flushed on Q-key /
        // clean exit, NOT on SIGTERM. Copy stat.csv too so we still
        // get cumulative totals when SIGTERM is the stop mechanism.
        const statLocal = path.join(sippDir, "stat.csv")
        const okStat = yield* kubectlCp(
          opts.namespace,
          pod,
          "/out/stat.csv",
          statLocal,
        ).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }))

        // 6. Parse stats: prefer screen.log (richer); fall back to
        //    stat.csv when screen.log is empty (the SIGTERM case).
        if (screenLog !== undefined) {
          const text = yield* Effect.tryPromise(() =>
            fs.readFile(screenLog!, "utf8"),
          ).pipe(Effect.orElseSucceed(() => ""))
          stats = parseSippStats(text)
        }
        if (stats === null && okStat) {
          const csv = yield* Effect.tryPromise(() =>
            fs.readFile(statLocal, "utf8"),
          ).pipe(Effect.orElseSucceed(() => ""))
          const totals = parseSippStat(csv)
          if (totals !== undefined) {
            stats = {
              successful: totals.successful,
              failed: totals.failed,
              created: totals.totalCalls,
            }
          }
        }
        // 7. Delete the pod to free its emptyDir.
        yield* exec(
          "kubectl",
          [
            "-n",
            opts.namespace,
            "delete",
            "pod",
            pod,
            "--grace-period=0",
            "--force",
            "--ignore-not-found",
          ],
          { timeoutMs: 30_000 },
        ).pipe(Effect.ignore)
      }

      // 8. Delete the Job too (releases ConfigMap mounts).
      yield* exec(
        "kubectl",
        [
          "-n",
          opts.namespace,
          "delete",
          "job",
          opts.name,
          "--ignore-not-found",
          "--wait=false",
        ],
        { timeoutMs: 30_000 },
      ).pipe(Effect.ignore)

      const out: SippDaemonResult = { name: opts.name, stats }
      if (msgLogGz !== undefined) (out as { msgLogGz?: string }).msgLogGz = msgLogGz
      if (screenLog !== undefined)
        (out as { screenLog?: string }).screenLog = screenLog
      if (errLog !== undefined) (out as { errLog?: string }).errLog = errLog
      return out
    })

    return { name: opts.name, stop }
  })

const renderJobManifest = (
  namespace: string,
  name: string,
  args: ReadonlyArray<string>,
): string => {
  const sippCmd = ["sipp", ...args].map(shellQuote).join(" ")
  // Wrapper: run sipp, then idle in `sleep` after exit so the
  // orchestrator can `kubectl cp` traces before the pod is reaped.
  const wrapper =
    `${sippCmd}; ec=$?; ` +
    `echo "$ec" > /out/.exit; touch /out/.done; ` +
    `trap 'exit $ec' TERM INT; ` +
    `sleep 86400 & wait $!; ` +
    `exit $ec`
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: ${name}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: sipp-uac
    sipp-job-name: ${name}
    sipp-endurance: "true"
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: sipp-uac
        sipp-job-name: ${name}
        sipp-endurance: "true"
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

const shellQuote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"

const applyManifest = (yaml: string) =>
  Effect.gen(function* () {
    const tmp = path.join(os.tmpdir(), `endurance-sipp-${process.pid}-${Date.now()}.yaml`)
    yield* Effect.tryPromise(() => fs.writeFile(tmp, yaml, "utf8")).pipe(Effect.orDie)
    try {
      yield* exec("kubectl", ["apply", "-f", tmp])
    } finally {
      yield* Effect.tryPromise(() => fs.unlink(tmp)).pipe(Effect.ignore)
    }
  })

const findJobPod = (
  namespace: string,
  jobName: string,
): Effect.Effect<string, SippDaemonError> =>
  Effect.gen(function* () {
    const result = yield* exec("kubectl", [
      "-n",
      namespace,
      "get",
      "pods",
      "-l",
      `sipp-job-name=${jobName}`,
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ]).pipe(
      Effect.matchEffect({
        onSuccess: (r) => Effect.succeed(r.stdout.trim()),
        onFailure: () => Effect.succeed(""),
      }),
    )
    if (result === "") {
      return yield* new SippDaemonError({ job: jobName, reason: "no pod for sipp Job" })
    }
    return result
  })

/**
 * Wait until the sipp pod is in Running with sipp emitting at least
 * one stat line. Used by the orchestrator's WARMUP gate to confirm a
 * stream actually started before counting WARMUP success.
 */
export const waitSippRunning = (
  namespace: string,
  jobName: string,
  timeoutSec: number,
): Effect.Effect<void, SippDaemonError> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutSec * 1000
    while (Date.now() < deadline) {
      const phase = yield* exec("kubectl", [
        "-n",
        namespace,
        "get",
        "pods",
        "-l",
        `sipp-job-name=${jobName}`,
        "-o",
        "jsonpath={.items[0].status.phase}",
      ]).pipe(
        Effect.matchEffect({
          onSuccess: (r) => Effect.succeed(r.stdout.trim()),
          onFailure: () => Effect.succeed(""),
        }),
      )
      if (phase === "Running") return
      yield* Effect.sleep("1 second")
    }
    return yield* new SippDaemonError({
      job: jobName,
      reason: `sipp Job did not reach Running within ${timeoutSec}s`,
    })
  })

/**
 * Read sipp's stat.csv directly out of the running pod. Sipp updates
 * stat.csv every `-fd` seconds with a cumulative-counters row, unlike
 * screen.log which is only flushed on sipp exit. Used by the
 * orchestrator's SOAK-START sanity gate to confirm at least one
 * successful call before chaos starts.
 *
 * Returns the full CSV content or "" on failure.
 */
export const readSippStatCsv = (
  namespace: string,
  jobName: string,
): Effect.Effect<string, never> =>
  Effect.gen(function* () {
    const pod = yield* findJobPod(namespace, jobName).pipe(
      Effect.matchEffect({
        onSuccess: (p) => Effect.succeed(p),
        onFailure: () => Effect.succeed(""),
      }),
    )
    if (pod === "") return ""
    return yield* execInPod(namespace, pod, "uac", [
      "sh",
      "-c",
      "cat /out/stat.csv 2>/dev/null || true",
    ]).pipe(
      Effect.matchEffect({
        onSuccess: (r) => Effect.succeed(r.stdout),
        onFailure: () => Effect.succeed(""),
      }),
    )
  })

