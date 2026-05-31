/**
 * Auto-flush unit tests for `RuleExecutor`.
 *
 * The framework appends `flush-redis` to any rule whose actions mutate the
 * call (reference inequality with the pre-rule call) and that didn't already
 * emit one. This is the persistence-correctness backbone for the failover
 * matrix: without it, in-dialog mutations silently fail to replicate.
 */

import { describe, test, expect } from "vitest"
import { Effect } from "effect"
import { createRuleRegistry } from "../../src/b2bua/rules/framework/RuleRegistry.js"
import { executeRules } from "../../src/b2bua/rules/framework/RuleExecutor.js"
import type { AnyRuleDefinition } from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type { Call, Leg, Dialog } from "../../src/call/CallModel.js"
import type { ResolvedContext, HandlerResult } from "../../src/sip/SipRouter.js"
import { emptyEffects } from "../../src/sip/SipRouter.js"
import type { SipRequest, SipHeader, RemoteInfo } from "../../src/sip/types.js"
import { hydrateRequest } from "../../src/sip/parsers/extract-fields.js"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import type { CallDecisionEngine } from "../../src/decision/CallDecisionEngine.js"
import type { CallLimiter } from "../../src/call/CallLimiter.js"

// ── Fixture helpers ───────────────────────────────────────────────────────

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

function makeLeg(legId: string, callId: string, fromTag: string, dialog: Dialog): Leg {
  return {
    legId,
    callId,
    fromTag,
    source: { address: "192.168.1.100", port: 5060 },
    state: "confirmed",
    disposition: "bridged",
    dialogs: [dialog],
  }
}

function makeCall(): Call {
  const aDialog = makeDialog("tagB2BUAa", "alice-tag", "call-1")
  const bDialog = makeDialog("tagB2BUAb", "bob-tag", "1-call-1")
  const aLeg = makeLeg("a", "call-1", "alice-tag", aDialog)
  const bLeg = makeLeg("b-1", "1-call-1", "tagB2BUAb", bDialog)
  return {
    callRef: "call-1|alice-tag",
    aLeg,
    bLegs: [bLeg],
    activePeer: { legA: "a", legB: "b-1" },
    aLegInvite: {
      uri: "sip:bob@example.com",
      headers: [
        h("Via", "SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-orig"),
        h("From", "<sip:alice@example.com>;tag=alice-tag"),
        h("To", "<sip:bob@example.com>"),
        h("CSeq", "1 INVITE"),
        h("Call-ID", "call-1"),
      ],
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

function makeInfoRequest(): SipRequest {
  return hydrateRequest({
    method: "INFO",
    uri: "sip:b2bua@10.0.0.1:5060",
    headers: [
      h("Via", "SIP/2.0/UDP 192.168.1.100:5060;branch=z9hG4bK-info"),
      h("From", "<sip:alice@example.com>;tag=alice-tag"),
      h("To", "<sip:bob@example.com>;tag=tagB2BUAa"),
      h("Call-ID", "call-1"),
      h("CSeq", "2 INFO"),
      h("Contact", "<sip:alice@192.168.1.100:5060>"),
      h("Content-Length", "0"),
    ],
    body: new Uint8Array(),
    raw: Buffer.alloc(0),
  })
}

function makeCtx(call: Call): ResolvedContext {
  const message = makeInfoRequest()
  return {
    call,
    callRef: call.callRef,
    leg: call.aLeg,
    dialog: call.aLeg.dialogs[0],
    direction: "from-a",
    event: { type: "sip", message, rinfo },
    config: { sipLocalIp: "10.0.0.1", sipLocalPort: 5060, noAnswerTimeoutSec: 60 } as AppConfigData,
    callControl: {} as CallDecisionEngine["Service"],
    limiter: {} as CallLimiter["Service"],
    nowMs: 1_700_000_000_000,
  }
}

// ── Synthetic rule factories ──────────────────────────────────────────────

/** Rule that mutates the source leg's state (state-change → auto-flush). */
function mutatingRule(id: string): AnyRuleDefinition {
  return {
    id,
    name: id,
    alwaysActive: true,
    match: { kind: "request", method: "INFO" },
    handle: (ctx) =>
      Effect.succeed({
        actions: [
          { type: "update-leg-state" as const, legId: ctx.sourceLeg.legId, state: "confirmed" as const, disposition: "bridged" as const },
        ],
      }),
  }
}

/** Rule whose action set produces a flush effect (begin-termination → flush-redis). */
function manualFlushRule(id: string): AnyRuleDefinition {
  return {
    id,
    name: id,
    alwaysActive: true,
    match: { kind: "request", method: "INFO" },
    handle: () =>
      Effect.succeed({
        actions: [
          { type: "begin-termination" as const },
        ],
      }),
  }
}

/** Rule that handles the event with no actions and no state change. */
function inertRule(id: string): AnyRuleDefinition {
  return {
    id,
    name: id,
    alwaysActive: true,
    match: { kind: "request", method: "INFO" },
    handle: () =>
      Effect.succeed({
        actions: [],
      }),
  }
}

const noopFallback = (_ctx: ResolvedContext) =>
  Effect.succeed<HandlerResult>({
    call: _ctx.call,
    effects: emptyEffects,
  })

function countFlush(result: HandlerResult): number {
  return result.effects.critical.filter((e) => e.type === "flush-redis").length
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("RuleExecutor auto-flush", () => {
  test("adds flush-redis when a rule mutates state without emitting one", async () => {
    const registry = createRuleRegistry([mutatingRule("test-mutating")])
    const handler = executeRules(registry, noopFallback)
    const result = await Effect.runPromise(handler(makeCtx(makeCall())))
    expect(countFlush(result)).toBe(1)
  })

  test("does not duplicate flush-redis when a rule already emits one", async () => {
    const registry = createRuleRegistry([manualFlushRule("test-manual")])
    const handler = executeRules(registry, noopFallback)
    const result = await Effect.runPromise(handler(makeCtx(makeCall())))
    expect(countFlush(result)).toBe(1)
  })

  test("does not add flush-redis when actions don't change call state", async () => {
    const registry = createRuleRegistry([inertRule("test-inert")])
    const handler = executeRules(registry, noopFallback)
    const result = await Effect.runPromise(handler(makeCtx(makeCall())))
    expect(countFlush(result)).toBe(0)
  })
})
