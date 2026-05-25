/**
 * cross-call rule self-tests. Synthetic per-call traces feed the
 * aggregator rules.
 */

import { describe, it, expect } from "vitest"
import {
  RuleEngine,
  type RuleTrace,
  type RuleTraceEntry,
} from "../types.js"
import { uniqueCallIdRule } from "./unique-call-id.js"
import { limiterConcurrencyRule } from "./limiter-concurrency.js"

function baselineRec(callId = "c@h"): RuleTrace {
  const entries: RuleTraceEntry[] = [
    {
      kind: "message",
      direction: "sent",
      from: "alice",
      to: "DUT",
      sentMs: 0,
      receivedMs: 0,
      raw: `INVITE sip:dst SIP/2.0\r\nCall-ID: ${callId}\r\n\r\n`,
    },
  ]
  return {
    scenarioId: "synth",
    serviceCaseId: null,
    callId,
    startMs: 0,
    entries,
  }
}

describe("cross-call rule self-tests", () => {
  describe("cross-call.unique-call-id", () => {
    const engine = new RuleEngine([uniqueCallIdRule])

    it("passes when each recording has a distinct Call-ID", () => {
      const a: RuleTrace = { ...baselineRec(), callId: "call-a" }
      const b: RuleTrace = { ...baselineRec(), callId: "call-b" }
      const out = engine.run([a, b], null)
      expect(out.passed).toBe(true)
    })

    it("fires when two recordings share a Call-ID", () => {
      const a: RuleTrace = { ...baselineRec(), callId: "dup" }
      const b: RuleTrace = { ...baselineRec(), callId: "dup" }
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
    function syntheticHold(callId: string, okMs: number, endMs: number, limit: number): RuleTrace {
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
      const a = syntheticHold("a", 100, 200, 1)
      const b = syntheticHold("b", 300, 400, 1)
      const out = engine.run([a, b], null)
      expect(out.passed).toBe(true)
    })

    it("fires when two confirmed calls overlap and limit=1", () => {
      const a = syntheticHold("a", 100, 500, 1)
      const b = syntheticHold("b", 200, 300, 1)
      const out = engine.run([a, b], null)
      expect(out.passed).toBe(false)
    })

    it("ignores rejected calls (no 2xx) when computing concurrency", () => {
      const a = syntheticHold("a", 100, 500, 1)
      const b: RuleTrace = {
        ...syntheticHold("b", 0, 0, 1),
        entries: [syntheticHold("b", 0, 0, 1).entries[0]!],
      }
      const out = engine.run([a, b], null)
      expect(out.passed).toBe(true)
    })
  })
})
