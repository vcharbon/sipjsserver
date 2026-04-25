/**
 * RuleEngine escape-hatch self-tests.
 *
 * Two opt-out levers exist for ServiceCases that intentionally violate
 * a rule (or for transient debugging where a rule is too noisy):
 *
 *   - disableRules: [name]        skip the rule entirely
 *   - expectViolations: [name]    invert: pass becomes fail and vice-versa
 *
 * These can be supplied either as runtime opts to runDriveOnly or as
 * declarative ServiceCase fields. The runner prefers runtime opts;
 * absent that, it falls back to the ServiceCase. This test exercises
 * the engine contract directly with a known-bad mutation.
 */
import { describe, it, expect } from "vitest"
import { loadRecording } from "../fixtures/load.js"
import type { CallRecording, RecordedMessage, RecordingEntry } from "../recording.js"
import { RuleEngine } from "./types.js"
import { rfcRules } from "./rfc/index.js"

function mutateRawAt(
  rec: CallRecording,
  predicate: (e: RecordedMessage) => boolean,
  mutator: (raw: string) => string
): CallRecording {
  let mutated = false
  const entries: RecordingEntry[] = rec.entries.map((e) => {
    if (e.kind !== "message" || mutated || !predicate(e)) return e
    const next = mutator(e.raw)
    if (next === e.raw) return e
    mutated = true
    const { parsed: _ignored, ...rest } = e
    return { ...rest, raw: next } as RecordedMessage
  })
  if (!mutated) throw new Error("mutateRawAt: predicate matched no entry / no change")
  return { ...rec, entries }
}

const isBobInvite = (e: RecordedMessage): boolean =>
  e.direction === "received" && e.to === "bob1" && e.raw.startsWith("INVITE ")

const RULE = "rfc.maxForwards"

const tooManyHops = (rec: CallRecording): CallRecording =>
  mutateRawAt(rec, isBobInvite, (raw) => raw.replace(/Max-Forwards: \d+/, "Max-Forwards: 200"))

describe("rule engine escape hatches", () => {
  it("baseline: mutated fixture trips rfc.maxForwards and fails", () => {
    const bad = tooManyHops(loadRecording("basic-call-clean"))
    const engine = new RuleEngine(rfcRules)
    const out = engine.run([bad], null)
    expect(out.passed).toBe(false)
    const finding = out.findings.find((f) => f.ruleName === RULE)
    expect(finding?.status).toBe("fail")
  })

  it("disableRules skips the rule and the engine passes", () => {
    const bad = tooManyHops(loadRecording("basic-call-clean"))
    const engine = new RuleEngine(rfcRules)
    const out = engine.run([bad], null, { disableRules: [RULE] })
    expect(out.passed).toBe(true)
    // Skipped rule produces no finding at all.
    expect(out.findings.find((f) => f.ruleName === RULE)).toBeUndefined()
  })

  it("expectViolations inverts a failing rule into a pass", () => {
    const bad = tooManyHops(loadRecording("basic-call-clean"))
    const engine = new RuleEngine(rfcRules)
    const out = engine.run([bad], null, { expectViolations: [RULE] })
    expect(out.passed).toBe(true)
    const finding = out.findings.find((f) => f.ruleName === RULE)
    // Violations are still reported; only the status is inverted.
    expect(finding?.status).toBe("pass")
    expect(finding?.violations.length).toBeGreaterThan(0)
  })

  it("expectViolations on a clean run flips an unexpected pass into a failure", () => {
    const clean = loadRecording("basic-call-clean")
    const engine = new RuleEngine(rfcRules)
    const out = engine.run([clean], null, { expectViolations: [RULE] })
    expect(out.passed).toBe(false)
    const finding = out.findings.find((f) => f.ruleName === RULE)
    expect(finding?.status).toBe("fail")
    expect(finding?.violations.length).toBe(0)
  })
})
