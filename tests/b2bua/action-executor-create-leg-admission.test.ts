/**
 * Admission gate for rule-driven `create-leg` actions.
 *
 * If a rule routes to a host that fails the suffix allow-list, executeActions
 * must skip the b-leg creation and emit terminate effects instead of letting
 * the bogus host flow to `dgram.send`.
 */

import { describe, expect, test } from "vitest"
import { executeActions } from "../../src/b2bua/rules/framework/ActionExecutor.js"
import type { RuleAction, RuleContext } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { Call, Leg, Dialog } from "../../src/call/CallModel.js"
import type { SipRequest, SipHeader, RemoteInfo } from "../../src/sip/types.js"
import { hydrateRequest } from "../../src/sip/parsers/extract-fields.js"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import type { CallDecisionEngine } from "../../src/decision/CallDecisionEngine.js"
import type { CallLimiter } from "../../src/call/CallLimiter.js"

const h = (name: string, value: string): SipHeader => ({ name, value })
const rinfo: RemoteInfo = { address: "192.168.1.100", port: 5060 }

function makeALegDialog(): Dialog {
  return {
    sip: {
      callId: "call-1",
      localTag: "b2bua-tag",
      remoteTag: "alice-tag",
      localUri: "<sip:b2bua@10.0.0.1>",
      remoteUri: "<sip:alice@example.com>",
      remoteTarget: "<sip:alice@192.168.1.100:5060>",
      localCSeq: 100,
      routeSet: [],
    },
    ext: { remoteCSeq: 1, inboundPendingRequests: [] },
  }
}

function makeLeg(legId: string, dialog: Dialog): Leg {
  return {
    legId,
    callId: dialog.sip.callId,
    fromTag: dialog.sip.remoteTag,
    source: { address: "192.168.1.100", port: 5060 },
    state: "confirmed",
    disposition: "bridged",
    dialogs: [dialog],
  }
}

function makeCall(aLeg: Leg): Call {
  return {
    callRef: `${aLeg.callId}|${aLeg.fromTag}`,
    aLeg,
    bLegs: [],
    activePeer: null,
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
    tagMap: [],
    limiterEntries: [],
    timers: [],
    cdrEvents: [],
    state: "active",
    createdAt: 0,
  }
}

function makeCtx(call: Call, allowedSuffixes: ReadonlyArray<string>): RuleContext {
  const reinvite: SipRequest = hydrateRequest({
    method: "INVITE",
    uri: "sip:bob@example.com",
    headers: call.aLegInvite.headers.map((hh) => ({ name: hh.name, value: hh.value })),
    body: new Uint8Array(),
    raw: Buffer.alloc(0),
  })
  return {
    call,
    callRef: call.callRef,
    event: { type: "sip" as const, message: reinvite, rinfo },
    sourceLeg: call.aLeg,
    sourceDialog: call.aLeg.dialogs[0],
    direction: "from-a",
    config: {
      sipLocalIp: "10.0.0.1",
      sipLocalPort: 5060,
      noAnswerTimeoutSec: 60,
      workerAllowedTargetSuffixes: allowedSuffixes,
    } as AppConfigData,
    callControl: {} as CallDecisionEngine["Service"],
    limiter: {} as CallLimiter["Service"],
    nowMs: 1_700_000_000_000,
  }
}

describe("ActionExecutor create-leg admission gate", () => {
  const aDialog = makeALegDialog()
  const aLeg = makeLeg("a", aDialog)
  const call = makeCall(aLeg)

  test("rule routing to a non-IP non-suffixed host is rejected — no b-leg outbound, terminate effects emitted", () => {
    const ctx = makeCtx(call, [".svc.cluster.local"])
    const actions: RuleAction[] = [
      {
        type: "create-leg",
        destination: { host: "kindlab", port: 5060 },
        fromInvite: "snapshot",
      },
    ]

    const result = executeActions(actions, ctx, "test-rule")

    expect(result.effects.outbound.length).toBe(0)
    // terminate effects include 'remove-call'
    expect(result.effects.critical.some((e) => e.type === "remove-call")).toBe(true)
    // span event reflects the rejection
    expect(result.spanEvents?.some((e) => e.name === "rule_action" && e.attributes?.["rule.outcome"] === "admission_reject")).toBe(true)
  })

  test("rule routing to an IP literal is admitted regardless of suffix list", () => {
    const ctx = makeCtx(call, [".svc.cluster.local"])
    const actions: RuleAction[] = [
      {
        type: "create-leg",
        destination: { host: "10.0.1.5", port: 5060 },
        fromInvite: "snapshot",
      },
    ]

    const result = executeActions(actions, ctx, "test-rule")

    // IP literal admitted: b-leg INVITE outbound emitted, no terminate.
    expect(result.effects.outbound.length).toBeGreaterThan(0)
    expect(result.effects.critical.some((e) => e.type === "remove-call")).toBe(false)
  })

  test("wildcard `*` in allow-list lets any host through", () => {
    const ctx = makeCtx(call, ["*"])
    const actions: RuleAction[] = [
      {
        type: "create-leg",
        destination: { host: "kindlab", port: 5060 },
        fromInvite: "snapshot",
      },
    ]

    const result = executeActions(actions, ctx, "test-rule")

    expect(result.effects.outbound.length).toBeGreaterThan(0)
    expect(result.effects.critical.some((e) => e.type === "remove-call")).toBe(false)
  })
})
