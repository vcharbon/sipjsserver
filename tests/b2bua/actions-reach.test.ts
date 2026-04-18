/**
 * Reach tests for the Slice-B dialog-confirm primitives.
 *
 * Every primitive in the rule-action ADT is documented with a narrow "reach":
 * the exact state region it is allowed to mutate. Each test below exercises
 * one primitive and asserts:
 *   - the in-reach region changed as specified,
 *   - every out-of-reach region remained strict-equal to the input call.
 *
 * Reach invariants verified here:
 *   update-leg-state      → legs.{legId}.state + .disposition
 *   stamp-dialog-to-tag   → legs.{legId}.dialogs[0].toTag (or a new dialog[0])
 *   confirm-dialog        → legs.{legId}.dialogs[0] (toTag/contact/routeSet/CSeq)
 *   add-tag-mapping       → tagMap (idempotent by (bLegId, bTag))
 */

import { describe, test, expect } from "vitest"
import { executeActions } from "../../src/b2bua/rules/framework/ActionExecutor.js"
import type { RuleAction, RuleContext } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { Call, Leg, Dialog } from "../../src/call/CallModel.js"
import type { SipRequest, SipResponse, SipHeader, RemoteInfo } from "../../src/sip/types.js"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import type { CallControlClient } from "../../src/http/CallControlClient.js"
import type { CallLimiter } from "../../src/call/CallLimiter.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

const h = (name: string, value: string): SipHeader => ({ name, value })
const rinfo: RemoteInfo = { address: "192.168.1.100", port: 5060 }

function makeDialog(toTag: string, localCSeq = 1000): Dialog {
  return {
    toTag,
    contact: "<sip:peer@192.168.1.200:5060>",
    localCSeq,
    remoteCSeq: 1,
    inboundPendingRequests: [],
    routeSet: [],
  }
}

function makeLeg(legId: string, callId: string, fromTag: string, dialog?: Dialog): Leg {
  return {
    legId,
    callId,
    fromTag,
    source: { address: "192.168.1.200", port: 5060 },
    state: "trying",
    disposition: "bridged",
    dialogs: dialog ? [dialog] : [],
  }
}

function makeCall(aLeg: Leg, bLeg: Leg): Call {
  return {
    callRef: `${aLeg.callId}|${aLeg.fromTag}`,
    aLeg,
    bLegs: [bLeg],
    activePeer: { legA: "a", legB: bLeg.legId },
    aLegVias: ["SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-orig"],
    aLegFrom: `<sip:alice@example.com>;tag=${aLeg.fromTag}`,
    aLegTo: "<sip:bob@example.com>",
    aLegInviteCSeq: 42,
    tagMap: [],
    limiterEntries: [],
    timers: [],
    cdrEvents: [],
    state: "active",
    createdAt: 0,
  }
}

function makeCtx(
  call: Call,
  sourceLeg: Leg,
  sourceDialog: Dialog | undefined,
  direction: "from-a" | "from-b",
  message: SipRequest | SipResponse,
): RuleContext {
  return {
    call,
    callRef: call.callRef,
    event: { type: "sip" as const, message, rinfo },
    sourceLeg,
    sourceDialog,
    direction,
    config: { sipLocalIp: "10.0.0.1", sipLocalPort: 5060, noAnswerTimeoutSec: 60 } as AppConfigData,
    callControl: {} as CallControlClient["Service"],
    limiter: {} as CallLimiter["Service"],
    nowMs: Date.now(),
  }
}

// Build a 200 OK INVITE response from the b-leg. Rules that call
// confirm-dialog emit the action in response to exactly this event shape.
function make200InviteFromB(toTag: string, recordRoutes: ReadonlyArray<string> = []): SipResponse {
  const rrHeaders: ReadonlyArray<SipHeader> = recordRoutes.map((v) => h("Record-Route", v))
  return {
    type: "response",
    version: "SIP/2.0",
    status: 200,
    reason: "OK",
    headers: [
      h("Via", "SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-b1"),
      h("From", `<sip:bob@example.com>;tag=tagB2BUA`),
      h("To", `<sip:alice@example.com>;tag=${toTag}`),
      h("Call-ID", "1-call-1"),
      h("CSeq", "1000 INVITE"),
      h("Contact", "<sip:bob@192.168.1.200:5060>"),
      h("Content-Length", "0"),
      ...rrHeaders,
    ],
    body: new Uint8Array(0),
    raw: Buffer.alloc(0),
    parsed: {
      to: { displayName: undefined, uri: "sip:alice@example.com", tag: toTag, params: {} },
      from: undefined, callId: undefined, cseq: undefined, via: undefined, vias: [],
      contact: { displayName: undefined, uri: "sip:bob@192.168.1.200:5060", params: {} },
      requestUri: undefined,
    },
  }
}

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
      headers: [h("Via", "SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-orig")],
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
