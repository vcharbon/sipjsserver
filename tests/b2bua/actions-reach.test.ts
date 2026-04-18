/**
 * Reach tests for the rule-action ADT primitives and audited composites.
 *
 * Every primitive action is documented with a narrow "reach": the exact
 * state region it is allowed to mutate. Each test exercises one action and
 * asserts:
 *   - the in-reach region changed as specified,
 *   - every out-of-reach region remained strict-equal to the input call.
 *
 * Reach invariants verified here (Slice B + Slice C audit):
 *   update-leg-state      → legs.{legId}.state + .disposition
 *   stamp-dialog-to-tag   → legs.{legId}.dialogs[0].toTag (or a new dialog[0])
 *   confirm-dialog        → legs.{legId}.dialogs[0] (toTag/contact/routeSet/CSeq)
 *   add-tag-mapping       → tagMap (idempotent by (bLegId, bTag))
 *   cancel-leg            → legs.{legId}.disposition
 *   terminate-leg         → legs.{legId}.state + .byeDisposition
 *   merge                 → call.activePeer (both legs named in params)
 *   split                 → call.activePeer (structural un-peer)
 *   destroy-leg           → legs.{legId}.* + call.activePeer (composite)
 *   begin-termination     → all live legs + call.state + call.timers (composite)
 *   terminate-call        → all legs + call.state + call.activePeer (composite)
 */

import { describe, test, expect } from "vitest"
import { executeActions } from "../../src/b2bua/rules/framework/ActionExecutor.js"
import type { RuleAction } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { Call, Leg } from "../../src/call/CallModel.js"
import type { SipRequest } from "../../src/sip/types.js"
import { makeDialog, makeLeg, makeCall, makeCtx, make200InviteFromB } from "./helpers/reach.js"

// ── update-leg-state ────────────────────────────────────────────────────────

describe("update-leg-state reach", () => {
  test("flips only the named leg's state + disposition; no other fields touched", () => {
    const aDialog = makeDialog("alice-remote-tag", 100)
    const bDialog = makeDialog("", 1000) // placeholder dialog on b
    const aLeg = makeLeg("a", "call-1", "tagA", aDialog)
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog)
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, bLeg, bDialog, "from-b", make200InviteFromB("bob-tag"))
    const actions: RuleAction[] = [
      { type: "update-leg-state", legId: "b-1", state: "confirmed", disposition: "bridged" },
    ]

    const result = executeActions(actions, ctx, "test-rule")
    const outB = result.call.bLegs.find((l) => l.legId === "b-1")!

    expect(outB.state).toBe("confirmed")
    expect(outB.disposition).toBe("bridged")

    // Out-of-reach: dialogs on b-leg unchanged (reference equal)
    expect(outB.dialogs).toBe(bLeg.dialogs)
    expect(outB.callId).toBe(bLeg.callId)
    expect(outB.fromTag).toBe(bLeg.fromTag)

    // Out-of-reach: a-leg untouched (structurally equal — legs are replaced
    // immutably but nothing about the a-leg should change)
    expect(result.call.aLeg).toEqual(call.aLeg)

    // Out-of-reach: call-level state untouched
    expect(result.call.tagMap).toBe(call.tagMap)
    expect(result.call.activePeer).toBe(call.activePeer)
    expect(result.call.timers).toBe(call.timers)
    expect(result.call.cdrEvents).toBe(call.cdrEvents)
    expect(result.call.limiterEntries).toBe(call.limiterEntries)
  })

  test("omitting disposition leaves it unchanged", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog(""))
    const call = makeCall(aLeg, bLeg)
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))

    const before = bLeg.disposition
    const result = executeActions(
      [{ type: "update-leg-state", legId: "b-1", state: "early" }],
      ctx,
      "test-rule",
    )
    const outB = result.call.bLegs.find((l) => l.legId === "b-1")!
    expect(outB.state).toBe("early")
    expect(outB.disposition).toBe(before)
  })

  test("unknown legId is a no-op (call unchanged by reference)", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog(""))
    const call = makeCall(aLeg, bLeg)
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))

    const result = executeActions(
      [{ type: "update-leg-state", legId: "b-does-not-exist", state: "confirmed" }],
      ctx,
      "test-rule",
    )
    expect(result.call).toBe(call)
  })
})

// ── stamp-dialog-to-tag ─────────────────────────────────────────────────────

describe("stamp-dialog-to-tag reach", () => {
  test("rewrites only dialog[0].toTag when a dialog already exists", () => {
    const aDialog = makeDialog("", 100) // placeholder
    const bDialog = makeDialog("bob-tag", 1000)
    const aLeg = makeLeg("a", "call-1", "tagA", aDialog)
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog)
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, bLeg, bDialog, "from-b", make200InviteFromB("bob-tag"))
    const result = executeActions(
      [{ type: "stamp-dialog-to-tag", legId: "a", toTag: "aFacing-7" }],
      ctx,
      "test-rule",
    )

    const outA = result.call.aLeg
    expect(outA.dialogs.length).toBe(1)
    expect(outA.dialogs[0]!.toTag).toBe("aFacing-7")
    // Every other dialog field preserved exactly.
    expect(outA.dialogs[0]!.contact).toBe(aDialog.contact)
    expect(outA.dialogs[0]!.localCSeq).toBe(aDialog.localCSeq)
    expect(outA.dialogs[0]!.remoteCSeq).toBe(aDialog.remoteCSeq)
    expect(outA.dialogs[0]!.routeSet).toBe(aDialog.routeSet)
    expect(outA.dialogs[0]!.inboundPendingRequests).toBe(aDialog.inboundPendingRequests)

    // Leg-level fields untouched.
    expect(outA.state).toBe(aLeg.state)
    expect(outA.disposition).toBe(aLeg.disposition)
    expect(outA.callId).toBe(aLeg.callId)

    // b-leg and call-level state untouched.
    expect(result.call.bLegs[0]).toEqual(bLeg)
    expect(result.call.tagMap).toBe(call.tagMap)
    expect(result.call.activePeer).toBe(call.activePeer)
  })

  test("creates a fresh dialog[0] when the a-leg has none — seeds remoteCSeq from aLegInviteCSeq", () => {
    const aLeg = makeLeg("a", "call-1", "tagA") // no dialog
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog(""))
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))
    const result = executeActions(
      [{ type: "stamp-dialog-to-tag", legId: "a", toTag: "aFacing-42" }],
      ctx,
      "test-rule",
    )

    const outA = result.call.aLeg
    expect(outA.dialogs.length).toBe(1)
    expect(outA.dialogs[0]!.toTag).toBe("aFacing-42")
    // makeDialogFromIncoming: remoteCSeq preserved from aLegInviteCSeq.
    expect(outA.dialogs[0]!.remoteCSeq).toBe(call.aLegInviteCSeq)
  })

  test("creates an empty dialog on a non-a leg when the leg has none", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA") // no dialog
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, bLeg, undefined, "from-b", make200InviteFromB("bob-tag"))
    const result = executeActions(
      [{ type: "stamp-dialog-to-tag", legId: "b-1", toTag: "c-facing" }],
      ctx,
      "test-rule",
    )

    const outB = result.call.bLegs.find((l) => l.legId === "b-1")!
    expect(outB.dialogs.length).toBe(1)
    expect(outB.dialogs[0]!.toTag).toBe("c-facing")
    expect(outB.dialogs[0]!.remoteCSeq).toBeNull() // makeEmptyDialog
  })
})

// ── confirm-dialog ──────────────────────────────────────────────────────────

describe("confirm-dialog reach", () => {
  test("populates dialog[0] from 200 OK response — touches only the named leg", () => {
    const aDialog = makeDialog("alice-tag", 100)
    const bDialog = makeDialog("", 1000) // placeholder
    const aLeg = makeLeg("a", "call-1", "tagA", aDialog)
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog)
    const call = makeCall(aLeg, bLeg)

    const resp = make200InviteFromB("bob-tag", [
      "<sip:proxy1@10.1.1.1;lr>",
      "<sip:proxy2@10.1.1.2;lr>",
    ])
    const ctx = makeCtx(call, bLeg, bDialog, "from-b", resp)

    const result = executeActions(
      [{ type: "confirm-dialog", legId: "b-1" }],
      ctx,
      "test-rule",
    )

    const outB = result.call.bLegs.find((l) => l.legId === "b-1")!
    expect(outB.dialogs.length).toBe(1)
    expect(outB.dialogs[0]!.toTag).toBe("bob-tag")
    expect(outB.dialogs[0]!.contact).toBe("sip:bob@192.168.1.200:5060")
    // RFC 3261 §12.1.2: route set is Record-Route in reverse.
    expect(outB.dialogs[0]!.routeSet).toEqual([
      "<sip:proxy2@10.1.1.2;lr>",
      "<sip:proxy1@10.1.1.1;lr>",
    ])
    // lastInviteCSeq captured from the response's CSeq.
    expect(outB.dialogs[0]!.lastInviteCSeq).toBe(1000)

    // Leg-level state/disposition NOT touched — that belongs to update-leg-state.
    expect(outB.state).toBe(bLeg.state)
    expect(outB.disposition).toBe(bLeg.disposition)

    // a-leg dialog untouched — NO peer-sync in the narrow primitive.
    expect(result.call.aLeg.dialogs[0]).toBe(aDialog)
    expect(result.call.aLeg.dialogs[0]!.toTag).toBe("alice-tag")

    // Call-level state untouched.
    expect(result.call.tagMap).toBe(call.tagMap)
    expect(result.call.activePeer).toBe(call.activePeer)
  })

  test("no-op when the event is not a SIP response (call reference-equal)", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog(""))
    const call = makeCall(aLeg, bLeg)

    const req: SipRequest = {
      type: "request",
      method: "INVITE",
      uri: "sip:b2bua@10.0.0.1:5060",
      version: "SIP/2.0",
      headers: [{ name: "Via", value: "SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-orig" }],
      body: new Uint8Array(0),
      raw: Buffer.alloc(0),
    }
    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", req)

    const result = executeActions(
      [{ type: "confirm-dialog", legId: "a" }],
      ctx,
      "test-rule",
    )
    expect(result.call).toBe(call)
  })
})

// ── add-tag-mapping (reach + idempotency) ───────────────────────────────────

describe("add-tag-mapping reach", () => {
  test("appends exactly one mapping; all other call state reference-equal", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog(""))
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))
    const result = executeActions(
      [{ type: "add-tag-mapping", aTag: "aFacing-1", bLegId: "b-1", bTag: "bob-tag" }],
      ctx,
      "test-rule",
    )

    expect(result.call.tagMap).toEqual([{ aTag: "aFacing-1", bLegId: "b-1", bTag: "bob-tag" }])
    // Legs unchanged (reference-equal) — tagMap is a call-level field only.
    expect(result.call.aLeg).toBe(call.aLeg)
    expect(result.call.bLegs).toBe(call.bLegs)
    expect(result.call.activePeer).toBe(call.activePeer)
    expect(result.call.timers).toBe(call.timers)
  })

  test("is idempotent by (bLegId, bTag) — second emit is a no-op", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog(""))
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))
    const result = executeActions(
      [
        { type: "add-tag-mapping", aTag: "aFacing-1", bLegId: "b-1", bTag: "bob-tag" },
        { type: "add-tag-mapping", aTag: "aFacing-2", bLegId: "b-1", bTag: "bob-tag" },
      ],
      ctx,
      "test-rule",
    )

    expect(result.call.tagMap.length).toBe(1)
    expect(result.call.tagMap[0]!.aTag).toBe("aFacing-1") // first-writer wins
  })
})

// ── cancel-leg (primitive) ──────────────────────────────────────────────────

describe("cancel-leg reach", () => {
  test("flips only disposition → 'cancelling' on a trying b-leg; emits one CANCEL", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog(""))
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "cancel-leg", legId: "b-1" }], ctx, "test-rule")
    const outB = result.call.bLegs.find((l) => l.legId === "b-1")!

    // In-reach: only disposition changed.
    expect(outB.disposition).toBe("cancelling")
    // Out-of-reach: state, byeDisposition, dialogs untouched.
    expect(outB.state).toBe(bLeg.state)
    expect(outB.byeDisposition).toBe(bLeg.byeDisposition)
    expect(outB.dialogs).toBe(bLeg.dialogs)

    // Out-of-reach: a-leg unchanged, call-level state unchanged.
    expect(result.call.aLeg).toBe(call.aLeg)
    expect(result.call.activePeer).toBe(call.activePeer)
    expect(result.call.tagMap).toBe(call.tagMap)
    expect(result.call.timers).toBe(call.timers)

    // One outbound CANCEL envelope, no side-effects.
    expect(result.outbound.length).toBe(1)
    expect(result.outbound[0]!.label).toContain("CANCEL b-1")
    expect(result.effects.length).toBe(0)
  })

  test("no-op on a confirmed leg (caller should use destroy-leg)", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg: Leg = { ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag")), state: "confirmed" }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "cancel-leg", legId: "b-1" }], ctx, "test-rule")

    expect(result.call).toBe(call)
    expect(result.outbound.length).toBe(0)
  })

  test("no-op on a terminated leg", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg: Leg = { ...makeLeg("b-1", "1-call-1", "tagB2BUA"), state: "terminated" }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "cancel-leg", legId: "b-1" }], ctx, "test-rule")

    expect(result.call).toBe(call)
    expect(result.outbound.length).toBe(0)
  })
})

// ── terminate-leg (primitive) ───────────────────────────────────────────────

describe("terminate-leg reach", () => {
  test("sets state → 'terminated' only; byeDisposition left unchanged when omitted", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag"))
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "terminate-leg", legId: "b-1" }], ctx, "test-rule")
    const outB = result.call.bLegs.find((l) => l.legId === "b-1")!

    expect(outB.state).toBe("terminated")
    expect(outB.byeDisposition).toBe(bLeg.byeDisposition) // unchanged (undefined)
    expect(outB.disposition).toBe(bLeg.disposition)
    expect(outB.dialogs).toBe(bLeg.dialogs)

    expect(result.call.aLeg).toBe(call.aLeg)
    expect(result.call.activePeer).toBe(call.activePeer) // peer NOT cleared — terminate-leg is narrow
    expect(result.call.state).toBe(call.state)
    expect(result.call.timers).toBe(call.timers)
    expect(result.outbound.length).toBe(0)
    expect(result.effects.length).toBe(0)
  })

  test("sets state + byeDisposition when both are named", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag"))
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions(
      [{ type: "terminate-leg", legId: "b-1", byeDisposition: "bye_received" }],
      ctx,
      "test-rule",
    )
    const outB = result.call.bLegs.find((l) => l.legId === "b-1")!
    expect(outB.state).toBe("terminated")
    expect(outB.byeDisposition).toBe("bye_received")

    expect(result.call.activePeer).toBe(call.activePeer)
    expect(result.outbound.length).toBe(0)
  })
})

// ── merge (primitive) ───────────────────────────────────────────────────────

describe("merge reach", () => {
  test("sets call.activePeer = { legA, legB }; no leg-level mutation", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag"))
    // Start with activePeer = null to observe the merge.
    const call: Call = { ...makeCall(aLeg, bLeg), activePeer: null }

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions(
      [{ type: "merge", legA: "a", legB: "b-1" }],
      ctx,
      "test-rule",
    )

    expect(result.call.activePeer).toEqual({ legA: "a", legB: "b-1" })
    // Out-of-reach: every leg, every leg field, every other call-level field
    // is strict-equal to the input.
    expect(result.call.aLeg).toBe(call.aLeg)
    expect(result.call.bLegs).toBe(call.bLegs)
    expect(result.call.tagMap).toBe(call.tagMap)
    expect(result.call.timers).toBe(call.timers)
    expect(result.call.state).toBe(call.state)

    expect(result.outbound.length).toBe(0)
    expect(result.effects.length).toBe(0)
  })
})

// ── split (primitive) ───────────────────────────────────────────────────────

describe("split reach", () => {
  test("clears call.activePeer when the named leg is part of the pair", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag"))
    const call = makeCall(aLeg, bLeg) // activePeer = { legA: "a", legB: "b-1" }

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "split", legId: "b-1" }], ctx, "test-rule")

    expect(result.call.activePeer).toBeNull()
    // Out-of-reach: no leg state touched.
    expect(result.call.aLeg).toBe(call.aLeg)
    expect(result.call.bLegs).toBe(call.bLegs)
    expect(result.call.tagMap).toBe(call.tagMap)
    expect(result.call.timers).toBe(call.timers)

    expect(result.outbound.length).toBe(0)
    expect(result.effects.length).toBe(0)
  })

  test("no-op when splitting a leg that isn't part of the current pair", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag"))
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "split", legId: "b-999" }], ctx, "test-rule")

    expect(result.call).toBe(call)
  })
})

// ── destroy-leg (composite — intentional scope) ─────────────────────────────

describe("destroy-leg reach (composite)", () => {
  test("confirmed branch: BYE outbound + byeDisposition='bye_sent' + state='terminated' + peer cleared", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg: Leg = {
      ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag")),
      state: "confirmed",
    }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "destroy-leg", legId: "b-1" }], ctx, "test-rule")
    const outB = result.call.bLegs.find((l) => l.legId === "b-1")!

    expect(outB.state).toBe("terminated")
    expect(outB.byeDisposition).toBe("bye_sent")
    expect(outB.disposition).toBe(bLeg.disposition) // not touched on confirmed path
    // Peer split because b-1 was part of the pair.
    expect(result.call.activePeer).toBeNull()

    // Out-of-reach: a-leg unchanged, no call-level state-field update, no timers.
    expect(result.call.aLeg).toBe(call.aLeg)
    expect(result.call.state).toBe(call.state)
    expect(result.call.timers).toBe(call.timers)
    expect(result.call.tagMap).toBe(call.tagMap)

    // Exactly one BYE outbound, no side-effects.
    expect(result.outbound.length).toBe(1)
    expect(result.outbound[0]!.label).toBe("BYE b-1")
    expect(result.effects.length).toBe(0)
  })

  test("cancelling branch: no outbound + byeDisposition='cancelled' + state='terminated'", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg: Leg = {
      ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("")),
      state: "early",
      disposition: "cancelling", // cancel-leg already fired a CANCEL
    }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "destroy-leg", legId: "b-1" }], ctx, "test-rule")
    const outB = result.call.bLegs.find((l) => l.legId === "b-1")!

    expect(outB.state).toBe("terminated")
    expect(outB.byeDisposition).toBe("cancelled")
    // disposition NOT rewritten on this branch (already "cancelling").
    expect(outB.disposition).toBe("cancelling")
    expect(result.call.activePeer).toBeNull()

    // No SIP emitted — CANCEL is already in flight from the earlier cancel-leg.
    expect(result.outbound.length).toBe(0)
  })

  test("trying/early branch: CANCEL outbound + disposition='cancelling' + byeDisposition='cancelled' + state='terminated'", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("")) // state:"trying" by default
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "destroy-leg", legId: "b-1" }], ctx, "test-rule")
    const outB = result.call.bLegs.find((l) => l.legId === "b-1")!

    expect(outB.state).toBe("terminated")
    expect(outB.byeDisposition).toBe("cancelled")
    expect(outB.disposition).toBe("cancelling")
    expect(result.call.activePeer).toBeNull()

    expect(result.outbound.length).toBe(1)
    expect(result.outbound[0]!.label).toContain("CANCEL b-1")
  })

  test("already-terminated leg is a strict no-op (call reference-equal)", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeDialog("alice-tag"))
    const bLeg: Leg = { ...makeLeg("b-1", "1-call-1", "tagB2BUA"), state: "terminated" }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "destroy-leg", legId: "b-1" }], ctx, "test-rule")

    expect(result.call).toBe(call)
    expect(result.outbound.length).toBe(0)
  })
})

// ── begin-termination (composite — intentional scope) ──────────────────────

describe("begin-termination reach (composite)", () => {
  test("confirmed a-leg + confirmed b-leg: BYEs to both, call.state='terminating', activePeer preserved", () => {
    const aLeg: Leg = { ...makeLeg("a", "call-1", "tagA", makeDialog("alice-tag")), state: "confirmed" }
    const bLeg: Leg = { ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag")), state: "confirmed" }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "begin-termination" }], ctx, "test-rule")

    const outA = result.call.aLeg
    const outB = result.call.bLegs[0]!
    expect(outA.byeDisposition).toBe("bye_sent")
    expect(outB.byeDisposition).toBe("bye_sent")
    // state on legs stays 'confirmed' — they become 'terminated' only when BYE 200 comes back.
    expect(outA.state).toBe("confirmed")
    expect(outB.state).toBe("confirmed")

    // call.state transitions to "terminating".
    expect(result.call.state).toBe("terminating")
    // activePeer deliberately preserved so the final BYE 200 relay still routes.
    expect(result.call.activePeer).toEqual(call.activePeer)

    // Safety timer appended to call.timers.
    expect(result.call.timers.length).toBe(call.timers.length + 1)
    const safety = result.call.timers[result.call.timers.length - 1]!
    expect(safety.type).toBe("terminating_timeout")

    // Effects: cancel-all-timers, schedule-timer, write-cdr, flush-redis.
    const effectTypes = result.effects.map((e) => e.type)
    expect(effectTypes).toEqual(["cancel-all-timers", "schedule-timer", "write-cdr", "flush-redis"])

    // Two BYE envelopes.
    const labels = result.outbound.map((o) => o.label)
    expect(labels).toContain("BYE a (begin-termination)")
    expect(labels).toContain("BYE b-1 (begin-termination)")
  })

  test("trying b-leg: CANCEL sent + byeDisposition='cancelled' + state='terminated'; a-leg not yet set → stays active but gets no SIP", () => {
    // a-leg is in "trying" (pre-200) → no SIP emitted, byeDisposition='none'
    const aLeg = makeLeg("a", "call-1", "tagA") // trying, no dialog
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("")) // trying
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, undefined, "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "begin-termination" }], ctx, "test-rule")

    const outA = result.call.aLeg
    const outB = result.call.bLegs[0]!
    // a-leg trying → byeDisposition='none', no outbound
    expect(outA.byeDisposition).toBe("none")
    expect(outA.state).toBe("trying") // not auto-terminated

    // b-leg trying → CANCEL + byeDisposition='cancelled' + state='terminated'
    expect(outB.byeDisposition).toBe("cancelled")
    expect(outB.state).toBe("terminated")

    const labels = result.outbound.map((o) => o.label)
    expect(labels).toContain("CANCEL b-1 (begin-termination)")
    expect(labels).not.toContain("BYE a (begin-termination)")
  })

  test("skips legs already handled (byeDisposition set or disposition='cancelling')", () => {
    const aLeg: Leg = {
      ...makeLeg("a", "call-1", "tagA", makeDialog("alice-tag")),
      state: "confirmed",
      byeDisposition: "bye_received", // already handled by the rule
    }
    const bLeg: Leg = {
      ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("")),
      disposition: "cancelling", // cancel-leg fired; must NOT re-BYE
    }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "begin-termination" }], ctx, "test-rule")

    // Neither leg gets a fresh SIP message from begin-termination.
    expect(result.outbound.length).toBe(0)

    // byeDisposition of already-marked legs preserved.
    const outA = result.call.aLeg
    const outB = result.call.bLegs[0]!
    expect(outA.byeDisposition).toBe("bye_received")
    expect(outB.byeDisposition).toBe(bLeg.byeDisposition)
    expect(outB.disposition).toBe("cancelling")

    // Call still transitions to "terminating".
    expect(result.call.state).toBe("terminating")
  })
})

// ── terminate-call (composite — intentional scope) ─────────────────────────

describe("terminate-call reach (composite)", () => {
  test("all legs → terminated, call.state='terminated', activePeer=null; BYE/CANCEL emitted per leg state", () => {
    const aLeg: Leg = { ...makeLeg("a", "call-1", "tagA", makeDialog("alice-tag")), state: "confirmed" }
    const bLeg: Leg = { ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("")), state: "trying" }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "terminate-call" }], ctx, "test-rule")

    expect(result.call.state).toBe("terminated")
    expect(result.call.activePeer).toBeNull()
    expect(result.call.aLeg.state).toBe("terminated")
    expect(result.call.bLegs[0]!.state).toBe("terminated")

    const labels = result.outbound.map((o) => o.label)
    // Confirmed a-leg → BYE.
    expect(labels).toContain("BYE a (terminate)")
    // Trying b-leg → CANCEL.
    expect(labels.some((l) => l.startsWith("CANCEL b-1"))).toBe(true)
  })

  test("already-terminated leg skipped (no BYE/CANCEL re-emission)", () => {
    const aLeg: Leg = { ...makeLeg("a", "call-1", "tagA", makeDialog("alice-tag")), state: "terminated" }
    const bLeg: Leg = { ...makeLeg("b-1", "1-call-1", "tagB2BUA"), state: "terminated" }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "terminate-call" }], ctx, "test-rule")

    expect(result.outbound.length).toBe(0)
    expect(result.call.state).toBe("terminated")
    expect(result.call.activePeer).toBeNull()
  })

  test("trying a-leg: no CANCEL emitted (a-leg is the UAS side); still marked terminated", () => {
    const aLeg = makeLeg("a", "call-1", "tagA") // trying, no dialog
    const bLeg: Leg = { ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag")), state: "confirmed" }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, undefined, "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "terminate-call" }], ctx, "test-rule")

    const labels = result.outbound.map((o) => o.label)
    // Only the b-leg BYE is emitted; the a-leg in "trying" is not CANCELed
    // (executeTerminateCall only CANCELs non-a trying/early legs).
    expect(labels.some((l) => l.startsWith("CANCEL"))).toBe(false)
    expect(labels).toContain("BYE b-1 (terminate)")

    expect(result.call.aLeg.state).toBe("terminated")
    expect(result.call.bLegs[0]!.state).toBe("terminated")
    expect(result.call.state).toBe("terminated")
    expect(result.call.activePeer).toBeNull()
  })
})
