/**
 * Reach-diff helpers for Slice-D action reach tests.
 *
 * `diffCall(before, after)` walks both Call trees and returns the set of
 * dotted paths whose values changed. Arrays that behave as opaque units at
 * the domain level (tagMap, timers, cdrEvents, limiterEntries, route sets,
 * Vias, activeRules, ruleState) are reported as a single path — individual
 * element diffs collapse to the parent key. Legs are indexed by `legId`
 * (not array position) so renaming or reordering does not masquerade as a
 * field-level mutation. Dialogs inside a leg are walked by index.
 *
 * The invariant each Slice-D test asserts is:
 *
 *   diffCall(before, after) === Set(<paths the action names in its params>)
 *
 * Any additional path in the diff is a reach violation — the action mutated
 * state it did not declare. Any missing path means the test's `before`
 * fixture failed to observe the named mutation.
 */

import { isDeepStrictEqual } from "node:util"
import { executeActions } from "../../../src/b2bua/rules/framework/ActionExecutor.js"
import type { HandlerResult } from "../../../src/sip/SipRouter.js"
import type { RuleAction, RuleContext } from "../../../src/b2bua/rules/framework/RuleDefinition.js"
import type { Call, Leg, Dialog } from "../../../src/call/CallModel.js"
import type { SipHeader, SipRequest, SipResponse, RemoteInfo } from "../../../src/sip/types.js"
import type { AppConfigData } from "../../../src/config/AppConfig.js"
import type { CallControlClient } from "../../../src/http/CallControlClient.js"
import type { CallLimiter } from "../../../src/call/CallLimiter.js"

// ── Scalar / atomic-collection keys ────────────────────────────────────────
// These Call fields are reported as a single path — their element-level
// structure is not part of an action's reach vocabulary.
const CALL_ATOMIC_KEYS = [
  "callRef",
  "callbackContext",
  "aLegInviteSnapshot",
  "limiterEntries",
  "timers",
  "cdrEvents",
  "state",
  "createdAt",
  "aLegVias",
  "aLegPendingVias",
  "aLegPendingCSeq",
  "aLegFrom",
  "aLegTo",
  "aLegInviteCSeq",
  "tagMap",
  "traceId",
  "rootSpanId",
  "sampled",
  "workerIndex",
  "emergency",
  "policies",
  "policyUpdateHeaders",
  "activeRules",
  "ruleState",
  "transfer",
] as const satisfies ReadonlyArray<keyof Call>

const LEG_ATOMIC_KEYS = [
  "callId",
  "fromTag",
  "source",
  "state",
  "disposition",
  "byeDisposition",
  "noAnswerTimeoutSec",
  "localUri",
  "remoteUri",
  "inviteRequestUri",
  "inviteBranch",
] as const satisfies ReadonlyArray<keyof Leg>

const DIALOG_ATOMIC_KEYS = [
  "toTag",
  "contact",
  "localCSeq",
  "remoteCSeq",
  "lastInviteCSeq",
  "routeSet",
  "inboundPendingRequests",
  "ackBranch",
] as const satisfies ReadonlyArray<keyof Dialog>

function eq(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b)
}

function diffDialog(
  legId: string,
  i: number,
  before: Dialog,
  after: Dialog,
  out: Set<string>,
): void {
  for (const k of DIALOG_ATOMIC_KEYS) {
    if (!eq(before[k], after[k])) out.add(`legs.${legId}.dialogs[${i}].${k}`)
  }
}

function diffLeg(legId: string, before: Leg, after: Leg, out: Set<string>): void {
  for (const k of LEG_ATOMIC_KEYS) {
    if (!eq(before[k], after[k])) out.add(`legs.${legId}.${k}`)
  }
  const len = Math.max(before.dialogs.length, after.dialogs.length)
  for (let i = 0; i < len; i++) {
    const b = before.dialogs[i]
    const a = after.dialogs[i]
    if (b === undefined) {
      out.add(`legs.${legId}.dialogs[${i}]`)
      continue
    }
    if (a === undefined) {
      out.add(`legs.${legId}.dialogs[${i}]`)
      continue
    }
    diffDialog(legId, i, b, a, out)
  }
}

export function diffCall(before: Call, after: Call): Set<string> {
  const out = new Set<string>()

  for (const k of CALL_ATOMIC_KEYS) {
    if (!eq(before[k], after[k])) out.add(k)
  }
  if (!eq(before.activePeer, after.activePeer)) out.add("activePeer")

  const byId = (legs: readonly Leg[]): Map<string, Leg> =>
    new Map(legs.map((l) => [l.legId, l]))
  const beforeMap: Map<string, Leg> = new Map([
    ["a", before.aLeg],
    ...byId(before.bLegs),
  ])
  const afterMap: Map<string, Leg> = new Map([
    ["a", after.aLeg],
    ...byId(after.bLegs),
  ])
  const allIds = new Set<string>([...beforeMap.keys(), ...afterMap.keys()])
  for (const legId of allIds) {
    const b = beforeMap.get(legId)
    const a = afterMap.get(legId)
    if (b === undefined || a === undefined) {
      out.add(`legs.${legId}`)
      continue
    }
    diffLeg(legId, b, a, out)
  }

  return out
}

// ── runActions ─────────────────────────────────────────────────────────────

/**
 * Thin wrapper around `executeActions` that returns the resulting Call
 * together with the full HandlerResult (so tests that care about outbound
 * or effects can peek at them).
 *
 * The caller provides a ready-made RuleContext — this helper does not
 * fabricate one. Fixtures that only need the call diff can reuse a single
 * ctx built once via `makeCtx(...)`.
 */
export function runActions(
  actions: ReadonlyArray<RuleAction>,
  ctx: RuleContext,
  ruleId: string = "test-rule",
): { after: Call; result: HandlerResult } {
  const result = executeActions(actions, ctx, ruleId)
  return { after: result.call, result }
}

// ── Fixture builders ───────────────────────────────────────────────────────
// Minimal Call/Leg/Dialog factories for reach tests. Shared with
// `actions-reach.test.ts` so both suites agree on the baseline shape.

const h = (name: string, value: string): SipHeader => ({ name, value })
const DEFAULT_RINFO: RemoteInfo = { address: "192.168.1.100", port: 5060 }

export function makeDialog(toTag: string, localCSeq = 1000): Dialog {
  return {
    toTag,
    contact: "<sip:peer@192.168.1.200:5060>",
    localCSeq,
    remoteCSeq: 1,
    inboundPendingRequests: [],
    routeSet: [],
  }
}

export function makeLeg(
  legId: string,
  callId: string,
  fromTag: string,
  dialog?: Dialog,
): Leg {
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

export function makeCall(aLeg: Leg, bLeg: Leg): Call {
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

export function makeCtx(
  call: Call,
  sourceLeg: Leg,
  sourceDialog: Dialog | undefined,
  direction: "from-a" | "from-b",
  message: SipRequest | SipResponse,
  nowMs: number = 1_700_000_000_000,
): RuleContext {
  return {
    call,
    callRef: call.callRef,
    event: { type: "sip" as const, message, rinfo: DEFAULT_RINFO },
    sourceLeg,
    sourceDialog,
    direction,
    config: {
      sipLocalIp: "10.0.0.1",
      sipLocalPort: 5060,
      noAnswerTimeoutSec: 60,
    } as AppConfigData,
    callControl: {} as CallControlClient["Service"],
    limiter: {} as CallLimiter["Service"],
    nowMs,
  }
}

/** Build a 200 OK INVITE response from the b-leg. */
export function make200InviteFromB(
  toTag: string,
  recordRoutes: ReadonlyArray<string> = [],
): SipResponse {
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
      from: undefined,
      callId: undefined,
      cseq: undefined,
      via: undefined,
      vias: [],
      contact: { displayName: undefined, uri: "sip:bob@192.168.1.200:5060", params: {} },
      requestUri: undefined,
    },
  }
}
