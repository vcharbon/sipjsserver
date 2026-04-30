import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ClassifiedCall, LifecycleState } from "./callLifecycle.js"
import type { SippOutcome } from "./sippOutcomes.js"

/**
 * The 4 lifecycle buckets, in the order they appear as columns of
 * the headline 5×4 matrix.
 */
const STATES: ReadonlyArray<LifecycleState> = [
  "unaffected",
  "established-on-dying",
  "in-flight-on-dying",
  "pre-routed-on-dying",
]

/**
 * The 5 possible sipp outcomes, in the order they appear as columns
 * of the matrix.
 */
const OUTCOMES: ReadonlyArray<SippOutcome> = [
  "clean",
  "retransmitted",
  "establish-failed",
  "bye-timeout",
  "mid-dialog-error",
]

export interface RollupCounters {
  readonly reEmissions: number
  readonly establishFailures: number
  readonly badlyTreated: number
}

/**
 * Compute the 3 headline counters from a list of classifications.
 * Exposed separately from the file-writing flow so tests that just
 * want a one-line log summary don't need an archive directory.
 *
 * - `re-emissions` — sum of the `retransmits` field across all calls.
 *   This counts every duplicate UDP send sipp had to perform.
 * - `establish-failures` — count of calls whose outcome is
 *   `establish-failed`.
 * - `badly-treated` — count of calls whose outcome is `bye-timeout`
 *   or `mid-dialog-error`. These are calls that did establish but
 *   then suffered a mid-dialog failure.
 */
export const summarize = (
  classifications: ReadonlyArray<ClassifiedCall>,
): RollupCounters => {
  let reEmissions = 0
  let establishFailures = 0
  let badlyTreated = 0
  for (const c of classifications) {
    reEmissions += c.retransmits
    if (c.outcome === "establish-failed") establishFailures++
    if (c.outcome === "bye-timeout" || c.outcome === "mid-dialog-error") {
      badlyTreated++
    }
  }
  return { reEmissions, establishFailures, badlyTreated }
}

const buildMatrix = (
  classifications: ReadonlyArray<ClassifiedCall>,
): ReadonlyMap<LifecycleState, ReadonlyMap<SippOutcome, number>> => {
  const m = new Map<LifecycleState, Map<SippOutcome, number>>()
  for (const s of STATES) {
    const inner = new Map<SippOutcome, number>()
    for (const o of OUTCOMES) inner.set(o, 0)
    m.set(s, inner)
  }
  for (const c of classifications) {
    const row = m.get(c.state)
    if (!row) continue
    row.set(c.outcome, (row.get(c.outcome) ?? 0) + 1)
  }
  return m
}

/**
 * Render a fixed-width plain-text matrix with the 4 states as rows
 * and the 5 outcomes as columns. The format is intentionally easy
 * for both humans and `failover-summary.ts` cross-run aggregation
 * to consume.
 */
const renderMatrix = (
  classifications: ReadonlyArray<ClassifiedCall>,
): string => {
  const matrix = buildMatrix(classifications)
  const headers = ["state \\ outcome", ...OUTCOMES]
  const rows: Array<Array<string>> = [headers]
  for (const s of STATES) {
    const row: Array<string> = [s]
    const inner = matrix.get(s)
    for (const o of OUTCOMES) {
      row.push(String(inner?.get(o) ?? 0))
    }
    rows.push(row)
  }
  const widths = headers.map((_, col) =>
    Math.max(...rows.map((r) => (r[col] ?? "").length)),
  )
  const lines: Array<string> = []
  for (const r of rows) {
    lines.push(r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  "))
  }
  return lines.join("\n")
}

const renderSummary = (
  scenarioName: string,
  classifications: ReadonlyArray<ClassifiedCall>,
): string => {
  const totals = summarize(classifications)
  const lines: Array<string> = []
  lines.push(`scenario: ${scenarioName}`)
  lines.push(`total calls: ${classifications.length}`)
  lines.push("")
  lines.push("state x outcome (counts):")
  lines.push(renderMatrix(classifications))
  lines.push("")
  lines.push("rollup counters:")
  lines.push(`  re-emissions:        ${totals.reEmissions}`)
  lines.push(`  establish-failures:  ${totals.establishFailures}`)
  lines.push(`  badly-treated:       ${totals.badlyTreated}`)
  lines.push("")
  return lines.join("\n")
}

export interface KillTimeline {
  readonly tInviteFirst?: string
  readonly tKillIssued?: string
  readonly tPodTerminated?: string
  readonly tPodRecreated?: string
  readonly tProxyMarkedDead?: string
  readonly tInviteLast?: string
  /** Free-form fields scenarios may want to tag. */
  readonly [k: string]: unknown
}

export interface WriteFailoverReportInput {
  readonly archiveDir: string
  readonly classifications: ReadonlyArray<ClassifiedCall>
  readonly killTimeline: KillTimeline
  readonly scenarioName: string
}

/**
 * Write the standard archive layout under `archiveDir`:
 *
 *   summary.txt        — human-readable 5×4 matrix + 3 rollup counters
 *   categories.json    — array of {callId, state, outcome, retransmits}
 *   kill-timeline.json — the supplied `killTimeline` as JSON
 *
 * The directory is created if missing. Existing files are overwritten.
 */
export const writeFailoverReport = (
  input: WriteFailoverReportInput,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { archiveDir, classifications, killTimeline, scenarioName } = input
    yield* Effect.tryPromise(() => fs.mkdir(archiveDir, { recursive: true })).pipe(
      Effect.orDie,
    )
    const summaryPath = path.join(archiveDir, "summary.txt")
    const categoriesPath = path.join(archiveDir, "categories.json")
    const timelinePath = path.join(archiveDir, "kill-timeline.json")
    const summaryText = renderSummary(scenarioName, classifications)
    const categoriesJson = serializeCategories(classifications)
    const timelineJson = serializeTimeline(killTimeline)
    yield* Effect.tryPromise(() =>
      fs.writeFile(summaryPath, summaryText, "utf8"),
    ).pipe(Effect.orDie)
    yield* Effect.tryPromise(() =>
      fs.writeFile(categoriesPath, categoriesJson, "utf8"),
    ).pipe(Effect.orDie)
    yield* Effect.tryPromise(() =>
      fs.writeFile(timelinePath, timelineJson, "utf8"),
    ).pipe(Effect.orDie)
  })

// Pure helpers extracted so the JSON.stringify calls live outside of
// `Effect.gen` — the Effect plugin warns otherwise (see
// docs/typescript-effect.md `preferSchemaOverJson`). The payloads
// here are typed plain shapes; a Schema codec would be overkill.
const serializeCategories = (
  classifications: ReadonlyArray<ClassifiedCall>,
): string => JSON.stringify(classifications, null, 2) + "\n"

const serializeTimeline = (timeline: KillTimeline): string =>
  JSON.stringify(timeline, null, 2) + "\n"
