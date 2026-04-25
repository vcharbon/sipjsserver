/**
 * RFC rule self-tests. Loads the clean basic-call fixture and injects
 * targeted violations to confirm each rule fires.
 *
 * Mutations edit the raw SIP wire bytes; parsedOf() re-parses lazily so
 * the rule sees the mutated message exactly as a fresh recording would.
 *
 * Mutators use regex matches rather than literal nonces so the tests
 * stay green when the fixture is recaptured (random branch/Call-ID
 * values change run-to-run; the structure does not).
 */

import { describe, it, expect } from "vitest"
import { loadRecording } from "../../fixtures/load.js"
import type { CallRecording, RecordedMessage, RecordingEntry } from "../../recording.js"
import { RuleEngine } from "../types.js"
import { rfcRules } from "./index.js"

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

function runOne(rule: (typeof rfcRules)[number], rec: CallRecording) {
  const engine = new RuleEngine([rule])
  return engine.run([rec], null)
}

function ruleByName(name: string) {
  const r = rfcRules.find((x) => x.name === name)
  if (!r) throw new Error(`rule ${name} missing`)
  return r
}

/**
 * RFC validators only fire on RECEIVED messages (the perspective of the
 * agent observing the wire). To trip a check we mutate a message that
 * an agent receives — the B2BUA-relayed INVITE arriving at bob1, or
 * the BYE arriving at bob1.
 */
const isBobInvite = (e: RecordedMessage): boolean =>
  e.direction === "received" && e.to === "bob1" && e.raw.startsWith("INVITE ")

const isBobBye = (e: RecordedMessage): boolean =>
  e.direction === "received" && e.to === "bob1" && e.raw.startsWith("BYE ")

describe("rfc rule self-tests", () => {
  it("clean fixture passes every rfc rule", () => {
    const rec = loadRecording("basic-call-clean")
    const engine = new RuleEngine(rfcRules)
    const out = engine.run([rec], null)
    if (!out.passed) {
      const details = out.findings
        .filter((f) => f.status === "fail")
        .map((f) => `${f.ruleName}: ${f.violations.map((v) => v.message).join(" | ")}`)
        .join("\n")
      throw new Error(`expected clean fixture to pass but got:\n${details}`)
    }
    expect(out.passed).toBe(true)
  })

  it("rfc.cseq fires when BYE CSeq is bumped out of sequence", () => {
    const clean = loadRecording("basic-call-clean")
    const mutated = mutateRawAt(clean, isBobBye, (raw) =>
      raw.replace(/CSeq: \d+ BYE/, "CSeq: 42 BYE")
    )
    const out = runOne(ruleByName("rfc.cseq"), mutated)
    expect(out.passed).toBe(false)
  })

  it("rfc.branchPrefix fires when a Via branch drops the magic cookie", () => {
    const clean = loadRecording("basic-call-clean")
    const mutated = mutateRawAt(clean, isBobInvite, (raw) =>
      raw.replace(/branch=z9hG4bK/g, "branch=")
    )
    const out = runOne(ruleByName("rfc.branchPrefix"), mutated)
    expect(out.passed).toBe(false)
  })

  it("rfc.contentLength fires when Content-Length disagrees with body", () => {
    const clean = loadRecording("basic-call-clean")
    // Use a *smaller* value than the actual body. A larger value would make
    // the custom parser throw (Content-Length exceeds remaining bytes), and
    // the message would be dropped before the rule could see it. A smaller
    // declared value parses fine (parser slices body to N) yet leaves the
    // raw on-wire body longer than declared, which the raw-bytes check
    // (see checkRawContentLength in ./index.ts) catches.
    const mutated = mutateRawAt(clean, isBobInvite, (raw) =>
      raw.replace(/Content-Length: \d+/, "Content-Length: 5")
    )
    const out = runOne(ruleByName("rfc.contentLength"), mutated)
    expect(out.passed).toBe(false)
  })

  it("rfc.maxForwards fires when the value exceeds 70", () => {
    const clean = loadRecording("basic-call-clean")
    const mutated = mutateRawAt(clean, isBobInvite, (raw) =>
      raw.replace(/Max-Forwards: \d+/, "Max-Forwards: 200")
    )
    const out = runOne(ruleByName("rfc.maxForwards"), mutated)
    expect(out.passed).toBe(false)
  })
})
