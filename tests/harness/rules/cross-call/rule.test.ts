/**
 * cross-call rule self-tests. Reuses the basic-call clean fixture as
 * a single-call baseline, then constructs synthetic multi-recording
 * inputs to exercise the aggregator rules.
 */

import { describe, it, expect } from "vitest"
import { loadRecording } from "../../fixtures/load.js"
import type { CallRecording } from "../../recording.js"
import { RuleEngine } from "../types.js"
import { uniqueCallIdRule } from "./unique-call-id.js"
import { limiterConcurrencyRule } from "./limiter-concurrency.js"

describe("cross-call rule self-tests", () => {
  const baseline = loadRecording("basic-call-clean")

  describe("cross-call.unique-call-id", () => {
    const engine = new RuleEngine([uniqueCallIdRule])

    it("passes when each recording has a distinct Call-ID", () => {
      const a: CallRecording = { ...baseline, callId: "call-a" }
      const b: CallRecording = { ...baseline, callId: "call-b" }
      const out = engine.run([a, b], null)
      expect(out.passed).toBe(true)
    })

    it("fires when two recordings share a Call-ID", () => {
      const a: CallRecording = { ...baseline, callId: "dup" }
      const b: CallRecording = { ...baseline, callId: "dup" }
      const out = engine.run([a, b], null)
      expect(out.passed).toBe(false)
    })
  })

  describe("cross-call.limiter-concurrency", () => {
    const engine = new RuleEngine([limiterConcurrencyRule])

    /**
     * Build a synthetic recording: alice sends INVITE with limiter
     * declaration, then receives 200 OK at `okMs`, then a final
     * marker at `endMs`. Captures just enough wire bytes for the
     * rule's regexes to work.
     */
    function syntheticHold(callId: string, okMs: number, endMs: number, limit: number): CallRecording {
      const limiterValue = JSON.stringify({
        action: "route",
        call_limiter: [{ id: "L", limit }],
      })
      const inviteRaw = [
        "INVITE sip:dst@h SIP/2.0",
        "Call-ID: " + callId,
        "X-Api-Call: " + limiterValue,
        "",
        "",
      ].join("\r\n")
      const okRaw = [
        "SIP/2.0 200 OK",
        "Call-ID: " + callId,
        "",
        "",
      ].join("\r\n")
      return {
        scenarioId: "synth",
        serviceCaseId: null,
        callId,
        startMs: 0,
        entries: [
          {
            kind: "message",
            direction: "sent",
            from: "alice",
            to: "DUT",
            sentMs: 0,
            receivedMs: 0,
            raw: inviteRaw,
          },
          {
            kind: "message",
            direction: "received",
            from: "DUT",
            to: "alice",
            sentMs: okMs,
            receivedMs: okMs,
            raw: okRaw,
          },
          { kind: "marker", atMs: endMs, label: "end" },
        ],
      }
    }

    it("passes when concurrent confirmed calls stay within the limit", () => {
      // Two non-overlapping windows, limit=1.
      const a = syntheticHold("a", 100, 200, 1)
      const b = syntheticHold("b", 300, 400, 1)
      const out = engine.run([a, b], null)
      expect(out.passed).toBe(true)
    })

    it("fires when two confirmed calls overlap and limit=1", () => {
      const a = syntheticHold("a", 100, 500, 1)
      const b = syntheticHold("b", 200, 300, 1) // overlaps a
      const out = engine.run([a, b], null)
      expect(out.passed).toBe(false)
    })

    it("ignores rejected calls (no 2xx) when computing concurrency", () => {
      const a = syntheticHold("a", 100, 500, 1)
      // Call b: never gets a 2xx — drop the OK entry.
      const b: CallRecording = {
        ...syntheticHold("b", 0, 0, 1),
        entries: [syntheticHold("b", 0, 0, 1).entries[0]!], // INVITE only
      }
      const out = engine.run([a, b], null)
      expect(out.passed).toBe(true)
    })
  })
})
