/**
 * Proxy-side text report writer.
 *
 * Emits per-scenario `.txt` files under `test-results/sip-front-proxy/`:
 *   - <scenarioName>.global.txt       all participants, chronological
 *   - <scenarioName>.<participant>.txt one per recorded participant
 *
 * Format mirrors `tests/fullcall/framework/text-report.ts` so a developer
 * who knows the B2BUA reports recognises the proxy ones immediately.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ProxyScenarioResult, ProxyTraceEntry } from "./types.js"

const SEPARATOR_WIDTH = 80

const formatTimestamp = (ms: number): string => {
  const safe = ms < 0 ? 0 : ms
  const totalSec = Math.floor(safe / 1000)
  const millis = safe % 1000
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min > 0) {
    return `${min}m${sec.toString().padStart(2, "0")}.${millis
      .toString()
      .padStart(3, "0")}s`
  }
  return `${sec}.${millis.toString().padStart(3, "0")}s`
}

const peerLabel = (entry: ProxyTraceEntry): string =>
  `${entry.peer.host}:${entry.peer.port}`

const arrowLine = (entry: ProxyTraceEntry, baseTs: number): string => {
  const rel = entry.timestampMs - baseTs
  const tsBlock = `T+${formatTimestamp(rel)}`
  const dir =
    entry.direction === "send"
      ? `${entry.participant} → ${peerLabel(entry)}`
      : `${peerLabel(entry)} → ${entry.participant}`
  const prefix = `── [${tsBlock}] ${dir} ── ${entry.label} `
  return prefix.padEnd(SEPARATOR_WIDTH, "─")
}

const renderEntry = (entry: ProxyTraceEntry, baseTs: number): string => {
  const lines: string[] = [arrowLine(entry, baseTs), ""]
  if (entry.message !== undefined) {
    // Use the raw bytes — they're authoritative and match what the wire saw.
    lines.push(entry.rawBytes.toString("utf-8").trimEnd())
  } else {
    lines.push("[unparseable — hex follows]")
    lines.push(entry.rawBytes.toString("hex"))
  }
  lines.push("")
  return lines.join("\n")
}

const renderHeader = (
  scenarioName: string,
  viewLabel: string,
  result: ProxyScenarioResult
): string => {
  const status = result.status === "pass" ? "PASS" : "FAIL"
  const lines = [
    "=".repeat(SEPARATOR_WIDTH),
    `  SIP Front Proxy — ${scenarioName}`,
    `  View: ${viewLabel}`,
    `  Status: ${status}`,
    "=".repeat(SEPARATOR_WIDTH),
    "",
  ]
  if (result.scenarioDescription) {
    lines.push("Description:")
    lines.push("")
    for (const raw of result.scenarioDescription.split(/\r?\n/)) {
      lines.push(raw.length > 0 ? `  ${raw}` : "")
    }
    lines.push("")
    lines.push("-".repeat(SEPARATOR_WIDTH))
    lines.push("")
  }
  if (result.status === "fail" && result.failureReason) {
    lines.push("Failure:")
    lines.push("")
    for (const raw of result.failureReason.split(/\r?\n/)) {
      lines.push(raw.length > 0 ? `  ${raw}` : "")
    }
    lines.push("")
    lines.push("-".repeat(SEPARATOR_WIDTH))
    lines.push("")
  }
  return lines.join("\n")
}

export interface WriteTextReportsResult {
  readonly globalFilename: string
  readonly perParticipantFilenames: ReadonlyArray<string>
}

export const writeTextReports = (
  result: ProxyScenarioResult,
  outputDir: string
): WriteTextReportsResult => {
  mkdirSync(outputDir, { recursive: true })

  const sorted = [...result.trace].sort((a, b) => a.timestampMs - b.timestampMs)
  const baseTs = sorted.length > 0 ? sorted[0]!.timestampMs : 0

  // Global
  const globalBody = sorted.map((e) => renderEntry(e, baseTs)).join("\n")
  const globalFilename = `${result.scenarioName}.global.txt`
  writeFileSync(
    join(outputDir, globalFilename),
    renderHeader(result.scenarioName, "Global (all participants)", result) +
      globalBody,
    "utf-8"
  )

  // Per-participant
  const perFilenames: string[] = []
  for (const participant of result.participants) {
    const filtered = sorted.filter((e) => e.participant === participant)
    if (filtered.length === 0) continue
    const body = filtered.map((e) => renderEntry(e, baseTs)).join("\n")
    const filename = `${result.scenarioName}.${participant}.txt`
    writeFileSync(
      join(outputDir, filename),
      renderHeader(result.scenarioName, `${participant} (endpoint)`, result) + body,
      "utf-8"
    )
    perFilenames.push(filename)
  }

  return { globalFilename, perParticipantFilenames: perFilenames }
}
