/**
 * Endurance run post-analyzer (CLI).
 *
 *   npm run test:k8s:endurance:analyze -- <run-dir>
 *   npm run test:k8s:endurance:analyze -- forensic --call-id <id> <run-dir>
 *   npm run test:k8s:endurance:analyze -- window <T1>..<T2> <run-dir>
 *   npm run test:k8s:endurance:analyze -- metric <name> <run-dir>
 *   npm run test:k8s:endurance:analyze -- top-failures <run-dir>
 *
 * Default invocation reads the artifact dir and emits:
 *
 *   - verdict.json          machine-readable verdict
 *   - report.md             human-readable report (summary + tables)
 *   - forensics/<Call-ID>.txt  per-call forensic for failed STEADY +
 *                              capped sample of chaos-window failures
 *   - metrics/*.csv         per-metric CSV extracted from
 *                           metrics/<pod>.ndjson for analyst plotting
 *
 * Handles partial (orchestrator-crashed) artifact dirs gracefully.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { gunzip as gunzipCb } from "node:zlib"
import { promisify } from "node:util"
import { parseSippMessageTrace, type CallOutcome } from "../fixtures/sippOutcomes.js"
import {
  buildPerEventBreakdown,
  categorizeCalls,
  type CallCategory,
  type CategorizedCall,
  type ChaosImpactWindow,
  type PhaseBounds,
} from "./categorize.js"

const gunzip = promisify(gunzipCb)

const FORENSIC_SAMPLE_CAP_PER_CATEGORY = 100

interface ChaosTimelineRow {
  index: number
  type: string
  status: "executed" | "skipped"
  target?: string
  tFire: string
  tRecovered?: string
  reason?: string
  relativeSec: number
  readyBefore?: number
  readyAfter?: number
}

interface MetricRow {
  tScrape: string
  pod: string
  metric: string
  labels: Record<string, string>
  value: number
}

interface LimiterRow {
  tScrape: string
  limiterId: string
  inflight: number
  redisReady: boolean
}

interface MetadataFile {
  runId: string
  tStart: string
  args: {
    durationSec: number
    caps: number
    limiterCap: number
    smoke: boolean
    seed: number
  }
  phase: {
    tWarmupStart: string
    tSoakStart: string
    tSoakEnd: string
    tCooldownEnd: string
    tDrainEnd: string
  }
  chaosEventsScheduled: number
  chaosEventsExecuted: number
  chaosEventsSkipped: number
}

export const runAnalyze = async (artifactDir: string): Promise<void> => {
  const meta = await readJson<MetadataFile>(path.join(artifactDir, "metadata.json")).catch(
    () => undefined,
  )
  const chaos = await readNdjson<ChaosTimelineRow>(
    path.join(artifactDir, "chaos-timeline.ndjson"),
  ).catch(() => [] as Array<ChaosTimelineRow>)
  const limiter = await readNdjson<LimiterRow>(
    path.join(artifactDir, "limiter-probe.ndjson"),
  ).catch(() => [] as Array<LimiterRow>)

  // Collect outcomes from each sipp stream's gzipped msg.log.
  const outcomes = new Map<string, CallOutcome>()
  const sippDir = path.join(artifactDir, "sipp")
  const streamDirs = await fs.readdir(sippDir).catch(() => [] as Array<string>)
  for (const sd of streamDirs) {
    const gz = path.join(sippDir, sd, "msg.log.gz")
    const exists = await fs.stat(gz).catch(() => undefined)
    if (exists === undefined) continue
    try {
      const raw = await fs.readFile(gz)
      const text = (await gunzip(raw)).toString("utf8")
      const m = parseSippMessageTrace(text)
      for (const [k, v] of m) outcomes.set(k, v)
    } catch (e) {
      console.warn(`analyze: skipped ${gz}: ${String(e)}`)
    }
  }

  // Phase bounds. Tolerate missing values (incomplete run).
  const phase: PhaseBounds = {
    tWarmupStart: parseDateOr(meta?.phase.tWarmupStart, new Date(0)),
    tSoakStart: parseDateOr(meta?.phase.tSoakStart, new Date(0)),
    tSoakEnd: parseDateOr(meta?.phase.tSoakEnd, new Date(8.64e15)),
    tDrainEnd: parseDateOr(meta?.phase.tDrainEnd, new Date(8.64e15)),
  }

  // Convert chaos timeline to impact windows (executed-only).
  const impactWindows: Array<ChaosImpactWindow> = chaos
    .filter((c) => c.status === "executed" && c.tRecovered !== undefined)
    .map((c) => ({
      tFire: new Date(c.tFire),
      tRecovered: new Date(c.tRecovered as string),
      type: c.type,
      target: c.target ?? "",
    }))

  // Identify the limiter-probe Call-ID prefix from sipp dirs.
  const limiterStream = streamDirs.find((d) => d.includes("limiter")) ?? ""
  const limiterPrefix = limiterStream === "" ? "endurance-limiter" : limiterStream

  const categorized = categorizeCalls({
    outcomes,
    chaos: impactWindows,
    phase,
    limiterProbeCidPrefix: limiterPrefix,
  })

  const perEvent = buildPerEventBreakdown(categorized, impactWindows)

  // Verdict computation.
  const counters: Record<CallCategory, { ok: number; failed: number }> = {
    STEADY: { ok: 0, failed: 0 },
    MID_DIALOG_DURING_CHAOS: { ok: 0, failed: 0 },
    ESTABLISHING_DURING_CHAOS: { ok: 0, failed: 0 },
    POST_RECOVERY: { ok: 0, failed: 0 },
    LIMITER_PROBE: { ok: 0, failed: 0 },
    PRE_WARMUP: { ok: 0, failed: 0 },
    POST_DRAIN: { ok: 0, failed: 0 },
  }
  for (const c of categorized) {
    const slot = counters[c.category]
    if (c.success) slot.ok += 1
    else slot.failed += 1
  }

  const limiterStability = analyzeLimiterStability(limiter, meta?.args.limiterCap ?? 10)

  const isIncomplete =
    meta === undefined ||
    meta.phase.tDrainEnd === undefined ||
    meta.phase.tDrainEnd === ""

  const steadyFail = counters.STEADY.failed > 0
  const limiterLeak = limiterStability.exceededCap
  const verdictOutcome: "PASS" | "FAIL" | "INCOMPLETE" = isIncomplete
    ? "INCOMPLETE"
    : steadyFail || limiterLeak
      ? "FAIL"
      : "PASS"

  const verdict = {
    outcome: verdictOutcome,
    runId: meta?.runId ?? path.basename(artifactDir),
    counters,
    limiterProbe: limiterStability,
    chaos: {
      scheduled: meta?.chaosEventsScheduled ?? chaos.length,
      executed: meta?.chaosEventsExecuted ?? impactWindows.length,
      skipped: meta?.chaosEventsSkipped ?? chaos.filter((c) => c.status === "skipped").length,
    },
    perEvent,
  }

  await fs.writeFile(
    path.join(artifactDir, "verdict.json"),
    JSON.stringify(verdict, null, 2),
    "utf8",
  )

  await writeReport(artifactDir, verdict, meta)
  await writeForensicsForFailures(artifactDir, categorized, impactWindows)
  await emitMetricCsvs(artifactDir)

  console.log(
    `analyze: ${verdictOutcome} | STEADY ok=${counters.STEADY.ok} fail=${counters.STEADY.failed}` +
      ` | limiter cap=${limiterStability.cap} max=${limiterStability.maxInflight} exceeded=${limiterStability.exceededCap}` +
      ` | events executed=${verdict.chaos.executed} skipped=${verdict.chaos.skipped}`,
  )
}

interface LimiterStability {
  readonly cap: number
  readonly maxInflight: number
  readonly mean: number
  readonly samples: number
  readonly exceededCap: boolean
  readonly stabilizedAtCap: boolean
}

const analyzeLimiterStability = (
  rows: ReadonlyArray<LimiterRow>,
  cap: number,
): LimiterStability => {
  if (rows.length === 0) {
    return {
      cap,
      maxInflight: 0,
      mean: 0,
      samples: 0,
      exceededCap: false,
      stabilizedAtCap: false,
    }
  }
  let sum = 0
  let max = 0
  let exceeded = false
  let atCapCount = 0
  for (const r of rows) {
    sum += r.inflight
    if (r.inflight > max) max = r.inflight
    if (r.inflight > cap) exceeded = true
    if (r.inflight === cap) atCapCount += 1
  }
  return {
    cap,
    maxInflight: max,
    mean: sum / rows.length,
    samples: rows.length,
    exceededCap: exceeded,
    stabilizedAtCap: atCapCount / rows.length > 0.5,
  }
}

const writeReport = async (
  artifactDir: string,
  verdict: ReturnType<typeof JSON.parse>,
  meta: MetadataFile | undefined,
) => {
  const lines: Array<string> = []
  lines.push(`# Endurance Run ${verdict.runId}\n`)
  lines.push(`**Verdict: ${verdict.outcome}**\n`)
  if (meta) {
    lines.push(`- Started: ${meta.tStart}`)
    lines.push(`- Soak duration: ${meta.args.durationSec}s${meta.args.smoke ? " (smoke)" : ""}`)
    lines.push(`- CAPS: ${meta.args.caps}`)
    lines.push(`- Limiter cap: ${meta.args.limiterCap}`)
    lines.push(`- Seed: ${meta.args.seed}\n`)
  }

  lines.push(`## Calls by category\n`)
  lines.push(`| Category | OK | Failed |`)
  lines.push(`| --- | ---: | ---: |`)
  for (const [cat, c] of Object.entries(verdict.counters) as Array<
    [CallCategory, { ok: number; failed: number }]
  >) {
    lines.push(`| ${cat} | ${c.ok} | ${c.failed} |`)
  }
  lines.push("")

  lines.push(`## Limiter probe\n`)
  lines.push(`- cap=${verdict.limiterProbe.cap}`)
  lines.push(`- maxInflight=${verdict.limiterProbe.maxInflight}`)
  lines.push(`- mean=${verdict.limiterProbe.mean.toFixed(2)}`)
  lines.push(`- samples=${verdict.limiterProbe.samples}`)
  lines.push(`- exceededCap=${verdict.limiterProbe.exceededCap}`)
  lines.push(`- stabilizedAtCap=${verdict.limiterProbe.stabilizedAtCap}\n`)

  lines.push(`## Chaos events\n`)
  lines.push(`- scheduled=${verdict.chaos.scheduled}`)
  lines.push(`- executed=${verdict.chaos.executed}`)
  lines.push(`- skipped=${verdict.chaos.skipped}\n`)
  lines.push(`### Per-event breakdown\n`)
  lines.push(`| # | type | target | tFire | recovered | during ok | during fail | after ok | after fail |`)
  lines.push(`| --: | --- | --- | --- | --- | --: | --: | --: | --: |`)
  for (const e of verdict.perEvent) {
    lines.push(
      `| ${e.index} | ${e.type} | ${e.target} | ${e.tFire} | ${e.tRecovered} | ${e.during_issue.ok} | ${e.during_issue.failed} | ${e.stabilized_after.ok} | ${e.stabilized_after.failed} |`,
    )
  }
  lines.push("")

  lines.push(`## Top failure pointers\n`)
  lines.push(
    `Forensics for individual failed calls live under \`forensics/<Call-ID>.txt\`. Use the \`forensic --call-id <id>\` subcommand for ad-hoc lookups.\n`,
  )

  await fs.writeFile(path.join(artifactDir, "report.md"), lines.join("\n"), "utf8")
}

const writeForensicsForFailures = async (
  artifactDir: string,
  calls: ReadonlyArray<CategorizedCall>,
  chaos: ReadonlyArray<ChaosImpactWindow>,
): Promise<void> => {
  const dir = path.join(artifactDir, "forensics")
  await fs.mkdir(dir, { recursive: true })
  // STEADY failures: ALL of them.
  const steadyFails = calls.filter(
    (c) => c.category === "STEADY" && !c.success,
  )
  // For other categories: capped sample.
  const sampledByCat: Map<string, Array<CategorizedCall>> = new Map()
  for (const c of calls) {
    if (c.success) continue
    if (c.category === "STEADY") continue
    const key = c.category
    let list = sampledByCat.get(key)
    if (!list) {
      list = []
      sampledByCat.set(key, list)
    }
    if (list.length < FORENSIC_SAMPLE_CAP_PER_CATEGORY) {
      list.push(c)
    }
  }
  const all: Array<CategorizedCall> = [...steadyFails]
  for (const list of sampledByCat.values()) all.push(...list)

  for (const c of all) {
    const file = path.join(dir, `${sanitizeCid(c.callId)}.txt`)
    const lines: Array<string> = []
    lines.push(`Call-ID: ${c.callId}`)
    lines.push(`Category: ${c.category}`)
    lines.push(`Outcome: ${c.outcome.outcome}`)
    lines.push(`Last response: ${c.outcome.lastResponse ?? "n/a"}`)
    lines.push(`First INVITE: ${c.outcome.tFirstInvite?.toISOString() ?? "n/a"}`)
    lines.push(`ACK: ${c.outcome.tAck?.toISOString() ?? "n/a"}`)
    lines.push(`Retransmits: ${c.outcome.retransmits}`)
    if (c.chaosEventIndex !== undefined && chaos[c.chaosEventIndex] !== undefined) {
      const ev = chaos[c.chaosEventIndex]!
      lines.push("")
      lines.push(`Nearest chaos event #${c.chaosEventIndex}:`)
      lines.push(`  type=${ev.type} target=${ev.target}`)
      lines.push(`  tFire=${ev.tFire.toISOString()}`)
      lines.push(`  tRecovered=${ev.tRecovered.toISOString()}`)
    }
    await fs.writeFile(file, lines.join("\n"), "utf8")
  }
}

const sanitizeCid = (cid: string): string => cid.replace(/[^A-Za-z0-9._@-]/g, "_")

/**
 * Emit one CSV per (metric name × pod) for analyst plotting. Reads
 * each `metrics/<pod>.ndjson` and writes `metrics/<metric>__<pod>.csv`
 * with columns: tScrape,value,labels.
 */
const emitMetricCsvs = async (artifactDir: string) => {
  const dir = path.join(artifactDir, "metrics")
  const files = await fs.readdir(dir).catch(() => [] as Array<string>)
  const ndjsonFiles = files.filter((f) => f.endsWith(".ndjson"))
  for (const f of ndjsonFiles) {
    const rows = await readNdjson<MetricRow>(path.join(dir, f)).catch(
      () => [] as Array<MetricRow>,
    )
    if (rows.length === 0) continue
    // Group by metric name.
    const byMetric = new Map<string, Array<MetricRow>>()
    for (const r of rows) {
      let list = byMetric.get(r.metric)
      if (!list) {
        list = []
        byMetric.set(r.metric, list)
      }
      list.push(r)
    }
    const podName = f.replace(/\.ndjson$/, "")
    for (const [metric, mrows] of byMetric) {
      const csv: Array<string> = ["tScrape,value,labels"]
      for (const r of mrows) {
        const labels = Object.entries(r.labels)
          .map(([k, v]) => `${k}=${v}`)
          .join(";")
        csv.push(`${r.tScrape},${r.value},"${labels}"`)
      }
      await fs.writeFile(
        path.join(dir, `${metric}__${podName}.csv`),
        csv.join("\n"),
        "utf8",
      )
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const readJson = async <T>(filePath: string): Promise<T> => {
  const text = await fs.readFile(filePath, "utf8")
  return JSON.parse(text) as T
}

const readNdjson = async <T>(filePath: string): Promise<Array<T>> => {
  const text = await fs.readFile(filePath, "utf8")
  const out: Array<T> = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as T)
    } catch {
      // skip malformed
    }
  }
  return out
}

const parseDateOr = (raw: string | undefined, fallback: Date): Date => {
  if (raw === undefined || raw === "") return fallback
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? fallback : d
}

/* ------------------------------------------------------------------ */
/* Subcommands                                                         */
/* ------------------------------------------------------------------ */

const subCmdForensic = async (
  callId: string,
  artifactDir: string,
): Promise<void> => {
  // Re-run analysis to get categorized calls fresh.
  await runAnalyze(artifactDir)
  const file = path.join(artifactDir, "forensics", `${sanitizeCid(callId)}.txt`)
  const exists = await fs.stat(file).catch(() => undefined)
  if (exists === undefined) {
    // Generate on-demand for non-failed calls too: pull from outcomes.
    const sippDir = path.join(artifactDir, "sipp")
    const streamDirs = await fs.readdir(sippDir).catch(() => [] as Array<string>)
    for (const sd of streamDirs) {
      const gz = path.join(sippDir, sd, "msg.log.gz")
      const exists = await fs.stat(gz).catch(() => undefined)
      if (exists === undefined) continue
      const raw = await fs.readFile(gz)
      const text = (await gunzip(raw)).toString("utf8")
      const m = parseSippMessageTrace(text)
      const o = m.get(callId)
      if (o !== undefined) {
        const lines: Array<string> = []
        lines.push(`Call-ID: ${callId}`)
        lines.push(`Outcome: ${o.outcome}`)
        lines.push(`First INVITE: ${o.tFirstInvite?.toISOString() ?? "n/a"}`)
        lines.push(`ACK: ${o.tAck?.toISOString() ?? "n/a"}`)
        lines.push(`Retransmits: ${o.retransmits}`)
        await fs.mkdir(path.join(artifactDir, "forensics"), { recursive: true })
        await fs.writeFile(file, lines.join("\n"), "utf8")
        console.log(file)
        return
      }
    }
    console.error(`No record for Call-ID '${callId}'`)
    process.exit(1)
  }
  console.log(file)
}

const subCmdMetric = async (metric: string, artifactDir: string): Promise<void> => {
  const dir = path.join(artifactDir, "metrics")
  const files = await fs.readdir(dir).catch(() => [] as Array<string>)
  const csvs = files.filter((f) => f.startsWith(`${metric}__`) && f.endsWith(".csv"))
  if (csvs.length === 0) {
    // Try regen via emitMetricCsvs.
    await emitMetricCsvs(artifactDir)
    const refreshed = await fs.readdir(dir)
    const fresh = refreshed.filter(
      (f) => f.startsWith(`${metric}__`) && f.endsWith(".csv"),
    )
    if (fresh.length === 0) {
      console.error(`No metric CSV for '${metric}' in ${dir}`)
      process.exit(1)
    }
    for (const f of fresh) console.log(path.join(dir, f))
    return
  }
  for (const f of csvs) console.log(path.join(dir, f))
}

const subCmdWindow = async (
  range: string,
  artifactDir: string,
): Promise<void> => {
  const m = /^(.+?)\.\.(.+)$/.exec(range)
  if (!m) {
    console.error(`bad window range '${range}', expected 'T1..T2' (ISO 8601)`)
    process.exit(1)
  }
  const start = new Date(m[1]!)
  const end = new Date(m[2]!)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    console.error(`bad window range '${range}', dates unparseable`)
    process.exit(1)
  }
  // Slice chaos timeline + limiter timeline + metrics to the window.
  const chaos = await readNdjson<ChaosTimelineRow>(
    path.join(artifactDir, "chaos-timeline.ndjson"),
  ).catch(() => [] as Array<ChaosTimelineRow>)
  const inWindow = chaos.filter((c) => {
    const t = new Date(c.tFire).getTime()
    return t >= start.getTime() && t <= end.getTime()
  })
  console.log(JSON.stringify({ start, end, chaos: inWindow }, null, 2))
}

const subCmdTopFailures = async (artifactDir: string): Promise<void> => {
  const verdict = await readJson<{
    perEvent: Array<{
      index: number
      type: string
      target: string
      during_issue: { failed: number }
    }>
  }>(path.join(artifactDir, "verdict.json"))
  const ranked = [...verdict.perEvent]
    .sort((a, b) => b.during_issue.failed - a.during_issue.failed)
    .slice(0, 10)
  console.log("Top 10 chaos events by failures during impact window:")
  for (const e of ranked) {
    console.log(`  #${e.index} ${e.type} target=${e.target} failed=${e.during_issue.failed}`)
  }
}

/* ------------------------------------------------------------------ */
/* CLI dispatch                                                        */
/* ------------------------------------------------------------------ */

const cliMain = async (argv: ReadonlyArray<string>): Promise<void> => {
  const [first, ...rest] = argv
  if (first === undefined) {
    console.error(
      `usage: analyze-endurance.ts <run-dir>\n` +
        `       analyze-endurance.ts forensic --call-id <id> <run-dir>\n` +
        `       analyze-endurance.ts metric <name> <run-dir>\n` +
        `       analyze-endurance.ts window <T1>..<T2> <run-dir>\n` +
        `       analyze-endurance.ts top-failures <run-dir>`,
    )
    process.exit(2)
  }
  if (first === "forensic") {
    const idIdx = rest.indexOf("--call-id")
    if (idIdx === -1 || rest[idIdx + 1] === undefined) {
      console.error("forensic: --call-id <id> is required")
      process.exit(2)
    }
    const id = rest[idIdx + 1]!
    const dir = rest[rest.length - 1]
    if (dir === undefined) {
      console.error("forensic: <run-dir> is required")
      process.exit(2)
    }
    await subCmdForensic(id, dir)
    return
  }
  if (first === "metric") {
    const name = rest[0]
    const dir = rest[1]
    if (name === undefined || dir === undefined) {
      console.error("metric <name> <run-dir>")
      process.exit(2)
    }
    await subCmdMetric(name, dir)
    return
  }
  if (first === "window") {
    const range = rest[0]
    const dir = rest[1]
    if (range === undefined || dir === undefined) {
      console.error("window <T1>..<T2> <run-dir>")
      process.exit(2)
    }
    await subCmdWindow(range, dir)
    return
  }
  if (first === "top-failures") {
    const dir = rest[0]
    if (dir === undefined) {
      console.error("top-failures <run-dir>")
      process.exit(2)
    }
    await subCmdTopFailures(dir)
    return
  }
  // Default: full analyze of the given dir.
  await runAnalyze(first)
}

// Only invoke CLI when run directly (not when imported by run-endurance).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1] ?? ""}` ||
  process.argv[1]?.endsWith("analyze-endurance.ts") === true
if (isDirectInvocation) {
  cliMain(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
}
