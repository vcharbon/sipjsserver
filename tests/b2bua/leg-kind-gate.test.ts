/**
 * Unadopted-leg gate + send-provisional-to-leg (ADR-0014 / B.2 / B.3).
 *
 * A parked MRF media leg (`kind: "media"`, `adopted: false`) is never an
 * `activePeer`. The generic `relay-to-peer` implicit-"a" fallback must NOT
 * route its events to A; instead the owning rule brokers SDP onto A's INVITE
 * via `send-provisional-to-leg` (an unreliable 183 — RFC 3262).
 *
 * `executeActions` is a pure function, so these run under plain vitest.
 */

import { describe, test, expect } from "vitest"
import { executeActions } from "../../src/b2bua/rules/framework/ActionExecutor.js"
import type { RuleAction, RuleContext } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { Call, Leg, Dialog } from "../../src/call/CallModel.js"
import type { SipRequest, SipResponse, SipHeader, RemoteInfo } from "../../src/sip/types.js"
import { hydrateResponse } from "../../src/sip/parsers/extract-fields.js"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import type { CallDecisionEngine } from "../../src/decision/CallDecisionEngine.js"
import type { CallLimiter } from "../../src/call/CallLimiter.js"

const h = (name: string, value: string): SipHeader => ({ name, value })
const rinfo: RemoteInfo = { address: "10.20.0.9", port: 5090 }
const mrfSdp = new TextEncoder().encode(
  "v=0\r\no=- 7 1 IN IP4 10.20.0.9\r\ns=-\r\nc=IN IP4 10.20.0.9\r\nt=0 0\r\nm=audio 49000 RTP/AVP 0\r\n",
)

function aDialog(): Dialog {
  return {
    sip: {
      callId: "call-1", localTag: "aFacingTag", remoteTag: "tagA",
      localUri: "<sip:b2bua@10.0.0.1>", remoteUri: "<sip:alice@example.com>",
      remoteTarget: "<sip:alice@192.168.1.100:5060>", localCSeq: 100, routeSet: [],
    },
    ext: { remoteCSeq: 1, inboundPendingRequests: [] },
  }
}

function legDialog(remoteTag: string, remoteTarget: string): Dialog {
  return {
    sip: {
      callId: "leg-call", localTag: "b2buaTag", remoteTag,
      localUri: "<sip:b2bua@10.0.0.1>", remoteUri: "<sip:peer@10.20.0.9>",
      remoteTarget, localCSeq: 1000, routeSet: [],
    },
    ext: { remoteCSeq: 1, inboundPendingRequests: [] },
  }
}

const aLeg: Leg = {
  legId: "a", callId: "call-1", fromTag: "tagA",
  source: { address: "192.168.1.100", port: 5060 },
  state: "early", disposition: "bridged", dialogs: [aDialog()],
  kind: "a", adopted: true,
}

const mediaLeg: Leg = {
  legId: "media-1", callId: "leg-call", fromTag: "b2buaTag",
  source: { address: "10.20.0.9", port: 5090 },
  state: "confirmed", disposition: "bridged",
  dialogs: [legDialog("mrfTag", "<sip:mrf@10.20.0.9:5090>")],
  kind: "media", adopted: false,
}

const adoptedBLeg: Leg = {
  ...mediaLeg, legId: "b-1", kind: "destination", adopted: true,
  dialogs: [legDialog("bobTag", "<sip:bob@192.168.1.200:5060>")],
}

function makeCall(extraLeg: Leg): Call {
  return {
    callRef: "call-1|tagA",
    aLeg,
    bLegs: [extraLeg],
    activePeer: null, // nothing peered — early dialog
    aLegInvite: {
      uri: "sip:bob@example.com",
      headers: [
        { name: "Via", value: "SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-orig" },
        { name: "From", value: "<sip:alice@example.com>;tag=tagA" },
        { name: "To", value: "<sip:bob@example.com>" },
        { name: "CSeq", value: "1 INVITE" },
        { name: "Call-ID", value: "call-1" },
      ],
      body: new Uint8Array(),
    },
    tagMap: [],
    limiterEntries: [], timers: [], cdrEvents: [], state: "active", createdAt: 0,
  }
}

function makeCtx(call: Call, sourceLeg: Leg, message: SipRequest | SipResponse): RuleContext {
  return {
    call, callRef: call.callRef,
    event: { type: "sip" as const, message, rinfo },
    sourceLeg, sourceDialog: sourceLeg.dialogs[0], direction: "from-b",
    config: { sipLocalIp: "10.0.0.1", sipLocalPort: 5060, noAnswerTimeoutSec: 60 } as AppConfigData,
    callControl: {} as CallDecisionEngine["Service"],
    limiter: {} as CallLimiter["Service"],
    nowMs: 1779440099000,
  }
}

const mrf200: SipResponse = hydrateResponse({
  status: 200, reason: "OK",
  headers: [
    h("Via", "SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-m1"),
    h("From", "<sip:b2bua@10.0.0.1>;tag=b2buaTag"),
    h("To", "<sip:mrf@10.20.0.9>;tag=mrfTag"),
    h("Call-ID", "leg-call"),
    h("CSeq", "1 INVITE"),
    h("Content-Type", "application/sdp"),
    h("Content-Length", String(mrfSdp.byteLength)),
  ],
  body: mrfSdp,
  raw: Buffer.alloc(0),
})

const getH = (hs: ReadonlyArray<SipHeader>, n: string) =>
  hs.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value

describe("unadopted-leg gate (relay-to-peer)", () => {
  test("relay-to-peer from an unadopted media leg is NOT routed to A", () => {
    const call = makeCall(mediaLeg)
    const ctx = makeCtx(call, mediaLeg, mrf200)
    const result = executeActions([{ type: "relay-to-peer" }], ctx, "media-rule")
    expect(result.effects.outbound.length).toBe(0)
  })

  test("relay-to-peer from an adopted b-leg still falls back to A", () => {
    const call = makeCall(adoptedBLeg)
    const ctx = makeCtx(call, adoptedBLeg, mrf200)
    const result = executeActions([{ type: "relay-to-peer" }], ctx, "relay-rule")
    expect(result.effects.outbound.length).toBe(1)
    expect(result.effects.outbound[0]!.legId).toBe("a")
  })
})

describe("send-provisional-to-leg (unreliable 183 to A)", () => {
  test("emits a 183 onto A's INVITE with the B2BUA-owned tag and MRF SDP", () => {
    const call = makeCall(mediaLeg)
    const ctx = makeCtx(call, mediaLeg, mrf200)
    const actions: RuleAction[] = [
      { type: "send-provisional-to-leg", legId: "a", status: 183, body: mrfSdp, contentType: "application/sdp", reliable: false },
    ]
    const result = executeActions(actions, ctx, "media-rule")
    expect(result.effects.outbound.length).toBe(1)

    const out = result.effects.outbound[0]!
    expect(out.legId).toBe("a")
    // Back to A (the a-leg dialog remote target).
    expect(out.destination.host).toBe("192.168.1.100")
    const msg = out.message
    expect(msg.type).toBe("response")
    if (msg.type !== "response") throw new Error("expected response")
    expect(msg.status).toBe(183)
    // B2BUA-owned early To-tag (consistent early dialog with A).
    expect(getH(msg.headers, "To")).toContain("tag=aFacingTag")
    // Informational SDP answer (RFC 3264).
    expect(msg.body).toEqual(mrfSdp)
    expect(getH(msg.headers, "Content-Type")).toBe("application/sdp")
    // RFC 3262: unreliable — no Require: 100rel, no RSeq.
    expect(getH(msg.headers, "Require")).toBeUndefined()
    expect(getH(msg.headers, "RSeq")).toBeUndefined()
  })

  test("mints + persists a stable early To-tag when the a-leg has no dialog yet", () => {
    // a-leg with no dialog (provisional precedes any 18x relay).
    const aLegNoDialog: Leg = { ...aLeg, dialogs: [] }
    const call: Call = { ...makeCall(mediaLeg), aLeg: aLegNoDialog }
    const ctx = makeCtx(call, mediaLeg, mrf200)
    const action: RuleAction = { type: "send-provisional-to-leg", legId: "a", status: 183, body: mrfSdp, reliable: false }

    const r1 = executeActions([action], ctx, "media-rule")
    const msg1 = r1.effects.outbound[0]!.message
    if (msg1.type !== "response") throw new Error("expected response")
    const to1 = getH(msg1.headers, "To")!
    const tag1 = /tag=([^;]+)/.exec(to1)?.[1]
    expect(tag1).toBeTruthy()
    // The tag is persisted onto the a-leg dialog.
    expect(r1.call.aLeg.dialogs[0]?.sip.localTag).toBe(tag1)

    // A second provisional on the updated call reuses the SAME tag (RFC 3261 §12.1).
    const r2 = executeActions([action], makeCtx(r1.call, mediaLeg, mrf200), "media-rule")
    const msg2 = r2.effects.outbound[0]!.message
    if (msg2.type !== "response") throw new Error("expected response")
    expect(getH(msg2.headers, "To")).toContain(`tag=${tag1}`)
  })

  test("rejects a non-provisional status (no outbound)", () => {
    const call = makeCall(mediaLeg)
    const ctx = makeCtx(call, mediaLeg, mrf200)
    const result = executeActions(
      [{ type: "send-provisional-to-leg", legId: "a", status: 200, reliable: false }],
      ctx, "media-rule",
    )
    expect(result.effects.outbound.length).toBe(0)
  })

  test("declines a non-a leg (no stored UAS INVITE)", () => {
    const call = makeCall(mediaLeg)
    const ctx = makeCtx(call, mediaLeg, mrf200)
    const result = executeActions(
      [{ type: "send-provisional-to-leg", legId: "media-1", status: 183, reliable: false }],
      ctx, "media-rule",
    )
    expect(result.effects.outbound.length).toBe(0)
  })
})
