/**
 * Spawn one subprocess per variant, collect JSON results, print tables.
 *
 *   tsx driver.ts                       # default 20_000 iter, all variants
 *   tsx driver.ts 50000                 # explicit iteration count
 *   tsx driver.ts 20000 v1 v6           # subset
 *   tsx driver.ts --gate v6-msgpackr    # gate mode: budgets.ts thresholds
 *                                       # exits non-zero on regression
 *
 * Gate mode is the CI hook. Set per-stage thresholds in `budgets.ts`;
 * the gate refuses to ship a regression that breaches them on the
 * named champion variant. Other variants still run for diagnostic
 * comparison but don't gate the build.
 */

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import { BUDGETS_BY_VARIANT, type StageBudget } from "./budgets.js"
import type { FixtureKind } from "./fixtureKinds.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const workerPath = path.join(here, "worker.ts")

const ALL_VARIANTS = [
  "v1-schema",
  "v2-raw-json",
  "v3-no-repl-reparse",
  "v4-cas-outofband",
  "v5-protobuf",
  "v5b-protobuf-static",
  "v6-msgpackr",
]

// ── Argument parsing ───────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2)
let gateVariant: string | null = null
const positional: string[] = []
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i]!
  if (a === "--gate") {
    gateVariant = rawArgs[++i] ?? null
    if (!gateVariant) {
      console.error("--gate requires a variant name (e.g. --gate v6-msgpackr)")
      process.exit(2)
    }
  } else {
    positional.push(a)
  }
}
const iterations = positional[0] && /^\d+$/.test(positional[0]) ? parseInt(positional[0], 10) : 20_000
const variantArgs = positional.slice(positional[0] && /^\d+$/.test(positional[0]) ? 1 : 0)
let toRun = variantArgs.length > 0 ? variantArgs : ALL_VARIANTS
if (gateVariant && !toRun.includes(gateVariant)) toRun = [gateVariant, ...toRun]

interface StageResult {
  name: string
  iter: number
  meanNs: number
  p50Ns: number
  p95Ns: number
  p99Ns: number
  totalNs: number
  wallNs: number
  gc: {
    count: number
    totalMs: number
    pctOfWall: number
    perIterCount: number
    byKind: Record<string, { count: number; totalMs: number }>
  }
  heap: { deltaMb: number; totalDeltaMb: number; mallocedDeltaMb: number }
}

interface Result {
  variant: string
  iterations: number
  poolSize: number
  fixtureMix: Record<FixtureKind, number>
  bytes: { bodyMean: number; bodyMax: number; frameMean: number; frameMax: number }
  stages: Record<string, StageResult>
  mem: { rssDeltaMb: number; heapDeltaMb: number; externalDeltaMb: number }
}

const runOne = (variant: string): Promise<Result> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "--expose-gc", workerPath, variant, String(iterations)],
      { stdio: ["ignore", "pipe", "pipe"] }
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => { stdout += d.toString() })
    child.stderr.on("data", (d) => { stderr += d.toString() })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${variant} exited ${code}\nstderr:\n${stderr}\nstdout:\n${stdout}`))
        return
      }
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("__RESULT__"))
      if (!line) {
        reject(new Error(`${variant} produced no result\nstderr:\n${stderr}\nstdout:\n${stdout}`))
        return
      }
      resolve(JSON.parse(line.slice("__RESULT__".length)))
    })
  })

const pad = (s: string | number, w: number, right = true) => {
  const str = String(s)
  return right ? str.padStart(w) : str.padEnd(w)
}

const fmtNs = (ns: number): string => {
  if (ns < 1_000) return `${ns.toFixed(0)} ns`
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} µs`
  return `${(ns / 1_000_000).toFixed(2)} ms`
}

interface Breach {
  stage: string
  field: keyof StageBudget
  budget: number
  observed: number
  ratio: number
}

const checkBudget = (
  result: Result,
  budgets: Record<string, StageBudget>,
): Breach[] => {
  const breaches: Breach[] = []
  for (const [stage, budget] of Object.entries(budgets)) {
    const stageResult = result.stages[stage]
    if (!stageResult) continue
    const checks: Array<[keyof StageBudget, number | undefined, number]> = [
      ["meanNs", budget.meanNs, stageResult.meanNs],
      ["p95Ns", budget.p95Ns, stageResult.p95Ns],
      ["p99Ns", budget.p99Ns, stageResult.p99Ns],
      ["gcPctOfWall", budget.gcPctOfWall, stageResult.gc.pctOfWall],
    ]
    for (const [field, budgetVal, observed] of checks) {
      if (budgetVal === undefined) continue
      if (observed > budgetVal) {
        breaches.push({ stage, field, budget: budgetVal, observed, ratio: observed / budgetVal })
      }
    }
  }
  return breaches
}

const main = async () => {
  console.log(`# Call codec benchmark — ${iterations} iterations per variant`)
  console.log(`# variants: ${toRun.join(", ")}`)
  if (gateVariant) console.log(`# gate champion: ${gateVariant}`)
  console.log()

  const results: Result[] = []
  for (const v of toRun) {
    process.stdout.write(`running ${pad(v, 22, false)} … `)
    const t0 = Date.now()
    try {
      const r = await runOne(v)
      console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`)
      results.push(r)
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message.split("\n")[0]}`)
      console.error(e)
    }
  }

  // Mix tally — printed once (all variants share the same mix seed).
  const first = results[0]
  if (first) {
    console.log()
    console.log(`## Fixture mix (pool size ${first.poolSize})`)
    for (const [k, n] of Object.entries(first.fixtureMix)) {
      const pct = (n / first.poolSize * 100).toFixed(1).padStart(5)
      console.log(`  ${pad(k, 22, false)}  ${pad(n, 6)}  (${pct}%)`)
    }
  }

  console.log()
  console.log("## Bytes per encoded form (mean / max across mix)")
  console.log(`${pad("variant", 22, false)}  ${pad("body μ", 8)}  ${pad("body max", 10)}  ${pad("frame μ", 9)}  ${pad("frame max", 10)}`)
  console.log("─".repeat(74))
  for (const r of results) {
    console.log(
      `${pad(r.variant, 22, false)}  ${pad(r.bytes.bodyMean, 8)}  ${pad(r.bytes.bodyMax, 10)}  ${pad(r.bytes.frameMean, 9)}  ${pad(r.bytes.frameMax, 10)}`,
    )
  }

  console.log()
  console.log("## HEADLINE — fullFlush (body pack + envelope pack, the prod hot loop)")
  console.log(`${pad("variant", 22, false)}  ${pad("mean", 12)}  ${pad("p95", 12)}  ${pad("p99", 12)}  ${pad("ops/sec", 10)}  ${pad("GC %", 8)}`)
  console.log("─".repeat(86))
  for (const r of results) {
    const s = r.stages.fullFlush!
    const ops = (1_000_000_000 / s.meanNs).toFixed(0)
    console.log(
      `${pad(r.variant, 22, false)}  ${pad(fmtNs(s.meanNs), 12)}  ${pad(fmtNs(s.p95Ns), 12)}  ${pad(fmtNs(s.p99Ns), 12)}  ${pad(ops, 10)}  ${pad(s.gc.pctOfWall.toFixed(1) + "%", 8)}`,
    )
  }

  console.log()
  console.log("## Per-stage mean time (drill-down)")
  const stages = ["A", "B", "C", "D", "fullFlush", "fullFlushHeld", "fullFlushConcurrent", "FULL"]
  const stageLabel = (s: string) =>
    s === "FULL" ? "A+B+C+D"
    : s === "fullFlush" ? "A+B"
    : s === "fullFlushHeld" ? "A+B/held"
    : s === "fullFlushConcurrent" ? "A+B/noise"
    : s
  const header = `${pad("variant", 22, false)}  ${stages.map((s) => pad(stageLabel(s), 12)).join("  ")}`
  console.log(header)
  console.log("─".repeat(header.length))
  for (const r of results) {
    const cols = stages.map((s) => pad(fmtNs(r.stages[s]!.meanNs), 12)).join("  ")
    console.log(`${pad(r.variant, 22, false)}  ${cols}`)
  }

  console.log()
  console.log("## Per-stage p99 time")
  console.log(header)
  console.log("─".repeat(header.length))
  for (const r of results) {
    const cols = stages.map((s) => pad(fmtNs(r.stages[s]!.p99Ns), 12)).join("  ")
    console.log(`${pad(r.variant, 22, false)}  ${cols}`)
  }

  console.log()
  console.log("## Throughput (full round-trip ops/sec, single-threaded)")
  console.log(`${pad("variant", 22, false)}  ${pad("ops/sec", 12)}  ${pad("ns/op", 12)}  ${pad("rss Δ MB", 10)}  ${pad("ext Δ MB", 10)}`)
  console.log("─".repeat(74))
  for (const r of results) {
    const opsPerSec = 1_000_000_000 / r.stages.FULL!.meanNs
    console.log(
      `${pad(r.variant, 22, false)}  ${pad(opsPerSec.toFixed(0), 12)}  ${pad(fmtNs(r.stages.FULL!.meanNs), 12)}  ${pad(r.mem.rssDeltaMb.toFixed(1), 10)}  ${pad(r.mem.externalDeltaMb.toFixed(1), 10)}`,
    )
  }

  console.log()
  console.log("## GC pressure on FULL round-trip")
  console.log(`${pad("variant", 22, false)}  ${pad("GC count", 10)}  ${pad("GC ms", 10)}  ${pad("% wall", 8)}  ${pad("GC/1k iter", 11)}  ${pad("minor:major", 12)}`)
  console.log("─".repeat(80))
  for (const r of results) {
    const g = r.stages.FULL!.gc
    const minor = g.byKind["minor"]?.count ?? 0
    const major = g.byKind["major"]?.count ?? 0
    console.log(
      `${pad(r.variant, 22, false)}  ${pad(g.count, 10)}  ${pad(g.totalMs.toFixed(1), 10)}  ${pad(g.pctOfWall.toFixed(1) + "%", 8)}  ${pad((g.perIterCount * 1000).toFixed(2), 11)}  ${pad(`${minor}:${major}`, 12)}`,
    )
  }

  // Production-lifetime regimes — the existing FULL stage discards each
  // encoded Buffer immediately; production keeps each one alive in
  // flushCache + BufferedTerminateWriter queue + ioredis send queue for
  // the lifetime of a flush. fullFlushHeld replays that lifetime;
  // fullFlushConcurrent adds the other allocators (rule chain, parser,
  // Effect Generator chain) competing for new-space. A codec that
  // looks fine on FULL but spikes on these is the failure mode the
  // 2026-05-24 protobuf endurance investigation surfaced.
  console.log()
  console.log("## GC pressure on production-lifetime regimes (held + concurrent)")
  console.log(`${pad("variant", 22, false)}  ${pad("held % wall", 12)}  ${pad("held major", 11)}  ${pad("noise % wall", 13)}  ${pad("noise major", 12)}`)
  console.log("─".repeat(82))
  for (const r of results) {
    const held = r.stages.fullFlushHeld!.gc
    const noise = r.stages.fullFlushConcurrent!.gc
    const heldMajor = held.byKind["major"]?.count ?? 0
    const noiseMajor = noise.byKind["major"]?.count ?? 0
    console.log(
      `${pad(r.variant, 22, false)}  ${pad(held.pctOfWall.toFixed(1) + "%", 12)}  ${pad(heldMajor, 11)}  ${pad(noise.pctOfWall.toFixed(1) + "%", 13)}  ${pad(noiseMajor, 12)}`,
    )
  }

  if (results.length >= 2) {
    console.log()
    const baseline = results.find((r) => r.variant === "v1-schema") ?? results[0]!
    console.log(`## Speedup vs ${baseline.variant} (fullFlush)`)
    console.log(`${pad("variant", 22, false)}  ${pad("× faster", 10)}  ${pad("body × smaller", 16)}`)
    console.log("─".repeat(54))
    for (const r of results) {
      const speed = baseline.stages.fullFlush!.meanNs / r.stages.fullFlush!.meanNs
      const sizeRatio = baseline.bytes.bodyMean / r.bytes.bodyMean
      console.log(`${pad(r.variant, 22, false)}  ${pad(speed.toFixed(2) + "×", 10)}  ${pad(sizeRatio.toFixed(2) + "×", 16)}`)
    }
  }

  // ── Gate ──────────────────────────────────────────────────────────────
  if (gateVariant) {
    const champion = results.find((r) => r.variant === gateVariant)
    if (!champion) {
      console.error(`\n[gate] champion ${gateVariant} did not produce a result`)
      process.exit(1)
    }
    const budgets = BUDGETS_BY_VARIANT[gateVariant]
    if (!budgets) {
      console.error(`\n[gate] no budgets defined for ${gateVariant} in budgets.ts`)
      process.exit(1)
    }
    const breaches = checkBudget(champion, budgets)
    console.log()
    console.log(`## Gate verdict — ${gateVariant}`)
    if (breaches.length === 0) {
      console.log(`  PASS — all ${Object.keys(budgets).length} budgeted stages within thresholds`)
      return
    }
    console.log(`  FAIL — ${breaches.length} threshold breach(es):`)
    for (const b of breaches) {
      const fmt = b.field === "gcPctOfWall" ? `${b.observed.toFixed(1)}% (budget ${b.budget}%)` : `${fmtNs(b.observed)} (budget ${fmtNs(b.budget)})`
      console.log(`    ${pad(b.stage, 12, false)}  ${pad(b.field, 14, false)}  ${fmt}  ${b.ratio.toFixed(2)}×`)
    }
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
