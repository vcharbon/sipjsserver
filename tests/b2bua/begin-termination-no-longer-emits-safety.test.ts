/**
 * Phase 6 of docs/plan/2026-05-15-StructuralEffectGuarantees-moth.md.
 *
 * `executeBeginTermination` no longer emits the
 * `schedule-timer(terminating_timeout)` effect. The structural safety
 * net is auto-armed inside `CallState.update` when the call transitions
 * into `terminating` (Phase 5). This regression test pins the new
 * contract: a terminating composite must NOT push a duplicate
 * safety-timer effect.
 */

import { describe, expect, test } from "vitest"
import { executeActions } from "../../src/b2bua/rules/framework/ActionExecutor.js"
import type { RuleAction } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import {
  makeCall,
  makeLeg,
  makeDialog,
  makeALegDialog,
  makeCtx,
  make200InviteFromB,
} from "./helpers/reach.js"

describe("begin-termination no longer emits safety timer", () => {
  test("confirmed-leg termination produces no schedule-timer(terminating_timeout)", () => {
    const aDialog = makeALegDialog("alice-tag", "tagA")
    const bDialog = makeDialog("bob-tag")
    const aLeg = { ...makeLeg("a", "call-1", "tagA", aDialog), state: "confirmed" as const }
    const bLeg = { ...makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog), state: "confirmed" as const }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aDialog, "from-a", make200InviteFromB("bob-tag"))
    const actions: RuleAction[] = [{ type: "begin-termination" }]
    const result = executeActions(actions, ctx, "test-rule")

    const safetyTimers = result.effects.critical.filter(
      (e) =>
        e.type === "schedule-timer" &&
        (e as { type: "schedule-timer"; timer: { type: string } }).timer.type === "terminating_timeout",
    )
    expect(safetyTimers.length).toBe(0)
  })

  test("trying-only call termination produces no schedule-timer(terminating_timeout)", () => {
    const aLeg = makeLeg("a", "call-1", "tagA")
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog(""))
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, undefined, "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "begin-termination" }], ctx, "test-rule")

    const safetyTimers = result.effects.critical.filter(
      (e) =>
        e.type === "schedule-timer" &&
        (e as { type: "schedule-timer"; timer: { type: string } }).timer.type === "terminating_timeout",
    )
    expect(safetyTimers.length).toBe(0)
  })

  test("emits cancel-all-timers + flush-redis (still mandatory) but no schedule-timer", () => {
    const aDialog = makeALegDialog("alice-tag", "tagA")
    const bDialog = makeDialog("bob-tag")
    const aLeg = { ...makeLeg("a", "call-1", "tagA", aDialog), state: "confirmed" as const }
    const bLeg = { ...makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog), state: "confirmed" as const }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aDialog, "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "begin-termination" }], ctx, "test-rule")

    const types = result.effects.critical.map((e) => e.type)
    expect(types).toContain("cancel-all-timers")
    expect(types).toContain("flush-redis")
    expect(types).not.toContain("schedule-timer")
  })
})
