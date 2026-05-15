/**
 * ActionExecutor Content-Length tests — verifies that body transforms
 * and send-request-to-leg correctly update Content-Length.
 *
 * Uses plain vitest since executeActions is a pure function.
 */

import { describe, test, expect } from "vitest"
import { executeActions } from "../../src/b2bua/rules/framework/ActionExecutor.js"
import type { RuleAction, RuleContext } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { Call, Leg, Dialog } from "../../src/call/CallModel.js"
import type { SipRequest, SipResponse, SipHeader, RemoteInfo } from "../../src/sip/types.js"
import { hydrateRequest, hydrateResponse } from "../../src/sip/parsers/extract-fields.js"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import type { CallDecisionEngine } from "../../src/decision/CallDecisionEngine.js"
import type { CallLimiter } from "../../src/call/CallLimiter.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

const h = (name: string, value: string): SipHeader => ({ name, value })
const emptyBody = new Uint8Array(0)
const sdpBody = new TextEncoder().encode("v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n")
const newSdpBody = new TextEncoder().encode("v=0\r\no=- 1 1 IN IP4 10.0.0.1\r\ns=replaced\r\n")

function getHeaderValue(headers: ReadonlyArray<SipHeader>, name: string): string | undefined {
  return headers.find((hdr) => hdr.name.toLowerCase() === name.toLowerCase())?.value
}

const rinfo: RemoteInfo = { address: "192.168.1.100", port: 5060 }

function makeDialog(toTag: string, localCSeq = 1000): Dialog {
  return {
    sip: {
      callId: "1-call-1",
      localTag: "tagB2BUA",
      remoteTag: toTag,
      localUri: "<sip:b2bua@10.0.0.1>",
      remoteUri: "<sip:bob@example.com>",
      remoteTarget: "<sip:peer@192.168.1.200:5060>",
      localCSeq,
      routeSet: [],
    },
    ext: {
      remoteCSeq: 1,
      inboundPendingRequests: [],
    },
  }
}

function makeALegDialog(toTag: string, fromTag: string, localCSeq = 1000): Dialog {
  return {
    sip: {
      callId: "call-1",
      localTag: toTag,
      remoteTag: fromTag,
      localUri: "<sip:b2bua@10.0.0.1>",
      remoteUri: "<sip:alice@example.com>",
      remoteTarget: "<sip:alice@192.168.1.100:5060>",
      localCSeq,
      routeSet: [],
    },
    ext: {
      remoteCSeq: 1,
      inboundPendingRequests: [],
    },
  }
}

function makeLeg(legId: string, callId: string, fromTag: string, dialog?: Dialog): Leg {
  return {
    legId,
    callId,
    fromTag,
    source: { address: "192.168.1.200", port: 5060 },
    state: "confirmed",
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
    aLegInvite: {
      uri: "sip:bob@example.com",
      headers: [
        { name: "Via", value: "SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-orig" },
        { name: "From", value: `<sip:alice@example.com>;tag=${aLeg.fromTag}` },
        { name: "To", value: "<sip:bob@example.com>" },
        { name: "CSeq", value: "1 INVITE" },
        { name: "Call-ID", value: aLeg.callId },
      ],
      body: new Uint8Array(),
    },
    tagMap: [{ aTag: "aFacing123", bLegId: bLeg.legId, bTag: bLeg.dialogs[0]?.sip.remoteTag ?? "" }],
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
    callControl: {} as CallDecisionEngine["Service"],
    limiter: {} as CallLimiter["Service"],
    nowMs: Date.now(),
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ActionExecutor Content-Length correctness", () => {
  describe("request relay body transforms", () => {
    // Setup: a-leg sends re-INVITE to b-leg, transform replaces body
    const aDialog = makeALegDialog("alice-remote-tag", "tagA", 100)
    const bDialog = makeDialog("bob-remote-tag", 1000)
    const aLeg = makeLeg("a", "call-1", "tagA", aDialog)
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog)
    const call = makeCall(aLeg, bLeg)

    const reinvite: SipRequest = hydrateRequest({
      method: "INVITE",
      uri: "sip:b2bua@10.0.0.1:5060",
      headers: [
        h("Via", "SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-reinv"),
        h("From", `<sip:alice@example.com>;tag=${aLeg.fromTag}`),
        h("To", `<sip:bob@example.com>;tag=alice-remote-tag`),
        h("Call-ID", "call-1"),
        h("CSeq", "2 INVITE"),
        h("Contact", "<sip:alice@192.168.1.100:5060>"),
        h("Content-Type", "application/sdp"),
        h("Content-Length", String(sdpBody.byteLength)),
      ],
      body: sdpBody,
      raw: Buffer.alloc(0),
    })

    test("body replacement updates Content-Length", () => {
      const ctx = makeCtx(call, aLeg, aDialog, "from-a", reinvite)
      const actions: RuleAction[] = [
        { type: "relay-to-leg", legId: "b-1", transform: { bodyUpdate: { kind: "set", value: newSdpBody } } },
      ]

      const result = executeActions(actions, ctx, "test-rule")
      expect(result.effects.outbound.length).toBe(1)

      const out = result.effects.outbound[0]!.message
      expect(out.body).toEqual(newSdpBody)
      expect(getHeaderValue(out.headers, "Content-Length")).toBe(String(newSdpBody.byteLength))
    })

    test("bodyUpdate drop sets Content-Length to 0", () => {
      const ctx = makeCtx(call, aLeg, aDialog, "from-a", reinvite)
      const actions: RuleAction[] = [
        { type: "relay-to-leg", legId: "b-1", transform: { bodyUpdate: { kind: "drop" } } },
      ]

      const result = executeActions(actions, ctx, "test-rule")
      expect(result.effects.outbound.length).toBe(1)

      const out = result.effects.outbound[0]!.message
      expect(out.body.byteLength).toBe(0)
      expect(getHeaderValue(out.headers, "Content-Length")).toBe("0")
    })
  })

  describe("response relay body transforms", () => {
    // Setup: b-leg sends 183 with SDP to a-leg, transform strips body
    const aDialog = makeALegDialog("alice-remote-tag", "tagA", 100)
    const bDialog = makeDialog("bob-remote-tag", 1000)
    const aLeg = makeLeg("a", "call-1", "tagA", aDialog)
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog)
    const call = makeCall(aLeg, bLeg)

    const resp183: SipResponse = hydrateResponse({
      status: 183,
      reason: "Session Progress",
      headers: [
        h("Via", "SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-b1"),
        h("From", `<sip:bob@example.com>;tag=tagB2BUA`),
        h("To", `<sip:alice@example.com>;tag=bob-remote-tag`),
        h("Call-ID", "1-call-1"),
        h("CSeq", "1000 INVITE"),
        h("Contact", "<sip:bob@192.168.1.200:5060>"),
        h("Content-Type", "application/sdp"),
        h("Content-Length", String(sdpBody.byteLength)),
      ],
      body: sdpBody,
      raw: Buffer.alloc(0),
    })

    test("bodyUpdate drop on response sets Content-Length to 0", () => {
      const ctx = makeCtx(call, bLeg, bDialog, "from-b", resp183)
      const actions: RuleAction[] = [
        { type: "relay-to-leg", legId: "a", transform: { status: 180, reason: "Ringing", bodyUpdate: { kind: "drop" } } },
      ]

      const result = executeActions(actions, ctx, "test-rule")
      expect(result.effects.outbound.length).toBe(1)

      const out = result.effects.outbound[0]!.message
      expect(out.body.byteLength).toBe(0)
      expect(getHeaderValue(out.headers, "Content-Length")).toBe("0")
    })

    test("body replacement on response updates Content-Length", () => {
      const ctx = makeCtx(call, bLeg, bDialog, "from-b", resp183)
      const actions: RuleAction[] = [
        { type: "relay-to-leg", legId: "a", transform: { bodyUpdate: { kind: "set", value: newSdpBody } } },
      ]

      const result = executeActions(actions, ctx, "test-rule")
      expect(result.effects.outbound.length).toBe(1)

      const out = result.effects.outbound[0]!.message
      expect(out.body).toEqual(newSdpBody)
      expect(getHeaderValue(out.headers, "Content-Length")).toBe(String(newSdpBody.byteLength))
    })
  })

  describe("send-request-to-leg body", () => {
    const aDialog = makeALegDialog("alice-remote-tag", "tagA", 100)
    const bDialog = makeDialog("bob-remote-tag", 1000)
    const aLeg = makeLeg("a", "call-1", "tagA", aDialog)
    const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog)
    const call = makeCall(aLeg, bLeg)

    // Event doesn't matter much for send-request-to-leg — it generates its own request
    const dummyReq: SipRequest = hydrateRequest({
      method: "OPTIONS",
      uri: "sip:b2bua@10.0.0.1:5060",
      headers: [
        h("Via", "SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-opt"),
        h("From", `<sip:alice@example.com>;tag=${aLeg.fromTag}`),
        h("To", `<sip:bob@example.com>;tag=alice-remote-tag`),
        h("Call-ID", "call-1"),
        h("CSeq", "1 OPTIONS"),
        h("Content-Length", "0"),
      ],
      body: emptyBody,
      raw: Buffer.alloc(0),
    })

    test("send-request-to-leg with body updates Content-Length from 0", () => {
      const ctx = makeCtx(call, aLeg, aDialog, "from-a", dummyReq)
      const infoBody = new TextEncoder().encode('{"action":"hold"}')
      const actions: RuleAction[] = [
        { type: "send-request-to-leg", legId: "b-1", method: "INFO", body: infoBody },
      ]

      const result = executeActions(actions, ctx, "test-rule")
      expect(result.effects.outbound.length).toBe(1)

      const out = result.effects.outbound[0]!.message
      expect(out.body).toEqual(infoBody)
      expect(getHeaderValue(out.headers, "Content-Length")).toBe(String(infoBody.byteLength))
    })

    test("send-request-to-leg without body keeps Content-Length: 0", () => {
      const ctx = makeCtx(call, aLeg, aDialog, "from-a", dummyReq)
      const actions: RuleAction[] = [
        { type: "send-request-to-leg", legId: "b-1", method: "OPTIONS" },
      ]

      const result = executeActions(actions, ctx, "test-rule")
      expect(result.effects.outbound.length).toBe(1)

      const out = result.effects.outbound[0]!.message
      expect(out.body.byteLength).toBe(0)
      expect(getHeaderValue(out.headers, "Content-Length")).toBe("0")
    })
  })
})
