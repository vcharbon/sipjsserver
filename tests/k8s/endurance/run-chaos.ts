/**
 * Iteration sub-command — fire one chaos event into a running
 * `--no-chaos` baseline campaign and emit a per-event verdict.
 *
 *   npm run test:k8s:chaos -- --event <ChaosEventType>
 *   npm run test:k8s:chaos -- --event <type> --artifact-dir <path>
 *   npm run test:k8s:chaos -- --event <type> --no-wait
 *   npm run test:k8s:chaos -- --event <type> --seed <N>
 *
 * Architecture: the sub-command process owns end-to-end: chaos
 * primitive + impact-window wait + analyzer slice + verdict print.
 * The baseline orchestrator never touches chaos code — it just keeps
 * the cluster, sipp streams, and recorder running. Transport is the
 * shared artifact dir (no HTTP). Editing `chaosOps.ts`,
 * `dispatchChaos.ts`, or `expectedImpact.ts` and re-running this
 * sub-command picks up the new code immediately.
 *
 * See docs/k8s-endurance.md §"Iteration workflow" for the full
 * design.
 */

import { Effect, References } from "effect"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { execInPod, listPods } from "../fixtures/kubectl.js"
import {
  parseSippMessageTrace,
  type CallOutcome,
} from "../fixtures/sippOutcomes.js"
import {
  ALL_CHAOS_EVENT_TYPES,
  type ChaosEventType,
  type ChaosOutcome,
} from "./chaosOps.js"
import { dispatchChaos } from "./dispatchChaos.js"
import {
  aggregateImpact,
  evaluateEvent,
  type EventEvalResult,
  type LimiterSample,
} from "./evaluateImpact.js"
import { EXPECTED_IMPACT } from "./expectedImpact.js"
import { appendNdjsonRows } from "./recorder.js"

const NAMESPACE = "sip-test"

interface CliArgs {
  readonly event: ChaosEventType
  readonly artifactDir: string
  readonly noWait: boolean
  readonly seed: number
}

const parseCli = async (argv: ReadonlyArray<string>): Promise<CliArgs> => {
  const args = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined || !a.startsWith("--")) continue
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      flags.add(k)
    } else {
      args.set(k, next)
      i++
    }
  }
  const event = args.get("event")
  if (event === undefined) {
    throw new Error(
      `--event <type> is required. Valid types: ${ALL_CHAOS_EVENT_TYPES.join(", ")}`,
    )
  }
  if (!ALL_CHAOS_EVENT_TYPES.includes(event as ChaosEventType)) {
    throw new Error(
      `unknown chaos type '${event}'. Valid: ${ALL_CHAOS_EVENT_TYPES.join(", ")}`,
    )
  }
  const artifactDir =
    args.get("artifact-dir") ?? (await resolveActiveArtifactDir())
  return {
    event: event as ChaosEventType,
    artifactDir,
    noWait: flags.has("no-wait"),
    seed: parseInt(args.get("seed") ?? String(Date.now()), 10),
  }
}

const resolveActiveArtifactDir = async (): Promise<string> => {
  const pointer = path.resolve("test-results", "k8s-endurance", ".active")
  try {
    const raw = await fsp.readFile(pointer, "utf8")
    const trimmed = raw.trim()
    if (trimmed === "") {
      throw new Error(".active pointer file is empty")
    }
    return trimmed
  } catch (e) {
    throw new Error(
      `no --artifact-dir override and '.active' pointer missing/unreadable at ${pointer}: ${e instanceof Error ? e.message : String(e)}. ` +
        `Is the baseline campaign running (npm run test:k8s:endurance -- --no-chaos)?`,
    )
  }
}

interface ChaosTimelineRow {
  readonly index: number
  readonly type: string
  readonly status: string
  readonly tFire?: string
  readonly tRecovered?: string
}

const nextEventIndex = async (artifactDir: string): Promise<number> => {
  const file = path.join(artifactDir, "chaos-timeline.ndjson")
  try {
    const text = await fsp.readFile(file, "utf8")
    let max = -1
    for (const line of text.split("\n")) {
      const t = line.trim()
      if (t === "") continue
      try {
        const row = JSON.parse(t) as ChaosTimelineRow
        if (typeof row.index === "number" && row.index > max) max = row.index
      } catch {
        // skip malformed
      }
    }
    return max + 1
  } catch {
    return 0
  }
}

const mulberry32 = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Compute the latest tRecovered offset (post-recovery + grace) any
 *  ImpactRule for `type` requires. The sub-command sleeps until then
 *  before evaluating the rules, so recovery-anchored assertions have
 *  the data they need.
 */
const maxRuleHorizonMs = (type: ChaosEventType): number => {
  const spec = EXPECTED_IMPACT[type]
  if (spec === undefined) return 0
  let horizon = 0
  for (const r of spec.rules) {
    if (r.window.anchor === "tFire") continue
    const end = r.window.startOffsetMs + r.window.durationMs
    if (end > horizon) horizon = end
  }
  return horizon
}

/**
 * Read msg.log from each sipp pod, but server-side-filter to the
 * relevant window. The full msg.log grows multiple GB over a multi-h
 * SOAK; streaming all of it through `kubectl exec` exceeds the exec
 * helper's 64 MiB buffer and the call silently fails. awk slices the
 * file to records whose separator-timestamp is in
 * `[tFire - PRE_MARGIN, tEnd + POST_MARGIN]`, second precision —
 * enough to keep INVITEs of in-flight short-hold calls (PRE_MARGIN
 * covers their setup) and any retransmits arriving just after the
 * window (POST_MARGIN).
 *
 * Returns an empty Map if no pods are ready (chaos rendered them
 * un-execable).
 */
const PRE_MARGIN_MS = 60_000
const POST_MARGIN_MS = 10_000

const collectOutcomesFromLiveStreams = (
  windowStartMs: number,
  windowEndMs: number,
): Effect.Effect<Map<string, CallOutcome>, never> =>
  Effect.gen(function* () {
    const pods = yield* listPods(NAMESPACE, "app.kubernetes.io/name=sipp-uac")
    const out = new Map<string, CallOutcome>()
    // Truncate to second precision so the awk comparison is precision-
    // safe (msg.log has microseconds, .toISOString() has ms).
    const lo = new Date(windowStartMs - PRE_MARGIN_MS).toISOString().slice(0, 19)
    const hi = new Date(windowEndMs + POST_MARGIN_MS).toISOString().slice(0, 19)
    // busybox awk (the sipp image's `awk`) doesn't support `{n}`
    // bounded-repetition ERE, so the regex is `^---` rather than
    // `^-+ [0-9]{4}-`. False-positives on other lines starting with
    // `---` would be rare in sipp's msg.log and harmless — they just
    // briefly toggle `keep` and the next true separator resets it.
    const awkScript =
      "/^---/ { ts=substr($2,1,19); keep=(ts>=lo && ts<=hi) } keep"
    for (const pod of pods) {
      if (!pod.ready) continue
      const result = yield* execInPod(NAMESPACE, pod.name, "uac", [
        "awk",
        "-v",
        `lo=${lo}`,
        "-v",
        `hi=${hi}`,
        awkScript,
        "/out/msg.log",
      ]).pipe(
        Effect.matchEffect({
          onSuccess: (r) => Effect.succeed(r.stdout),
          onFailure: () => Effect.succeed(""),
        }),
      )
      if (result === "") continue
      const parsed = parseSippMessageTrace(result)
      for (const [k, v] of parsed) out.set(k, v)
    }
    return out
  })

const readLimiterSamples = async (
  artifactDir: string,
): Promise<ReadonlyArray<LimiterSample>> => {
  const file = path.join(artifactDir, "limiter-probe.ndjson")
  try {
    const text = await fsp.readFile(file, "utf8")
    const out: Array<LimiterSample> = []
    for (const line of text.split("\n")) {
      const t = line.trim()
      if (t === "") continue
      try {
        const row = JSON.parse(t) as {
          tScrape: string
          inflight: number
        }
        out.push({ tScrape: new Date(row.tScrape), inflight: row.inflight })
      } catch {
        // skip
      }
    }
    return out
  } catch {
    return []
  }
}

const listSippJobNames = async (): Promise<ReadonlyArray<string>> => {
  // Sipp pods carry `sipp-job-name=<job>` label; collect distinct names.
  const result = await Effect.runPromise(
    listPods(NAMESPACE, "app.kubernetes.io/name=sipp-uac"),
  )
  const names = new Set<string>()
  for (const p of result) {
    if (!p.name) continue
    // Pod name is `<job-name>-<suffix>`; not stable to split. The
    // analyzer uses these as substring needles, so we provide the
    // expected baseline labels directly — they're stable strings the
    // catalog stream patterns will match.
    names.add(p.name)
  }
  return Array.from(names)
}

const formatBound = (b: EventEvalResult["rules"][number]["bound"]): string => {
  switch (b.kind) {
    case "lessThan":
      return `< ${b.value}`
    case "greaterThan":
      return `> ${b.value}`
    case "around":
      return `${b.target} ± ${b.tolerance}`
  }
}

const formatMetric = (
  m: EventEvalResult["rules"][number]["metric"],
): string => {
  const codeQual = (
    codes: ReadonlyArray<number> | undefined,
    codesExclude: ReadonlyArray<number> | undefined,
  ): string => {
    if (codes !== undefined) return `, codes=[${codes.join(",")}]`
    if (codesExclude !== undefined) return `, exclCodes=[${codesExclude.join(",")}]`
    return ""
  }
  switch (m.kind) {
    case "failureRate":
      return `failureRate(${m.stream}${codeQual(m.codes, m.codesExclude)})`
    case "midDialogFailureRate":
      return `midDialogFailureRate(${m.stream}${codeQual(m.codes, m.codesExclude)})`
    case "stream503Rate":
      return `stream503Rate(${m.stream})`
    case "limiterInflight":
      return "limiterInflight"
    case "concurrentCalls":
      return `concurrentCalls(${m.stream})`
  }
}

const printVerdict = (eval_: EventEvalResult): void => {
  if (!eval_.hasSpec) {
    console.log(
      `event#${eval_.eventIndex} type=${eval_.type} → status=WARN (no ExpectedImpact spec — TODO)`,
    )
    return
  }
  console.log(
    `event#${eval_.eventIndex} type=${eval_.type} — ${eval_.rules.length} rule(s):`,
  )
  for (const r of eval_.rules) {
    const obs = r.observedValue === undefined ? "—" : r.observedValue.toFixed(4)
    console.log(
      `  [${r.status.toUpperCase()}] ${formatMetric(r.metric)} ${formatBound(r.bound)} observed=${obs} n=${r.sampleSize} severity=${r.severity}`,
    )
    console.log(`    ${r.description}`)
    if (r.note !== undefined) console.log(`    note: ${r.note}`)
    console.log(`    window: ${r.windowStart} .. ${r.windowEnd}`)
  }
  const ag = aggregateImpact([eval_])
  console.log(
    `aggregate: ${ag.outcome} pass=${ag.counts.pass} warn=${ag.counts.warn} fail=${ag.counts.fail} no-data=${ag.counts.noData}`,
  )
}

const main = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const cli = yield* Effect.tryPromise(() => parseCli(argv)).pipe(Effect.orDie)
    yield* Effect.logInfo(
      `chaos sub-command: event=${cli.event} artifactDir=${cli.artifactDir} noWait=${cli.noWait} seed=${cli.seed}`,
    )

    const eventIndex = yield* Effect.tryPromise(() =>
      nextEventIndex(cli.artifactDir),
    ).pipe(Effect.orDie)
    const rand = mulberry32(cli.seed + eventIndex * 1_000_003)

    yield* Effect.logInfo(
      `firing chaos event #${eventIndex} type=${cli.event}`,
    )

    // Dispatch the chaos primitive. Match either success or failure
    // (the dispatcher's union error type) so we can record either
    // outcome in the timeline.
    const dispatchResult: { ok: true; outcome: ChaosOutcome } | { ok: false; error: string } =
      yield* dispatchChaos(cli.event, rand, {
        namespace: NAMESPACE,
        artifactDir: cli.artifactDir,
      }).pipe(
        Effect.matchEffect({
          onSuccess: (outcome) => Effect.succeed({ ok: true as const, outcome }),
          onFailure: (e) => Effect.succeed({ ok: false as const, error: e.message }),
        }),
      )

    if (!dispatchResult.ok) {
      yield* appendNdjsonRows(
        path.join(cli.artifactDir, "chaos-timeline.ndjson"),
        [
          {
            index: eventIndex,
            type: cli.event,
            status: "skipped",
            reason: dispatchResult.error,
            tFire: new Date().toISOString(),
            relativeSec: 0,
          },
        ],
      )
      yield* Effect.logError(`chaos event skipped: ${dispatchResult.error}`)
      process.exitCode = 1
      return
    }

    const outcome = dispatchResult.outcome
    const verify = outcome.verify
    const status: "executed" | "noop" =
      verify !== undefined && !verify.ok ? "noop" : "executed"
    if (status === "noop" && verify !== undefined && !verify.ok) {
      yield* Effect.logWarning(
        `chaos[${eventIndex}] NOOP_DETECTED: ${verify.reason}`,
      )
    }
    yield* appendNdjsonRows(
      path.join(cli.artifactDir, "chaos-timeline.ndjson"),
      [
        {
          index: eventIndex,
          type: cli.event,
          status,
          target: outcome.target,
          tFire: outcome.tFire.toISOString(),
          tRecovered: outcome.tRecovered.toISOString(),
          relativeSec: 0,
          readyBefore: outcome.readyBefore,
          readyAfter: outcome.readyAfter,
          ...(verify !== undefined && { verify }),
        },
      ],
    )
    if (status === "noop") {
      // Surface noop as a non-zero exit for the operator's iteration
      // loop — they'll see `chaos[verify] FAILED` in stdout, but the
      // exit code is what scripts/CI watch for.
      process.exitCode = 2
    }

    if (cli.noWait) {
      yield* Effect.logInfo("--no-wait: not blocking for verdict")
      return
    }

    // Sleep through any recovery-anchored rule windows so the
    // analyzer slice has data to evaluate.
    const horizonMs = maxRuleHorizonMs(cli.event)
    if (horizonMs > 0) {
      yield* Effect.logInfo(
        `waiting ${Math.round(horizonMs / 1000)}s for recovery-anchored impact windows to elapse`,
      )
      yield* Effect.sleep(`${horizonMs} millis`)
    }

    // Collect live data and evaluate rules for THIS event. Pass the
    // event's full impact window so the pod-side awk filter slices
    // msg.log to a manageable size.
    const outcomes = yield* collectOutcomesFromLiveStreams(
      outcome.tFire.getTime(),
      outcome.tRecovered.getTime() + horizonMs,
    )
    const limiter = yield* Effect.tryPromise(() =>
      readLimiterSamples(cli.artifactDir),
    ).pipe(Effect.orDie)
    const streamJobNames = yield* Effect.tryPromise(listSippJobNames).pipe(
      Effect.orDie,
    )

    const eval_ = evaluateEvent(
      eventIndex,
      {
        type: cli.event,
        tFire: outcome.tFire,
        tRecovered: outcome.tRecovered,
      },
      { outcomes, limiter, streamJobNames },
    )
    printVerdict(eval_)

    // Exit code: 1 on any FAIL, 0 otherwise (WARN included in 0 by
    // convention — `--stop-at-first-failure` semantics live in the
    // SOAK loop, not here).
    const ag = aggregateImpact([eval_])
    if (ag.outcome === "FAIL") {
      process.exitCode = 1
    }
  })

Effect.runPromise(
  main(process.argv.slice(2)).pipe(
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
