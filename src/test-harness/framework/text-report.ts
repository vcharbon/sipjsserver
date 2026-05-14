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
  const method = msg.getHeader("cseq").method
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
  // Tiebreak same-ms entries by `seq` so the merged SIP + internal-hop
  // stream renders in capture order — matches the SVG renderer's sort.
  const sorted = [...entries].sort((a, b) => {
    const dt = a.timestamp - b.timestamp
    return dt !== 0 ? dt : a.seq - b.seq
  })
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
    const fromLabel = `${entry.from} (${entry.fromAddr.ip}:${entry.fromAddr.port})`
    const toLabel = `${entry.to} (${entry.toAddr.ip}:${entry.toAddr.port})`
    const prefix = `── [${tsBlock}] ${fromLabel} → ${toLabel} ── ${label}${statusTag} `
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
  const transportLabel =
    result.transportKind === "fake" ? "FAKE NET"
    : result.transportKind === "live" ? "LIVE UDP"
    : "HYBRID"
  const lines: string[] = [
    "=".repeat(SEPARATOR_WIDTH),
    `  SIP Exchange Report: ${scenarioName}`,
    `  View: ${viewLabel}`,
    `  Transport: ${transportLabel}`,
    `  Status: ${statusLine} (${stats})`,
    "=".repeat(SEPARATOR_WIDTH),
    "",
  ]
  const description = result.scenarioDescription?.trim()
  if (description) {
    lines.push("Description:")
    lines.push("")
    for (const rawLine of description.split(/\r?\n/)) {
      lines.push(rawLine.length > 0 ? `  ${rawLine}` : "")
    }
    lines.push("")
    lines.push("-".repeat(SEPARATOR_WIDTH))
    lines.push("")
  }
  lines.push("")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write per-scenario .txt reports (global + per-endpoint).
 * Returns the list of generated filenames (relative to outputDir).
 *
 * Per-agent files live in a `<network>/` subfolder (`ext/alice.txt`,
 * `core/coreServer.txt`) so dual-stack scenarios surface the fabric
 * boundary at the file system level. Slice 1: every agent is on `ext`,
 * so output materialises under `outputDir/ext/...`.
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

  for (const participant of result.participants) {
    if (!agentNames.has(participant.name)) continue // skip SUT-only participants

    const filtered = result.trace.filter(
      (e) => e.from === participant.name || e.to === participant.name
    )
    if (filtered.length === 0) continue

    const header = renderHeader(
      result.scenarioName,
      `${participant.name} (endpoint, network=${participant.network})`,
      result,
    )
    const body = renderTraceEntries(filtered, baseTs)
    const subdir = participant.network
    mkdirSync(join(outputDir, subdir), { recursive: true })
    const relPath = `${subdir}/${result.scenarioName}.${participant.name}.txt`
    writeFileSync(join(outputDir, relPath), header + body, "utf-8")
    filenames.push(relPath)
  }

  return filenames
}
