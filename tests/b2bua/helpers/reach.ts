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
import type { Call, Leg, Dialog, StackDialogSchemaType, B2buaDialogExt, InviteTxnHandle } from "../../../src/call/CallModel.js"
import type { SipHeader, SipRequest, SipResponse, RemoteInfo } from "../../../src/sip/types.js"
import { hydrateRequest, hydrateResponse } from "../../../src/sip/parsers/extract-fields.js"
import type { AppConfigData } from "../../../src/config/AppConfig.js"
import type { CallDecisionEngine } from "../../../src/decision/CallDecisionEngine.js"
import type { CallLimiter } from "../../../src/call/CallLimiter.js"

// ── Scalar / atomic-collection keys ────────────────────────────────────────
// These Call fields are reported as a single path — their element-level
// structure is not part of an action's reach vocabulary.
const CALL_ATOMIC_KEYS = [
  "callRef",
  "callbackContext",
  "aLegInvite",
  "limiterEntries",
  "timers",
  "cdrEvents",
  "state",
  "createdAt",
  "aLegPendingVias",
  "aLegPendingCSeq",
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
] as const satisfies ReadonlyArray<keyof Leg>

const DIALOG_SIP_KEYS = [
  "callId",
  "localTag",
  "remoteTag",
  "localUri",
  "remoteUri",
  "remoteTarget",
  "localCSeq",
  "routeSet",
] as const satisfies ReadonlyArray<keyof StackDialogSchemaType>

const DIALOG_EXT_KEYS = [
  "remoteCSeq",
  "inboundPendingRequests",
  "ackBranch",
] as const satisfies ReadonlyArray<keyof B2buaDialogExt>

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
  for (const k of DIALOG_SIP_KEYS) {
    if (!eq(before.sip[k], after.sip[k])) out.add(`legs.${legId}.dialogs[${i}].sip.${k}`)
  }
  for (const k of DIALOG_EXT_KEYS) {
    if (!eq(before.ext[k], after.ext[k])) out.add(`legs.${legId}.dialogs[${i}].ext.${k}`)
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

/**
 * Build a b-leg-shaped Dialog — identity tag lives on `sip.remoteTag` (Bob's
 * tag), matching how b-leg dialogs were keyed under the old flat shape
 * (`dialog.toTag` → `dialog.sip.remoteTag` on the b-leg).
 */
export function makeDialog(toTag: string, localCSeq = 1000): Dialog {
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

/**
 * Build an a-leg-shaped Dialog — identity tag lives on `sip.localTag`
 * (the B2BUA's tag pinned in 200 OK), matching how a-leg dialogs were keyed
 * under the old flat shape (`dialog.toTag` → `dialog.sip.localTag` on the
 * a-leg). Alice's tag (`fromTag` on the Leg) lands on `sip.remoteTag`.
 */
export function makeALegDialog(toTag: string, fromTag: string, localCSeq = 1000): Dialog {
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

/**
 * Build a stub InviteTxnHandle shaped enough to feed `generateCancel`.
 * `generateCancel` reads Via/From/To/Call-ID/CSeq + Request-URI from the
 * cached INVITE, so that's all the stub carries.
 */
function makeInviteTxnHandleStub(
  legId: string,
  callId: string,
  fromTag: string,
): InviteTxnHandle {
  const branch = `z9hG4bK-${legId}-invite`
  const invite: SipRequest = hydrateRequest({
    method: "INVITE",
    uri: "sip:bob@192.168.1.200:5060",
    headers: [
      h("Via", `SIP/2.0/UDP 10.0.0.1:5060;branch=${branch}`),
      h("Max-Forwards", "70"),
      h("From", `<sip:b2bua@10.0.0.1>;tag=${fromTag}`),
      h("To", "<sip:bob@example.com>"),
      h("Call-ID", callId),
      h("CSeq", "1 INVITE"),
      h("Content-Length", "0"),
    ],
    body: new Uint8Array(0),
    raw: Buffer.alloc(0),
  })
  return {
    kind: "invite",
    branch,
    originalInvite: invite,
    destination: { host: "192.168.1.200", port: 5060 },
  }
}

export function makeLeg(
  legId: string,
  callId: string,
  fromTag: string,
  dialog?: Dialog,
): Leg {
  // b-legs default to state "trying" with an outstanding INVITE, so populate
  // `pendingInviteTxn` to match the production invariant (§9.1 CANCEL reuse).
  // a-legs never carry a pendingInviteTxn — the B2BUA doesn't send INVITE up.
  const pendingInviteTxn = legId === "a"
    ? undefined
    : makeInviteTxnHandleStub(legId, callId, fromTag)
  return {
    legId,
    callId,
    fromTag,
    source: { address: "192.168.1.200", port: 5060 },
    state: "trying",
    disposition: "bridged",
    dialogs: dialog ? [dialog] : [],
    ...(pendingInviteTxn !== undefined && { pendingInviteTxn }),
  }
}

export function makeCall(aLeg: Leg, bLeg: Leg): Call {
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
        { name: "CSeq", value: "42 INVITE" },
        { name: "Call-ID", value: aLeg.callId },
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
    callControl: {} as CallDecisionEngine["Service"],
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
  return hydrateResponse({
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
  })
}
