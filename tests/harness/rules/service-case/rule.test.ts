/**
 * service-case rule self-tests. Pairs the clean basic-call recording
 * with the basic-call ServiceCase, then derives modified ServiceCases
 * with deliberately failing checks to confirm the rule reports.
 *
 * The recording is left untouched; mutating the *expectations* (the
 * ServiceCase) is the cleanest way to surface the rule, since the rule
 * runs declared checks against the observed wire bytes.
 */

import { describe, it, expect } from "vitest"
import { loadRecording } from "../../fixtures/load.js"
import { loadServiceCase } from "../../service-case/load.js"
import type { ServiceCase, ServiceCaseLeg } from "../../service-case/types.js"
import { RuleEngine } from "../types.js"
import { serviceCaseRules } from "./index.js"

function ruleByName(name: string) {
  const r = serviceCaseRules.find((x) => x.name === name)
  if (!r) throw new Error(`rule ${name} missing`)
  return r
}

function withLeg(sc: ServiceCase, name: string, patch: Partial<ServiceCaseLeg>): ServiceCase {
  const legs = sc.legs.map((l) => (l.name === name ? { ...l, ...patch } : l))
  return { ...sc, legs }
}

describe("service-case rule self-tests", () => {
  const cleanRec = loadRecording("basic-call-clean")
  const baseCase = loadServiceCase("basic-call")
  const rule = ruleByName("service-case.field-checks")
  const engine = new RuleEngine([rule])

  it("clean recording + clean service-case passes", () => {
    const out = engine.run([cleanRec], baseCase)
    if (!out.passed) {
      const details = out.findings
        .filter((f) => f.status === "fail")
        .map((f) => `${f.ruleName}: ${f.violations.map((v) => v.message).join(" | ")}`)
        .join("\n")
      throw new Error(`expected clean to pass but got:\n${details}`)
    }
    expect(out.passed).toBe(true)
  })

  it("fires when leg.inviteRuri eq does not match the observed Request-URI", () => {
    const sc = withLeg(baseCase, "bob1", {
      checks: { inviteRuri: { eq: "sip:does-not-exist@example.com" } },
    })
    const out = engine.run([cleanRec], sc)
    expect(out.passed).toBe(false)
  })

  it("fires when leg.inviteHeaders demands a header that is missing", () => {
    const sc = withLeg(baseCase, "bob1", {
      checks: { inviteHeaders: { "X-Not-Present": { eq: "anything" } } },
    })
    const out = engine.run([cleanRec], sc)
    expect(out.passed).toBe(false)
  })

  it("fires when leg.inviteRuri regex does not match the observed Request-URI", () => {
    const sc = withLeg(baseCase, "bob1", {
      checks: { inviteRuri: { regex: "^sips:" } },
    })
    const out = engine.run([cleanRec], sc)
    expect(out.passed).toBe(false)
  })
})
