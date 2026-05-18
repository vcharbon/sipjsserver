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

import { Data, Effect, Fiber } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { BURST_CAPS, BURST_DURATION_SEC, type ChaosOutcome } from "./chaosOps.js"
import { exec } from "../fixtures/exec.js"
import { FRONT_PROXY_VIP_TARGET } from "../fixtures/frontProxyTarget.js"
import { execInPod, kubectlCp } from "../fixtures/kubectl.js"
import { appendNdjsonRows } from "./recorder.js"
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
  /**
   * Path (inside the sipp container) of a CSV passed as `-inf`. One row
   * is consumed per launched call; columns are exposed inside the
   * scenario as `[field0]`, `[field1]`, etc. Used by abuse archetypes
   * to deliver hundreds of distinct call shapes from one scenario.
   */
  readonly inject?: string
  /**
   * Extra raw argv tokens appended to the sipp command line. Abuse
   * archetypes use this to set `-default_behaviors none`, which stops
   * sipp from auto-replying / auto-BYE-ing / aborting on the unexpected
   * 481s and in-dialog requests their floods provoke from the B2BUA.
   */
  readonly extraArgs?: ReadonlyArray<string>
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

// HOST-PLATFORM FREEZE (NOT a B2BUA regression, NOT a real sipp bug).
//
// Symptom: "wheel_base is X, clock_tick is X-1" lines in sipp's err.log
// followed by sipp wedging — stat.csv `ElapsedTime(C)` stops advancing,
// `OutgoingCall` plateaus, `CurrentCall` pins at the in-flight count
// at the moment of freeze, and the proxy's per-worker INVITE-rate
// panel drops to ~0.
//
// Root cause: the host VM (notably WSL2 on Hyper-V, but any VM with
// CPU-stolen TSC behaviour) pauses the guest for ~1-2 s, during which
// sipp's traffic thread can't run while wheel_base keeps advancing
// from the post-pause recovery overshoot. clock_tick ends up trailing
// wheel_base by one tick, which trips the timewheel assert in
// `timewheel::task2list()`. sipp 3.7.0+ (PR #619) closed the main
// thread-race vector inside sipp itself; the residual sensitivity is
// to *external* clock perturbations, which v3.7.7 cannot defend
// against. Direct evidence in our 2026-05-16 run: WSL2 kernel logged
// 11% TSC re-anchor + recurring vmbus_alloc_ring order:7 failures
// during the run window. Two sipp pods independently saw the SAME
// 2-second message-rate dip at the SAME wall-time, proving the stall
// was host-side not sipp-internal.
//
// What this means for the analyst: when per-event "during ok/fail"
// counts collapse to 0 from a specific timestamp onward AND there is
// a `wheel_base` line in err.log, classify as a platform freeze and
// look at host kernel logs (`dmesg -T | grep -i tsc`, vmbus_alloc),
// NOT at the B2BUA. The renderer surfaces this in `timeline.html`
// via the "Platform-side event detected" banner.
//
// Mitigation in this harness: `runStalenessWatchdog` below emits
// staleness rows to `sipp-staleness.ndjson` so the freeze is at
// least *visible* — auto-restart deliberately not wired (mid-soak
// Job recreation skews analysis). The real fix is to run endurance
// on a host with stable monotonic time (dedicated Linux VM or bare
// metal); see docs/plan/2026-05-14-post-proxy-graceful-481-wave-investigation.md
// §6.4.5b.

// Concurrent-call cap (`-l`). Default heuristic ramps to ~3000 under load,
// at which point sipp self-throttles its CallRate to keep CurrentCall at
// that ceiling — calls that get stuck waiting on a failed BYE eat slots
// forever and starve new INVITEs, so the test stops exercising the
// configured CAPS. Set high enough that we can't hit it even with
// minutes of stuck calls accumulating.
const CALL_LIMIT = 100_000

// Per-call inactivity cap (`-recv_timeout`, in ms). If any `<recv>` step
// waits this long for a message the call is aborted as failed. 16 min is
// well above the long-options scenario's 350 s OPTIONS keepalive timeout
// and the short scenario's ~32 s BYE-retransmit window, so it only fires
// on genuinely stuck calls.
const RECV_TIMEOUT_MS = 16 * 60 * 1000

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
    args.push("-l", String(CALL_LIMIT))
    args.push("-recv_timeout", String(RECV_TIMEOUT_MS))
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
    if (opts.inject !== undefined) {
      args.push("-inf", opts.inject)
    }
    for (const a of opts.extraArgs ?? []) {
      args.push(a)
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

    // Staleness watchdog (see wheel_base comment near MAX_CALLS).
    // v3.7.7 doesn't crash on the timewheel race; sipp keeps running
    // but stops scheduling new calls and freezes ElapsedTime(C). A pod
    // watch can't detect this. We poll stat.csv and emit a one-shot
    // staleness event when ElapsedTime(C) hasn't advanced.
    const watchdogFiber = yield* Effect.forkChild(
      runStalenessWatchdog({
        namespace: opts.namespace,
        name: opts.name,
        scenario: opts.scenario,
        artifactDir: opts.artifactDir,
      }),
    )

    const stop = Effect.gen(function* () {
      yield* Fiber.interrupt(watchdogFiber).pipe(Effect.ignore)
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
 * Fire a non-emergency overload burst — a one-shot sipp Job pumping
 * BURST_CAPS calls/s of the `uac-burst-non-emergency.xml` scenario
 * against the proxy VIP for BURST_DURATION_SEC, then stops.
 *
 * The burst's INVITEs carry no `Resource-Priority` header, so they
 * land in the dispatcher's `normalNewCall` class queue and are shed
 * by Tier-1/2/3 once those tiers' thresholds trip. The three baseline
 * streams (which DO carry `Resource-Priority: esnet.0`) sail through
 * unaffected — the expected-impact spec for this event captures that.
 *
 * Returns a `ChaosOutcome` with tFire/tRecovered bracketing the
 * burst's lifetime. The Job's trace artifacts (msg.log.gz,
 * screen.log, err.log, stat.csv) land at
 * `<artifactDir>/sipp/<burstJobName>/` so the analyzer can score
 * the burst's 503-rate / failure-rate against the expected impact.
 */
export const nonEmergencyBurstEvent = (opts: {
  readonly namespace: string
  readonly runId: string
  readonly artifactDir: string
}): Effect.Effect<ChaosOutcome, SippDaemonError> =>
  Effect.gen(function* () {
    // BURST_CAPS / BURST_DURATION_SEC env overrides — used by
    // the chaos sub-command for dichotomy / breaking-point sweeps
    // without rebuilding the cluster image.
    const capsOverride = Number.parseInt(process.env["BURST_CAPS"] ?? "", 10)
    const durOverride = Number.parseInt(process.env["BURST_DURATION_SEC"] ?? "", 10)
    const caps = Number.isFinite(capsOverride) && capsOverride > 0 ? capsOverride : BURST_CAPS
    const durSec =
      Number.isFinite(durOverride) && durOverride > 0 ? durOverride : BURST_DURATION_SEC
    const tFire = new Date()
    const burstName = `burst-${tFire.getTime()}`
    yield* Effect.logInfo(
      `chaos[non-emergency-burst] starting sipp burst (${caps} CAPS for ${durSec}s, name=${burstName})`,
    )
    const handle = yield* startSippDaemon({
      namespace: opts.namespace,
      name: burstName.slice(0, 50),
      scenario: "uac-burst-non-emergency.xml",
      cps: caps,
      artifactDir: opts.artifactDir,
    })
    // Best-effort: even if waitSippRunning fails, the burst still
    // runs (sipp can be Running before the watcher catches it).
    yield* waitSippRunning(opts.namespace, handle.name, 30).pipe(Effect.ignore)
    yield* Effect.sleep(`${durSec} seconds`).pipe(
      Effect.ensuring(handle.stop.pipe(Effect.ignore)),
    )
    const tRecovered = new Date()
    return {
      type: "non-emergency-burst",
      target: burstName,
      tFire,
      tRecovered,
      readyBefore: 0,
      readyAfter: 0,
    }
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
 * Abuse stream archetype catalogue.
 *
 * Each archetype maps to a sipp scenario file + a CSV of per-call
 * mutation parameters. Call-ID prefix is forced to `abuse-` (via the
 * Job name) so the analyzer routes outcomes to the ABUSE_STREAM
 * category — never to STEADY.
 *
 * Architectural invariant: ALL abuse traffic, regardless of which
 * side (UAC or UAS) carries the bad behaviour, routes its B-leg
 * through the abuse-UAS service. The standard sipp-UAS must keep a
 * 100 % OK rate; structural isolation is the only way to guarantee
 * that. Call-control mock detects the `abuse-` prefix in `call_id`
 * and returns abuse-UAS as the destination.
 */
export interface AbuseArchetype {
  /** Slug used in Job name + Call-ID prefix (`abuse-<slug>-...`). */
  readonly slug: string
  /** Scenario filename in the sipp-scenarios ConfigMap. */
  readonly scenario: string
  /** Optional CSV filename (mounted at /scenarios/<csv>). */
  readonly injectCsv?: string
}

/**
 * Starter set of three UAC-side archetypes. The full ≥20-archetype
 * catalogue lands incrementally; see the plan for the queue.
 */
export const ABUSE_ARCHETYPES: ReadonlyArray<AbuseArchetype> = [
  { slug: "reinvite-flood", scenario: "uac-abuse-reinvite-flood.xml", injectCsv: "uac-abuse-reinvite-flood.csv" },
  { slug: "options-flood", scenario: "uac-abuse-options-flood.xml", injectCsv: "uac-abuse-options-flood.csv" },
  { slug: "ghost-after-ack", scenario: "uac-abuse-ghost-after-ack.xml" },
]

export interface AbuseStreamOpts {
  readonly namespace: string
  readonly runId: string
  readonly artifactDir: string
  /** Total CAPS summed across all archetypes. 0 = no abuse Jobs at all. */
  readonly totalCaps: number
  /** If set, run only this slug; everything else stays idle. */
  readonly onlySlug?: string
  /** Forwarded to `startSippDaemon.target`. */
  readonly proxyTarget?: string
}

/**
 * Launch one sipp Job per (selected) archetype. Returns the handles
 * so the orchestrator can stop them on DRAIN. Returns an empty array
 * when totalCaps === 0.
 *
 * Each archetype gets `totalCaps / N` CAPS, with a fractional-rate
 * fallback (one call every `1000 / cps` ms) when cps < 1.
 */
export const startAbuseStreams = (
  opts: AbuseStreamOpts,
): Effect.Effect<ReadonlyArray<SippDaemonHandle>, SippDaemonError> =>
  Effect.gen(function* () {
    if (opts.totalCaps <= 0) return []
    const archetypes = opts.onlySlug !== undefined
      ? ABUSE_ARCHETYPES.filter((a) => a.slug === opts.onlySlug)
      : ABUSE_ARCHETYPES
    if (archetypes.length === 0) {
      return yield* new SippDaemonError({
        job: opts.onlySlug ?? "<all>",
        reason: `no abuse archetype matched --abuse-only='${opts.onlySlug}'`,
      })
    }
    const perArchetypeCps = opts.totalCaps / archetypes.length
    const handles: Array<SippDaemonHandle> = []
    for (const a of archetypes) {
      // Job name must start with `abuse-` so the Call-ID prefix
      // (set by sippJobs.ts as `<jobName>-%u@det`) matches
      // ABUSE_CID_PREFIX in categorize.ts.
      const name = k8sJobName(`abuse-${a.slug}-${opts.runId}`)
      const handle = yield* startSippDaemon({
        namespace: opts.namespace,
        name,
        scenario: a.scenario,
        ...(perArchetypeCps >= 1
          ? { cps: Math.floor(perArchetypeCps) }
          : {
              callsPerPeriodMs: {
                count: 1,
                periodMs: Math.max(1000, Math.floor(1000 / Math.max(0.05, perArchetypeCps))),
              },
            }),
        ...(a.injectCsv !== undefined && {
          inject: `/scenarios/${a.injectCsv}`,
        }),
        // Abuse flows trigger unsolicited 481s, in-dialog OPTIONS, and
        // BYEs from the B2BUA. sipp's default behaviors would auto-reply
        // / auto-BYE / abort the call; disabling them lets the scenario
        // keep dispatching new calls instead of dying on the first
        // unexpected message.
        extraArgs: ["-default_behaviors", "none"],
        artifactDir: opts.artifactDir,
        ...(opts.proxyTarget !== undefined && { target: opts.proxyTarget }),
      })
      handles.push(handle)
    }
    return handles
  })

// Duplicate of run-endurance.ts's helper; not exported there to avoid
// circular dep, so re-derived here for the abuse-stream Job names.
const k8sJobName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .slice(0, 50)
    .replace(/^[-.]+|[-.]+$/g, "")

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

const parseElapsedTimeC = (csv: string): string | undefined => {
  const lines = csv.split("\n").filter((l) => l.trim().length > 0)
  if (lines.length < 2) return undefined
  const header = (lines[0] ?? "").split(";")
  const lastRow = (lines[lines.length - 1] ?? "").split(";")
  const idx = header.indexOf("ElapsedTime(C)")
  if (idx < 0) return undefined
  const v = (lastRow[idx] ?? "").trim()
  return v === "" ? undefined : v
}

// Polls stat.csv every 30s; flags the stream once when ElapsedTime(C)
// hasn't advanced for ≥60s. Continues polling after flagging (cheap,
// and useful if sipp ever recovers). The flagged event lands in
// sipp-staleness.ndjson so the analyzer / operator can correlate.
const runStalenessWatchdog = (opts: {
  readonly namespace: string
  readonly name: string
  readonly scenario: string
  readonly artifactDir: string
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    let prev: string | undefined
    let staleCount = 0
    let flagged = false
    while (true) {
      yield* Effect.sleep("30 seconds")
      const csv = yield* readSippStatCsv(opts.namespace, opts.name)
      const elapsed = parseElapsedTimeC(csv)
      if (elapsed === undefined) continue
      if (prev !== undefined && elapsed === prev) staleCount += 1
      else staleCount = 0
      prev = elapsed
      if (staleCount >= 2 && !flagged) {
        flagged = true
        const tDetected = new Date().toISOString()
        yield* Effect.logWarning(
          `sipp staleness detected on ${opts.name} (scenario=${opts.scenario}): ElapsedTime(C) stuck at ${elapsed} for ≥60s. Suspect wheel_base/clock_tick race (see MAX_CALLS comment).`,
        )
        yield* appendNdjsonRows(
          path.join(opts.artifactDir, "sipp-staleness.ndjson"),
          [
            {
              tDetected,
              name: opts.name,
              scenario: opts.scenario,
              lastElapsed: elapsed,
            },
          ],
        )
      }
    }
  })

