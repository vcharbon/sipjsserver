/**
 * Matcher selection tests for the layered, explicit-order model.
 *
 * The `Match.transferPhase` column and per-rule specificity scoring were
 * retired: the REFER transfer flow is a callflow service whose rules gate on
 * the decoded `ext.phase` via their `filter`, and selection is first-match-wins
 * by precedence layer then registration order. These tests lock:
 *   1. `matchAccepts` invokes a rule's `filter` after column match (so a
 *      phase-reading filter can reject an otherwise-matching event).
 *   2. `pickRanked` ranks a higher layer (service) above a lower one (core),
 *      keeps registration order within a layer, and honours `overrides`
 *      regardless of layer.
 */

import { describe, it, expect } from "vitest"
import { matchAccepts, pickRanked } from "../../src/b2bua/rules/framework/Matcher.js"
import { CORE_LAYER, SERVICE_LAYER } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { AnyRuleDefinition, Match, RuleContext } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { Call } from "../../src/call/CallModel.js"

// Minimal RuleContext stub — only the fields the matcher / filters read here.
// `ext` carries the transfer service's decoded slice (as the RuleExecutor
// decode bracket would present it to a service rule's filter).
function ctxWith(phase: string | undefined, callState = "active"): RuleContext {
  const call = {
    state: callState,
    ext: phase !== undefined ? { transfer: { phase } } : undefined,
  } as unknown as Call
  return {
    call,
    event: { type: "timer", timerType: "refer_overall_safety", legId: undefined },
  } as unknown as RuleContext
}

// Minimal rule stub — pickRanked reads id / match / layer / overrides only.
function ruleStub(
  id: string,
  match: Match,
  layer: number,
  overrides?: string | ReadonlyArray<string>,
): AnyRuleDefinition {
  return { id, name: id, match, layer, ...(overrides !== undefined ? { overrides } : {}) } as unknown as AnyRuleDefinition
}

describe("matcher phase gating via filter", () => {
  it("no filter → column match alone accepts any phase", () => {
    const m: Match = { kind: "timer", timerType: "refer_overall_safety" }
    expect(matchAccepts(m, ctxWith("c-ringing"))).toBe(true)
    expect(matchAccepts(m, ctxWith(undefined))).toBe(true)
  })

  it("a phase-reading filter rejects a mismatching phase after columns match", () => {
    const m: Match = {
      kind: "timer",
      timerType: "refer_overall_safety",
      filter: (ctx) =>
        (ctx.call.ext as { transfer?: { phase?: string } } | undefined)?.transfer?.phase ===
        "c-ringing",
    }
    expect(matchAccepts(m, ctxWith("c-ringing"))).toBe(true)
    expect(matchAccepts(m, ctxWith("a-realigning"))).toBe(false)
    expect(matchAccepts(m, ctxWith(undefined))).toBe(false)
  })

  it("the filter only runs when columns already match (wrong timer type → no accept)", () => {
    let filterRan = false
    const m: Match = {
      kind: "timer",
      timerType: "no_answer", // mismatches the stub event's refer_overall_safety
      filter: () => {
        filterRan = true
        return true
      },
    }
    expect(matchAccepts(m, ctxWith("c-ringing"))).toBe(false)
    expect(filterRan).toBe(false)
  })
})

describe("pickRanked layered ordering", () => {
  const timer: Match = { kind: "timer", timerType: "refer_overall_safety" }

  it("a SERVICE_LAYER rule outranks a colliding CORE_LAYER rule", () => {
    const core = ruleStub("core", timer, CORE_LAYER)
    const svc = ruleStub("svc", timer, SERVICE_LAYER)
    // Registration order is core-first; the service must still win.
    const ranked = pickRanked([core, svc], ctxWith("c-ringing"))
    expect(ranked.map((r) => r.id)).toEqual(["svc", "core"])
  })

  it("within a layer, registration order is preserved (stable)", () => {
    const first = ruleStub("first", timer, CORE_LAYER)
    const second = ruleStub("second", timer, CORE_LAYER)
    const ranked = pickRanked([first, second], ctxWith("c-ringing"))
    expect(ranked.map((r) => r.id)).toEqual(["first", "second"])
  })

  it("overrides removes the named rule regardless of layer (lower trumps higher)", () => {
    // A core rule that overrides a service rule — the escape hatch a layer
    // cannot express (transfer-reject-replaces over transfer-reject-second-refer).
    const svc = ruleStub("svc", timer, SERVICE_LAYER)
    const core = ruleStub("core", timer, CORE_LAYER, "svc")
    const ranked = pickRanked([svc, core], ctxWith("c-ringing"))
    expect(ranked.map((r) => r.id)).toEqual(["core"])
  })
})
