/**
 * K8s endurance test orchestrator (CLI).
 *
 *   npm run test:k8s:endurance -- --duration 6h
 *   npm run test:k8s:endurance:smoke
 *
 * Sequences the full run: BRINGUP → WARMUP → SOAK-START GATE → SOAK
 * (chaos schedule active) → COOLDOWN → DRAIN → SNAPSHOT → ANALYZE.
 *
 * See docs/plan/long-endurence-tests-session-hidden-graham.md and
 * docs/k8s-endurance.md for design + operator notes.
 */

import { Data, Effect, References } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { clusterDown, clusterUp } from "../fixtures/cluster.js"
import {
  installProxy,
  installRedis,
  installSipp,
  installWorker,
  WORKER_VALUES_ENDURANCE,
} from "../fixtures/helm.js"
import { buildAndLoad } from "../fixtures/images.js"
import {
  killPodEvent,
  nodeShutdownEvent,
  proxyCutoffEvent,
  type ChaosEventType,
  type ChaosOutcome,
} from "./chaosOps.js"
import { appendNdjsonRows, startRecorder } from "./recorder.js"
import {
  buildSchedule,
  buildSmokeSchedule,
  type ScheduledEvent,
} from "./scheduler.js"
import {
  readSippStatCsv,
  startSippDaemon,
  waitSippRunning,
  type SippDaemonHandle,
  type SippDaemonResult,
} from "./sippJobs.js"
import { captureSnapshot } from "./snapshot.js"
import { parseSippStat } from "../fixtures/sippOutcomes.js"

const NAMESPACE = "sip-test"
const LIMITER_PROBE_ID = "endurance-probe"

// K8s Job names must be RFC 1123 subdomain compliant: lowercase
// alphanumerics + '-' + '.', start/end alphanumeric, ≤63 chars.
const k8sJobName = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .slice(0, 50)
    .replace(/^[-.]+|[-.]+$/g, "")

class EnduranceAbort extends Data.TaggedError("EnduranceAbort")<{
  readonly phase: string
  readonly reason: string
}> {
  override get message(): string {
    return `endurance ${this.phase}: ${this.reason}`
  }
}

interface CliArgs {
  readonly durationSec: number
  readonly caps: number
  readonly limiterCap: number
  readonly warmupSec: number
  readonly cooldownSec: number
  readonly drainSec: number
  readonly chaosMinIntervalSec: number
  readonly chaosMaxIntervalSec: number
  readonly seed: number
  readonly reuseCluster: boolean
  readonly smoke: boolean
  readonly runId: string
  readonly noAnalyze: boolean
  readonly proxyChaosDisabled: boolean
  /**
   * Optional chaos-event weight overrides parsed from `--chaos-weights
   * type1=N1,type2=N2`. Missing types fall through to the scheduler's
   * defaults; an explicit `=0` zeroes the type out.
   */
  readonly chaosWeights?: Partial<Record<ChaosEventType, number>>
  /**
   * Override the target SIP URI host[:port] sipp sends to. Default is
   * `FRONT_PROXY_VIP_TARGET` (`172.20.255.250:5060`, the front-proxy
   * VIP). With `sip-front-proxy.vip.enabled` (the test default), the
   * proxy listener binds the VIP only and the Service DNS doesn't
   * work — see docs/lb-proxy-ha.md.
   */
  readonly proxyTarget?: string
}

const DEFAULTS = {
  durationSec: 6 * 60 * 60, // 6h
  caps: 45,
  limiterCap: 10,
  warmupSec: 5 * 60,
  cooldownSec: 5 * 60,
  drainSec: 25 * 60,
  chaosMinIntervalSec: 5 * 60,
  chaosMaxIntervalSec: 15 * 60,
} as const

const SMOKE_OVERRIDES = {
  durationSec: 5 * 60,
  warmupSec: 60,
  cooldownSec: 30,
  drainSec: 2 * 60,
  // Smoke uses a much lower CAPS than the real run so we can validate
  // the harness pipeline without depending on the cluster sustaining
  // production-level load. Existing K8s tests use 10-20 CPS; we match
  // the lower end so even a cold cluster gets calls through.
  caps: 10,
} as const

const parseArgs = (argv: ReadonlyArray<string>): CliArgs => {
  const args = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue
    if (!a.startsWith("--")) continue
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      flags.add(k)
    } else {
      args.set(k, next)
      i++
    }
  }
  const smoke = flags.has("smoke")
  const get = (k: string, fallback: string): string =>
    args.get(k) ?? fallback
  const durationSec = parseDuration(
    get("duration", smoke ? `${SMOKE_OVERRIDES.durationSec}s` : `${DEFAULTS.durationSec}s`),
  )
  const warmupSec = parseDuration(
    get("warmup", smoke ? `${SMOKE_OVERRIDES.warmupSec}s` : `${DEFAULTS.warmupSec}s`),
  )
  const cooldownSec = parseDuration(
    get("cooldown", smoke ? `${SMOKE_OVERRIDES.cooldownSec}s` : `${DEFAULTS.cooldownSec}s`),
  )
  const drainSec = parseDuration(
    get("drain", smoke ? `${SMOKE_OVERRIDES.drainSec}s` : `${DEFAULTS.drainSec}s`),
  )
  return {
    durationSec,
    caps: parseInt(get("caps", String(smoke ? SMOKE_OVERRIDES.caps : DEFAULTS.caps)), 10),
    limiterCap: parseInt(get("limiter-cap", String(DEFAULTS.limiterCap)), 10),
    warmupSec,
    cooldownSec,
    drainSec,
    chaosMinIntervalSec: parseDuration(
      get("chaos-min-interval", `${DEFAULTS.chaosMinIntervalSec}s`),
    ),
    chaosMaxIntervalSec: parseDuration(
      get("chaos-max-interval", `${DEFAULTS.chaosMaxIntervalSec}s`),
    ),
    seed: parseInt(get("seed", String(Date.now())), 10),
    reuseCluster: flags.has("reuse-cluster"),
    smoke,
    runId: get(
      "run-id",
      `endurance-${new Date().toISOString().replace(/[:.]/g, "-").toLowerCase()}`,
    ),
    noAnalyze: flags.has("no-analyze"),
    proxyChaosDisabled: flags.has("proxy-chaos-disabled"),
    ...(args.has("chaos-weights")
      ? { chaosWeights: parseChaosWeights(args.get("chaos-weights")!) }
      : {}),
    ...(args.has("proxy-target") ? { proxyTarget: args.get("proxy-target")! } : {}),
  }
}

const VALID_CHAOS_TYPES: ReadonlySet<string> = new Set<ChaosEventType>([
  "worker-pod-graceful",
  "worker-pod-kill9",
  "proxy-pod-graceful",
  "proxy-pod-kill9",
  "limiter-redis-graceful",
  "limiter-redis-kill9",
  "node-shutdown-app",
  "node-shutdown-edge",
  "proxy-cutoff-vrrp",
])

const parseChaosWeights = (raw: string): Partial<Record<ChaosEventType, number>> => {
  const out: Partial<Record<ChaosEventType, number>> = {}
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim()
    if (trimmed === "") continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) {
      throw new Error(`bad --chaos-weights entry: '${trimmed}' (expected key=N)`)
    }
    const key = trimmed.slice(0, eq)
    const val = trimmed.slice(eq + 1)
    if (!VALID_CHAOS_TYPES.has(key)) {
      throw new Error(
        `unknown chaos type '${key}' in --chaos-weights; valid: ${[...VALID_CHAOS_TYPES].join(",")}`,
      )
    }
    const n = parseFloat(val)
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`bad --chaos-weights value for '${key}': '${val}'`)
    }
    out[key as ChaosEventType] = n
  }
  return out
}

const parseDuration = (raw: string): number => {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(raw.trim())
  if (!m) throw new Error(`bad duration: '${raw}' (expected e.g. '5m' '1h' '30s')`)
  const n = parseFloat(m[1] ?? "")
  const unit = m[2] ?? "s"
  return Math.round(n * (unit === "h" ? 3600 : unit === "m" ? 60 : 1))
}

interface RunMeta {
  readonly runId: string
  readonly tStart: string
  readonly args: CliArgs
  readonly phase: {
    tWarmupStart: string
    tSoakStart: string
    tSoakEnd: string
    tCooldownEnd: string
    tDrainEnd: string
  }
  readonly verdict?: string
  readonly chaosEventsScheduled: number
  readonly chaosEventsExecuted: number
  readonly chaosEventsSkipped: number
  readonly initialPodRestartCounts: Record<string, number>
}

const main = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const args = parseArgs(argv)
    yield* Effect.logInfo(
      `endurance run: smoke=${args.smoke} duration=${args.durationSec}s caps=${args.caps} limiterCap=${args.limiterCap} seed=${args.seed} runId=${args.runId}`,
    )

    const artifactDir = path.resolve("test-results", "k8s-endurance", args.runId)
    yield* Effect.tryPromise(() => fs.mkdir(artifactDir, { recursive: true })).pipe(
      Effect.orDie,
    )
    const tStart = new Date()
    const meta: RunMeta = {
      runId: args.runId,
      tStart: tStart.toISOString(),
      args,
      phase: {
        tWarmupStart: "",
        tSoakStart: "",
        tSoakEnd: "",
        tCooldownEnd: "",
        tDrainEnd: "",
      },
      chaosEventsScheduled: 0,
      chaosEventsExecuted: 0,
      chaosEventsSkipped: 0,
      initialPodRestartCounts: {},
    }
    const writeMeta = () =>
      Effect.tryPromise(() =>
        fs.writeFile(
          path.join(artifactDir, "metadata.json"),
          JSON.stringify(meta, null, 2),
          "utf8",
        ),
      ).pipe(Effect.orDie)

    yield* writeMeta()

    /* ----- BRINGUP ------------------------------------------------- */
    // Default policy: ALWAYS destroy and recreate the kind cluster
    // (and rebuild images) before a run, regardless of smoke vs full
    // endurance. This is non-negotiable for analyzer correctness — a
    // prior run can leave dangling call state in worker memory and
    // sidecar Redis, which the next run inherits and the orphan
    // sweeper cannot drain fast enough; the second run then collapses
    // ~10 min into SOAK with `current` calls climbing and successes
    // going to zero before any chaos has fired. Confirmed in
    // `docs/k8s-endurance.md` §"Troubleshooting" and observed in run
    // endurance-2026-05-09t18-38-55-758z (post-replication-fix 1h).
    //
    // `--reuse-cluster` exists ONLY for tight inner-loop development
    // where you knowingly accept that cluster state is whatever the
    // last run left behind. It must NEVER be used to chain
    // independent runs (e.g. smoke followed by 1h) — the contamination
    // is silent and looks like a system bug.
    if (!args.reuseCluster) {
      yield* Effect.logInfo("phase=BRINGUP (down-then-up)")
      yield* clusterDown.pipe(Effect.ignore)
      yield* clusterUp
      // Build + side-load b2bua + sipp + redis-sidecar images into the
      // fresh kind cluster — without this the Helm installs below fail
      // with ErrImagePull.
      yield* buildAndLoad
      yield* installRedis(NAMESPACE)
      yield* installSipp(NAMESPACE)
      // Layer the endurance-specific overlay on top of the base
      // worker values so memory limits + heap-snapshot diagnostics
      // are active for every endurance run. The memleak harness uses
      // its own overlay and is not affected.
      yield* installWorker(NAMESPACE, { extraValues: [WORKER_VALUES_ENDURANCE] })
      yield* installProxy(NAMESPACE)
    } else {
      yield* Effect.logWarning(
        "phase=BRINGUP (--reuse-cluster: skipped) — DEV-ONLY shortcut: " +
          "in-memory worker state and sidecar Redis carry over from " +
          "the previous run. Do NOT chain a fresh run on top of " +
          "another (e.g. smoke→1h) with this flag — orphan-sweep " +
          "contamination causes silent collapse mid-SOAK. See " +
          "docs/k8s-endurance.md §Troubleshooting."
      )
    }

    /* ----- start recorders ---------------------------------------- */
    const recorder = yield* startRecorder({
      namespace: NAMESPACE,
      artifactDir,
      limiterProbeId: LIMITER_PROBE_ID,
    })

    /* ----- launch sipp streams ------------------------------------ */
    const streams: Array<SippDaemonHandle> = []
    const cleanupStreams = () =>
      Effect.gen(function* () {
        for (const s of streams) {
          yield* s.stop
        }
      })

    try {
      const tWarmupStart = new Date()
      meta.phase.tWarmupStart = tWarmupStart.toISOString()
      yield* writeMeta()

      const shortHoldHandle = yield* startSippDaemon({
        namespace: NAMESPACE,
        name: k8sJobName(`endurance-short-${args.runId}`),
        scenario: "uac-endurance-short.xml",
        cps: Math.max(1, Math.floor(args.caps * 0.88)),
        // Hold is hardcoded to 30000ms in the scenario — sipp's
        // [$var] macro doesn't expand inside <pause milliseconds>.
        artifactDir,
        ...(args.proxyTarget !== undefined && { target: args.proxyTarget }),
      })
      streams.push(shortHoldHandle)

      const longCps = args.caps * 0.01
      const longPeriodMs = Math.max(1000, Math.floor(1000 / longCps))
      const longHandle = yield* startSippDaemon({
        namespace: NAMESPACE,
        name: k8sJobName(`endurance-long-${args.runId}`),
        scenario: "uac-long-options.xml",
        callsPerPeriodMs: { count: 1, periodMs: longPeriodMs },
        // Hold is hardcoded to 1200000ms (20 min) in the scenario.
        artifactDir,
        ...(args.proxyTarget !== undefined && { target: args.proxyTarget }),
      })
      streams.push(longHandle)

      const limiterCps = Math.max(1, Math.floor(args.caps * 0.11))
      // Sipp 3.6 rejects `[`/`]` chars in CDATA as keyword refs, even
      // inside JSON. The `-key xapi <value>` substitution side-steps
      // this: sipp's single-pass replacement doesn't re-parse the
      // value's brackets. Scenario refers to `[xapi]`.
      const xapiJson = `{"action":"route","call_limiter":[{"id":"${LIMITER_PROBE_ID}","limit":${args.limiterCap}}]}`
      const limiterHandle = yield* startSippDaemon({
        namespace: NAMESPACE,
        name: k8sJobName(`endurance-limiter-${args.runId}`),
        scenario: "uac-endurance-limiter.xml",
        cps: limiterCps,
        keyVars: [["xapi", xapiJson]],
        artifactDir,
        ...(args.proxyTarget !== undefined && { target: args.proxyTarget }),
      })
      streams.push(limiterHandle)

      yield* Effect.logInfo("phase=WARMUP (sipp streams ramping)")
      // Wait for all sipp Jobs to actually be Running before counting.
      for (const s of streams) {
        yield* waitSippRunning(NAMESPACE, s.name, 60).pipe(
          Effect.mapError(
            (e) =>
              new EnduranceAbort({
                phase: "WARMUP",
                reason: `sipp job ${s.name} not Running: ${e.message}`,
              }),
          ),
        )
      }
      yield* Effect.sleep(`${args.warmupSec} seconds`)

      // SOAK-START SANITY GATE: read tail of each sipp Job's screen.log
      // and confirm Successful >= 1 (proves at least one call completed).
      yield* Effect.logInfo("phase=SOAK-START SANITY GATE")
      yield* sanityGate(streams)

      const tSoakStart = new Date()
      meta.phase.tSoakStart = tSoakStart.toISOString()
      yield* writeMeta()

      /* ----- SOAK ------------------------------------------------- */
      // --chaos-weights is an exclusive allow-list: unlisted event types
      // get weight 0. --proxy-chaos-disabled stays a coarse one-shot
      // toggle that zeroes proxy-side events on top of the defaults.
      const allChaosTypes: ReadonlyArray<ChaosEventType> = [
        "worker-pod-graceful",
        "worker-pod-kill9",
        "proxy-pod-graceful",
        "proxy-pod-kill9",
        "limiter-redis-graceful",
        "limiter-redis-kill9",
        "node-shutdown-app",
        "node-shutdown-edge",
        "proxy-cutoff-vrrp",
      ]
      const buildExplicitWeights = (
        explicit: Partial<Record<ChaosEventType, number>>,
      ): Record<ChaosEventType, number> => {
        const out = {} as Record<ChaosEventType, number>
        for (const t of allChaosTypes) out[t] = explicit[t] ?? 0
        return out
      }
      const explicitWeights: Partial<Record<ChaosEventType, number>> | undefined =
        args.chaosWeights !== undefined
          ? buildExplicitWeights(args.chaosWeights)
          : args.proxyChaosDisabled
            ? {
                "proxy-pod-graceful": 0,
                "proxy-pod-kill9": 0,
                "proxy-cutoff-vrrp": 0,
                "node-shutdown-edge": 0,
              }
            : undefined
      const schedule = args.smoke
        ? buildSmokeSchedule()
        : buildSchedule({
            seed: args.seed,
            chaosMinIntervalSec: args.chaosMinIntervalSec,
            chaosMaxIntervalSec: args.chaosMaxIntervalSec,
            soakDurationSec: args.durationSec,
            ...(explicitWeights !== undefined && { weights: explicitWeights }),
          })
      ;(meta as { chaosEventsScheduled: number }).chaosEventsScheduled =
        schedule.length
      yield* writeMeta()

      yield* runChaosLoop({
        artifactDir,
        schedule,
        tSoakStart,
        durationSec: args.durationSec,
        seed: args.seed,
        meta,
      })

      const tSoakEnd = new Date()
      meta.phase.tSoakEnd = tSoakEnd.toISOString()
      yield* writeMeta()

      /* ----- COOLDOWN -------------------------------------------- */
      yield* Effect.logInfo(`phase=COOLDOWN (${args.cooldownSec}s)`)
      yield* Effect.sleep(`${args.cooldownSec} seconds`)
      meta.phase.tCooldownEnd = new Date().toISOString()
      yield* writeMeta()

      /* ----- DRAIN: stop sipp jobs gracefully -------------------- */
      yield* Effect.logInfo(`phase=DRAIN (stopping sipp + waiting up to ${args.drainSec}s)`)
      const drainResults: Array<SippDaemonResult> = []
      for (const s of streams) {
        const res = yield* s.stop
        drainResults.push(res)
      }
      yield* appendNdjsonRows(
        path.join(artifactDir, "sipp-results.ndjson"),
        drainResults,
      )
      streams.length = 0 // mark cleaned up

      meta.phase.tDrainEnd = new Date().toISOString()
      yield* writeMeta()

      /* ----- SNAPSHOT -------------------------------------------- */
      yield* Effect.logInfo("phase=SNAPSHOT")
      yield* recorder.stop
      yield* captureSnapshot({ namespace: NAMESPACE, artifactDir }).pipe(Effect.ignore)

      /* ----- ANALYZE --------------------------------------------- */
      if (!args.noAnalyze) {
        yield* Effect.logInfo("phase=ANALYZE")
        const { runAnalyze } = yield* Effect.tryPromise(
          () => import("./analyze-endurance.js"),
        ).pipe(Effect.orDie)
        yield* Effect.tryPromise(() => runAnalyze(artifactDir)).pipe(Effect.orDie)
      }
      yield* Effect.logInfo(`endurance run complete: artifacts at ${artifactDir}`)
    } finally {
      yield* cleanupStreams()
      yield* recorder.stop.pipe(Effect.ignore)
      yield* writeMeta()
    }
  })

const sanityGate = (streams: ReadonlyArray<SippDaemonHandle>) =>
  Effect.gen(function* () {
    // sipp's stat.csv is updated every -fd seconds (10s) so by WARMUP
    // end it should have multiple rows. The criterion is "at least one
    // call has been created and is established (or has completed
    // successfully)" — `CurrentCall >= 1` covers long-running scenarios
    // (long-options streams have calls in their 20-min hold by the
    // gate; they wouldn't satisfy `successful >= 1` for 20 minutes
    // even when working perfectly). `successful >= 1` covers short
    // streams where calls have already terminated.
    const maxAttempts = 6
    for (const s of streams) {
      let satisfied = false
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const csv = yield* readSippStatCsv(NAMESPACE, s.name)
        const stats = parseSippStat(csv)
        const currentCall = parseCurrentCall(csv)
        if (
          stats !== undefined &&
          (stats.successful >= 1 || currentCall >= 1)
        ) {
          satisfied = true
          break
        }
        yield* Effect.sleep("5 seconds")
      }
      if (!satisfied) {
        return yield* new EnduranceAbort({
          phase: "ABORT_PRE_SOAK_SANITY",
          reason: `stream '${s.name}' has no live or completed calls after WARMUP + ${maxAttempts * 5}s grace`,
        })
      }
    }
  })

/**
 * Pull the `CurrentCall` value from sipp's stat.csv. parseSippStat
 * doesn't expose it, so we extract it by column name from the same
 * CSV (header / lastRow split). Returns 0 if the file is empty or
 * the column is missing.
 */
const parseCurrentCall = (csv: string): number => {
  const lines = csv.split("\n").filter((l) => l.trim().length > 0)
  if (lines.length < 2) return 0
  const header = (lines[0] ?? "").split(";")
  const lastRow = (lines[lines.length - 1] ?? "").split(";")
  const idx = header.indexOf("CurrentCall")
  if (idx < 0) return 0
  const v = (lastRow[idx] ?? "").trim()
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : 0
}

interface ChaosLoopOpts {
  readonly artifactDir: string
  readonly schedule: ReadonlyArray<ScheduledEvent>
  readonly tSoakStart: Date
  readonly durationSec: number
  readonly seed: number
  readonly meta: RunMeta
}

const runChaosLoop = (opts: ChaosLoopOpts) =>
  Effect.gen(function* () {
    let nextEventIdx = 0
    let lastEventEndMs = 0
    // Lightweight RNG for in-loop random picks (target replica selection
    // among ready pods); seeded from the global seed + event index so
    // reproducibility holds across runs.
    const eventRng = (eventIndex: number) => {
      let s = (opts.seed + eventIndex * 1_000_003) >>> 0
      return () => {
        s = (s + 0x6d2b79f5) >>> 0
        let t = s
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    const tSoakEndMs = opts.tSoakStart.getTime() + opts.durationSec * 1000
    while (Date.now() < tSoakEndMs) {
      // Has the next scheduled event come due?
      const nextEvent = opts.schedule[nextEventIdx]
      if (nextEvent === undefined) {
        // No more scheduled events; just wait out the remainder.
        yield* Effect.sleep("10 seconds")
        continue
      }
      const dueMs = opts.tSoakStart.getTime() + nextEvent.relativeSec * 1000
      const remaining = dueMs - Date.now()
      if (remaining > 0) {
        yield* Effect.sleep(`${Math.min(remaining, 10_000)} millis`)
        continue
      }
      // Constraint: don't fire too soon after a previous event's recovery.
      // (Recovery already includes the replica readiness wait inside
      // chaosOps; here we add the configured min-interval.)
      const since = Date.now() - lastEventEndMs
      const minIntervalMs = 60_000 // 1 min absolute floor
      if (lastEventEndMs > 0 && since < minIntervalMs) {
        yield* Effect.sleep(`${minIntervalMs - since} millis`)
        continue
      }

      const fired = yield* fireChaosEvent(
        opts.artifactDir,
        nextEvent,
        eventRng(nextEvent.index),
      )
      lastEventEndMs = Date.now()
      nextEventIdx += 1
      if (fired) {
        ;(opts.meta as { chaosEventsExecuted: number }).chaosEventsExecuted += 1
      } else {
        ;(opts.meta as { chaosEventsSkipped: number }).chaosEventsSkipped += 1
      }
    }
  })

const fireChaosEvent = (
  artifactDir: string,
  event: ScheduledEvent,
  rand: () => number,
): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    yield* Effect.logInfo(
      `chaos[${event.index}] fire ${event.type} (relativeSec=${event.relativeSec})`,
    )
    const tFire = new Date()
    const result = yield* dispatchChaos(event.type, rand).pipe(
      Effect.matchEffect({
        onSuccess: (r) => Effect.succeed({ ok: true as const, outcome: r }),
        onFailure: (e) =>
          Effect.succeed({ ok: false as const, error: e.message }),
      }),
    )
    if (!result.ok) {
      yield* Effect.logWarning(
        `chaos[${event.index}] skipped: ${result.error}`,
      )
      yield* appendNdjsonRows(path.join(artifactDir, "chaos-timeline.ndjson"), [
        {
          index: event.index,
          type: event.type,
          status: "skipped",
          reason: result.error,
          tFire: tFire.toISOString(),
          relativeSec: event.relativeSec,
        },
      ])
      return false
    }
    yield* appendNdjsonRows(path.join(artifactDir, "chaos-timeline.ndjson"), [
      {
        index: event.index,
        type: event.type,
        status: "executed",
        target: result.outcome.target,
        tFire: result.outcome.tFire.toISOString(),
        tRecovered: result.outcome.tRecovered.toISOString(),
        relativeSec: event.relativeSec,
        readyBefore: result.outcome.readyBefore,
        readyAfter: result.outcome.readyAfter,
      },
    ])
    return true
  })

const dispatchChaos = (
  type: ChaosEventType,
  rand: () => number,
): Effect.Effect<ChaosOutcome, { readonly message: string }> => {
  switch (type) {
    case "node-shutdown-app":
      return nodeShutdownEvent({ namespace: NAMESPACE, tier: "app" }, rand)
    case "node-shutdown-edge":
      return nodeShutdownEvent({ namespace: NAMESPACE, tier: "edge" }, rand)
    case "proxy-cutoff-vrrp":
      return proxyCutoffEvent({ namespace: NAMESPACE, kind: "vrrp" }, rand)
    default:
      return killPodEvent({ namespace: NAMESPACE, type }, rand)
  }
}

Effect.runPromise(
  main(process.argv.slice(2)).pipe(
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)

