/**
 * Slice D — per-primitive reach-invariant tests.
 *
 * Each test exercises exactly one primitive action and asserts:
 *
 *   diffCall(before, after) === Set(<paths the action names in its params>)
 *
 * Any extra path in the diff is a reach violation. Composite actions
 * (destroy-leg, begin-termination, terminate-call) are covered by
 * branch-level tests in `actions-reach.test.ts` — their wider reach is
 * intentional and documented on the action contract.
 *
 * See `helpers/reach.ts` for the `diffCall` + `runActions` shared helpers
 * and the fixture builders.
 */

import { describe, test, expect } from "vitest"
import type { RuleAction } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { Call, Leg } from "../../src/call/CallModel.js"
import {
  diffCall,
  runActions,
  makeDialog,
  makeLeg,
  makeCall,
  makeCtx,
  make200InviteFromB,
} from "./helpers/reach.js"

// ── Shared "bridged" baseline ─────────────────────────────────────────────

function bridged(): {
  call: Call
  aLeg: Leg
  bLeg: Leg
} {
  const aDialog = makeDialog("alice-tag", 100)
  const bDialog = makeDialog("bob-tag", 1000)
  const aLeg: Leg = {
    ...makeLeg("a", "call-1", "tagA", aDialog),
    state: "confirmed",
  }
  const bLeg: Leg = {
    ...makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog),
    state: "confirmed",
  }
  const call = makeCall(aLeg, bLeg)
  return { call, aLeg, bLeg }
}

// ── update-leg-state ───────────────────────────────────────────────────────

describe("update-leg-state reach-diff", () => {
  test("names legs.{legId}.state only when disposition is omitted", () => {
    const { call, bLeg } = bridged()
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))
    const actions: RuleAction[] = [
      { type: "update-leg-state", legId: "b-1", state: "terminated" },
    ]
    const { after } = runActions(actions, ctx)
    expect(diffCall(call, after)).toEqual(new Set(["legs.b-1.state"]))
  })

  test("names legs.{legId}.state AND legs.{legId}.disposition when both are set", () => {
    const { call, bLeg } = bridged()
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))
    const actions: RuleAction[] = [
      { type: "update-leg-state", legId: "b-1", state: "terminated", disposition: "rejected" },
    ]
    const { after } = runActions(actions, ctx)
    expect(diffCall(call, after)).toEqual(
      new Set(["legs.b-1.state", "legs.b-1.disposition"]),
    )
  })
})

// ── stamp-dialog-to-tag ────────────────────────────────────────────────────

describe("stamp-dialog-to-tag reach-diff", () => {
  test("names legs.{legId}.dialogs[0].toTag only, when the dialog already exists", () => {
    const { call, bLeg } = bridged()
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))
    const actions: RuleAction[] = [
      { type: "stamp-dialog-to-tag", legId: "a", toTag: "alice-new-tag" },
    ]
    const { after } = runActions(actions, ctx)
    expect(diffCall(call, after)).toEqual(new Set(["legs.a.dialogs[0].toTag"]))
  })
})

// ── confirm-dialog ─────────────────────────────────────────────────────────

describe("confirm-dialog reach-diff", () => {
  test("names only the target leg's dialogs[0] fields — no leg-level or call-level state", () => {
    // Baseline with an empty placeholder dialog on b-1, so the action populates
    // contact/toTag/localCSeq/lastInviteCSeq/routeSet in dialog[0].
    const aDialog = makeDialog("alice-tag", 100)
    const bPlaceholder = makeDialog("", 1000)
    const aLeg = makeLeg("a", "call-1", "tagA", aDialog)
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bPlaceholder)
    const call = makeCall(aLeg, bLeg)
    const resp = make200InviteFromB("bob-tag", ["<sip:proxy@10.1.1.1;lr>"])
    const ctx = makeCtx(call, bLeg, bPlaceholder, "from-b", resp)

    const { after } = runActions([{ type: "confirm-dialog", legId: "b-1" }], ctx)
    const diff = diffCall(call, after)

    // Every changed path must be under legs.b-1.dialogs[0]. The action names
    // "dialogs[0] on the named leg" — field-level paths inside that dialog
    // are allowed.
    for (const path of diff) {
      expect(path.startsWith("legs.b-1.dialogs[0].")).toBe(true)
    }
    // The observable changes: toTag, contact, routeSet, localCSeq, lastInviteCSeq.
    expect(diff.has("legs.b-1.dialogs[0].toTag")).toBe(true)
    expect(diff.has("legs.b-1.dialogs[0].contact")).toBe(true)
    expect(diff.has("legs.b-1.dialogs[0].routeSet")).toBe(true)
  })
})

// ── add-tag-mapping ────────────────────────────────────────────────────────

describe("add-tag-mapping reach-diff", () => {
  test("names tagMap only", () => {
    const { call, bLeg } = bridged()
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))
    const { after } = runActions(
      [{ type: "add-tag-mapping", aTag: "aFacing-1", bLegId: "b-1", bTag: "bob-tag" }],
      ctx,
    )
    expect(diffCall(call, after)).toEqual(new Set(["tagMap"]))
  })
})

// ── cancel-leg ─────────────────────────────────────────────────────────────

describe("cancel-leg reach-diff", () => {
  test("names legs.{legId}.disposition only on a trying b-leg", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("")) // trying
    const call = makeCall(aLeg, bLeg)
    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const { after } = runActions([{ type: "cancel-leg", legId: "b-1" }], ctx)
    expect(diffCall(call, after)).toEqual(new Set(["legs.b-1.disposition"]))
  })
})

// ── terminate-leg ──────────────────────────────────────────────────────────

describe("terminate-leg reach-diff", () => {
  test("names legs.{legId}.state only when byeDisposition is omitted", () => {
    const { call, bLeg } = bridged()
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))
    const { after } = runActions([{ type: "terminate-leg", legId: "b-1" }], ctx)
    expect(diffCall(call, after)).toEqual(new Set(["legs.b-1.state"]))
  })

  test("names legs.{legId}.state AND legs.{legId}.byeDisposition when both are set", () => {
    const { call, bLeg } = bridged()
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))
    const { after } = runActions(
      [{ type: "terminate-leg", legId: "b-1", byeDisposition: "bye_received" }],
      ctx,
    )
    expect(diffCall(call, after)).toEqual(
      new Set(["legs.b-1.state", "legs.b-1.byeDisposition"]),
    )
  })
})

// ── merge ──────────────────────────────────────────────────────────────────

describe("merge reach-diff", () => {
  test("names activePeer only", () => {
    const { aLeg, bLeg } = bridged()
    // Start unpeered so merge produces a real diff.
    const call: Call = { ...makeCall(aLeg, bLeg), activePeer: null }
    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const { after } = runActions([{ type: "merge", legA: "a", legB: "b-1" }], ctx)
    expect(diffCall(call, after)).toEqual(new Set(["activePeer"]))
  })
})

// ── split ──────────────────────────────────────────────────────────────────

describe("split reach-diff", () => {
  test("names activePeer only when the leg is part of the current pair", () => {
    const { call, bLeg } = bridged()
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))
    const { after } = runActions([{ type: "split", legId: "b-1" }], ctx)
    expect(diffCall(call, after)).toEqual(new Set(["activePeer"]))
  })

  test("empty diff (no-op) when splitting an unrelated leg", () => {
    const { call, bLeg } = bridged()
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))
    const { after } = runActions([{ type: "split", legId: "b-does-not-exist" }], ctx)
    expect(diffCall(call, after)).toEqual(new Set())
  })
})

// ── schedule-timer / cancel-timer / cancel-all-timers ──────────────────────

describe("schedule-timer reach-diff", () => {
  test("names timers only", () => {
    const { call, aLeg } = bridged()
    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const { after } = runActions(
      [{ type: "schedule-timer", timerType: "global_duration", delaySec: 60 }],
      ctx,
    )
    expect(diffCall(call, after)).toEqual(new Set(["timers"]))
  })
})

describe("cancel-timer reach-diff", () => {
  test("names timers only (removes a matching entry)", () => {
    const { aLeg, bLeg } = bridged()
    const call: Call = {
      ...makeCall(aLeg, bLeg),
      timers: [
        { id: "no_answer-call-1", type: "no_answer", fireAt: 1000 },
      ],
    }
    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const { after } = runActions(
      [{ type: "cancel-timer", timerId: "no_answer-call-1" }],
      ctx,
    )
    expect(diffCall(call, after)).toEqual(new Set(["timers"]))
  })
})

describe("cancel-all-timers reach-diff", () => {
  test("names timers only", () => {
    const { aLeg, bLeg } = bridged()
    const call: Call = {
      ...makeCall(aLeg, bLeg),
      timers: [
        { id: "no_answer-call-1", type: "no_answer", fireAt: 1000 },
        { id: "global_duration-call-1", type: "global_duration", fireAt: 2000 },
      ],
    }
    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const { after } = runActions([{ type: "cancel-all-timers" }], ctx)
    expect(diffCall(call, after)).toEqual(new Set(["timers"]))
  })
})

// ── add-cdr-event ──────────────────────────────────────────────────────────

describe("add-cdr-event reach-diff", () => {
  test("names cdrEvents only", () => {
    const { call, aLeg } = bridged()
    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const { after } = runActions(
      [{ type: "add-cdr-event", eventType: "answered", legId: "b-1", statusCode: 200 }],
      ctx,
    )
    expect(diffCall(call, after)).toEqual(new Set(["cdrEvents"]))
  })
})

// ── deactivate-rule ────────────────────────────────────────────────────────

describe("deactivate-rule reach-diff", () => {
  test("names activeRules only", () => {
    const { aLeg, bLeg } = bridged()
    const call: Call = {
      ...makeCall(aLeg, bLeg),
      activeRules: [{ id: "test-rule", active: true }],
    }
    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const { after } = runActions([{ type: "deactivate-rule" }], ctx, "test-rule")
    expect(diffCall(call, after)).toEqual(new Set(["activeRules"]))
  })
})

// ── clear-transfer ─────────────────────────────────────────────────────────

describe("clear-transfer reach-diff", () => {
  test("names transfer only", () => {
    const { aLeg, bLeg } = bridged()
    const call: Call = {
      ...makeCall(aLeg, bLeg),
      transfer: {
        phase: "authorized",
        referrerLegId: "a",
        referToUri: "sip:charlie@example.com",
        startedAtMs: 0,
      },
    }
    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const { after } = runActions([{ type: "clear-transfer" }], ctx)
    expect(diffCall(call, after)).toEqual(new Set(["transfer"]))
  })
})
