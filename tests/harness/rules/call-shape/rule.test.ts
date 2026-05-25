/**
 * call-shape rule self-tests. Builds synthetic per-call traces inline
 * — sufficient for rule-logic exercise without needing the full
 * runDriveOnly pipeline.
 *
 * - noUnexpectedRule: mutate an entry's `unexpected` flag to trip.
 * - allExpectedReceivedRule: drop the bob1 INVITE-received entry to trip.
 */

import { describe, it, expect } from "vitest"
import { loadServiceCase } from "../../service-case/load.js"
import {
  RuleEngine,
  type RuleTrace,
  type RuleTraceEntry,
  type RuleTraceMessage,
} from "../types.js"
import { callShapeRules } from "./index.js"

function ruleByName(name: string) {
  const r = callShapeRules.find((x) => x.name === name)
  if (!r) throw new Error(`rule ${name} missing`)
  return r
}

function msg(direction: "sent" | "received", from: string, to: string, raw: string, atMs = 0): RuleTraceMessage {
  return { kind: "message", direction, from, to, sentMs: atMs, receivedMs: atMs, raw }
}

const INVITE_ALICE_RURI =
  "INVITE sip:+1234@127.0.0.1:15060 SIP/2.0\r\nCall-ID: c@h\r\n\r\n"
const INVITE_BOB1 =
  "INVITE sip:bob1@test SIP/2.0\r\nCall-ID: c@h\r\n\r\n"

function syntheticBasicCallTrace(): RuleTrace {
  const entries: RuleTraceEntry[] = [
    msg("sent", "alice", "DUT", INVITE_ALICE_RURI, 0),
    msg("received", "DUT", "alice", "SIP/2.0 100 Trying\r\nCall-ID: c@h\r\n\r\n", 5),
    msg("received", "DUT", "bob1", INVITE_BOB1, 10),
    msg("sent", "bob1", "DUT", "SIP/2.0 180 Ringing\r\nCall-ID: c@h\r\n\r\n", 15),
    msg("received", "DUT", "alice", "SIP/2.0 180 Ringing\r\nCall-ID: c@h\r\n\r\n", 20),
    msg("sent", "bob1", "DUT", "SIP/2.0 200 OK\r\nCall-ID: c@h\r\n\r\n", 25),
    msg("received", "DUT", "alice", "SIP/2.0 200 OK\r\nCall-ID: c@h\r\n\r\n", 30),
  ]
  return {
    scenarioId: "basic-call",
    serviceCaseId: "basic-call",
    callId: "c@h",
    startMs: 0,
    entries,
  }
}

function runOne(rule: (typeof callShapeRules)[number], rec: RuleTrace, sc = loadServiceCase("basic-call")) {
  const engine = new RuleEngine([rule])
  return engine.run([rec], sc)
}

describe("call-shape rule self-tests", () => {
  const sc = loadServiceCase("basic-call")

  it("clean synthetic trace passes every call-shape rule", () => {
    const rec = syntheticBasicCallTrace()
    const engine = new RuleEngine(callShapeRules)
    const out = engine.run([rec], sc)
    if (!out.passed) {
      const details = out.findings
        .filter((f) => f.status === "fail")
        .map((f) => `${f.ruleName}: ${f.violations.map((v) => v.message).join(" | ")}`)
        .join("\n")
      throw new Error(`expected clean trace to pass but got:\n${details}`)
    }
    expect(out.passed).toBe(true)
  })

  it("call-shape.no-unexpected fires when an entry is marked unexpected", () => {
    const clean = syntheticBasicCallTrace()
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
    const clean = syntheticBasicCallTrace()
    const entries = clean.entries.filter(
      (e) =>
        !(e.kind === "message" && e.direction === "received" && e.to === "bob1" && e.raw.startsWith("INVITE "))
    )
    if (entries.length === clean.entries.length) {
      throw new Error("filter removed nothing; synthetic trace lacks bob1-received INVITE")
    }
    const out = runOne(ruleByName("call-shape.all-expected-received"), { ...clean, entries })
    expect(out.passed).toBe(false)
  })
})
