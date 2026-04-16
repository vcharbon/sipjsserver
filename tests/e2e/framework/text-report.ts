/**
 * Text report writer — generates per-scenario .txt files with full SIP
 * message details.
 *
 * Three flavors per scenario:
 *   - global:        all exchanges from every endpoint
 *   - per-endpoint:  filtered to a single agent's perspective
 *
 * Timestamps reflect the simulated clock (TestClock) when running under
 * the simulated backend, so time progression matches virtual pauses.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ScenarioResult, TraceEntry } from "./types.js"
import { serializeMessage } from "./svg-sequence-diagram.js"

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

function formatTimestamp(ms: number): string {
  if (ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const millis = ms % 1000
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min > 0) {
    return `${min}m${sec.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}s`
  }
  return `${sec}.${millis.toString().padStart(3, "0")}s`
}

// ---------------------------------------------------------------------------
// Arrow label (similar to SVG renderer but plain text)
// ---------------------------------------------------------------------------

function getArrowLabel(entry: TraceEntry): string {
  const msg = entry.message
  if (msg.type === "request") {
    return msg.uri ? `${msg.method} ${msg.uri}` : msg.method
  }
  const cseq = msg.headers.find((h) => h.name.toLowerCase() === "cseq")?.value ?? ""
  const method = cseq.split(/\s+/)[1] ?? ""
  return `${msg.status} ${msg.reason}${method ? ` (${method})` : ""}`
}

// ---------------------------------------------------------------------------
// Render trace entries to text
// ---------------------------------------------------------------------------

const SEPARATOR_WIDTH = 80

function renderTraceEntries(
  entries: readonly TraceEntry[],
  baseTimestamp: number
): string {
  const lines: string[] = []
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp)
  for (const entry of sorted) {
    const sentRel = entry.sentMs - baseTimestamp
    const rcvdRel = entry.receivedMs - baseTimestamp
    const tsBlock =
      entry.sentMs === entry.receivedMs
        ? `T+${formatTimestamp(sentRel)}`
        : `sent T+${formatTimestamp(sentRel)} → rcvd T+${formatTimestamp(rcvdRel)}`
    const label = getArrowLabel(entry)
    const statusTag =
      entry.status === "unexpected" ? " [UNEXPECTED]"
      : entry.status === "fail" ? " [FAIL]"
      : ""
    const prefix = `── [${tsBlock}] ${entry.from} → ${entry.to} ── ${label}${statusTag} `
    lines.push(prefix.padEnd(SEPARATOR_WIDTH, "─"))
    lines.push("")
    lines.push(serializeMessage(entry.message))
    lines.push("")
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Header block
// ---------------------------------------------------------------------------

function renderHeader(
  scenarioName: string,
  viewLabel: string,
  result: ScenarioResult
): string {
  const statusLine = result.failed > 0 ? "FAIL" : "PASS"
  const stats = `${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`
  return [
    "=".repeat(SEPARATOR_WIDTH),
    `  SIP Exchange Report: ${scenarioName}`,
    `  View: ${viewLabel}`,
    `  Status: ${statusLine} (${stats})`,
    "=".repeat(SEPARATOR_WIDTH),
    "",
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write per-scenario .txt reports (global + per-endpoint).
 * Returns the list of generated filenames (relative to outputDir).
 */
export function writeTextReports(
  result: ScenarioResult,
  outputDir: string
): string[] {
  mkdirSync(outputDir, { recursive: true })

  const filenames: string[] = []
  const baseTs = result.trace.length > 0 ? result.trace[0]!.timestamp : 0

  // --- Global report (all endpoints) ---
  {
    const header = renderHeader(result.scenarioName, "Global (all endpoints)", result)
    const body = renderTraceEntries(result.trace, baseTs)
    const filename = `${result.scenarioName}.global.txt`
    writeFileSync(join(outputDir, filename), header + body, "utf-8")
    filenames.push(filename)
  }

  // --- Per-endpoint reports ---
  // Determine which participants are test agents (as opposed to SUT).
  // Agents appear as senders in "send" entries and receivers in "receive" entries.
  const agentNames = new Set<string>()
  for (const entry of result.trace) {
    if (entry.direction === "send") agentNames.add(entry.from)
    else agentNames.add(entry.to)
  }

  for (const agent of result.participants) {
    if (!agentNames.has(agent)) continue // skip SUT-only participants

    const filtered = result.trace.filter(
      (e) => e.from === agent || e.to === agent
    )
    if (filtered.length === 0) continue

    const header = renderHeader(result.scenarioName, `${agent} (endpoint)`, result)
    const body = renderTraceEntries(filtered, baseTs)
    const filename = `${result.scenarioName}.${agent}.txt`
    writeFileSync(join(outputDir, filename), header + body, "utf-8")
    filenames.push(filename)
  }

  return filenames
}
