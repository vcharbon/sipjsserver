/**
 * HTML report writer — generates self-contained HTML files with SVG sequence
 * diagrams and click-to-inspect message detail panels.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ScenarioResult } from "./types.js"
import { renderSequenceDiagram, serializeMessage } from "./svg-sequence-diagram.js"

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

  const svg = renderSequenceDiagram(result.trace, result.participants)

  // Build message data for the click handler
  const messageData: Array<{ stepIndex: number; raw: string }> = result.trace.map(
    (entry) => ({
      stepIndex: entry.stepIndex,
      raw: serializeMessage(entry.message),
    })
  )

  const statusBadge = result.failed > 0
    ? `<span class="badge fail">FAIL</span>`
    : `<span class="badge pass">PASS</span>`

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
  </style>
</head>
<body>
  <header>
    <a href="index.html" class="index-link">&larr; Index</a>
    <h1>${escapeHtml(result.scenarioName)}</h1>
    ${statusBadge}
    <span class="summary">${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped</span>
    ${(textFilenames && textFilenames.length > 0) ? `<div class="txt-links">${textFilenames.map((f) => {
      const label = f.replace(/\.txt$/, "").split(".").slice(1).join(".") || f
      return `<a href="${escapeHtml(f)}" title="${escapeHtml(f)}">${escapeHtml(label)}.txt</a>`
    }).join("")}</div>` : ""}
  </header>
  <div class="main">
    <div class="diagram-panel">
      ${svg}
    </div>
    <div class="detail-panel">
      <div class="detail-header">Message Detail</div>
      <div class="detail-body">
        <div class="detail-placeholder">Click an arrow to inspect the full SIP message</div>
      </div>
    </div>
  </div>
  <script>
    const messages = {
      ${messageData.map((m) => `${m.stepIndex}: '${escapeJs(m.raw)}'`).join(",\n      ")}
    };

    let selectedArrow = null;

    document.querySelectorAll('.trace-arrow').forEach(g => {
      g.addEventListener('click', () => {
        const idx = parseInt(g.dataset.stepIndex, 10);
        const raw = messages[idx];

        if (selectedArrow) selectedArrow.classList.remove('selected');
        g.classList.add('selected');
        selectedArrow = g;

        const body = document.querySelector('.detail-body');
        if (raw) {
          body.innerHTML = '<pre>' + raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
        } else {
          body.innerHTML = '<div class="detail-placeholder">No message data for step #' + (idx + 1) + '</div>';
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
    return `<tr>
      <td>${badge}</td>
      <td><a href="${escapeHtml(r.scenarioName)}.html">${escapeHtml(r.scenarioName)}</a></td>
      <td>${r.passed}</td>
      <td>${r.failed}</td>
      <td>${r.skipped}</td>
    </tr>`
  })

  const totalPassed = results.reduce((s, r) => s + r.passed, 0)
  const totalFailed = results.reduce((s, r) => s + r.failed, 0)
  const totalSkipped = results.reduce((s, r) => s + r.skipped, 0)

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
  </style>
</head>
<body>
  <h1>SIP E2E Test Report</h1>
  <div class="summary">${results.length} scenarios | ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped</div>
  <table>
    <thead>
      <tr><th>Status</th><th>Scenario</th><th>Passed</th><th>Failed</th><th>Skipped</th></tr>
    </thead>
    <tbody>
      ${rows.join("\n      ")}
    </tbody>
  </table>
</body>
</html>`

  const filepath = join(outputDir, "index.html")
  writeFileSync(filepath, html, "utf-8")
  return filepath
}
