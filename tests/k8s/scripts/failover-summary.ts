#!/usr/bin/env tsx
/**
 * Walk test-results/k8s-failover/<runId>/summary.txt and print a
 * chronological table of (run × scenario × the 3 rollup counters)
 * so trends across runs are visible at a glance.
 *
 * Usage:
 *   tsx tests/k8s/scripts/failover-summary.ts            # all runs
 *   tsx tests/k8s/scripts/failover-summary.ts --filter phase-3
 *
 * Output is plain text — pipe through `column -t` or paste into a
 * spreadsheet for closer inspection. Each run's full archive
 * (categories.json, routing-decisions.ndjson, kill-timeline.json,
 * sipp-traces/, proxy-logs/, worker-logs/) stays on disk; this
 * script only summarises summary.txt.
 */
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as process from "node:process"

interface RunSummary {
  readonly runId: string
  readonly archivePath: string
  readonly mtime: Date
  readonly scenario: string
  readonly totalCalls: number
  readonly reEmissions: number
  readonly establishFailures: number
  readonly badlyTreated: number
}

const ROOT = path.resolve(process.cwd(), "test-results", "k8s-failover")

const parseSummary = (text: string): Omit<RunSummary, "runId" | "archivePath" | "mtime"> => {
  const out = {
    scenario: "",
    totalCalls: 0,
    reEmissions: 0,
    establishFailures: 0,
    badlyTreated: 0,
  }
  for (const line of text.split("\n")) {
    const t = line.trim()
    let m
    m = /^scenario:\s*(.+)$/.exec(t)
    if (m) {
      out.scenario = m[1] ?? ""
      continue
    }
    m = /^total calls:\s*(\d+)$/.exec(t)
    if (m) {
      out.totalCalls = parseInt(m[1] ?? "0", 10)
      continue
    }
    m = /^re-emissions:\s*(\d+)$/.exec(t)
    if (m) {
      out.reEmissions = parseInt(m[1] ?? "0", 10)
      continue
    }
    m = /^establish-failures:\s*(\d+)$/.exec(t)
    if (m) {
      out.establishFailures = parseInt(m[1] ?? "0", 10)
      continue
    }
    m = /^badly-treated:\s*(\d+)$/.exec(t)
    if (m) {
      out.badlyTreated = parseInt(m[1] ?? "0", 10)
      continue
    }
  }
  return out
}

const collectRuns = async (filter: string | undefined): Promise<Array<RunSummary>> => {
  let entries: Array<string> = []
  try {
    entries = await fs.readdir(ROOT)
  } catch {
    return []
  }
  const runs: Array<RunSummary> = []
  for (const name of entries) {
    if (filter && !name.includes(filter)) continue
    const archivePath = path.join(ROOT, name)
    const summaryPath = path.join(archivePath, "summary.txt")
    try {
      const stat = await fs.stat(summaryPath)
      if (!stat.isFile()) continue
      const text = await fs.readFile(summaryPath, "utf8")
      const parsed = parseSummary(text)
      runs.push({
        runId: name,
        archivePath,
        mtime: stat.mtime,
        ...parsed,
      })
    } catch {
      // skip runs without a summary.txt
    }
  }
  runs.sort((a, b) => a.mtime.getTime() - b.mtime.getTime())
  return runs
}

const renderTable = (runs: ReadonlyArray<RunSummary>): string => {
  const headers = [
    "mtime",
    "runId",
    "scenario",
    "calls",
    "re-emissions",
    "establish-fail",
    "badly-treated",
  ]
  const rows: Array<Array<string>> = [headers]
  for (const r of runs) {
    rows.push([
      r.mtime.toISOString().replace("T", " ").slice(0, 19),
      r.runId,
      r.scenario || "(unknown)",
      String(r.totalCalls),
      String(r.reEmissions),
      String(r.establishFailures),
      String(r.badlyTreated),
    ])
  }
  const widths = headers.map((_, col) =>
    Math.max(...rows.map((r) => (r[col] ?? "").length)),
  )
  return rows
    .map((r) => r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  "))
    .join("\n")
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2)
  let filter: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--filter" && i + 1 < args.length) {
      filter = args[i + 1]
      i++
    }
  }
  const runs = await collectRuns(filter)
  if (runs.length === 0) {
    console.log(
      `No runs found under ${ROOT}${filter ? ` matching --filter ${filter}` : ""}.`,
    )
    return
  }
  console.log(renderTable(runs))
  console.log("")
  console.log(`${runs.length} run(s) summarised. Archive root: ${ROOT}`)
}

await main()
