/**
 * call-shape rule self-tests. Loads the clean basic-call fixture and
 * pairs it with the basic-call ServiceCase so allExpectedReceivedRule
 * has a leg/alice list to validate against.
 *
 * - noUnexpectedRule: flag set per-entry by the runner; mutate to true
 *   to trip the rule.
 * - allExpectedReceivedRule: derives expectations from ServiceCase
 *   legs/alices; remove a bob1 INVITE entry to trip it.
 */

import { describe, it, expect } from "vitest"
import { loadRecording } from "../../fixtures/load.js"
import { loadServiceCase } from "../../service-case/load.js"
import type { CallRecording } from "../../recording.js"
import { RuleEngine } from "../types.js"
import { callShapeRules } from "./index.js"

function ruleByName(name: string) {
  const r = callShapeRules.find((x) => x.name === name)
  if (!r) throw new Error(`rule ${name} missing`)
  return r
}

function runOne(rule: (typeof callShapeRules)[number], rec: CallRecording, sc = loadServiceCase("basic-call")) {
  const engine = new RuleEngine([rule])
  return engine.run([rec], sc)
}

describe("call-shape rule self-tests", () => {
  const sc = loadServiceCase("basic-call")

  it("clean fixture passes every call-shape rule", () => {
    const rec = loadRecording("basic-call-clean")
    const engine = new RuleEngine(callShapeRules)
    const out = engine.run([rec], sc)
    if (!out.passed) {
      const details = out.findings
        .filter((f) => f.status === "fail")
        .map((f) => `${f.ruleName}: ${f.violations.map((v) => v.message).join(" | ")}`)
        .join("\n")
      throw new Error(`expected clean fixture to pass but got:\n${details}`)
    }
    expect(out.passed).toBe(true)
  })

  it("call-shape.no-unexpected fires when an entry is marked unexpected", () => {
    const clean = loadRecording("basic-call-clean")
    let mutated = false
    const entries = clean.entries.map((e) => {
      if (e.kind === "message" && !mutated) {
        mutated = true
        return { ...e, unexpected: true }
      }
      return e
    })
    if (!mutated) throw new Error("no message entry to mutate")
    const out = runOne(ruleByName("call-shape.no-unexpected"), { ...clean, entries })
    expect(out.passed).toBe(false)
  })

  it("call-shape.all-expected-received fires when bob1's INVITE is missing", () => {
    const clean = loadRecording("basic-call-clean")
    // Drop every INVITE arriving at bob1 — the rule must complain that
    // the leg's expected INVITE never appeared.
    const entries = clean.entries.filter(
      (e) =>
        !(e.kind === "message" && e.direction === "received" && e.to === "bob1" && e.raw.startsWith("INVITE "))
    )
    if (entries.length === clean.entries.length) {
      throw new Error("filter removed nothing; fixture has no bob1-received INVITE")
    }
    const out = runOne(ruleByName("call-shape.all-expected-received"), { ...clean, entries })
    expect(out.passed).toBe(false)
  })
})
