/**
 * HTML report writer — generates self-contained HTML files with SVG sequence
 * diagrams and click-to-inspect message detail panels.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ScenarioResult } from "./types.js"
import { renderSequenceDiagram, serializeMessage } from "./svg-sequence-diagram.js"
import { ruleRegistry } from "../../b2bua/B2buaCore.js"
import { snapshot as ruleSnapshot } from "./rule-usage-collector.js"

// ---------------------------------------------------------------------------
// Escape helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function escapeJs(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
}

// ---------------------------------------------------------------------------
// Scenario report
// ---------------------------------------------------------------------------

export function writeScenarioReport(
  result: ScenarioResult,
  outputDir: string,
  textFilenames?: readonly string[]
): string {
  mkdirSync(outputDir, { recursive: true })

  // Tiebreak same-ms entries by `seq` so the click-to-inspect index
  // matches the SVG row order (the SVG renderer applies the same
  // tiebreaker). Without this the index can desync from the diagram
  // when two trace entries share a timestamp.
  const sortedTrace = [...result.trace].sort((a, b) => {
    const dt = a.timestamp - b.timestamp
    return dt !== 0 ? dt : a.seq - b.seq
  })
  const replicationEntries = result.replicationTrace ?? []
  const svg = renderSequenceDiagram(
    sortedTrace,
    result.lanes,
    replicationEntries,
    result.transportKind,
  )

  // Build message data for the click handler. Key is the entry's index
  // in `sortedTrace` — `stepIndex` would collide for internal hops
  // (proxy↔worker), which all share `stepIndex = -1`.
  const messageData: Array<{ traceIndex: number; raw: string }> = sortedTrace.map(
    (entry, i) => ({
      traceIndex: i,
      raw: serializeMessage(entry.message),
    })
  )

  const statusBadge = result.failed > 0
    ? `<span class="badge fail">FAIL</span>`
    : `<span class="badge pass">PASS</span>`

  // Transport-kind chip — `[FAKE NET]` / `[LIVE UDP]` / `[HYBRID]`.
  // Colours match the faint canvas tint in the SVG so an operator
  // scanning thumbnails recognises the transport at a glance.
  const transportChip = (() => {
    switch (result.transportKind) {
      case "fake":
        return `<span class="badge transport-fake">FAKE NET</span>`
      case "live":
        return `<span class="badge transport-live">LIVE UDP</span>`
      case "hybrid":
        return `<span class="badge transport-hybrid">HYBRID</span>`
    }
  })()

  // Data-anomalies panel — Slice 1's recorder emits these; the
  // Slice-2-light interpreter currently surfaces name conflicts from
  // `buildParticipantsAndLanes`. Empty array → panel omitted.
  const anomaliesHtml = result.anomalies.length > 0
    ? `<div class="anomalies">
        <div class="anomalies-header">Data anomalies — ${result.anomalies.length} item${result.anomalies.length === 1 ? "" : "s"}</div>
        <ul class="anomalies-list">
          ${result.anomalies.map((a) => {
            if (a.kind === "nameConflict") {
              return `<li><span class="anomalies-kind">name conflict</span> <code>${escapeHtml(a.laneKey)}</code> → ${escapeHtml(a.names.join(", "))}</li>`
            }
            return `<li><span class="anomalies-kind">orphan repl pod</span> <code>${escapeHtml(a.pod)}</code></li>`
          }).join("")}
        </ul>
      </div>`
    : ""

  // Collect failure details (step errors + assertion errors) for the root-cause panel
  const failureItems: Array<{ stepIndex: number; label: string; reasons: string[] }> = []
  for (const sr of result.stepResults) {
    const reasons: string[] = []
    if (sr.status === "fail" && sr.error) reasons.push(sr.error)
    if (sr.assertionErrors && sr.assertionErrors.length > 0) {
      for (const ae of sr.assertionErrors) reasons.push(ae)
    }
    if (reasons.length === 0) continue
    const step = sr.step
    let label = `step #${sr.stepIndex + 1}`
    if (step.type === "expect") {
      const what = step.match.method ?? `${step.match.statusCode}`
      label += ` — ${step.agent} <- ${what}`
    } else if (step.type === "send") {
      const what = step.method ?? `${step.statusCode}`
      label += ` — ${step.agent} -> ${what}`
    }
    failureItems.push({ stepIndex: sr.stepIndex, label, reasons })
  }

  const failuresHtml = failureItems.length > 0
    ? `<div class="failures">
        <div class="failures-header">Failure detail — ${failureItems.length} step${failureItems.length === 1 ? "" : "s"} with root cause</div>
        <ul class="failures-list">
          ${failureItems.map((f) => `<li>
            <div class="failures-step">${escapeHtml(f.label)}</div>
            ${f.reasons.map((r) => `<pre class="failures-reason">${escapeHtml(r)}</pre>`).join("")}
          </li>`).join("")}
        </ul>
      </div>`
    : ""

  // Replication-frame click-target payloads. The frames themselves are
  // rendered inline in the SVG sequence diagram above, interleaved with
  // SIP arrows by timestamp. Each replication arrow carries
  // `data-repl-index` that maps into this dictionary so the click
  // handler shows the full decoded JSON in the detail panel.
  const replicationJson: Record<number, string> = {}
  for (let i = 0; i < replicationEntries.length; i++) {
    replicationJson[i] = JSON.stringify(replicationEntries[i]!, null, 2)
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(result.scenarioName)} - SIP Test Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #f9fafb;
      color: #111827;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    header {
      padding: 12px 20px;
      background: #1f2937;
      color: #f9fafb;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    header h1 { font-size: 16px; font-weight: 600; }
    .badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 700;
    }
    .badge.pass { background: #059669; color: white; }
    .badge.fail { background: #dc2626; color: white; }
    .badge.transport-fake { background: #4f46e5; color: white; }
    .badge.transport-live { background: #047857; color: white; }
    .badge.transport-hybrid { background: #7c3aed; color: white; }
    .anomalies {
      background: #fffbeb;
      border-bottom: 2px solid #d97706;
      padding: 8px 20px;
      max-height: 25vh;
      overflow-y: auto;
    }
    .anomalies-header {
      font-size: 12px;
      font-weight: 700;
      color: #92400e;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .anomalies-list { list-style: none; padding: 0; margin: 0; }
    .anomalies-list li {
      font-size: 12px;
      color: #92400e;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      padding: 2px 0;
    }
    .anomalies-kind {
      display: inline-block;
      font-weight: 600;
      color: #b45309;
      margin-right: 6px;
    }
    .summary {
      font-size: 13px;
      color: #9ca3af;
    }
    .main {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .diagram-panel {
      flex: 1;
      overflow: auto;
      padding: 20px;
    }
    .diagram-panel svg { display: block; }
    .detail-panel {
      width: 500px;
      border-left: 1px solid #e5e7eb;
      background: #ffffff;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .detail-header {
      padding: 12px 16px;
      background: #f3f4f6;
      border-bottom: 1px solid #e5e7eb;
      font-size: 13px;
      font-weight: 600;
      color: #374151;
    }
    .detail-body {
      flex: 1;
      overflow: auto;
      padding: 16px;
    }
    .detail-body pre {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
      color: #374151;
    }
    .detail-placeholder {
      color: #9ca3af;
      font-style: italic;
      padding: 20px;
      text-align: center;
    }
    .trace-arrow:hover line { stroke-width: 3 !important; }
    .trace-arrow:hover rect { fill: rgba(59, 130, 246, 0.05) !important; }
    .trace-arrow.selected rect { fill: rgba(59, 130, 246, 0.1) !important; }
    /* Out-of-dialog non-INVITE arrows (OPTIONS keepalive, out-of-dialog
       NOTIFY/INFO, etc.) are muted so call signaling stays visually
       dominant. They remain fully visible — and clickable — but recede
       so the eye finds the call flow first. */
    .trace-arrow--out-of-dialog-non-invite { opacity: 0.35; }
    .trace-arrow--out-of-dialog-non-invite:hover { opacity: 1; }
    .index-link {
      font-size: 13px;
      color: #60a5fa;
      text-decoration: none;
    }
    .index-link:hover { text-decoration: underline; }
    .txt-links {
      margin-left: auto;
      display: flex;
      gap: 8px;
      font-size: 12px;
    }
    .txt-links a {
      color: #9ca3af;
      text-decoration: none;
      padding: 2px 6px;
      border: 1px solid #4b5563;
      border-radius: 3px;
    }
    .txt-links a:hover {
      color: #f9fafb;
      border-color: #60a5fa;
    }
    .failures {
      background: #fef2f2;
      border-bottom: 2px solid #dc2626;
      padding: 12px 20px;
      max-height: 40vh;
      overflow-y: auto;
    }
    .failures-header {
      font-size: 13px;
      font-weight: 700;
      color: #991b1b;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .failures-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .failures-list li {
      border-left: 3px solid #dc2626;
      padding: 6px 10px;
      background: #ffffff;
      border-radius: 2px;
    }
    .failures-step {
      font-size: 12px;
      font-weight: 600;
      color: #7f1d1d;
      margin-bottom: 4px;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    }
    .failures-reason {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #374151;
      white-space: pre-wrap;
      word-break: break-word;
      margin: 2px 0 0 0;
      padding: 6px 8px;
      background: #fef2f2;
      border-radius: 2px;
    }
    .repl-arrow:hover line { stroke-width: 3 !important; }
    .repl-arrow:hover rect { fill: rgba(79, 70, 229, 0.08) !important; }
    .repl-arrow.selected rect { fill: rgba(79, 70, 229, 0.18) !important; }
  </style>
</head>
<body>
  <header>
    <a href="./" class="index-link">&larr; Index</a>
    <h1>${escapeHtml(result.scenarioName)}</h1>
    ${statusBadge}
    ${transportChip}
    <span class="summary">${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped</span>
    ${(textFilenames && textFilenames.length > 0) ? `<div class="txt-links">${textFilenames.map((f) => {
      // `f` is either a flat name (`scenario.global.txt`) or a network-
      // prefixed path (`ext/scenario.alice.txt`). Strip leading subdir
      // and the scenario prefix so the link label stays terse.
      const stripped = f.includes("/") ? f.slice(f.indexOf("/") + 1) : f
      const label = stripped.replace(/\.txt$/, "").split(".").slice(1).join(".") || stripped
      return `<a href="${escapeHtml(f)}" title="${escapeHtml(f)}">${escapeHtml(label)}.txt</a>`
    }).join("")}</div>` : ""}
  </header>
  ${failuresHtml}
  ${anomaliesHtml}
  <div class="main">
    <div class="diagram-panel">
      ${svg}
    </div>
    <div class="detail-panel">
      <div class="detail-header">Message Detail</div>
      <div class="detail-body">
        <div class="detail-placeholder">Click an arrow or a replication row to inspect</div>
      </div>
    </div>
  </div>
  <script>
    const messages = {
      ${messageData.map((m) => `${m.traceIndex}: '${escapeJs(m.raw)}'`).join(",\n      ")}
    };
    const replicationFrames = {
      ${Object.entries(replicationJson).map(([i, j]) => `${i}: '${escapeJs(j)}'`).join(",\n      ")}
    };

    let selectedArrow = null;
    let selectedReplRow = null;

    document.querySelectorAll('.trace-arrow').forEach(g => {
      g.addEventListener('click', () => {
        const idx = parseInt(g.dataset.traceIndex, 10);
        const raw = messages[idx];

        if (selectedArrow) selectedArrow.classList.remove('selected');
        g.classList.add('selected');
        selectedArrow = g;
        if (selectedReplRow) { selectedReplRow.classList.remove('selected'); selectedReplRow = null; }

        const body = document.querySelector('.detail-body');
        if (raw) {
          body.innerHTML = '<pre>' + raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
        } else {
          body.innerHTML = '<div class="detail-placeholder">No message data for trace entry #' + (idx + 1) + '</div>';
        }
      });
    });

    document.querySelectorAll('.repl-arrow').forEach(g => {
      g.addEventListener('click', () => {
        const idx = parseInt(g.dataset.replIndex, 10);
        const raw = replicationFrames[idx];

        if (selectedReplRow) selectedReplRow.classList.remove('selected');
        g.classList.add('selected');
        selectedReplRow = g;
        if (selectedArrow) { selectedArrow.classList.remove('selected'); selectedArrow = null; }

        const body = document.querySelector('.detail-body');
        if (raw) {
          body.innerHTML = '<pre>' + raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
        } else {
          body.innerHTML = '<div class="detail-placeholder">No JSON for replication entry #' + (idx + 1) + '</div>';
        }
      });
    });
  </script>
</body>
</html>`

  const filename = `${result.scenarioName}.html`
  const filepath = join(outputDir, filename)
  writeFileSync(filepath, html, "utf-8")
  return filepath
}

// ---------------------------------------------------------------------------
// Index report
// ---------------------------------------------------------------------------

export function writeIndexReport(
  results: readonly ScenarioResult[],
  outputDir: string
): string {
  mkdirSync(outputDir, { recursive: true })

  const rows = results.map((r) => {
    const status = r.failed > 0 ? "fail" : "pass"
    const badge = status === "fail"
      ? `<span class="badge fail">FAIL</span>`
      : `<span class="badge pass">PASS</span>`
    // Distinct networks the scenario touched — sorted so the column is
    // stable across runs. A pure-`ext` scenario shows just `ext`; a
    // dual-stack scenario shows both.
    const networks = Array.from(new Set(r.participants.map((p) => p.network))).sort()
    const networksLabel = networks.length > 0 ? networks.join(", ") : "—"
    return `<tr>
      <td>${badge}</td>
      <td><a href="${escapeHtml(r.scenarioName)}.html">${escapeHtml(r.scenarioName)}</a></td>
      <td>${escapeHtml(networksLabel)}</td>
      <td>${r.passed}</td>
      <td>${r.failed}</td>
      <td>${r.skipped}</td>
    </tr>`
  })

  const totalPassed = results.reduce((s, r) => s + r.passed, 0)
  const totalFailed = results.reduce((s, r) => s + r.failed, 0)
  const totalSkipped = results.reduce((s, r) => s + r.skipped, 0)

  const coverageHtml = renderRuleCoverage()

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SIP E2E Test Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #f9fafb;
      color: #111827;
      padding: 40px;
    }
    h1 { font-size: 20px; margin-bottom: 8px; }
    .summary { font-size: 14px; color: #6b7280; margin-bottom: 24px; }
    table { border-collapse: collapse; width: 100%; max-width: 700px; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { font-size: 12px; text-transform: uppercase; color: #6b7280; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
    }
    .badge.pass { background: #059669; color: white; }
    .badge.fail { background: #dc2626; color: white; }
    .badge.warn { background: #b45309; color: white; }
    h2 { font-size: 16px; margin: 32px 0 8px; }
    .coverage-summary { font-size: 13px; color: #6b7280; margin-bottom: 12px; }
    .coverage-table { max-width: 900px; }
    .coverage-table .uncovered td { background: #fef3c7; }
    .scenario-list { font-size: 12px; color: #4b5563; }
    .priority-band { font-size: 11px; color: #6b7280; }
  </style>
</head>
<body>
  <h1>SIP E2E Test Report</h1>
  <div class="summary">${results.length} scenarios | ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped</div>
  <table>
    <thead>
      <tr><th>Status</th><th>Scenario</th><th>Networks</th><th>Passed</th><th>Failed</th><th>Skipped</th></tr>
    </thead>
    <tbody>
      ${rows.join("\n      ")}
    </tbody>
  </table>
  ${coverageHtml}
</body>
</html>`

  const filepath = join(outputDir, "index.html")
  writeFileSync(filepath, html, "utf-8")
  return filepath
}

// ---------------------------------------------------------------------------
// Rule coverage section
// ---------------------------------------------------------------------------

interface RuleCoverageRow {
  readonly id: string
  readonly name: string
  readonly scenarios: string[]
}

function renderRuleCoverage(): string {
  const firings = ruleSnapshot()
  const rows: RuleCoverageRow[] = []
  for (const [id, rule] of ruleRegistry.definitions) {
    const scenarios = firings.get(id)
    rows.push({
      id,
      name: rule.name,
      scenarios: scenarios ? [...scenarios].sort() : [],
    })
  }
  // Never-fired rules first; then by id.
  rows.sort((a, b) => {
    const aFired = a.scenarios.length === 0 ? 0 : 1
    const bFired = b.scenarios.length === 0 ? 0 : 1
    if (aFired !== bFired) return aFired - bFired
    return a.id.localeCompare(b.id)
  })

  const total = rows.length
  const fired = rows.filter((r) => r.scenarios.length > 0).length
  const uncovered = total - fired
  const killRule = process.env.KILL_RULE

  const killNotice = killRule !== undefined && killRule.length > 0
    ? `<div class="coverage-summary"><span class="badge warn">KILL MODE</span> rule <code>${escapeHtml(killRule)}</code> was disabled for this run — coverage numbers reflect the mutated run, not baseline.</div>`
    : ""

  const rowHtml = rows.map((r) => {
    const cls = r.scenarios.length === 0 ? ' class="uncovered"' : ""
    const badge = r.scenarios.length === 0
      ? `<span class="badge warn">NEVER FIRED</span>`
      : `${r.scenarios.length}`
    const scenarioList = r.scenarios.length === 0
      ? `<span class="scenario-list">—</span>`
      : `<span class="scenario-list">${r.scenarios.map(escapeHtml).join(", ")}</span>`
    return `<tr${cls}>
      <td><code>${escapeHtml(r.id)}</code></td>
      <td>${escapeHtml(r.name)}</td>
      <td>${badge}</td>
      <td>${scenarioList}</td>
    </tr>`
  })

  return `
  <h2>Rule coverage</h2>
  ${killNotice}
  <div class="coverage-summary">${fired}/${total} rules fired \u2014 ${uncovered} never fired in any scenario</div>
  <table class="coverage-table">
    <thead>
      <tr><th>Rule id</th><th>Name</th><th>Scenarios</th><th>Exercised by</th></tr>
    </thead>
    <tbody>
      ${rowHtml.join("\n      ")}
    </tbody>
  </table>`
}
