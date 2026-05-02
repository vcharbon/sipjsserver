/**
 * Test report — formats ScenarioResult into a readable step-by-step report.
 *
 * Integrates with vitest: the report string is attached to the error on failure
 * so it appears in the test output.
 */

import type { ScenarioResult, Step, StepResult } from "./types.js"

export function formatReport(result: ScenarioResult): string {
  const lines: string[] = []
  lines.push(`Scenario: ${result.scenarioName}`)

  for (const sr of result.stepResults) {
    lines.push(formatStepResult(sr))
  }

  lines.push("")

  // Assertion errors
  const assertionFailures = result.stepResults.filter(
    (r) => r.assertionErrors && r.assertionErrors.length > 0
  )
  if (assertionFailures.length > 0) {
    lines.push("  Assertions:")
    for (const sr of assertionFailures) {
      for (const err of sr.assertionErrors!) {
        lines.push(`    step #${sr.stepIndex + 1}: ${err}`)
      }
    }
  }

  // Unexpected messages
  const unexpected = result.stepResults.filter(
    (r) => r.status === "fail" && r.error?.startsWith("Unexpected message")
  )
  if (unexpected.length > 0) {
    lines.push(`  Unexpected:  ${unexpected.length}`)
    for (const sr of unexpected) {
      lines.push(`    ${sr.error}`)
    }
  }

  // Timing
  const timed = result.stepResults.filter(
    (r) => r.status === "pass" && r.durationMs !== undefined && r.step.type === "expect"
  )
  if (timed.length > 0) {
    lines.push("  Timing:")
    for (const sr of timed) {
      const desc = stepDescription(sr.step)
      const timeout = sr.step.type === "expect" ? (sr.step.timeout ?? 5000) : 5000
      const ok = sr.durationMs! < timeout
      lines.push(
        `    step #${sr.stepIndex + 1} (${desc}): ${sr.durationMs}ms [< ${timeout}ms ${ok ? "OK" : "SLOW"}]`
      )
    }
  }

  lines.push(
    `  Result:      ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`
  )

  return lines.join("\n")
}

function formatStepResult(sr: StepResult): string {
  const tag = sr.status === "pass" ? "PASS" : sr.status === "fail" ? "FAIL" : "SKIP"
  const num = `#${sr.stepIndex + 1}`.padStart(4)
  const desc = stepDescription(sr.step)
  const timing = sr.durationMs !== undefined ? ` (${sr.durationMs}ms)` : ""
  const err = sr.error ? ` — ${sr.error}` : ""
  const dep = sr.dependsOn !== undefined ? ` (depends on #${sr.dependsOn + 1})` : ""

  return `  [${tag}]  ${num}  ${desc}${timing}${err}${dep}`
}

function stepDescription(step: Step): string {
  switch (step.type) {
    case "send": {
      const dir = step.statusCode !== undefined
        ? `${step.agent} -> ${step.statusCode} ${reasonForCode(step.statusCode)}`
        : `${step.agent} -> ${step.method}${step.uri ? " " + step.uri : ""}`
      return dir
    }
    case "expect": {
      const what = step.match.method ?? `${step.match.statusCode}`
      return `${step.agent} <- ${what}`
    }
    case "pause":
      return `pause ${step.duration}ms`
    case "infra":
      return `${step.action} ${step.target}`
  }
}

function reasonForCode(code: number): string {
  const reasons: Record<number, string> = {
    100: "Trying",
    180: "Ringing",
    183: "Session Progress",
    200: "OK",
    403: "Forbidden",
    486: "Busy Here",
    487: "Request Terminated",
  }
  return reasons[code] ?? ""
}
