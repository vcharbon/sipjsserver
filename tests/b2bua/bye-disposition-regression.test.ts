/**
 * Regression tests for the BYE-disposition leak class.
 *
 * Slice 3 fix: when a leg is in `byeDisposition: "bye_sent"` and a 200 OK
 * to BYE arrives — even while `call.state === "active"` (e.g. a single-leg
 * `destroy-leg` was emitted without `begin-termination`) — the matcher
 * picks `resolveByeResponseRule` over `absorbBye200Rule` and the leg
 * transitions to `bye_confirmed`. Before the fix the absorb rule won by
 * specificity in active state and the leg stayed `bye_sent` forever.
 *
 * Slice 4 invariant: even if a custom rule absorbs a BYE-resolution event
 * without emitting `terminate-leg`, the framework force-corrects the
 * disposition and increments the violation counter.
 */

import { describe, test, expect, beforeEach } from "vitest"
import { Effect } from "effect"
import { createRuleRegistry } from "../../src/b2bua/rules/framework/RuleRegistry.js"
import { executeRules } from "../../src/b2bua/rules/framework/RuleExecutor.js"
import {
  getByeDispositionInvariantViolationCount,
  resetByeDispositionInvariantViolationCount,
} from "../../src/b2bua/rules/framework/ByeDispositionInvariant.js"
import { defaultRules } from "../../src/b2bua/rules/defaults/index.js"
import type { AnyRuleDefinition } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { Call, Leg, Dialog } from "../../src/call/CallModel.js"
import type { ResolvedContext, HandlerResult } from "../../src/sip/SipRouter.js"
import { emptyEffects } from "../../src/sip/SipRouter.js"
import type { SipResponse, SipHeader, RemoteInfo } from "../../src/sip/types.js"
import { hydrateResponse } from "../../src/sip/parsers/extract-fields.js"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import type { CallDecisionEngine } from "../../src/decision/CallDecisionEngine.js"
import type { CallLimiter } from "../../src/call/CallLimiter.js"

const h = (name: string, value: string): SipHeader => ({ name, value })
const rinfo: RemoteInfo = { address: "192.168.1.100", port: 5060 }

function makeDialog(localTag: string, remoteTag: string, callId: string): Dialog {
  return {
    sip: {
      callId,
      localTag,
      remoteTag,
      localUri: "<sip:b2bua@10.0.0.1>",
      remoteUri: "<sip:peer@example.com>",
      remoteTarget: "<sip:peer@192.168.1.100:5060>",
      localCSeq: 100,
      routeSet: [],
    },
    ext: {
      remoteCSeq: 1,
      inboundPendingRequests: [],
    },
  }
}

function makeBye200Response(legId: "a" | "b-1"): SipResponse {
  return hydrateResponse({
    status: 200,
    reason: "OK",
    headers: [
      h("Via", `SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-bye-${legId};lg=${legId}`),
      h("From", "<sip:b2bua@10.0.0.1>;tag=tagB2BUA"),
      h("To", "<sip:peer@example.com>;tag=peer-tag"),
      h("Call-ID", legId === "a" ? "call-1" : "1-call-1"),
      h("CSeq", "101 BYE"),
      h("Content-Length", "0"),
    ],
    body: new Uint8Array(),
    raw: Buffer.alloc(0),
  })
}

function makeActiveCallWithByeSentOnB(): Call {
  // a-leg confirmed, b-leg confirmed but with byeDisposition: "bye_sent"
  // (the state a single-leg `destroy-leg` would leave the call in: BYE
  // sent on b-1, call.state stays "active" because no `begin-termination`).
  const aDialog = makeDialog("tagB2BUAa", "alice-tag", "call-1")
  const bDialog = makeDialog("tagB2BUAb", "bob-tag", "1-call-1")
  const aLeg: Leg = {
    legId: "a",
    callId: "call-1",
    fromTag: "alice-tag",
    source: { address: "192.168.1.100", port: 5060 },
    state: "confirmed",
    disposition: "bridged",
    dialogs: [aDialog],
  }
  const bLeg: Leg = {
    legId: "b-1",
    callId: "1-call-1",
    fromTag: "tagB2BUAb",
    source: { address: "192.168.1.100", port: 5060 },
    state: "confirmed",
    disposition: "bridged",
    byeDisposition: "bye_sent",
    dialogs: [bDialog],
  }
  return {
    callRef: "call-1|alice-tag",
    aLeg,
    bLegs: [bLeg],
    activePeer: { legA: "a", legB: "b-1" },
    aLegInvite: {
      uri: "sip:bob@example.com",
      headers: [],
      body: new Uint8Array(),
    },
    tagMap: [{ aTag: "tagB2BUAa", bLegId: "b-1", bTag: "tagB2BUAb" }],
    limiterEntries: [],
    timers: [],
    cdrEvents: [],
    state: "active",
    createdAt: 0,
  }
}

function makeCtx(call: Call, legId: "a" | "b-1"): ResolvedContext {
  const message = makeBye200Response(legId)
  const sourceLeg = legId === "a" ? call.aLeg : call.bLegs[0]!
  return {
    call,
    callRef: call.callRef,
    leg: sourceLeg,
    dialog: sourceLeg.dialogs[0],
    direction: legId === "a" ? "from-a" : "from-b",
    event: { type: "sip", message, rinfo },
    config: { sipLocalIp: "10.0.0.1", sipLocalPort: 5060, noAnswerTimeoutSec: 60 } as AppConfigData,
    callControl: {} as CallDecisionEngine["Service"],
    limiter: {} as CallLimiter["Service"],
    nowMs: 1_700_000_000_000,
  }
}

const noopFallback = (ctx: ResolvedContext) =>
  Effect.succeed<HandlerResult>({
    call: ctx.call,
    effects: emptyEffects,
  })

describe("BYE-disposition regression — Slice 3 rule fix", () => {
  test("active-state BYE/200 on bye_sent leg → bye_confirmed via resolveByeResponseRule", async () => {
    const registry = createRuleRegistry(defaultRules)
    const handler = executeRules(registry, noopFallback)
    const call = makeActiveCallWithByeSentOnB()
    expect(call.state).toBe("active") // pre-condition: still active, not terminating
    expect(call.bLegs[0]!.byeDisposition).toBe("bye_sent")

    const result = await Effect.runPromise(handler(makeCtx(call, "b-1")))

    // Slice 3 fix: resolveByeResponseRule wins (specificity 4 vs 3) because
    // the source leg is in bye_sent. Without the fix, absorbBye200 would win
    // in active state and the disposition would stay bye_sent.
    expect(result.call.bLegs[0]!.byeDisposition).toBe("bye_confirmed")
    // Rule attribution span event names which rule fired.
    const ruleAttribution = result.spanEvents?.find((e) => e.name === "rule_handled")
    expect(ruleAttribution?.attributes?.["rule.id"]).toBe("resolve-bye-response")
  })
})

describe("BYE-disposition regression — Slice 4 framework invariant", () => {
  beforeEach(() => {
    resetByeDispositionInvariantViolationCount()
  })

  test("a misbehaving rule that absorbs BYE/200 without terminate-leg → framework force-corrects + counter increments", async () => {
    // Synthetic rule that wins over both absorbBye200Rule (score 3) and
    // resolveByeResponseRule (score 4) by adding a filter (+1 = score 5)
    // and emits no terminate-leg — exactly the bug class the invariant
    // exists to catch.
    const misbehavingRule: AnyRuleDefinition = {
      id: "test-misbehaving-bye-absorber",
      name: "Test misbehaving BYE absorber",
      alwaysActive: true,
      match: {
        kind: "response",
        cseqMethod: "BYE",
        statusClass: "2xx",
        filter: () => true,
      },
      handle: () => Effect.succeed({ actions: [] }),
    }

    const registry = createRuleRegistry([misbehavingRule])
    const handler = executeRules(registry, noopFallback)
    const call = makeActiveCallWithByeSentOnB()
    const before = getByeDispositionInvariantViolationCount()

    const result = await Effect.runPromise(handler(makeCtx(call, "b-1")))

    // The misbehaving rule won — but the framework invariant force-set the
    // disposition to bye_confirmed and bumped the violation counter.
    expect(result.call.bLegs[0]!.byeDisposition).toBe("bye_confirmed")
    expect(getByeDispositionInvariantViolationCount()).toBe(before + 1)
  })

  test("counter does NOT increment on healthy resolve-bye-response path", async () => {
    const registry = createRuleRegistry(defaultRules)
    const handler = executeRules(registry, noopFallback)
    const call = makeActiveCallWithByeSentOnB()
    const before = getByeDispositionInvariantViolationCount()

    const result = await Effect.runPromise(handler(makeCtx(call, "b-1")))

    expect(result.call.bLegs[0]!.byeDisposition).toBe("bye_confirmed")
    // Healthy path: the rule itself emitted terminate-leg, so the invariant
    // observed a clean transition and did NOT trip.
    expect(getByeDispositionInvariantViolationCount()).toBe(before)
  })
})
