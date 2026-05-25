/**
 * service-case rule self-tests. Pairs a synthetic per-call trace
 * carrying a parseable INVITE pair (alice-side + leg-side) with the
 * basic-call ServiceCase, then derives modified ServiceCases with
 * deliberately failing checks to confirm the rule reports.
 *
 * The recording is left untouched; mutating the *expectations* (the
 * ServiceCase) is the cleanest way to surface the rule, since the rule
 * runs declared checks against the observed wire bytes.
 */

import { describe, it, expect } from "vitest"
import { loadServiceCase } from "../../service-case/load.js"
import type { ServiceCase, ServiceCaseLeg } from "../../service-case/types.js"
import {
  RuleEngine,
  type RuleTrace,
  type RuleTraceEntry,
} from "../types.js"
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

const ALICE_INVITE = [
  "INVITE sip:+1234@127.0.0.1:15060 SIP/2.0",
  "Via: SIP/2.0/UDP 127.0.0.1:15661;branch=z9hG4bK1",
  "Max-Forwards: 70",
  "From: <sip:alice@test>;tag=a1",
  "To: <sip:+1234@test>",
  "Call-ID: c@h",
  "CSeq: 1 INVITE",
  "Contact: <sip:127.0.0.1:15661;transport=udp>",
  "Content-Length: 0",
  "",
  "",
].join("\r\n")

const BOB1_INVITE = [
  "INVITE sip:+1234@127.0.0.1:5666 SIP/2.0",
  "Via: SIP/2.0/UDP 127.0.0.1:15060;branch=z9hG4bK2",
  "Max-Forwards: 69",
  "From: <sip:alice@test>;tag=b1",
  "To: <sip:+1234@test>",
  "Call-ID: 1-c@h",
  "CSeq: 1 INVITE",
  "Contact: <sip:b2bua@127.0.0.1:15060>",
  "Content-Length: 0",
  "",
  "",
].join("\r\n")

function syntheticBasicCall(): RuleTrace {
  const entries: RuleTraceEntry[] = [
    {
      kind: "message",
      direction: "sent",
      from: "alice",
      to: "B2BUA",
      sentMs: 0,
      receivedMs: 15,
      raw: ALICE_INVITE,
    },
    {
      kind: "message",
      direction: "received",
      from: "B2BUA",
      to: "bob1",
      sentMs: 15,
      receivedMs: 30,
      raw: BOB1_INVITE,
    },
  ]
  return {
    scenarioId: "basic-call",
    serviceCaseId: "basic-call",
    callId: "c@h",
    startMs: 0,
    entries,
  }
}

describe("service-case rule self-tests", () => {
  const cleanRec = syntheticBasicCall()
  const baseCase = loadServiceCase("basic-call")
  const rule = ruleByName("service-case.field-checks")
  const engine = new RuleEngine([rule])

  it("clean trace + clean service-case passes", () => {
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
