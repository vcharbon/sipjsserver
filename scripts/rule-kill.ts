/**
 * Rule-kill mutation orchestrator.
 *
 * Iterates every rule in the production registry and runs the simulated
 * e2e suite once with that rule disabled (via KILL_RULE env var, read by
 * simulated-backend.ts). A rule whose disabling leaves the suite green is
 * a "surviving mutant" — not meaningfully tested.
 *
 * Run with: `npm run test:rule-kill`. This is an opt-in audit, not part
 * of the default test command — O(rules) full suite runs.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ruleRegistry } from "../src/b2bua/B2buaCore.js"

const OUTPUT_DIR = "test-results"
const REPORT_FILE = "rule-kill-report.txt"
const TARGET_TEST = "tests/e2e/e2e-fake-clock.test.ts"

interface Result {
  readonly id: string
  readonly killed: boolean
  readonly exitCode: number
}

function runSuiteWithRuleDisabled(ruleId: string): Result {
  const result = spawnSync(
    "npx",
    ["vitest", "run", TARGET_TEST, "--reporter=dot"],
    {
      env: { ...process.env, KILL_RULE: ruleId },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    },
  )
  const exitCode = result.status ?? -1
  return { id: ruleId, killed: exitCode !== 0, exitCode }
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true })
  const ruleIds = [...ruleRegistry.definitions.keys()].sort()

  const lines: string[] = []
  lines.push(`# Rule kill report — ${new Date().toISOString()}`)
  lines.push(`# Target: ${TARGET_TEST}`)
  lines.push(`# ${ruleIds.length} rules evaluated`)
  lines.push("")

  const results: Result[] = []
  for (const id of ruleIds) {
    process.stdout.write(`[rule-kill] ${id.padEnd(40)} ... `)
    const r = runSuiteWithRuleDisabled(id)
    results.push(r)
    if (r.killed) {
      console.log(`KILLED (exit=${r.exitCode})`)
      lines.push(`KILLED   ${id}`)
    } else {
      console.log("SURVIVED — not meaningfully tested")
      lines.push(`SURVIVED ${id}`)
    }
  }

  const surviving = results.filter((r) => !r.killed)
  lines.push("")
  lines.push(`# Summary: ${results.length - surviving.length} killed, ${surviving.length} survived`)
  if (surviving.length > 0) {
    lines.push("# Surviving rules (remove or add a test):")
    for (const r of surviving) lines.push(`#   - ${r.id}`)
  }

  const reportPath = join(OUTPUT_DIR, REPORT_FILE)
  writeFileSync(reportPath, lines.join("\n") + "\n", "utf-8")
  console.log(`\nReport written to ${reportPath}`)
  console.log(`${results.length - surviving.length} killed, ${surviving.length} survived.`)
  process.exit(surviving.length > 0 ? 1 : 0)
}

main()
