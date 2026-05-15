/**
 * ActionExecutor b-leg outbound-proxy invariant — verifies that every
 * B2BUA→Bob in-dialog request traverses the configured `b2bOutboundProxy`
 * even when the dialog routeSet is empty (e.g. upstream proxy did not
 * Record-Route the b-leg INVITE).
 *
 * The bug this guards against: in the k8s endurance run, the b-leg
 * dialog's routeSet was empty (because `B2B_OUTBOUND_PROXY` was unset
 * in helm and no proxy preloaded a Route on the b-leg INVITE). 15 min
 * later the keepalive OPTIONS went pod-direct, never reached sipp, and
 * `keepaliveTimeoutRule` tore the call down. The fix in
 * `applyEgressRouting` forces the request through `b2bOutboundProxy`
 * when configured, even with an empty routeSet, and logs an error.
 */

import { describe, test, expect } from "vitest"
import { executeActions } from "../../src/b2bua/rules/framework/ActionExecutor.js"
import type { RuleAction, RuleContext } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { Call, Leg, Dialog } from "../../src/call/CallModel.js"
import type { SipRequest, SipHeader, RemoteInfo } from "../../src/sip/types.js"
import { hydrateRequest } from "../../src/sip/parsers/extract-fields.js"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import type { CallDecisionEngine } from "../../src/decision/CallDecisionEngine.js"
import type { CallLimiter } from "../../src/call/CallLimiter.js"

const h = (name: string, value: string): SipHeader => ({ name, value })
const emptyBody = new Uint8Array(0)

const PROXY_HOST = "10.10.0.1"
const PROXY_PORT = 15060

const rinfo: RemoteInfo = { address: "192.168.1.100", port: 5060 }

function getHeaderValue(headers: ReadonlyArray<SipHeader>, name: string): string | undefined {
  return headers.find((hdr) => hdr.name.toLowerCase() === name.toLowerCase())?.value
}

function getAllHeaders(headers: ReadonlyArray<SipHeader>, name: string): ReadonlyArray<SipHeader> {
  return headers.filter((hdr) => hdr.name.toLowerCase() === name.toLowerCase())
}

function makeBLegDialog(routeSet: ReadonlyArray<string> = []): Dialog {
  return {
    sip: {
      callId: "1-call-1",
      localTag: "tagB2BUA",
      remoteTag: "bob-remote-tag",
      localUri: "<sip:b2bua@10.0.0.1>",
      remoteUri: "<sip:bob@example.com>",
      remoteTarget: "<sip:bob@192.168.1.200:5060>",
      localCSeq: 1000,
      routeSet,
    },
    ext: {
      remoteCSeq: 1,
      inboundPendingRequests: [],
    },
  }
}

function makeALegDialog(routeSet: ReadonlyArray<string> = []): Dialog {
  return {
    sip: {
      callId: "call-1",
      localTag: "tagAFacing",
      remoteTag: "tagA",
      localUri: "<sip:b2bua@10.0.0.1>",
      remoteUri: "<sip:alice@example.com>",
      remoteTarget: "<sip:alice@192.168.1.100:5060>",
      localCSeq: 100,
      routeSet,
    },
    ext: {
      remoteCSeq: 1,
      inboundPendingRequests: [],
    },
  }
}

function makeLeg(legId: string, callId: string, fromTag: string, dialog: Dialog): Leg {
  return {
    legId,
    callId,
    fromTag,
    source: { address: "192.168.1.200", port: 5060 },
    state: "confirmed",
    disposition: "bridged",
    dialogs: [dialog],
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
        h("Via", "SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-orig"),
        h("From", `<sip:alice@example.com>;tag=${aLeg.fromTag}`),
        h("To", "<sip:bob@example.com>"),
        h("CSeq", "1 INVITE"),
        h("Call-ID", aLeg.callId),
      ],
      body: new Uint8Array(),
    },
    tagMap: [{ aTag: aLeg.dialogs[0]!.sip.localTag, bLegId: bLeg.legId, bTag: bLeg.dialogs[0]!.sip.remoteTag }],
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
  sourceDialog: Dialog,
  outboundProxy?: { host: string; port: number },
): RuleContext {
  const dummyReq: SipRequest = hydrateRequest({
    method: "OPTIONS",
    uri: "sip:b2bua@10.0.0.1:5060",
    headers: [
      h("Via", "SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-opt"),
      h("From", "<sip:alice@example.com>;tag=tagA"),
      h("To", "<sip:bob@example.com>"),
      h("Call-ID", "call-1"),
      h("CSeq", "1 OPTIONS"),
      h("Content-Length", "0"),
    ],
    body: emptyBody,
    raw: Buffer.alloc(0),
  })
  const config: Partial<AppConfigData> = {
    sipLocalIp: "10.0.0.1",
    sipLocalPort: 5060,
    noAnswerTimeoutSec: 60,
    ...(outboundProxy !== undefined ? { b2bOutboundProxy: outboundProxy } : {}),
  }
  return {
    call,
    callRef: call.callRef,
    event: { type: "sip" as const, message: dummyReq, rinfo },
    sourceLeg,
    sourceDialog,
    direction: "from-a" as const,
    config: config as AppConfigData,
    callControl: {} as CallDecisionEngine["Service"],
    limiter: {} as CallLimiter["Service"],
    nowMs: Date.now(),
  }
}

describe("ActionExecutor b-leg outbound-proxy invariant", () => {
  describe("send-request-to-leg on b-leg with empty routeSet", () => {
    const aDialog = makeALegDialog([])
    const aLeg = makeLeg("a", "call-1", "tagA", aDialog)

    test("with b2bOutboundProxy set: forces wire dest to proxy + adds Route header", () => {
      const bDialog = makeBLegDialog([])
      const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog)
      const call = makeCall(aLeg, bLeg)
      const ctx = makeCtx(call, aLeg, aDialog, { host: PROXY_HOST, port: PROXY_PORT })

      const actions: RuleAction[] = [
        { type: "send-request-to-leg", legId: "b-1", method: "OPTIONS" },
      ]
      const result = executeActions(actions, ctx, "test-rule")

      expect(result.effects.outbound.length).toBe(1)
      const env = result.effects.outbound[0]!
      expect(env.destination).toEqual({ host: PROXY_HOST, port: PROXY_PORT })
      const routes = getAllHeaders(env.message.headers, "Route")
      expect(routes.length).toBe(1)
      expect(routes[0]!.value).toContain(`${PROXY_HOST}:${PROXY_PORT}`)
      expect(routes[0]!.value).toContain(";lr")
      // `;outbound` is the proxy's primary worker-outbound signal —
      // without it, the proxy's source-IP fallback may loop the
      // request back to a worker. Mirror the initial-INVITE preload
      // shape from helpers.ts.
      expect(routes[0]!.value).toContain(";outbound")
    })

    test("WITHOUT b2bOutboundProxy: goes pod-direct (operator-misconfig path)", () => {
      const bDialog = makeBLegDialog([])
      const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog)
      const call = makeCall(aLeg, bLeg)
      const ctx = makeCtx(call, aLeg, aDialog, undefined)

      const actions: RuleAction[] = [
        { type: "send-request-to-leg", legId: "b-1", method: "OPTIONS" },
      ]
      const result = executeActions(actions, ctx, "test-rule")

      expect(result.effects.outbound.length).toBe(1)
      const env = result.effects.outbound[0]!
      // Pod-direct: destination is the leg's remoteTarget, no Route added.
      expect(env.destination).toEqual({ host: "192.168.1.200", port: 5060 })
      const routes = getAllHeaders(env.message.headers, "Route")
      expect(routes.length).toBe(0)
    })
  })

  describe("send-request-to-leg on b-leg with non-empty routeSet", () => {
    const aDialog = makeALegDialog([])
    const aLeg = makeLeg("a", "call-1", "tagA", aDialog)

    test("dialog routeSet wins over b2bOutboundProxy fallback (RFC 3261 §12.2.1.1)", () => {
      const dialogRouteHost = "203.0.113.5"
      const dialogRoutePort = 5070
      const bDialog = makeBLegDialog([`<sip:${dialogRouteHost}:${dialogRoutePort};lr>`])
      const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog)
      const call = makeCall(aLeg, bLeg)
      const ctx = makeCtx(call, aLeg, aDialog, { host: PROXY_HOST, port: PROXY_PORT })

      const actions: RuleAction[] = [
        { type: "send-request-to-leg", legId: "b-1", method: "OPTIONS" },
      ]
      const result = executeActions(actions, ctx, "test-rule")

      expect(result.effects.outbound.length).toBe(1)
      const env = result.effects.outbound[0]!
      // dialog routeSet wins — destination is the routeSet's loose-route URI,
      // NOT b2bOutboundProxy.
      expect(env.destination).toEqual({ host: dialogRouteHost, port: dialogRoutePort })
      const routes = getAllHeaders(env.message.headers, "Route")
      expect(routes.length).toBe(1)
      expect(routes[0]!.value).toContain(`${dialogRouteHost}:${dialogRoutePort}`)
      // Importantly: NOT the configured proxy.
      expect(routes[0]!.value).not.toContain(`${PROXY_HOST}:${PROXY_PORT}`)
      // routeSet doesn't lead through b2bOutboundProxy → no `;outbound`
      // added (we only add it when egressing through the configured
      // proxy).
      expect(routes[0]!.value).not.toContain(";outbound")
    })

    test("E.2: routeSet's top route IS b2bOutboundProxy → append `;outbound`", () => {
      // Simulates the post-INVITE state in `proxy+b2b` deployments: the
      // proxy Record-Routed the b-leg INVITE so the b-leg dialog's
      // routeSet is `[<sip:proxy:port;lr;sticky=...>]`. The cookie
      // identifies the source worker for the proxy's stickiness path.
      const stickiness = "tgt=10.0.0.1.5061"
      const bDialog = makeBLegDialog([`<sip:${PROXY_HOST}:${PROXY_PORT};lr;${stickiness}>`])
      const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog)
      const call = makeCall(aLeg, bLeg)
      const ctx = makeCtx(call, aLeg, aDialog, { host: PROXY_HOST, port: PROXY_PORT })

      const actions: RuleAction[] = [
        { type: "send-request-to-leg", legId: "b-1", method: "OPTIONS" },
      ]
      const result = executeActions(actions, ctx, "test-rule")

      expect(result.effects.outbound.length).toBe(1)
      const env = result.effects.outbound[0]!
      expect(env.destination).toEqual({ host: PROXY_HOST, port: PROXY_PORT })
      const routes = getAllHeaders(env.message.headers, "Route")
      expect(routes.length).toBe(1)
      // Original stickiness cookie preserved (proxy may use it on the
      // bob-inbound direction).
      expect(routes[0]!.value).toContain(stickiness)
      // The egress mutation adds `;outbound` so the proxy's primary
      // classifier fires immediately and source-IP lookup is not on
      // the critical path.
      expect(routes[0]!.value).toContain(";outbound")
    })

    test("E.2: idempotent — `;outbound` not double-appended if routeSet already has it", () => {
      const bDialog = makeBLegDialog([`<sip:${PROXY_HOST}:${PROXY_PORT};lr;outbound>`])
      const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog)
      const call = makeCall(aLeg, bLeg)
      const ctx = makeCtx(call, aLeg, aDialog, { host: PROXY_HOST, port: PROXY_PORT })

      const actions: RuleAction[] = [
        { type: "send-request-to-leg", legId: "b-1", method: "OPTIONS" },
      ]
      const result = executeActions(actions, ctx, "test-rule")

      expect(result.effects.outbound.length).toBe(1)
      const routes = getAllHeaders(result.effects.outbound[0]!.message.headers, "Route")
      // Exactly one `;outbound` occurrence.
      const occurrences = routes[0]!.value.match(/;outbound(?:[;>]|$)/g) ?? []
      expect(occurrences.length).toBe(1)
    })
  })

  describe("send-request-to-leg on a-leg with empty routeSet", () => {
    test("a-leg with empty routeSet + b2bOutboundProxy set: still pod-direct", () => {
      // a-leg's routing is dictated by the inbound-INVITE Record-Route, NOT
      // by the worker's b2bOutboundProxy (which is a b-leg-only concept).
      const aDialog = makeALegDialog([])
      const aLeg = makeLeg("a", "call-1", "tagA", aDialog)
      const bDialog = makeBLegDialog([`<sip:${PROXY_HOST}:${PROXY_PORT};lr>`])
      const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUA", bDialog)
      const call = makeCall(aLeg, bLeg)
      const ctx = makeCtx(call, aLeg, aDialog, { host: PROXY_HOST, port: PROXY_PORT })

      const actions: RuleAction[] = [
        { type: "send-request-to-leg", legId: "a", method: "OPTIONS" },
      ]
      const result = executeActions(actions, ctx, "test-rule")

      expect(result.effects.outbound.length).toBe(1)
      const env = result.effects.outbound[0]!
      // a-leg goes pod-direct to alice — no proxy fallback for a-leg.
      expect(env.destination).toEqual({ host: "192.168.1.100", port: 5060 })
      const routes = getAllHeaders(env.message.headers, "Route")
      expect(routes.length).toBe(0)
    })
  })
})

// Reference helper to assert no missing imports
void getHeaderValue
