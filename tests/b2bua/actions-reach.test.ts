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
import { hydrateRequest } from "../../src/sip/parsers/extract-fields.js"
import { diffCall, makeDialog, makeALegDialog, makeLeg, makeCall, makeCtx, make200InviteFromB } from "./helpers/reach.js"

// ── update-leg-state ────────────────────────────────────────────────────────

describe("update-leg-state reach", () => {
  test("flips only the named leg's state + disposition; no other fields touched", () => {
    const aDialog = makeALegDialog("alice-remote-tag", "tagA", 100)
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aDialog = makeALegDialog("", "tagA", 100) // placeholder
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
    // a-leg identity lives on sip.localTag (B2BUA's pinned tag toward Alice).
    expect(outA.dialogs[0]!.sip.localTag).toBe("aFacing-7")
    // Every other dialog field preserved exactly.
    expect(outA.dialogs[0]!.sip.remoteTarget).toBe(aDialog.sip.remoteTarget)
    expect(outA.dialogs[0]!.sip.localCSeq).toBe(aDialog.sip.localCSeq)
    expect(outA.dialogs[0]!.ext.remoteCSeq).toBe(aDialog.ext.remoteCSeq)
    expect(outA.dialogs[0]!.sip.routeSet).toBe(aDialog.sip.routeSet)
    expect(outA.dialogs[0]!.ext.inboundPendingRequests).toBe(aDialog.ext.inboundPendingRequests)

    // Leg-level fields untouched.
    expect(outA.state).toBe(aLeg.state)
    expect(outA.disposition).toBe(aLeg.disposition)
    expect(outA.callId).toBe(aLeg.callId)

    // b-leg and call-level state untouched.
    expect(result.call.bLegs[0]).toEqual(bLeg)
    expect(result.call.tagMap).toBe(call.tagMap)
    expect(result.call.activePeer).toBe(call.activePeer)
  })

  test("creates a fresh dialog[0] when the a-leg has none — seeds remoteCSeq from aLegInvite CSeq", () => {
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
    expect(outA.dialogs[0]!.sip.localTag).toBe("aFacing-42")
    // makeDialogFromIncoming: remoteCSeq preserved from aLegInvite CSeq (42 in fixture).
    expect(outA.dialogs[0]!.ext.remoteCSeq).toBe(42)
  })

  test("creates an empty dialog on a non-a leg when the leg has none", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    // b-leg identity lives on sip.remoteTag (peer's tag).
    expect(outB.dialogs[0]!.sip.remoteTag).toBe("c-facing")
    expect(outB.dialogs[0]!.ext.remoteCSeq).toBeNull() // makeEmptyDialog
  })
})

// ── confirm-dialog ──────────────────────────────────────────────────────────

describe("confirm-dialog reach", () => {
  test("populates dialog[0] from 200 OK response — touches only the named leg", () => {
    const aDialog = makeALegDialog("alice-tag", "tagA", 100)
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
    expect(outB.dialogs[0]!.sip.remoteTag).toBe("bob-tag")
    expect(outB.dialogs[0]!.sip.remoteTarget).toBe("sip:bob@192.168.1.200:5060")
    // RFC 3261 §12.1.2: route set is Record-Route in reverse.
    expect(outB.dialogs[0]!.sip.routeSet).toEqual([
      "<sip:proxy2@10.1.1.2;lr>",
      "<sip:proxy1@10.1.1.1;lr>",
    ])
    // Leg-level state/disposition NOT touched — that belongs to update-leg-state.
    expect(outB.state).toBe(bLeg.state)
    expect(outB.disposition).toBe(bLeg.disposition)

    // a-leg dialog untouched — NO peer-sync in the narrow primitive.
    expect(result.call.aLeg.dialogs[0]).toBe(aDialog)
    expect(result.call.aLeg.dialogs[0]!.sip.localTag).toBe("alice-tag")

    // Call-level state untouched.
    expect(result.call.tagMap).toBe(call.tagMap)
    expect(result.call.activePeer).toBe(call.activePeer)
  })

  test("no-op when the event is not a SIP response (call reference-equal)", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog(""))
    const call = makeCall(aLeg, bLeg)

    const req: SipRequest = hydrateRequest({
      method: "INVITE",
      uri: "sip:b2bua@10.0.0.1:5060",
      headers: [
        { name: "Via", value: "SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-orig" },
        { name: "From", value: "<sip:alice@example.com>;tag=tagA" },
        { name: "To", value: "<sip:bob@example.com>" },
        { name: "Call-ID", value: "call-1" },
        { name: "CSeq", value: "1 INVITE" },
      ],
      body: new Uint8Array(0),
      raw: Buffer.alloc(0),
    })
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
    const bLeg: Leg = { ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag")), state: "confirmed" }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const result = executeActions([{ type: "cancel-leg", legId: "b-1" }], ctx, "test-rule")

    expect(result.call).toBe(call)
    expect(result.outbound.length).toBe(0)
  })

  test("no-op on a terminated leg", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
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
    const aLeg: Leg = { ...makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA")), state: "confirmed" }
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

    // Effects: cancel-all-timers, schedule-timer, flush-redis. CDR is written
    // exactly once when the call reaches "terminated" (InvariantEnforcer
    // injects write-cdr then) — emitting it here too produced a duplicate
    // record per call.
    const effectTypes = result.effects.map((e) => e.type)
    expect(effectTypes).toEqual(["cancel-all-timers", "schedule-timer", "flush-redis"])

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
      ...makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA")),
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

  // Endurance hardening — Slice 1.2 of
  // docs/plan/endurance-stuck-terminating-and-overload-hardening.md.
  // The historical bug: a late `keepalive_timeout` event firing while a
  // call is in `terminating` re-invoked `begin-termination`, which
  // re-issued cancel-all-timers + appended a fresh safety timer 64s
  // further out. As long as a stray timeout fired every 60s, the safety
  // net never expired and the call drifted indefinitely inside
  // `terminating`, only ever cleaned up by the 60-s orphan sweep.
  test("idempotency: re-entering while already 'terminating' with safety timer present is a no-op", () => {
    const aLeg: Leg = { ...makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA")), state: "confirmed" }
    const bLeg: Leg = { ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag")), state: "confirmed" }
    const call = makeCall(aLeg, bLeg)

    const ctx = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const first = executeActions([{ type: "begin-termination" }], ctx, "test-rule")

    // Sanity: first invocation transitioned + scheduled the safety timer.
    expect(first.call.state).toBe("terminating")
    expect(first.call.timers.filter((t) => t.type === "terminating_timeout").length).toBe(1)

    // Re-invoke begin-termination on the already-terminating call — same
    // path the keepalive_timeout loop used to take. Output must be inert:
    // no new outbound, no new effects, no fresh timer.
    const ctx2 = makeCtx(first.call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"), 1_700_000_060_000)
    const second = executeActions([{ type: "begin-termination" }], ctx2, "test-rule")

    expect(second.outbound.length).toBe(0)
    expect(second.effects.length).toBe(0)
    // Safety timer count unchanged (fireAt of the existing entry MUST NOT be pushed out).
    const safetyTimers = second.call.timers.filter((t) => t.type === "terminating_timeout")
    expect(safetyTimers.length).toBe(1)
    expect(safetyTimers[0]!.fireAt).toBe(first.call.timers.find((t) => t.type === "terminating_timeout")!.fireAt)
  })

  // The replace-by-id helper drops any prior entry with the same id
  // before appending. Without it, repeated scheduling of any recurring
  // timer (keepalive, safety, …) would balloon `state.call.timers` and
  // — on rehydration — respawn every stale entry, each of which re-arms
  // the next cycle's timeout.
  test("schedule-timer: re-scheduling the same id replaces (does not append) the persisted entry", () => {
    const aLeg: Leg = { ...makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA")), state: "confirmed" }
    const bLeg: Leg = { ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag")), state: "confirmed" }
    const call = makeCall(aLeg, bLeg)

    const ctx1 = makeCtx(call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"))
    const r1 = executeActions(
      [{ type: "schedule-timer", timerType: "keepalive", delaySec: 30 }],
      ctx1,
      "test-rule",
    )
    expect(r1.call.timers.length).toBe(1)
    const t1 = r1.call.timers[0]!
    expect(t1.type).toBe("keepalive")

    // Reschedule with the same id (same timerType + same callRef + no legId).
    const ctx2 = makeCtx(r1.call, aLeg, aLeg.dialogs[0], "from-a", make200InviteFromB("bob-tag"), 1_700_000_010_000)
    const r2 = executeActions(
      [{ type: "schedule-timer", timerType: "keepalive", delaySec: 30 }],
      ctx2,
      "test-rule",
    )
    expect(r2.call.timers.length).toBe(1)
    expect(r2.call.timers[0]!.id).toBe(t1.id)
    // fireAt advanced — the entry was replaced, not duplicated.
    expect(r2.call.timers[0]!.fireAt).toBeGreaterThan(t1.fireAt)
  })
})

// ── terminate-call (composite — intentional scope) ─────────────────────────

describe("terminate-call reach (composite)", () => {
  test("all legs → terminated, call.state='terminated', activePeer=null; BYE/CANCEL emitted per leg state", () => {
    const aLeg: Leg = { ...makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA")), state: "confirmed" }
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
    const aLeg: Leg = { ...makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA")), state: "terminated" }
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

// ── send-reinvite ───────────────────────────────────────────────────────────
//
// Reach contract: legs.{legId}.dialogs[0].localCSeq (+1). Nothing else on the
// leg, no tagMap touch, no call-level mutation, no activePeer change, and
// exactly one outbound re-INVITE whose body equals the supplied
// `bodyUpdate.value`. The ACK-for-2xx CSeq source (`pendingInviteTxn`) is
// captured by SipRouter.processResult — not touched by the action itself.
describe("send-reinvite reach", () => {
  test("emits one INVITE with the exact body and bumps dialog CSeq; no unrelated state touched", () => {
    const aLeg: Leg = { ...makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA")), state: "confirmed" }
    const bLeg: Leg = {
      ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag", 1000)),
      state: "confirmed",
      disposition: "bridged",
    }
    const call = makeCall(aLeg, bLeg)
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))

    const sdp = new TextEncoder().encode(
      "v=0\r\no=alice 1 1 IN IP4 10.0.0.1\r\ns=-\r\nc=IN IP4 10.0.0.1\r\nt=0 0\r\nm=audio 20000 RTP/AVP 0\r\n",
    )

    const result = executeActions(
      [
        {
          type: "send-reinvite",
          legId: "b-1",
          bodyUpdate: { kind: "set", value: sdp },
        },
      ],
      ctx,
      "test-rule",
    )

    // Exactly one outbound re-INVITE carrying the supplied SDP.
    expect(result.outbound).toHaveLength(1)
    const env = result.outbound[0]!
    expect(env.label).toBe("re-INVITE b-1")
    expect(env.legId).toBe("b-1")
    const msg = env.message
    expect(msg.type).toBe("request")
    const req = msg as SipRequest
    expect(req.method).toBe("INVITE")
    expect(req.body).toEqual(sdp)

    // Content-Length reflects the set body.
    const cl = req.headers.find((h) => h.name.toLowerCase() === "content-length")
    expect(cl?.value).toBe(String(sdp.byteLength))

    // CSeq header is the bumped value (was 1000 → next request is 1001).
    const cseqHdr = req.headers.find((h) => h.name.toLowerCase() === "cseq")
    expect(cseqHdr?.value).toBe("1001 INVITE")

    // Dialog state: localCSeq bumped.
    const outB = result.call.bLegs.find((l) => l.legId === "b-1")!
    const outDialog = outB.dialogs[0]!
    expect(outDialog.sip.localCSeq).toBe(1001)

    // Reach: only the b-1 dialog[0] sip.localCSeq moved.
    const paths = diffCall(call, result.call)
    expect(paths).toEqual(new Set([
      "legs.b-1.dialogs[0].sip.localCSeq",
    ]))
  })

  test("bodyUpdate omitted or drop → empty body, Content-Length: 0", () => {
    const aLeg: Leg = { ...makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA")), state: "confirmed" }
    const bLeg: Leg = {
      ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag", 50)),
      state: "confirmed",
    }
    const call = makeCall(aLeg, bLeg)
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))

    const result = executeActions(
      [{ type: "send-reinvite", legId: "b-1", bodyUpdate: { kind: "drop" } }],
      ctx,
      "test-rule",
    )

    expect(result.outbound).toHaveLength(1)
    const req = result.outbound[0]!.message as SipRequest
    expect(req.body.byteLength).toBe(0)
    const cl = req.headers.find((h) => h.name.toLowerCase() === "content-length")
    expect(cl?.value).toBe("0")
  })

  test("unknown legId → no-op (call unchanged by reference, no outbound)", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag"))
    const call = makeCall(aLeg, bLeg)
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))

    const result = executeActions(
      [{ type: "send-reinvite", legId: "b-does-not-exist" }],
      ctx,
      "test-rule",
    )
    expect(result.call).toBe(call)
    expect(result.outbound).toHaveLength(0)
  })

  test("terminated leg → no-op (no re-INVITE emitted)", () => {
    const aLeg = makeLeg("a", "call-1", "tagA", makeALegDialog("alice-tag", "tagA"))
    const bLeg: Leg = {
      ...makeLeg("b-1", "1-call-1", "tagB2BUA", makeDialog("bob-tag")),
      state: "terminated",
    }
    const call = makeCall(aLeg, bLeg)
    const ctx = makeCtx(call, bLeg, bLeg.dialogs[0], "from-b", make200InviteFromB("bob-tag"))

    const result = executeActions(
      [{
        type: "send-reinvite",
        legId: "b-1",
        bodyUpdate: { kind: "set", value: new TextEncoder().encode("x") },
      }],
      ctx,
      "test-rule",
    )
    expect(result.outbound).toHaveLength(0)
    expect(result.call).toBe(call)
  })
})
