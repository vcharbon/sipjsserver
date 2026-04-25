/**
 * Proxy-side HTML report writer.
 *
 * Per scenario: writes `<scenarioName>.html` containing
 *   1. a sequence-style timeline (one column per participant, plus a
 *      synthetic "proxy" column inferred from peer addresses), and
 *   2. a collapsible per-message detail block with the raw SIP bytes.
 *
 * Also writes/updates `index.html` listing every scenario under the
 * output directory.
 *
 * Kept much smaller than the B2BUA `tests/fullcall/framework/html-report.ts`
 * (no rule-coverage panel, no validation-error panel, no SVG diagram —
 * a CSS grid is plenty for proxy-level traffic). One self-contained file,
 * no external assets.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ProxyScenarioResult, ProxyTraceEntry } from "./types.js"

const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const formatTimestamp = (ms: number): string => {
  const safe = ms < 0 ? 0 : ms
  const sec = Math.floor(safe / 1000)
  const millis = safe % 1000
  return `${sec}.${millis.toString().padStart(3, "0")}s`
}

const peerLabel = (e: ProxyTraceEntry): string => `${e.peer.host}:${e.peer.port}`

// ---------------------------------------------------------------------------
// Per-scenario page
// ---------------------------------------------------------------------------

const renderTimelineRow = (
  entry: ProxyTraceEntry,
  baseTs: number,
  participants: ReadonlyArray<string>,
  index: number
): string => {
  const rel = entry.timestampMs - baseTs
  const ts = `T+${formatTimestamp(rel)}`
  const cells = participants
    .map((p) => {
      if (p !== entry.participant) {
        return `<td class="lane"></td>`
      }
      const arrow = entry.direction === "send" ? "→" : "←"
      const cls = entry.direction === "send" ? "send" : "receive"
      return `<td class="lane active ${cls}"><span class="arrow">${arrow}</span> <a href="#msg-${index}">${escapeHtml(entry.label)}</a></td>`
    })
    .join("")
  const peer =
    entry.direction === "send" ? `→ ${peerLabel(entry)}` : `← ${peerLabel(entry)}`
  return `<tr><td class="ts">${ts}</td>${cells}<td class="peer">${escapeHtml(peer)}</td></tr>`
}

const renderMessageDetail = (entry: ProxyTraceEntry, index: number): string => {
  const dirLabel = entry.direction === "send" ? "SENT" : "RECEIVED"
  const text =
    entry.message !== undefined
      ? entry.rawBytes.toString("utf-8").trimEnd()
      : `[unparseable]\n${entry.rawBytes.toString("hex")}`
  return `
<details class="msg" id="msg-${index}">
  <summary>
    <span class="badge ${entry.direction}">${dirLabel}</span>
    <span class="participant">${escapeHtml(entry.participant)}</span>
    <span class="peer">${escapeHtml(peerLabel(entry))}</span>
    <span class="label">${escapeHtml(entry.label)}</span>
    <span class="ts">${formatTimestamp(entry.timestampMs)}</span>
  </summary>
  <pre>${escapeHtml(text)}</pre>
</details>`
}

const PAGE_STYLE = `
:root { color-scheme: dark; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
       background: #1e1e1e; color: #d4d4d4; padding: 1rem 1.5rem; }
h1 { margin: 0 0 .25rem 0; font-size: 1.4rem; }
.status { display: inline-block; padding: .15rem .5rem; border-radius: .25rem;
          font-size: .85rem; font-weight: 600; }
.status.pass { background: #1f4e2c; color: #79e69b; }
.status.fail { background: #5a1f1f; color: #ff8e8e; }
.desc { color: #9ba3aa; margin: .5rem 0 1.25rem 0; white-space: pre-wrap; }
.failure { background: #2a1414; border: 1px solid #5a1f1f; color: #ffb0b0;
           padding: .5rem .75rem; border-radius: .25rem; margin: .5rem 0 1.25rem 0;
           white-space: pre-wrap; font-family: ui-monospace, monospace; }
table.timeline { border-collapse: collapse; width: 100%; font-family: ui-monospace, monospace;
                 font-size: .85rem; margin-bottom: 1.5rem; }
table.timeline th { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #444;
                    color: #c8d1d9; background: #252526; position: sticky; top: 0; }
table.timeline td { padding: .25rem .5rem; vertical-align: top; border-bottom: 1px solid #2a2a2a; }
td.ts { color: #888; white-space: nowrap; width: 6.5rem; }
td.peer { color: #6aa6e8; white-space: nowrap; }
td.lane { color: #555; }
td.lane.active.send { color: #79e69b; }
td.lane.active.receive { color: #e8d36a; }
td.lane a { color: inherit; text-decoration: none; }
td.lane a:hover { text-decoration: underline; }
.arrow { font-weight: 700; margin-right: .25rem; }
details.msg { background: #252526; border: 1px solid #333; border-radius: .25rem;
              margin: .25rem 0; padding: .35rem .65rem; }
details.msg summary { cursor: pointer; display: flex; gap: .75rem; align-items: center;
                      font-family: ui-monospace, monospace; font-size: .85rem; }
details.msg .badge { display: inline-block; padding: .05rem .4rem; border-radius: .2rem;
                     font-size: .7rem; font-weight: 700; letter-spacing: .03em; }
details.msg .badge.send { background: #1f4e2c; color: #79e69b; }
details.msg .badge.receive { background: #5a4a1f; color: #e8d36a; }
details.msg .participant { color: #c8d1d9; font-weight: 600; min-width: 5rem; }
details.msg .peer { color: #6aa6e8; min-width: 12rem; }
details.msg .label { color: #d4d4d4; flex: 1; }
details.msg .ts { color: #888; }
details.msg pre { background: #1a1a1a; padding: .75rem; border-radius: .25rem;
                  overflow-x: auto; margin: .5rem 0 0 0; }
nav.crumb { margin-bottom: 1rem; font-size: .85rem; }
nav.crumb a { color: #6aa6e8; text-decoration: none; }
nav.crumb a:hover { text-decoration: underline; }
`

const renderScenarioPage = (result: ProxyScenarioResult): string => {
  const sorted = [...result.trace].sort((a, b) => a.timestampMs - b.timestampMs)
  const baseTs = sorted.length > 0 ? sorted[0]!.timestampMs : 0
  const timelineRows = sorted
    .map((e, i) => renderTimelineRow(e, baseTs, result.participants, i))
    .join("\n")
  const messageDetails = sorted.map((e, i) => renderMessageDetail(e, i)).join("\n")
  const headerCells = result.participants
    .map((p) => `<th>${escapeHtml(p)}</th>`)
    .join("")
  const failureBlock =
    result.status === "fail" && result.failureReason
      ? `<div class="failure">${escapeHtml(result.failureReason)}</div>`
      : ""
  const desc = result.scenarioDescription
    ? `<div class="desc">${escapeHtml(result.scenarioDescription)}</div>`
    : ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(result.scenarioName)} — sip-front-proxy</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<nav class="crumb"><a href="./index.html">← all proxy scenarios</a></nav>
<h1>${escapeHtml(result.scenarioName)} <span class="status ${result.status}">${result.status.toUpperCase()}</span></h1>
${desc}
${failureBlock}
<table class="timeline">
  <thead><tr><th>time</th>${headerCells}<th>peer</th></tr></thead>
  <tbody>${timelineRows}</tbody>
</table>
<h2>Messages</h2>
${messageDetails}
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Index page (manifest-based; appends across runs)
// ---------------------------------------------------------------------------

interface IndexEntry {
  readonly scenarioName: string
  readonly status: "pass" | "fail"
  readonly messageCount: number
  readonly updatedAt: string
}

/**
 * Vitest runs each test file in its own worker process; a single
 * read-modify-write of one shared manifest file races and loses entries.
 * Instead, every scenario writes its own `<scenarioName>.index.json`
 * sidecar (atomic single write per scenario) and the index page is
 * rebuilt by globbing those sidecars under `outputDir`. Race-free across
 * any number of parallel workers.
 */
const MANIFEST_DIR = ".index.d"

const sidecarPath = (outputDir: string, scenarioName: string): string =>
  join(outputDir, MANIFEST_DIR, `${scenarioName}.json`)

const writeManifestEntry = (outputDir: string, entry: IndexEntry): void => {
  mkdirSync(join(outputDir, MANIFEST_DIR), { recursive: true })
  writeFileSync(sidecarPath(outputDir, entry.scenarioName), JSON.stringify(entry, null, 2), "utf-8")
}

const loadManifestEntries = (outputDir: string): ReadonlyArray<IndexEntry> => {
  const dir = join(outputDir, MANIFEST_DIR)
  let names: ReadonlyArray<string>
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"))
  } catch {
    return []
  }
  const out: IndexEntry[] = []
  for (const n of names) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, n), "utf-8")) as IndexEntry)
    } catch {
      // ignore corrupt sidecars (would only happen mid-write of a sibling)
    }
  }
  return out
}

const renderIndexPage = (entries: ReadonlyArray<IndexEntry>): string => {
  const sorted = [...entries].sort((a, b) => a.scenarioName.localeCompare(b.scenarioName))
  const rows = sorted
    .map(
      (e) => `<tr class="${e.status}">
  <td><a href="./${escapeHtml(e.scenarioName)}.html">${escapeHtml(e.scenarioName)}</a></td>
  <td><span class="status ${e.status}">${e.status.toUpperCase()}</span></td>
  <td>${e.messageCount}</td>
  <td>${escapeHtml(e.updatedAt)}</td>
</tr>`
    )
    .join("\n")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>sip-front-proxy — scenarios</title>
<style>${PAGE_STYLE}
table.idx { border-collapse: collapse; width: 100%; font-family: ui-monospace, monospace;
            font-size: .9rem; }
table.idx th { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #444;
               color: #c8d1d9; background: #252526; }
table.idx td { padding: .35rem .6rem; border-bottom: 1px solid #2a2a2a; }
table.idx tr.fail td { background: rgba(90, 31, 31, .15); }
table.idx tr:hover td { background: #2a2d2e; }
table.idx a { color: #6aa6e8; text-decoration: none; }
table.idx a:hover { text-decoration: underline; }
</style>
</head>
<body>
<h1>SIP Front Proxy — Test Scenarios</h1>
<p style="color:#9ba3aa">Generated by <code>tests/sip-front-proxy/_report/</code>. Click a scenario to see its sequence diagram and full message exchanges.</p>
<table class="idx">
  <thead><tr><th>scenario</th><th>status</th><th>messages</th><th>updated</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const writeHtmlReport = (
  result: ProxyScenarioResult,
  outputDir: string
): string => {
  mkdirSync(outputDir, { recursive: true })
  const filename = `${result.scenarioName}.html`
  writeFileSync(join(outputDir, filename), renderScenarioPage(result), "utf-8")

  writeManifestEntry(outputDir, {
    scenarioName: result.scenarioName,
    status: result.status,
    messageCount: result.trace.length,
    updatedAt: new Date().toISOString(),
  })
  // Rebuild the index from whatever sidecars are currently on disk.
  // Other workers may write their own sidecars after this rebuild — that's
  // fine; their `writeHtmlReport` calls re-render the index too.
  writeFileSync(
    join(outputDir, "index.html"),
    renderIndexPage(loadManifestEntries(outputDir)),
    "utf-8"
  )
  return filename
}
