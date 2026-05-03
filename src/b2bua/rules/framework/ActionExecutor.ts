/**
 * ActionExecutor — translates RuleAction[] into HandlerResult.
 *
 * Owns CSeq management, tag rewriting, dialog state transitions, and
 * message construction. Rules express high-level decisions; this module
 * converts them to SIP wire format.
 *
 * Maintains a working copy of Call state that accumulates changes
 * across actions executed sequentially.
 */

import type { RuleAction, RuleContext, MessageTransform } from "./RuleDefinition.js"
import { applyBodyUpdate, applyHeaderUpdates } from "./actions/apply.js"
import { hydrateRequest } from "../../../sip/parsers/extract-fields.js"
import type { HandlerResult, OutboundEnvelope, SideEffect } from "../../../sip/SipRouter.js"
import type { SipHeader, SipRequest, SipResponse } from "../../../sip/types.js"
import type { TimerEntry, Leg, Dialog, TransferState, MakeDialogLegCtx, InviteTxnHandle } from "../../../call/CallModel.js"
import {
  type Call,
  addCdrEvent,
  bumpLocalCSeq,
  randomInitialCSeq,
  deactivateRule,
  findBLeg,
  getPeer,
  mergeLeg,
  relayCSeqDelta,
  setByeDisposition,
  setLegDisposition,
  setLegState,
  splitLeg,
  updateRemoteCSeq,
  findByATag,
  findByBTag,
  addTagMapping,
  makeEmptyDialog,
  makeDialogFromIncoming,
  b2buaTag,
  remoteTag,
  updateLeg,
  updateDialog,
  addPendingRequest,
  findPendingRequest,
  removePendingRequest,
  aLegInviteCSeqNum,
} from "../../../call/CallModel.js"
import {
  extractContactUri,
  extractHostPort,
  getHeader,
  getHeaders,
  newTag,
  stripTag,
} from "../../../sip/MessageHelpers.js"
import { parseSipUriString, parseVia } from "../../../sip/parsers/custom/structured-headers.js"
import { Result } from "effect"
import {
  extractNonStructuralHeaders,
  generateAckFor2xx,
  generateCancel,
  generateInDialogRequest,
  generateRelayedResponse,
  generateResponse,
} from "../../../sip/generators.js"
import type { InviteClientTransactionHandle } from "../../../sip/TransactionLayer.js"
import { createBLegFromRoute } from "../../helpers.js"
import { legStackIdentity } from "../../stack-identity.js"

// ── Internal working state ─────────────────────────────────────────────────

interface ExecutionState {
  call: Call
  outbound: OutboundEnvelope[]
  effects: SideEffect[]
  spanEvents: Array<{ name: string; attributes?: Record<string, unknown> }>
}

// ── Leg target resolution ──────────────────────────────────────────────────

/** Resolve destination host:port for a leg (from dialog contact or source). */
function legTarget(leg: Leg): { host: string; port: number } {
  const dialog = leg.dialogs[0]
  if (dialog !== undefined && dialog.sip.remoteTarget) {
    const hp = extractHostPort(dialog.sip.remoteTarget)
    if (hp) return hp
  }
  return { host: leg.source.address, port: leg.source.port }
}

/**
 * Returns the identity tag used to key a dialog for `updateDialog` /
 * `bumpLocalCSeq` / `addPendingRequest` / … on a specific leg.
 *
 * a-leg: B2BUA's pinned tag (`sip.localTag`).
 * b-leg: peer's tag (`sip.remoteTag`) — the old `dialog.toTag` value.
 */
function dialogIdentityTag(legId: string, dialog: Dialog): string {
  return legId === "a" ? dialog.sip.localTag : dialog.sip.remoteTag
}

/**
 * RFC 3261 §13.2.2.4: ACK for 2xx echoes the INVITE's CSeq. RFC 3262 §7.2:
 * the middle token of RAck references the same INVITE CSeq. The canonical
 * source is the pending INVITE client-transaction handle — `dialog.ext` for
 * re-INVITEs (handle stored on the confirmed dialog), `leg.pendingInviteTxn`
 * for the initial INVITE (handle stored on the leg before any dialog exists).
 *
 * Returns `undefined` when no handle is reachable — Redis-recovered calls
 * that lost the handle in serialization fall back to `dialog.sip.localCSeq`
 * at call sites.
 */
function inviteCSeqFromHandle(leg: Leg, dialog: Dialog | undefined): number | undefined {
  const handle = dialog?.ext.pendingInviteTxn ?? leg.pendingInviteTxn
  if (handle === undefined) return undefined
  const invite = handle.originalInvite as SipRequest
  const cseqHeader = getHeader(invite.headers, "cseq") ?? ""
  const n = parseInt(cseqHeader, 10)
  return Number.isFinite(n) ? n : undefined
}

/** Extract the bare URI from `<uri>` or `name <uri>` form. */
function extractUriFromRoute(headerValue: string): string {
  const m = /<([^>]+)>/.exec(headerValue)
  return m ? m[1]! : headerValue.trim()
}

/**
 * Apply a dialog's route set to an outbound in-dialog request (RFC 3261
 * §12.2.1.1 / §16.12). Inserts Route headers in dialog order and, when the
 * first route is a loose router (`;lr` parameter), rewrites the destination
 * to that URI while keeping the Request-URI at the remote target.
 *
 * When `dialog.routeSet` is empty the request and destination are returned
 * unchanged. Strict routing (first route without `;lr`) is not implemented —
 * we fall through to the unchanged request in that case.
 */
function applyRouteSet(
  msg: SipRequest,
  dialog: Dialog | undefined,
  target: { host: string; port: number },
): { msg: SipRequest; target: { host: string; port: number } } {
  if (dialog === undefined || dialog.sip.routeSet.length === 0) return { msg, target }

  const firstRoute = dialog.sip.routeSet[0]!
  const firstUri = extractUriFromRoute(firstRoute)
  const isLoose = parseSipUriString(firstUri)?.params["lr"] !== undefined
  if (!isLoose) return { msg, target }

  const routeHeaders: SipHeader[] = dialog.sip.routeSet.map((uri: string) => ({ name: "Route", value: uri }))
  const without = msg.headers.filter((h) => h.name.toLowerCase() !== "route")
  const insertIdx = without.findIndex((h) => h.name.toLowerCase() === "content-length")
  const newHeaders = insertIdx >= 0
    ? [...without.slice(0, insertIdx), ...routeHeaders, ...without.slice(insertIdx)]
    : [...without, ...routeHeaders]

  const hp = extractHostPort(firstUri)
  const newTarget = hp ?? target

  return { msg: { ...msg, headers: newHeaders }, target: newTarget }
}

/** Resolve a leg by ID (a-leg or b-leg). */
function findLeg(call: Call, legId: string): Leg | undefined {
  if (legId === "a") return call.aLeg
  return findBLeg(call, legId)
}

/**
 * Pick the From/To tags for an outbound in-dialog request on a given target.
 *
 * Dialog-leg asymmetry (RFC 3261 §12.1):
 *  - b-leg target → B2BUA is UAC, its tag is `leg.fromTag`; remote is
 *    `dialog.toTag`.
 *  - a-leg target → B2BUA is UAS toward Alice, its tag lives in
 *    `dialog.toTag`; remote is `leg.fromTag`. Using `targetLeg.fromTag`
 *    directly would put Alice's own tag in From, which is wrong.
 *
 * Falling back to `""` on a missing tag preserves the pre-extraction
 * behavior (an empty `tag=` string renders safely and surfaces the
 * underlying dialog-state bug visibly in traces).
 */
function directionalTags(
  call: Call,
  targetLeg: Leg,
  targetDialog: Dialog,
): { fromTag: string; toTag: string } {
  if (targetLeg.legId === "a") {
    return {
      fromTag: b2buaTag(call, "a") ?? "",
      toTag: remoteTag(call, "a") ?? "",
    }
  }
  return { fromTag: targetLeg.fromTag, toTag: targetDialog.sip.remoteTag }
}

/**
 * Build a CANCEL envelope for a b-leg's outstanding INVITE.
 *
 * RFC 3261 §9.1: CANCEL copies the INVITE's Request-URI, topmost Via
 * (same branch — server transaction matching), From, To, Call-ID, and CSeq
 * number. `generateCancel` reads them directly off the cached INVITE in
 * `leg.pendingInviteTxn`, so no denormalised fields are needed here.
 *
 * Returns `undefined` when the leg has no pending INVITE transaction — the
 * caller must skip the outbound (there is nothing to cancel).
 */
function buildCancelEnvelope(
  leg: Leg,
  labelSuffix: string,
): OutboundEnvelope | undefined {
  const handle = leg.pendingInviteTxn
  if (handle === undefined) return undefined
  return {
    message: generateCancel(handle as unknown as InviteClientTransactionHandle),
    destination: handle.destination,
    label: `CANCEL ${leg.legId}${labelSuffix}`,
    legId: leg.legId,
  }
}

// ── Main executor ──────────────────────────────────────────────────────────

/**
 * Execute a sequence of RuleActions, accumulating into a HandlerResult.
 * The ActionExecutor maintains a working copy of Call that each action updates.
 */
export function executeActions(
  actions: ReadonlyArray<RuleAction>,
  ctx: RuleContext,
  ruleId: string,
): HandlerResult {
  const state: ExecutionState = {
    call: ctx.call,
    outbound: [],
    effects: [],
    spanEvents: [],
  }

  for (const action of actions) {
    executeAction(action, ctx, state, ruleId)
  }

  return {
    call: state.call,
    outbound: state.outbound,
    effects: state.effects,
    ...(state.spanEvents.length > 0 ? { spanEvents: state.spanEvents } : {}),
  }
}

// ── Action dispatch ────────────────────────────────────────────────────────

function executeAction(
  action: RuleAction,
  ctx: RuleContext,
  state: ExecutionState,
  ruleId: string,
): void {
  switch (action.type) {
    case "respond":
      executeRespond(action, ctx, state)
      break
    case "relay-to-peer":
      executeRelayToPeer(action, ctx, state)
      break
    case "relay-to-leg":
      executeRelayToLeg(action, ctx, state)
      break
    case "ack-leg":
      executeAckLeg(action, ctx, state)
      break
    case "send-request-to-leg":
      executeSendRequestToLeg(action, ctx, state)
      break
    case "send-prack-to-leg":
      executeSendPrackToLeg(action, ctx, state)
      break
    case "cache-sdp-on-leg-dialog":
      executeCacheSdpOnLegDialog(action, state)
      break
    case "set-policy-update-body":
      state.call = { ...state.call, policyUpdateBody: action.body }
      break
    case "confirm-dialog":
      executeConfirmDialog(action, ctx, state)
      break
    case "update-leg-state":
      executeUpdateLegState(action, state)
      break
    case "stamp-dialog-to-tag":
      executeStampDialogToTag(action, state)
      break
    case "create-leg":
      executeCreateLeg(action, ctx, state)
      break
    case "destroy-leg":
      executeDestroyLeg(action, ctx, state)
      break
    case "cancel-leg":
      executeCancelLeg(action, ctx, state)
      break
    case "merge":
      executeMerge(action, state)
      break
    case "split":
      executeSplit(action, state)
      break
    case "schedule-timer":
      executeScheduleTimer(action, ctx, state)
      break
    case "cancel-timer":
      executeCancelTimer(action, state)
      break
    case "cancel-all-timers":
      state.effects.push({ type: "cancel-all-timers" })
      state.call = { ...state.call, timers: [] }
      break
    case "terminate-call":
      executeTerminateCall(ctx, state)
      break
    case "begin-termination":
      executeBeginTermination(ctx, state)
      break
    case "terminate-leg":
      executeTerminateLeg(action, state)
      break
    case "add-cdr-event":
      executeAddCdrEvent(action, ctx, state)
      break
    case "deactivate-rule":
      state.call = deactivateRule(state.call, ruleId)
      break
    case "add-tag-mapping":
      executeAddTagMapping(action, state)
      break
    case "send-raw":
      executeSendRaw(action, state)
      break
    case "send-notify":
      executeSendNotify(action, ctx, state)
      break
    case "send-reinvite":
      executeSendReinvite(action, ctx, state)
      break
    case "update-transfer":
      executeUpdateTransfer(action, ctx, state)
      break
    case "clear-transfer":
      state.call = { ...state.call, transfer: null }
      break
    case "refer-async-http":
      executeReferAsyncHttp(action, ctx, state)
      break
  }
}

// ── respond ────────────────────────────────────────────────────────────────

function executeRespond(
  action: Extract<RuleAction, { type: "respond" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, status, reason, body, contentType } = action
  void type

  if (ctx.event.type !== "sip") return
  const msg = ctx.event.message
  if (msg.type !== "request") return

  const { contact } = legStackIdentity(state.call, ctx.sourceLeg.legId, ctx.config)
  const response = generateResponse(msg, status, reason ?? "", {
    toTag: newTag(),
    contact,
    ...(body !== undefined ? { body } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
  })
  state.outbound.push({
    message: response,
    destination: { host: ctx.event.rinfo.address, port: ctx.event.rinfo.port },
    label: `respond ${status}`,
    legId: ctx.sourceLeg.legId,
  })
}

// ── relay-to-peer ──────────────────────────────────────────────────────────

function executeRelayToPeer(
  action: Extract<RuleAction, { type: "relay-to-peer" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, transform } = action
  void type

  let peerLegId = getPeer(state.call, ctx.sourceLeg.legId)

  // Fallback: during early dialog (before merge), b-leg's implicit peer is "a".
  if (peerLegId === undefined && ctx.sourceLeg.legId !== "a") {
    peerLegId = "a"
  }

  // Fallback: a-leg with no activePeer — resolve target b-leg from To-tag.
  // During early dialog (PRACK, UPDATE), the a-leg isn't merged yet.
  // The To-tag on the request maps to a specific b-leg via tagMap.
  // We also carry the bTag to pick the right dialog on the target leg
  // (important for forking — multiple early dialogs on one b-leg).
  let targetToTag: string | undefined
  if (peerLegId === undefined && ctx.sourceLeg.legId === "a" && ctx.event.type === "sip") {
    const toTag = ctx.event.message.parsed?.to?.tag
    if (toTag) {
      const mapping = findByATag(state.call, toTag)
      if (mapping) {
        peerLegId = mapping.bLegId
        targetToTag = mapping.bTag
      }
    }
    // Single b-leg fallback
    if (peerLegId === undefined && state.call.bLegs.length === 1) {
      peerLegId = state.call.bLegs[0]!.legId
    }
  }

  if (peerLegId === undefined) return

  executeRelayToTarget(peerLegId, transform, ctx, state, targetToTag)
}

// ── relay-to-leg ───────────────────────────────────────────────────────────

function executeRelayToLeg(
  action: Extract<RuleAction, { type: "relay-to-leg" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, legId, transform } = action
  void type

  executeRelayToTarget(legId, transform, ctx, state)
}

// ── Core relay implementation ──────────────────────────────────────────────

/**
 * Relay the current event to a target leg.
 * Handles CSeq computation, tag rewriting, dialog state, and message construction.
 * This is the core of the ActionExecutor — all relay actions funnel through here.
 */
function executeRelayToTarget(
  targetLegId: string,
  transform: MessageTransform | undefined,
  ctx: RuleContext,
  state: ExecutionState,
  targetToTag?: string,
): void {
  if (ctx.event.type !== "sip") return
  const msg = ctx.event.message

  const targetLeg = findLeg(state.call, targetLegId)
  if (targetLeg === undefined) return
  // When a specific dialog is indicated (e.g. forking — multiple early dialogs),
  // pick it by To-tag. Otherwise default to the first dialog.
  const targetDialog = targetToTag
    ? targetLeg.dialogs.find((d) => dialogIdentityTag(targetLeg.legId, d) === targetToTag) ?? targetLeg.dialogs[0]
    : targetLeg.dialogs[0]
  const target = legTarget(targetLeg)

  if (msg.type === "request") {
    relayRequest(msg, ctx, state, targetLeg, targetDialog, target, transform)
  } else {
    relayResponseMsg(msg, ctx, state, targetLeg, targetDialog, target, transform)
  }
}

/** Relay an inbound SIP request to a target leg. */
function relayRequest(
  req: SipRequest,
  ctx: RuleContext,
  state: ExecutionState,
  targetLeg: Leg,
  targetDialog: Dialog | undefined,
  target: { host: string; port: number },
  transform: MessageTransform | undefined,
): void {
  if (targetDialog === undefined) return

  const inboundCSeqRaw = getHeader(req.headers, "cseq") ?? "1 UNKNOWN"
  const inboundCSeq = parseInt(inboundCSeqRaw, 10)
  const sourceDialog = ctx.sourceDialog

  // ACK for 2xx reuses the INVITE CSeq and does NOT advance the dialog
  // sequence counter (RFC 3261 §13.2.2.4). Skip CSeq bookkeeping for ACK.
  const isAck = req.method === "ACK"
  const delta = isAck ? 0 : relayCSeqDelta(inboundCSeq, sourceDialog?.ext.remoteCSeq ?? null)
  const outboundCSeq = targetDialog.sip.localCSeq + delta

  if (!isAck) {
    // Update source leg's remoteCSeq
    if (sourceDialog) {
      state.call = updateRemoteCSeq(state.call, ctx.sourceLeg.legId, dialogIdentityTag(ctx.sourceLeg.legId, sourceDialog), inboundCSeq)
    }
    // Bump target leg's localCSeq
    state.call = bumpLocalCSeq(state.call, targetLeg.legId, dialogIdentityTag(targetLeg.legId, targetDialog), delta)
  }

  const targetUri = targetDialog.sip.remoteTarget || `sip:${target.host}:${target.port}`

  let relayed: SipRequest | SipResponse

  // Transparent-header copy for relays (RFC 3261 §16.6 — non-structural headers
  // pass through unchanged; structural ones are owned by the generator).
  const transparentHeaders = extractNonStructuralHeaders(req)
  // Content-Type is structural, so it isn't in transparentHeaders; forward it
  // explicitly so non-SDP payloads (e.g. application/dtmf-relay) survive relay.
  const sourceContentType = getHeader(req.headers, "content-type")

  switch (req.method) {
    case "INVITE": {
      const { via, contact, branch } = legStackIdentity(state.call, targetLeg.legId, ctx.config)
      const { request: r } = generateInDialogRequest("INVITE", targetDialog.sip, {
        via,
        contact,
        requestUri: targetUri,
        cseq: outboundCSeq,
        body: req.body,
        ...(sourceContentType !== undefined ? { contentType: sourceContentType } : {}),
        extraHeaders: transparentHeaders,
      })
      relayed = r
      // Capture the INVITE handle so ACK-for-2xx can read the CSeq
      // (RFC 3261 §13.2.2.4) and CANCEL can reuse the branch (§9.1).
      // Re-INVITE handle lives on the confirmed dialog, not the leg.
      const inviteHandle: InviteTxnHandle = {
        kind: "invite",
        branch,
        originalInvite: r,
        destination: target,
      }
      state.call = updateDialog(state.call, targetLeg.legId, dialogIdentityTag(targetLeg.legId, targetDialog), (d) => ({
        ...d,
        ext: { ...d.ext, pendingInviteTxn: inviteHandle },
      }))
      // Track pending request for response correlation
      state.call = addPendingRequest(state.call, targetLeg.legId, dialogIdentityTag(targetLeg.legId, targetDialog), {
        method: "INVITE",
        outboundCSeq,
        inboundCSeq,
        sourceVias: getHeaders(req.headers, "via"),
        sourceCallId: ctx.sourceLeg.callId,
        sourceFrom: getHeader(req.headers, "from") ?? "",
        sourceTo: getHeader(req.headers, "to") ?? "",
        direction: ctx.direction,
      })
      break
    }
    case "ACK": {
      // RFC 3261 §13.2.2.4: ACK for 2xx echoes the INVITE's CSeq, regardless
      // of any intermediate in-dialog requests (PRACK, UPDATE) that bumped
      // the dialog's localCSeq between the INVITE and the 2xx. The INVITE
      // is cached on `pendingInviteTxn` (leg for initial, dialog for re-).
      const handle = targetDialog.ext.pendingInviteTxn ?? targetLeg.pendingInviteTxn
      const fallbackCSeq = inviteCSeqFromHandle(targetLeg, targetDialog) ?? targetDialog.sip.localCSeq
      // RFC 3261 §17.1.1.2: ACK for 2xx is its own hop; reuse the cached
      // branch on retransmit so the UAS correlates re-ACKs and stops
      // retransmitting the 2xx.
      const cachedBranch = targetDialog.ext.ackBranch
      const { via, branch } = legStackIdentity(state.call, targetLeg.legId, ctx.config, cachedBranch)
      relayed = generateAckFor2xx(handle as InviteClientTransactionHandle | undefined, targetDialog.sip, {
        via,
        cseq: fallbackCSeq,
        requestUri: targetUri,
        body: req.body,
        ...(sourceContentType !== undefined ? { contentType: sourceContentType } : {}),
        extraHeaders: transparentHeaders,
      })
      if (cachedBranch === undefined) {
        state.call = updateDialog(state.call, targetLeg.legId, dialogIdentityTag(targetLeg.legId, targetDialog), (d) => ({
          ...d,
          ext: { ...d.ext, ackBranch: branch },
        }))
      }
      break
    }
    case "BYE": {
      const { via, contact } = legStackIdentity(state.call, targetLeg.legId, ctx.config)
      const { request: r } = generateInDialogRequest("BYE", targetDialog.sip, {
        via,
        contact,
        requestUri: targetUri,
        cseq: outboundCSeq,
        extraHeaders: transparentHeaders,
      })
      relayed = r
      break
    }
    case "PRACK": {
      // RFC 3262 §7.2: RAck's CSeq must reference the CSeq of the INVITE that
      // produced the reliable 1xx on this leg. Rewrite the middle token of
      // "<RSeq> <CSeq> <Method>" to the target dialog's INVITE CSeq, sourced
      // from `pendingInviteTxn`.
      const rackIn = getHeader(req.headers, "rack") ?? ""
      const rackResult = req.lazy.rack()
      const parsedRack = Result.isSuccess(rackResult) ? rackResult.success : undefined
      const targetInviteCSeq = inviteCSeqFromHandle(targetLeg, targetDialog) ?? targetDialog.sip.localCSeq
      const rack = parsedRack !== undefined
        ? `${parsedRack.rseq} ${targetInviteCSeq} ${parsedRack.method}`
        : rackIn
      const { via, contact } = legStackIdentity(state.call, targetLeg.legId, ctx.config)
      const { request: r } = generateInDialogRequest("PRACK", targetDialog.sip, {
        via,
        contact,
        requestUri: targetUri,
        cseq: outboundCSeq,
        rack,
        body: req.body,
        ...(sourceContentType !== undefined ? { contentType: sourceContentType } : {}),
        extraHeaders: transparentHeaders,
      })
      relayed = r
      // Save source leg's Vias + CSeq for response relay (RFC 3261 §8.1.3.3: response CSeq must echo request CSeq).
      if (ctx.sourceLeg.legId === "a") {
        state.call = {
          ...state.call,
          aLegPendingVias: getHeaders(req.headers, "via"),
          aLegPendingCSeq: inboundCSeq,
        }
      }
      break
    }
    default: {
      // ── Transparent in-dialog request relay (OPTIONS, INFO, UPDATE, MESSAGE…) ──
      // The B2BUA must forward these end-to-end with payload intact, rewriting
      // only dialog identifiers and Via. Tag selection mirrors INVITE's logic
      // (B2BUA owns the tag shown to the a-leg). A pending entry is recorded
      // so relayResponseMsg can rebuild the response using the original
      // inbound Vias/From/To/Call-ID/CSeq snapshot (RFC 3261 §8.1.3.3).
      if (req.method !== "OPTIONS" && req.method !== "INFO" && req.method !== "UPDATE"
          && req.method !== "MESSAGE" && req.method !== "NOTIFY") {
        return
      }
      const { via, contact } = legStackIdentity(state.call, targetLeg.legId, ctx.config)
      const { request: r } = generateInDialogRequest(req.method, targetDialog.sip, {
        via,
        contact,
        requestUri: targetUri,
        cseq: outboundCSeq,
        body: req.body,
        ...(sourceContentType !== undefined ? { contentType: sourceContentType } : {}),
        extraHeaders: transparentHeaders,
      })
      relayed = r
      state.call = addPendingRequest(state.call, targetLeg.legId, dialogIdentityTag(targetLeg.legId, targetDialog), {
        method: req.method,
        outboundCSeq,
        inboundCSeq,
        sourceVias: getHeaders(req.headers, "via"),
        sourceCallId: ctx.sourceLeg.callId,
        sourceFrom: getHeader(req.headers, "from") ?? "",
        sourceTo: getHeader(req.headers, "to") ?? "",
        direction: ctx.direction,
      })
      break
    }
  }

  // Apply transform if provided (request branch — status/reason are not
  // applicable for request relay).
  if (transform && relayed.type === "request") {
    if (transform.headerUpdates !== undefined) {
      relayed = applyHeaderUpdates(relayed, transform.headerUpdates)
    }
    if (transform.bodyUpdate !== undefined) {
      relayed = applyBodyUpdate(relayed, transform.bodyUpdate)
    }
  }

  // RFC 3261 §12.2.1.1: apply dialog route set to outbound in-dialog requests
  // on the b-leg (the B2BUA is the UAC there). ACK, BYE, re-INVITE, PRACK and
  // any other in-dialog method get Route headers and, for loose routers, a
  // destination rewrite to the first route URI.
  let finalTarget = target
  if (relayed.type === "request") {
    // RFC 3261 §12.2.1.1: in-dialog requests honor the dialog's route set
    // on the way out — Route headers prepended, destination rewritten to
    // the first route hop for loose routers. Applies to both legs:
    // - B-leg (worker→bob via proxy when `b2bOutboundProxy` is set)
    // - A-leg (worker→alice via proxy in `proxy+b2b` SUT, where the A-leg
    //   dialog routeSet was seeded from the original INVITE's R-R)
    // `applyRouteSet` is a no-op when `dialog.sip.routeSet` is empty, so
    // b2bonly's A-leg (no R-R from alice) keeps its direct path.
    const routed = applyRouteSet(relayed, targetDialog, target)
    relayed = routed.msg
    finalTarget = routed.target
  }

  state.outbound.push({
    message: relayed,
    destination: finalTarget,
    label: `relay ${req.method} to ${targetLeg.legId}`,
    legId: targetLeg.legId,
  })
}

/** Relay an inbound SIP response to a target leg. */
function relayResponseMsg(
  resp: SipResponse,
  ctx: RuleContext,
  state: ExecutionState,
  targetLeg: Leg,
  _targetDialog: Dialog | undefined,
  _target: { host: string; port: number },
  transform: MessageTransform | undefined,
): void {
  // Determine effective status/reason (may be transformed, e.g., 183→200)
  const effectiveStatus = transform?.status ?? resp.status
  const effectiveReason = transform?.reason ?? resp.reason

  // Build the relayed response with target leg's identifiers
  const toTag = resp.parsed?.to?.tag ?? ""

  // ── Detect pending transparent-relay response correlation ──
  // If the source dialog has a pending relayed request matching this
  // response's CSeq, we must rebuild the relayed response from the pending
  // entry's snapshot (original Call-ID, Vias, From, To, CSeq) rather than
  // the leg's current headers. This is the framework-side counterpart to
  // addPendingRequest() in relayRequest above. Covers re-INVITE as well as
  // any transparent in-dialog method (OPTIONS, INFO, UPDATE, MESSAGE,
  // PRACK, …). See AdvancedCallModel.md §"Limitations" for context.
  const cseqMethod = resp.parsed.cseq.method.length > 0 ? resp.parsed.cseq.method.toUpperCase() : "INVITE"
  const cseqNum = resp.parsed.cseq.seq
  const pending = ctx.sourceDialog !== undefined
    ? findPendingRequest(ctx.sourceDialog, cseqNum)
    : undefined

  let relayed: SipResponse

  if (pending !== undefined) {
    // ── Pending transparent-relay response path ──
    // Rebuild headers from the snapshot captured when the request was relayed.
    // Covers re-INVITE as well as OPTIONS, INFO, UPDATE, MESSAGE, and any
    // other in-dialog transparent method (RFC 3261 §8.1.3.3 — CSeq must echo
    // the request's CSeq/method).
    const sourceContentType = getHeader(resp.headers, "content-type")
    // RFC 3261 §20.10: Contact on 2xx target-refreshes the peer to the B2BUA.
    const { contact: respContact } = legStackIdentity(state.call, targetLeg.legId, ctx.config)
    relayed = generateRelayedResponse(resp.status, resp.reason, {
      vias: pending.sourceVias,
      from: pending.sourceFrom,
      to: pending.sourceTo,
      callId: pending.sourceCallId,
      cseq: `${pending.inboundCSeq} ${cseqMethod}`,
      body: resp.body,
      transparentHeaders: extractNonStructuralHeaders(resp),
      ...(sourceContentType !== undefined ? { contentType: sourceContentType } : {}),
      contact: respContact,
    })
  } else {
    // ── Default response relay path (initial INVITE, PRACK/UPDATE, INFO, etc.) ──

    // Tag mapping: if response comes from a b-leg, map the tag to a-facing tag
    let aFacingToTag: string | undefined
    if (ctx.sourceLeg.legId !== "a" && toTag) {
      const mapping = findByBTag(state.call, ctx.sourceLeg.legId, toTag)
      if (mapping) {
        aFacingToTag = mapping.aTag
      } else if (effectiveStatus >= 100) {
        // New tag from b-leg — create mapping
        aFacingToTag = newTag()
        state.call = addTagMapping(state.call, { aTag: aFacingToTag, bLegId: ctx.sourceLeg.legId, bTag: toTag })
      }
    }

    // Determine which Vias/From/To to use for the relayed response
    const aLegInviteVias = getHeaders(state.call.aLegInvite.headers, "via")
    const aLegInviteFrom = getHeader(state.call.aLegInvite.headers, "from") ?? ""
    const aLegInviteTo = getHeader(state.call.aLegInvite.headers, "to") ?? ""
    const aLegInviteCSeq = aLegInviteCSeqNum(state.call)
    const viasForRelay = state.call.aLegPendingVias ?? aLegInviteVias
    const toWithTag = aFacingToTag
      ? `${stripTag(aLegInviteTo)};tag=${aFacingToTag}`
      : undefined

    // Non-INVITE responses to a-leg must echo the inbound a-leg request's CSeq
    // (RFC 3261 §8.1.3.3). For PRACK/UPDATE/INFO we tracked this as aLegPendingCSeq
    // when the request was relayed to b-leg.
    const aLegCSeq = targetLeg.legId === "a"
      ? cseqMethod === "INVITE"
        ? `${aLegInviteCSeq} INVITE`
        : `${state.call.aLegPendingCSeq ?? aLegInviteCSeq} ${cseqMethod}`
      : undefined

    // Preserve old relayResponse semantics: when aFacingToTag is undefined,
    // carry resp's own To transparently (old code's skipExtra fallback).
    const sourceContentType = getHeader(resp.headers, "content-type")
    const defaultCseq = aLegCSeq ?? (getHeader(resp.headers, "cseq") ?? "")
    const toHeader = toWithTag ?? getHeader(resp.headers, "to") ?? ""

    // policyUpdateBody substitution + record-route reflection both depend on
    // INVITE-response shape. Single source of truth declared below.
    // RFC 3261 §20.10: Contact on 2xx target-refreshes the peer to the B2BUA.
    const { contact: respContact } = legStackIdentity(state.call, targetLeg.legId, ctx.config)
    // RFC 3261 §12.1.1 + §12.1.2: reflect the inbound A-leg INVITE's
    // Record-Route on dialog-creating responses toward the A-leg so the
    // UAC (Alice) can build its route set and route subsequent in-dialog
    // requests through the upstream proxy. Reflection scope is narrow on
    // purpose: route set is fixed at dialog creation, mid-dialog refresh
    // is non-standard (see [docs/b2bua-sip-headers.md] B-leg traversal).
    //   - status 200..299 with INVITE CSeq → confirmed dialog 2xx
    //   - status 100..199 with INVITE CSeq AND a To-tag → early dialog
    // Other A-leg responses (in-dialog 200, OPTIONS replies, …) and any
    // B-leg response: omit; their dialogs are owned by the worker.
    const isInviteResponse = cseqMethod === "INVITE"
    const isDialogCreating2xx =
      isInviteResponse && resp.status >= 200 && resp.status < 300
    const isEarlyDialog1xx =
      isInviteResponse &&
      resp.status >= 100 &&
      resp.status < 200 &&
      toTag.length > 0
    const reflectRecordRoute =
      targetLeg.legId === "a" && (isDialogCreating2xx || isEarlyDialog1xx)
    const aLegRecordRoutes = reflectRecordRoute
      ? getHeaders(state.call.aLegInvite.headers, "record-route")
      : undefined

    // ── policyUpdateBody substitution (initial-INVITE 2xx → alice only) ──
    //
    // The `relayFirst18xTo180` `fake-prack` strategy stages bob's cached SDP
    // in `call.policyUpdateBody` so alice receives the negotiated body at
    // call confirmation. Re-INVITE responses take the `pending` path above
    // and skip this entirely. `null` means "force empty body".
    const policyBody =
      targetLeg.legId === "a" && isDialogCreating2xx
        ? state.call.policyUpdateBody
        : undefined
    let effectiveBody: Uint8Array = resp.body
    let effectiveContentType: string | undefined = sourceContentType
    if (policyBody === null) {
      effectiveBody = new Uint8Array(0)
      effectiveContentType = undefined
    } else if (policyBody !== undefined) {
      effectiveBody = policyBody
      effectiveContentType = "application/sdp"
    }
    relayed = generateRelayedResponse(resp.status, resp.reason, {
      vias: viasForRelay,
      from: aLegInviteFrom,
      to: toHeader,
      callId: targetLeg.callId,
      cseq: defaultCseq,
      body: effectiveBody,
      transparentHeaders: extractNonStructuralHeaders(resp),
      ...(effectiveContentType !== undefined ? { contentType: effectiveContentType } : {}),
      ...(aLegRecordRoutes !== undefined && aLegRecordRoutes.length > 0
        ? { recordRoutes: aLegRecordRoutes }
        : {}),
      contact: respContact,
    })

    // Track early dialog on source leg for provisional responses.
    // RFC 3261 §12.2.1.1: each forked early dialog maintains its own CSeq
    // sequence, all starting from the shared INVITE's CSeq (which the
    // response echoes in its CSeq header).
    if (resp.status >= 100 && resp.status < 200 && toTag && ctx.sourceLeg.legId !== "a") {
      const sourceLeg = ctx.sourceLeg
      if (!sourceLeg.dialogs.some((d) => d.sip.remoteTag === toTag)) {
        const contact = resp.parsed?.contact?.uri ?? ""
        // The response's CSeq number equals the INVITE's CSeq (responses
        // echo the request's CSeq — RFC 3261 §8.1.3.3). Seed this new
        // forked dialog independently from any sibling fork's counter.
        const inviteCSeq = Number.isFinite(cseqNum) ? cseqNum : randomInitialCSeq()
        const base = makeEmptyDialog({
          callId: sourceLeg.callId,
          localUri: sourceLeg.localUri ?? "",
          remoteUri: sourceLeg.remoteUri ?? "",
          localTag: sourceLeg.fromTag,
          remoteTag: toTag,
        })
        const dialog: Dialog = {
          sip: { ...base.sip, remoteTarget: contact, localCSeq: inviteCSeq },
          ext: base.ext,
        }
        // Drop any empty-remoteTag placeholder once the first real early
        // dialog exists so it doesn't shadow dialogs[0] in downstream lookups.
        const withoutPlaceholder = sourceLeg.dialogs.filter((d) => d.sip.remoteTag !== "")
        state.call = updateLeg(state.call, sourceLeg.legId, (l) => ({
          ...l, state: "early" as const, dialogs: [...withoutPlaceholder, dialog],
        }))
      }
    }

    // Ensure a-leg has a dialog when relaying provisional/answer
    if (targetLeg.legId === "a" && state.call.aLeg.dialogs.length === 0 && aFacingToTag) {
      const aLegCtx: MakeDialogLegCtx = {
        callId: state.call.aLeg.callId,
        localUri: state.call.aLeg.localUri ?? "",
        remoteUri: state.call.aLeg.remoteUri ?? "",
        localTag: aFacingToTag!,
        remoteTag: state.call.aLeg.fromTag,
      }
      // RFC 3261 §12.1.1: UAS dialog route set is the request's
      // Record-Route headers in order. Worker-originated A-leg in-dialog
      // requests (BYE relay, UPDATE) need this to traverse the front
      // proxy back to Alice — without it the proxy is bypassed and
      // Alice's UA either rejects the request or never sees it.
      const aLegRouteSet = getHeaders(state.call.aLegInvite.headers, "record-route")
      // RFC 3261 §12.1.1: UAS remote target is the UAC's Contact URI from
      // the request. Without this seeding, A-leg-originated in-dialog
      // requests fall back to `legTarget(aLeg)` — which is the INVITE's
      // SOURCE address. In b2bonly that's alice (correct); in proxy+b2b
      // that's the proxy (wrong, would loop). Pull the Contact off the
      // cached INVITE so the request URI is the UAC's real address.
      const aLegInviteContactRaw = getHeader(
        state.call.aLegInvite.headers,
        "contact",
      )
      const aLegInviteContact = aLegInviteContactRaw !== undefined
        ? extractContactUri(aLegInviteContactRaw)
        : ""
      const aLegDialog = makeDialogFromIncoming(
        aLegCtx,
        aLegInviteCSeqNum(state.call),
        aLegRouteSet,
      )
      state.call = updateLeg(state.call, "a", (l) => ({
        ...l,
        dialogs: [{
          ...aLegDialog,
          sip: { ...aLegDialog.sip, remoteTarget: aLegInviteContact },
        }],
      }))
    }

    // Clear pending Vias + CSeq after use (PRACK response relay)
    if (state.call.aLegPendingVias !== undefined || state.call.aLegPendingCSeq !== undefined) {
      state.call = { ...state.call, aLegPendingVias: undefined, aLegPendingCSeq: undefined }
    }
  }

  // Apply status/reason transform (applies to both branches)
  if (transform?.status !== undefined || transform?.reason !== undefined) {
    relayed = { ...relayed, status: effectiveStatus, reason: effectiveReason }
  }

  // Apply typed header + body transforms via the shared apply helpers.
  if (transform?.headerUpdates !== undefined) {
    relayed = applyHeaderUpdates(relayed, transform.headerUpdates)
  }
  if (transform?.bodyUpdate !== undefined) {
    relayed = applyBodyUpdate(relayed, transform.bodyUpdate)
  }

  // RFC 3261 §8.2.6.2: a UAS routes responses to the address in the
  // topmost Via, honoring `received` / `rport`. For pending-transparent
  // relays (in-dialog re-INVITE/OPTIONS/INFO/UPDATE responses heading
  // back to bob) the captured `pending.sourceVias[0]` is what the worker
  // must follow — not `legTarget(targetLeg)`. Without this, a B-leg
  // response in the proxy+b2b SUT would short-circuit to bob's contact
  // and bypass the proxy entirely (the proxy then never sees the response
  // and can't pop its own Via, which the agent-side test detects as a
  // mis-routed packet).
  const destinationFromTopVia = (vias: ReadonlyArray<string>) => {
    const top = vias[0]
    if (top === undefined) return undefined
    const parsed = parseVia(top)
    const receivedParam = parsed.params["received"]
    const rportParam = parsed.params["rport"]
    const host = typeof receivedParam === "string" && receivedParam.length > 0
      ? receivedParam
      : parsed.host
    const rportNum = typeof rportParam === "string" && rportParam.length > 0
      ? Number.parseInt(rportParam, 10)
      : undefined
    const port = rportNum !== undefined && Number.isFinite(rportNum)
      ? rportNum
      : parsed.port
    if (port === undefined || !Number.isFinite(port)) return undefined
    return { host, port }
  }
  const pendingDestination = pending !== undefined
    ? destinationFromTopVia(pending.sourceVias)
    : undefined
  const destination = targetLeg.legId === "a"
    ? { host: state.call.aLeg.source.address, port: state.call.aLeg.source.port }
    : pendingDestination ?? legTarget(targetLeg)

  state.outbound.push({
    message: relayed,
    destination,
    label: `relay ${effectiveStatus} to ${targetLeg.legId}`,
    legId: targetLeg.legId,
  })

  // ── Pending transparent-relay cleanup on final response ──
  // 2xx: update source dialog's contact if response carries a new Contact
  //      (subsequent in-dialog requests must route to the refreshed target).
  // Any final (>= 200): remove the pending entry to avoid leaks.
  if (pending !== undefined && resp.status >= 200 && ctx.sourceDialog !== undefined) {
    const sourceIdTag = dialogIdentityTag(ctx.sourceLeg.legId, ctx.sourceDialog)
    if (resp.status < 300) {
      const newContact = resp.parsed?.contact?.uri ?? ""
      if (newContact) {
        state.call = updateDialog(state.call, ctx.sourceLeg.legId, sourceIdTag, (d) => ({
          ...d, sip: { ...d.sip, remoteTarget: newContact },
        }))
      }
    }
    state.call = removePendingRequest(state.call, ctx.sourceLeg.legId, sourceIdTag, pending.outboundCSeq)
  }
}

// ── confirm-dialog (primitive) ────────────────────────────────────────────

/**
 * Confirm the named leg's dialog[0] from the current SIP *response* event.
 *
 * Reach (Slice B / Action reach discipline):
 *   legs.{action.legId}.dialogs[0] only — no leg.state, leg.disposition,
 *   tagMap, or peer-leg state is touched.
 *
 * Behaviour preserved from the pre-Slice-B composite:
 *   - If the leg has an early fork dialog with the response's toTag, that
 *     dialog is refreshed (contact, route set, CSeq).
 *   - Otherwise a new confirmed dialog is created from the placeholder
 *     CSeq (or a fresh random initial CSeq if no placeholder exists).
 *   - RFC 3261 §12.1.2 route set is captured from Record-Route in reverse.
 *
 * When the event is not a response (or not a SIP event at all) the action is
 * a no-op — this mirrors the old composite's behaviour and lets rules emit
 * the action unconditionally next to a response-shaped event.
 */
function executeConfirmDialog(
  action: Extract<RuleAction, { type: "confirm-dialog" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, legId } = action
  void type

  if (ctx.event.type !== "sip") return
  const resp = ctx.event.message
  if (resp.type !== "response") return

  const leg = findLeg(state.call, legId)
  if (leg === undefined) return

  const toTag = resp.parsed?.to?.tag ?? ""
  const legContact = resp.parsed?.contact?.uri ?? ""

  // RFC 3261 §12.1.2: capture the route set from the response's Record-Route
  // headers, in reverse order. The B2BUA is the UAC on the b-leg, so Bob's
  // RR entries define the proxy path that subsequent in-dialog requests
  // (ACK, BYE, re-INVITE, PRACK, INFO/UPDATE) must traverse.
  const recordRoutes = getHeaders(resp.headers, "record-route")
  const routeSet = recordRoutes.length > 0 ? [...recordRoutes].reverse() : []

  // Confirm existing early dialog or create new one. The placeholder dialog
  // (toTag="") seeded at b-leg creation carries the INVITE CSeq; any existing
  // fork dialog carries the INVITE CSeq echoed from its 1xx. ACK for 2xx
  // sources its CSeq from `pendingInviteTxn.originalInvite` (RFC 3261
  // §13.2.2.4), so `dialog.sip.localCSeq` here only needs to be a floor for
  // the next request we originate on this dialog.
  // Identity-key side: a-leg → localTag; b-leg → remoteTag. Placeholder has
  // empty identity tag in both directions, so we key off the correct side.
  const isALeg = leg.legId === "a"
  const placeholder = leg.dialogs.find((d) =>
    isALeg ? d.sip.localTag === "" : d.sip.remoteTag === "")
  const respCSeqHeader = getHeader(resp.headers, "cseq") ?? ""
  const respCSeqNum = parseInt(respCSeqHeader, 10)
  const baseCSeq = Number.isFinite(respCSeqNum) && respCSeqNum > 0
    ? respCSeqNum
    : placeholder?.sip.localCSeq ?? randomInitialCSeq()
  const existingDialog = leg.dialogs.find((d) =>
    isALeg ? d.sip.localTag === toTag : d.sip.remoteTag === toTag)
  const nextCSeq = existingDialog !== undefined
    ? Math.max(baseCSeq, existingDialog.sip.localCSeq)
    : baseCSeq
  const dialog: Dialog = existingDialog
    ? {
        sip: { ...existingDialog.sip, remoteTarget: legContact, localCSeq: nextCSeq, routeSet },
        ext: existingDialog.ext,
      }
    : (() => {
        const legCtx: MakeDialogLegCtx = {
          callId: leg.callId,
          localUri: leg.localUri ?? "",
          remoteUri: leg.remoteUri ?? "",
          localTag: isALeg ? toTag : leg.fromTag,
          remoteTag: isALeg ? leg.fromTag : toTag,
        }
        const base = makeEmptyDialog(legCtx)
        return {
          sip: { ...base.sip, remoteTarget: legContact, localCSeq: nextCSeq, routeSet },
          ext: base.ext,
        }
      })()

  state.call = updateLeg(state.call, leg.legId, (l) => ({
    ...l,
    dialogs: [dialog],
  }))
}

// ── update-leg-state (primitive) ──────────────────────────────────────────

/**
 * Set `leg.state` (and optionally `leg.disposition`) on the named leg.
 *
 * Reach: legs.{action.legId}.state + .disposition — nothing else.
 */
function executeUpdateLegState(
  action: Extract<RuleAction, { type: "update-leg-state" }>,
  state: ExecutionState,
): void {
  const { type, legId, state: legState, disposition } = action
  void type

  const leg = findLeg(state.call, legId)
  if (leg === undefined) return
  state.call = setLegState(state.call, legId, legState)
  if (disposition !== undefined) {
    state.call = setLegDisposition(state.call, legId, disposition)
  }
}

// ── stamp-dialog-to-tag (primitive) ───────────────────────────────────────

/**
 * Stamp an explicit toTag onto the named leg's dialog[0]. Used on the a-leg
 * (UAS side) when the B2BUA picks the a-facing tag at 200-OK time and needs
 * to align the a-leg dialog with it.
 *
 * When the leg has no dialog yet:
 *   - legId === "a" → uses makeDialogFromIncoming(toTag, aLegInviteCSeqNum(call))
 *     so Alice's inbound CSeq floor is preserved.
 *   - other legs    → uses makeEmptyDialog(toTag).
 *
 * Reach: legs.{action.legId}.dialogs[0].toTag (or a freshly created dialog[0]).
 */
function executeStampDialogToTag(
  action: Extract<RuleAction, { type: "stamp-dialog-to-tag" }>,
  state: ExecutionState,
): void {
  const { type, legId, toTag } = action
  void type

  const leg = findLeg(state.call, legId)
  if (leg === undefined) return

  const isALeg = legId === "a"
  if (leg.dialogs.length === 0) {
    const legCtx: MakeDialogLegCtx = {
      callId: leg.callId,
      localUri: leg.localUri ?? "",
      remoteUri: leg.remoteUri ?? "",
      localTag: isALeg ? toTag : leg.fromTag,
      remoteTag: isALeg ? leg.fromTag : toTag,
    }
    // RFC 3261 §12.1.1: UAS dialog route set is the request's
    // Record-Route headers in order. See `executeRelayResponse` for the
    // companion site that hits the same code path on the relay branch.
    const aLegRouteSet = isALeg
      ? getHeaders(state.call.aLegInvite.headers, "record-route")
      : []
    // RFC 3261 §12.1.1: UAS remote target is the UAC's Contact URI. For
    // A-leg this is alice's Contact from the cached INVITE; without it,
    // worker-originated A-leg in-dialog requests (BYE, UPDATE, NOTIFY)
    // fall back to `legTarget(aLeg)` — the proxy's address in proxy+b2b
    // — and loop. Mirrors the seeding in `executeRelayResponse`.
    const aLegInviteContact = isALeg
      ? (() => {
          const raw = getHeader(state.call.aLegInvite.headers, "contact")
          return raw !== undefined ? extractContactUri(raw) : ""
        })()
      : ""
    const baseDialog = isALeg
      ? makeDialogFromIncoming(legCtx, aLegInviteCSeqNum(state.call), aLegRouteSet)
      : makeEmptyDialog(legCtx)
    const dialog: Dialog = isALeg
      ? { ...baseDialog, sip: { ...baseDialog.sip, remoteTarget: aLegInviteContact } }
      : baseDialog
    state.call = updateLeg(state.call, legId, (l) => ({
      ...l,
      dialogs: [dialog],
    }))
    return
  }

  const existing = leg.dialogs[0]!
  const stamped: Dialog = isALeg
    ? { sip: { ...existing.sip, localTag: toTag }, ext: existing.ext }
    : { sip: { ...existing.sip, remoteTag: toTag }, ext: existing.ext }
  state.call = updateLeg(state.call, legId, (l) => ({
    ...l,
    dialogs: [stamped, ...l.dialogs.slice(1)],
  }))
}

// ── ack-leg ────────────────────────────────────────────────────────────────

function executeAckLeg(
  action: Extract<RuleAction, { type: "ack-leg" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, legId } = action
  void type

  const leg = findLeg(state.call, legId)
  if (leg === undefined) return
  const dialog = leg.dialogs[0]
  if (dialog === undefined) return

  const target = legTarget(leg)
  const targetUri = dialog.sip.remoteTarget || `sip:${target.host}:${target.port}`
  // RFC 3261 §13.2.2.4: ACK for 2xx echoes the INVITE's CSeq. The INVITE is
  // cached on `pendingInviteTxn` (leg for initial, dialog for re-INVITE).
  const handle = dialog.ext.pendingInviteTxn ?? leg.pendingInviteTxn
  const fallbackCSeq = inviteCSeqFromHandle(leg, dialog) ?? dialog.sip.localCSeq ?? 1

  // Dialog-leg asymmetry — B2BUA's outbound request needs the local/remote
  // tags rendered as From/To correctly. For leg.legId === "a", the B2BUA's
  // pinned localTag lives on dialog.sip.localTag already (and remoteTag is
  // Alice's fromTag). For b-leg, same mapping — the generator uses
  // dialog.sip.{localTag, remoteTag, localUri, remoteUri} directly.
  void directionalTags // retained import for other paths

  // RFC 3261 §17.1.1.2: ACK for 2xx is its own hop; reuse the cached branch
  // on retransmit so the UAS correlates re-ACKs and stops retransmitting 2xx.
  const cachedBranch = dialog.ext.ackBranch
  const { via, branch } = legStackIdentity(state.call, legId, ctx.config, cachedBranch)
  const ackMsg = generateAckFor2xx(handle as InviteClientTransactionHandle | undefined, dialog.sip, {
    via,
    cseq: fallbackCSeq,
    requestUri: targetUri,
  })
  if (cachedBranch === undefined) {
    state.call = updateDialog(state.call, legId, dialogIdentityTag(legId, dialog), (d) => ({
      ...d,
      ext: { ...d.ext, ackBranch: branch },
    }))
  }
  const routed = applyRouteSet(ackMsg, dialog, target)

  state.outbound.push({
    message: routed.msg,
    destination: routed.target,
    label: `ACK ${legId}`,
    legId,
  })
}

// ── send-request-to-leg ───────────────────────────────────────────────────

/**
 * Generate a new SIP request (e.g., OPTIONS, INFO, UPDATE) and send it to a leg.
 * Framework handles CSeq bump, tag lookup, and message construction.
 * Used by keepalive (OPTIONS), and potentially by custom rules (INFO, UPDATE).
 */
function executeSendRequestToLeg(
  action: Extract<RuleAction, { type: "send-request-to-leg" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, legId, method, body } = action
  void type

  const leg = findLeg(state.call, legId)
  if (leg === undefined || leg.state === "terminated") return
  const dialog = leg.dialogs[0]
  if (dialog === undefined) return

  // Only methods supported by the in-dialog generator; reject unknowns early
  // so SIP semantics stay explicit and typed.
  if (method !== "OPTIONS" && method !== "INFO" && method !== "UPDATE" && method !== "MESSAGE") {
    return
  }

  const target = legTarget(leg)
  const requestUri = dialog.sip.remoteTarget || `sip:${target.host}:${target.port}`
  const { via, contact } = legStackIdentity(state.call, legId, ctx.config)
  const { request, dialog: newSip } = generateInDialogRequest(
    method,
    dialog.sip,
    { via, contact, requestUri, ...(body !== undefined ? { body } : {}) },
  )
  // eslint-disable-next-line no-console
  console.log(
    `[diag] send-request-to-leg ${method} leg=${legId} pre.localCSeq=${dialog.sip.localCSeq} post.localCSeq=${newSip.localCSeq}`
  )
  state.call = updateDialog(state.call, leg.legId, dialogIdentityTag(leg.legId, dialog), (d) => ({
    ...d,
    sip: newSip,
  }))

  const routed = applyRouteSet(request, dialog, target)
  state.outbound.push({
    message: routed.msg,
    destination: routed.target,
    label: `${method} to ${legId}`,
    legId,
  })
}

// ── cache-sdp-on-leg-dialog ───────────────────────────────────────────────

/**
 * Stash an SDP body on a specific b-leg dialog so the 200 OK INVITE relay
 * can later substitute it into the response toward alice. Identifies the
 * dialog by `bTag` to handle forking (multiple early dialogs per leg).
 *
 * Drives the `relayFirst18xTo180` `fake-prack` strategy: bob's reliable-1xx
 * SDP (the answer to alice's offer) and any UPDATE re-offer are captured
 * here so alice never sees them until the 200 OK substitution.
 */
function executeCacheSdpOnLegDialog(
  action: Extract<RuleAction, { type: "cache-sdp-on-leg-dialog" }>,
  state: ExecutionState,
): void {
  const { type, legId, bTag, body } = action
  void type

  const leg = findLeg(state.call, legId)
  if (leg === undefined) return
  // Match on identity tag (b-leg → remoteTag); fall back to dialogs[0] only
  // when no specific dialog matches (shouldn't happen with proper bTag).
  state.call = updateDialog(state.call, legId, bTag, (d) => ({
    ...d,
    ext: { ...d.ext, cachedSdp: body },
  }))
}

// ── send-prack-to-leg ─────────────────────────────────────────────────────

/**
 * Synthesize a PRACK toward a b-leg that sent a reliable 1xx (Require:100rel,
 * RSeq). Used when the B2BUA receives a reliable provisional it is not
 * relaying to the a-leg (e.g. suppress-18x policy) and must ack locally to
 * stop the UAS retransmitting.
 *
 * Requires an early dialog on the target leg with the `bTag` from the 1xx.
 * The dialog is created by relayResponseMsg() when the reliable 1xx is
 * processed — this action must therefore follow the relay action in the
 * action sequence.
 */
function executeSendPrackToLeg(
  action: Extract<RuleAction, { type: "send-prack-to-leg" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, legId, rseq, inviteCSeq, bTag } = action
  void type

  const leg = findLeg(state.call, legId)
  if (leg === undefined || leg.state === "terminated") return
  const dialog = leg.dialogs.find((d) => dialogIdentityTag(leg.legId, d) === bTag) ?? leg.dialogs[0]
  if (dialog === undefined) return

  const target = legTarget(leg)
  const requestUri = dialog.sip.remoteTarget || `sip:${target.host}:${target.port}`
  const rack = `${rseq} ${inviteCSeq} INVITE`

  const { via, contact } = legStackIdentity(state.call, legId, ctx.config)
  const { request, dialog: newSip } = generateInDialogRequest(
    "PRACK",
    dialog.sip,
    { via, contact, rack, requestUri },
  )
  state.call = updateDialog(state.call, leg.legId, dialogIdentityTag(leg.legId, dialog), (d) => ({
    ...d,
    sip: newSip,
  }))

  const routed = applyRouteSet(request, dialog, target)
  state.outbound.push({
    message: routed.msg,
    destination: routed.target,
    label: `PRACK to ${legId}`,
    legId,
  })
}

// ── create-leg ─────────────────────────────────────────────────────────────

function executeCreateLeg(
  action: Extract<RuleAction, { type: "create-leg" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, destination, fromInvite, noAnswerTimeoutSec, callbackContext, bodyUpdate, headerUpdates, ruri } = action
  void type

  // Resolve the base INVITE to clone.
  let baseInvite: SipRequest | undefined
  if (fromInvite === "snapshot") {
    const snapshot = state.call.aLegInvite
    baseInvite = hydrateRequest({
      method: "INVITE",
      uri: snapshot.uri,
      headers: snapshot.headers.map((h) => ({ name: h.name, value: h.value })),
      body: snapshot.body,
      raw: Buffer.from(snapshot.body),
    })
  } else if (fromInvite !== undefined) {
    baseInvite = fromInvite
  }

  // ── Body: apply the typed BodyUpdate to the cloned base INVITE. ──
  // `inherit` is a no-op; `set`/`drop` rewrite the bytes and Content-Length.
  if (
    baseInvite !== undefined
    && bodyUpdate !== undefined
    && bodyUpdate.kind !== "inherit"
  ) {
    baseInvite = applyBodyUpdate(baseInvite, bodyUpdate)
    baseInvite = { ...baseInvite, raw: Buffer.from(baseInvite.body) }
  }

  // ── Request-URI: typed RuriOp. `kind:"inherit"` collapses to undefined
  // so createBLegFromRoute falls back to the base INVITE's URI. ──
  const ruriOverride: string | undefined =
    ruri !== undefined && ruri.kind === "set"
      ? (ruri.value as string)
      : undefined

  const port = destination.port ?? 5060
  const result = createBLegFromRoute({
    call: state.call,
    baseInvite,
    route: {
      destination: { host: destination.host, port },
      new_ruri: ruriOverride,
      // Header updates are applied *after* the INVITE is built — pass
      // through nothing here so multi-valued headers (Diversion, Supported)
      // are not collapsed by the Record<string, string | null> shape.
      update_headers: undefined,
      no_answer_timeout_sec: noAnswerTimeoutSec,
      callback_context: callbackContext,
    },
    config: ctx.config,
    nowMs: ctx.nowMs,
  })

  state.call = result.call

  // Apply the typed header updates to the outbound INVITE envelope.
  let outbound = result.outbound
  if (headerUpdates !== undefined && outbound.length > 0) {
    const first = outbound[0]!
    if (first.message.type === "request") {
      const patched = applyHeaderUpdates(first.message, headerUpdates)
      outbound = [{ ...first, message: patched }, ...outbound.slice(1)]
    }
  }

  state.outbound.push(...outbound)
  state.effects.push(...result.effects)
}

// ── destroy-leg (composite) ───────────────────────────────────────────────

/**
 * Destroy a single leg: emit the appropriate teardown SIP message and mark
 * the leg terminated, breaking any peer pairing.
 *
 * Reach (Slice C audit — intentional composite, scope declared in action contract):
 *   legs.{action.legId}.state          → "terminated" (always)
 *   legs.{action.legId}.byeDisposition → "bye_sent" | "cancelled"
 *   legs.{action.legId}.disposition    → "cancelling" (only on trying/early path)
 *   call.activePeer                    → null when the leg was part of the pair
 *
 * Behaviour by leg state:
 *   - terminated          → no-op.
 *   - confirmed           → BYE dialog[0]; byeDisposition = "bye_sent".
 *   - cancelling          → no SIP (CANCEL already in flight); byeDisposition = "cancelled".
 *   - trying / early      → CANCEL; disposition = "cancelling"; byeDisposition = "cancelled".
 *
 * Prefer `cancel-leg` over `destroy-leg` for trying/early legs when the leg
 * must stay alive to resolve a CANCEL/200-crossing race (RFC 3261 §9.1).
 */
function executeDestroyLeg(
  action: Extract<RuleAction, { type: "destroy-leg" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, legId } = action
  void type

  const leg = findLeg(state.call, legId)
  if (leg === undefined || leg.state === "terminated") return

  const target = legTarget(leg)

  if (leg.state === "confirmed") {
    // BYE a confirmed leg
    const dialog = leg.dialogs[0]
    if (dialog !== undefined) {
      const requestUri = dialog.sip.remoteTarget || `sip:${target.host}:${target.port}`
      const { via, contact } = legStackIdentity(state.call, legId, ctx.config)
      const { request, dialog: newSip } = generateInDialogRequest("BYE", dialog.sip, { via, contact, requestUri })
      state.call = updateDialog(state.call, leg.legId, dialogIdentityTag(leg.legId, dialog), (d) => ({
        ...d,
        sip: newSip,
      }))
      const routed = applyRouteSet(request, dialog, target)
      state.outbound.push({
        message: routed.msg,
        destination: routed.target,
        label: `BYE ${legId}`,
        legId,
      })
    }
    state.call = setByeDisposition(state.call, legId, "bye_sent")
  } else if (leg.disposition === "cancelling") {
    // CANCEL already in flight via executeCancelLeg — do not re-emit
    // (RFC 3261 §9.1 / §17.1.3: each CANCEL is a separate transaction with
    // a distinct branch, but the UAS key is CallId+branch of the target
    // INVITE, so a second CANCEL with the reused INVITE branch would either
    // be absorbed as a retransmit or rejected). Just record disposition and
    // let resolveCancelResponseRule/cancel200CrossingRule finish cleanup.
    state.call = setByeDisposition(state.call, legId, "cancelled")
  } else {
    // CANCEL an early/trying leg
    const env = buildCancelEnvelope(leg, "")
    if (env !== undefined) state.outbound.push(env)
    state.call = setByeDisposition(state.call, legId, "cancelled")
    state.call = setLegDisposition(state.call, legId, "cancelling")
  }

  state.call = setLegState(state.call, legId, "terminated")
  // Split from peer if peered
  state.call = splitLeg(state.call, legId)
}

// ── cancel-leg (primitive) ────────────────────────────────────────────────

/**
 * Send CANCEL for an outstanding early/trying b-leg INVITE but KEEP the leg
 * alive. Sets leg.disposition = "cancelling" so subsequent rules can resolve
 * the leg when bob responds:
 *   - Final non-2xx (e.g. 487) → resolve-cancel-response terminates the leg.
 *   - Crossing 2xx → cancel-200-crossing ACKs and BYEs (RFC 3261 §9.1).
 *
 * Reach (Slice C audit — primitive, single named field):
 *   legs.{action.legId}.disposition → "cancelling"
 *
 * No other state is mutated. `byeDisposition` is deliberately NOT set here —
 * cancel-resolving rules decide whether the eventual outcome is "cancelled",
 * a BYE exchange, or anything else. One outbound CANCEL envelope is pushed
 * on success.
 *
 * Called only by handle-cancel. For confirmed legs, use destroy-leg (BYE).
 */
function executeCancelLeg(
  action: Extract<RuleAction, { type: "cancel-leg" }>,
  _ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, legId } = action
  void type

  const leg = findLeg(state.call, legId)
  if (leg === undefined) return
  if (leg.state === "terminated") return
  if (leg.state === "confirmed") return // caller should have used destroy-leg

  const env = buildCancelEnvelope(leg, "")
  if (env !== undefined) state.outbound.push(env)
  state.call = setLegDisposition(state.call, legId, "cancelling")
}

// ── schedule-timer ─────────────────────────────────────────────────────────

function executeScheduleTimer(
  action: Extract<RuleAction, { type: "schedule-timer" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, timerType, delaySec, legId } = action
  void type

  const timerId = `${timerType}-${ctx.callRef}${legId ? `-${legId}` : ""}`
  const timer: TimerEntry = {
    id: timerId,
    type: timerType,
    fireAt: ctx.nowMs + delaySec * 1000,
    legId,
  }
  // Dedup by id so the persisted `call.timers` list mirrors the
  // in-memory `TimerService.fibersMap` semantics (MutableHashMap.set
  // replaces by id). Without this, every cycle of a recurring timer
  // (keepalive, limiter_refresh, …) appends a new entry without
  // removing the stale predecessor; on a worker restart the rehydration
  // path then respawns ALL of them, including ones whose fireAt has
  // already elapsed, which fires duplicate handlers and (for keepalive)
  // re-arms the keepalive_timeout that the in-flight 200 OK already
  // cancelled, blocking the next keepalive cycle.
  state.call = {
    ...state.call,
    timers: [
      ...state.call.timers.filter((t) => t.id !== timerId),
      timer,
    ],
  }
  state.effects.push({ type: "schedule-timer", timer })
}

// ── terminate-call (composite) ────────────────────────────────────────────

/**
 * Terminate the entire call immediately. Marks all legs terminated, sends
 * BYE/CANCEL to all peered legs, clears peering.
 *
 * Reach (Slice C audit — intentional call-scope composite):
 *   Every leg.state       → "terminated"
 *   call.state            → "terminated"
 *   call.activePeer       → null
 *   Outbound              → BYE for every confirmed leg (via dialog[0]),
 *                            CANCEL for every trying/early b-leg. No wait
 *                            for response — fire and forget.
 *
 * All production rules should prefer `begin-termination` so BYE/CANCEL
 * responses are correlated through the normal terminating phase and the
 * safety timer. `terminate-call` exists for onError:"terminate" fallout
 * and `InvariantEnforcer` adds limiter/timer/CDR/removal automatically.
 */
function executeTerminateCall(
  ctx: RuleContext,
  state: ExecutionState,
): void {
  // BYE or CANCEL all legs that are still alive and peered
  for (const leg of [state.call.aLeg, ...state.call.bLegs]) {
    if (leg.state === "terminated") continue

    if (leg.state === "confirmed") {
      const dialog = leg.dialogs[0]
      if (dialog !== undefined) {
        const target = legTarget(leg)
        const requestUri = dialog.sip.remoteTarget || `sip:${target.host}:${target.port}`
        const { via, contact } = legStackIdentity(state.call, leg.legId, ctx.config)
        const { request, dialog: newSip } = generateInDialogRequest("BYE", dialog.sip, { via, contact, requestUri })
        state.call = updateDialog(state.call, leg.legId, dialogIdentityTag(leg.legId, dialog), (d) => ({
          ...d,
          sip: newSip,
        }))
        const routed = applyRouteSet(request, dialog, target)
        state.outbound.push({
          message: routed.msg,
          destination: routed.target,
          label: `BYE ${leg.legId} (terminate)`,
          legId: leg.legId,
        })
      }
    } else if (leg.state === "trying" || leg.state === "early") {
      if (leg.legId !== "a") {
        const env = buildCancelEnvelope(leg, " (terminate)")
        if (env !== undefined) state.outbound.push(env)
      }
    }
  }

  // Mark everything terminated
  state.call = {
    ...state.call,
    state: "terminated",
    activePeer: null,
    aLeg: { ...state.call.aLeg, state: "terminated" },
    bLegs: state.call.bLegs.map((l) => ({ ...l, state: "terminated" as const })),
  }
}

// ── begin-termination (composite) ─────────────────────────────────────────

/**
 * Graceful call termination — the standard teardown path for all rules.
 *
 * Reach (Slice C audit — intentional call-scope composite):
 *   For each leg not already resolved (not terminated, no byeDisposition,
 *   not cancelling):
 *     - confirmed           → send BYE; byeDisposition = "bye_sent"
 *     - trying/early b-leg  → send CANCEL; byeDisposition = "cancelled";
 *                              state = "terminated"
 *     - trying/early a-leg  → byeDisposition = "none" (rule already
 *                              sent the SIP reply)
 *   call.state              → "terminating"
 *   call.timers             → append `terminating_timeout-{callRef}` (64s)
 *   effects                 → cancel-all-timers, schedule-timer (safety),
 *                              write-cdr, flush-redis
 *
 * Rules MUST pre-mark legs they already handled (e.g., the leg that sent
 * us a BYE gets byeDisposition: "bye_received" via terminate-leg action)
 * before emitting begin-termination. This prevents duplicate BYE sends.
 *
 * The framework (RuleExecutor) checks isFullyResolved() after this — if
 * all legs are already resolved, immediate transition to "terminated"
 * happens without waiting. `call.activePeer` is NOT touched here: the
 * terminating phase deliberately preserves the pairing so response relay
 * (e.g. final BYE 200 OK from one side to the other) still routes
 * correctly. Peering is cleared naturally as legs reach terminal state.
 */
function executeBeginTermination(
  ctx: RuleContext,
  state: ExecutionState,
): void {
  for (const leg of [state.call.aLeg, ...state.call.bLegs]) {
    // Skip legs already handled by the rule or already resolved
    if (leg.state === "terminated") continue
    if (leg.byeDisposition !== undefined) continue
    // Skip legs currently being cancelled — cancel-leg already sent CANCEL
    // and keeps the leg alive so we can resolve the CANCEL/2xx crossing
    // race when bob's final response arrives.
    if (leg.disposition === "cancelling") continue

    if (leg.state === "confirmed") {
      // Send BYE to confirmed leg — await 200 OK or timeout
      const dialog = leg.dialogs[0]
      if (dialog !== undefined) {
        const target = legTarget(leg)
        const requestUri = dialog.sip.remoteTarget || `sip:${target.host}:${target.port}`
        const { via, contact } = legStackIdentity(state.call, leg.legId, ctx.config)
        const { request, dialog: newSip } = generateInDialogRequest("BYE", dialog.sip, { via, contact, requestUri })
        state.call = updateDialog(state.call, leg.legId, dialogIdentityTag(leg.legId, dialog), (d) => ({
          ...d,
          sip: newSip,
        }))
        const routed = applyRouteSet(request, dialog, target)
        state.outbound.push({
          message: routed.msg,
          destination: routed.target,
          label: `BYE ${leg.legId} (begin-termination)`,
          legId: leg.legId,
        })
      }
      state.call = setByeDisposition(state.call, leg.legId, "bye_sent")
    } else if (leg.state === "trying" || leg.state === "early") {
      if (leg.legId !== "a") {
        // CANCEL trying/early b-legs
        const env = buildCancelEnvelope(leg, " (begin-termination)")
        if (env !== undefined) state.outbound.push(env)
        state.call = setByeDisposition(state.call, leg.legId, "cancelled")
        state.call = setLegState(state.call, leg.legId, "terminated")
      } else {
        // a-leg in trying/early — no SIP message needed (rule already handled it)
        state.call = setByeDisposition(state.call, leg.legId, "none")
      }
    }
  }

  // Transition to "terminating"
  state.call = { ...state.call, state: "terminating" }

  // Cancel all active timers (keepalive, duration, etc.)
  state.effects.push({ type: "cancel-all-timers" })

  // Schedule 64s safety timer (2x RFC 3261 Timer B/F)
  const TERMINATING_TIMEOUT_MS = 64_000
  const safetyTimer: TimerEntry = {
    id: `terminating-timeout-${ctx.callRef}`,
    type: "terminating_timeout",
    fireAt: ctx.nowMs + TERMINATING_TIMEOUT_MS,
  }
  state.call = { ...state.call, timers: [...state.call.timers, safetyTimer] }
  state.effects.push({ type: "schedule-timer", timer: safetyTimer })

  // Persist mid-teardown state for crash recovery. CDR is written exactly
  // once when the call transitions to `terminated` — the InvariantEnforcer
  // injects the `write-cdr` effect there. Emitting it here too produced a
  // duplicate record per call (one with state="terminating", one with
  // state="terminated"); the second carries the final state, so the first
  // is just billing noise.
  state.effects.push({ type: "flush-redis" })
}

// ── send-notify ───────────────────────────────────────────────────────────

/**
 * Emit a NOTIFY within an established dialog on the given leg.
 *
 * Used by REFER-driven transfer to report subscription progress (100 Trying,
 * 200 OK, 503 Service Unavailable, etc.) back to the referrer via a sipfrag
 * body. Framework handles CSeq bump, tag direction, route-set application.
 */
function executeSendNotify(
  action: Extract<RuleAction, { type: "send-notify" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, legId, event, subscriptionState, contentType, body } = action
  void type

  const leg = findLeg(state.call, legId)
  if (leg === undefined || leg.state === "terminated") return
  const dialog = leg.dialogs[0]
  if (dialog === undefined) return

  const target = legTarget(leg)
  const requestUri = dialog.sip.remoteTarget || `sip:${target.host}:${target.port}`

  const { via, contact } = legStackIdentity(state.call, legId, ctx.config)
  const { request, dialog: newSip } = generateInDialogRequest("NOTIFY", dialog.sip, {
    via,
    contact,
    requestUri,
    event,
    subscriptionState,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(body !== undefined ? { body } : {}),
  })
  state.call = updateDialog(state.call, leg.legId, dialogIdentityTag(leg.legId, dialog), (d) => ({
    ...d,
    sip: newSip,
  }))

  const routed = applyRouteSet(request, dialog, target)
  state.outbound.push({
    message: routed.msg,
    destination: routed.target,
    label: `NOTIFY ${legId}`,
    legId,
  })
}

// ── send-reinvite ─────────────────────────────────────────────────────────

/**
 * Emit a B2BUA-originated re-INVITE on the named leg's confirmed dialog.
 *
 * Used by the REFER transfer flow (c-realigning, a-realigning) to swap SDP
 * on an already-established leg. Framework bumps the dialog CSeq, stamps
 * Contact/Via placeholders via the standard SipRouter path (which also
 * captures the `pendingInviteTxn` handle the matching ACK will consult
 * for CSeq — RFC 3261 §13.2.2.4), and applies the dialog route set.
 *
 * Body semantics:
 *   - `bodyUpdate: { kind: "set", value }` — carry the given SDP offer.
 *   - `bodyUpdate: { kind: "drop" }` or omitted — empty body.
 *   - `bodyUpdate: { kind: "inherit" }` — not meaningful (no base body to
 *     inherit from); treated as drop.
 *
 * Reach (Slice C audit — primitive, single named leg):
 *   legs.{legId}.dialogs[0].localCSeq     → +1
 *
 * No tagMap touch; no peer mutation. Responses are matched by transfer rules
 * via `direction` + `filter` and handled explicitly (no pending-request
 * snapshot is recorded because the response is not transparently relayed).
 */
function executeSendReinvite(
  action: Extract<RuleAction, { type: "send-reinvite" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, legId, bodyUpdate, headerUpdates } = action
  void type

  const leg = findLeg(state.call, legId)
  if (leg === undefined || leg.state === "terminated") return
  const dialog = leg.dialogs[0]
  if (dialog === undefined) return

  const target = legTarget(leg)
  const requestUri = dialog.sip.remoteTarget || `sip:${target.host}:${target.port}`

  // `inherit` would normally copy the relayed message body, but send-reinvite
  // has no base body — collapse inherit to drop (empty body).
  const body = bodyUpdate !== undefined && bodyUpdate.kind === "set"
    ? bodyUpdate.value
    : new Uint8Array(0)

  const { via, contact, branch } = legStackIdentity(state.call, legId, ctx.config)
  let { request: reinvite, dialog: newSip } = generateInDialogRequest(
    "INVITE",
    dialog.sip,
    { via, contact, requestUri, body },
  )
  if (headerUpdates !== undefined) {
    reinvite = applyHeaderUpdates(reinvite, headerUpdates)
  }

  // Capture the INVITE handle so ACK-for-2xx reads CSeq from here
  // (RFC 3261 §13.2.2.4) and CANCEL can reuse the branch (§9.1). Re-INVITE
  // handle lives on the confirmed dialog.
  const reInviteHandle: InviteTxnHandle = {
    kind: "invite",
    branch,
    originalInvite: reinvite,
    destination: target,
  }
  state.call = updateDialog(state.call, leg.legId, dialogIdentityTag(leg.legId, dialog), (d) => ({
    ...d,
    sip: newSip,
    ext: { ...d.ext, pendingInviteTxn: reInviteHandle },
  }))

  const routed = applyRouteSet(reinvite, dialog, target)
  state.outbound.push({
    message: routed.msg,
    destination: routed.target,
    label: `re-INVITE ${legId}`,
    legId,
  })
}

// ── update-transfer ───────────────────────────────────────────────────────

/**
 * Merge a Partial<TransferState> onto `call.transfer`, or seed it when absent.
 *
 * When seeding from empty, the caller must include every required field of
 * TransferState (phase, referrerLegId, referToUri, startedAtMs). Subsequent
 * updates typically flip the phase or attach the created C-leg id / callback
 * context.
 */
function executeUpdateTransfer(
  action: Extract<RuleAction, { type: "update-transfer" }>,
  _ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, update } = action
  void type

  const existing = state.call.transfer ?? null
  const merged = (existing === null
    ? (update as TransferState)
    : { ...existing, ...update }) satisfies TransferState
  state.call = { ...state.call, transfer: merged }
}

// ── merge / split (peering primitives) ────────────────────────────────────

function executeMerge(
  action: Extract<RuleAction, { type: "merge" }>,
  state: ExecutionState,
): void {
  const { type, legA, legB } = action
  void type
  // Reach: call.activePeer → { legA, legB }. Both legs named in parameters.
  state.call = mergeLeg(state.call, legA, legB)
}

function executeSplit(
  action: Extract<RuleAction, { type: "split" }>,
  state: ExecutionState,
): void {
  const { type, legId } = action
  void type
  // Reach: call.activePeer → null when legId is part of the pair. Clearing
  // activePeer structurally un-peers both sides — inherent to the singleton
  // representation, not a hidden mutation of the other leg's own state.
  state.call = splitLeg(state.call, legId)
}

// ── cancel-timer ──────────────────────────────────────────────────────────

function executeCancelTimer(
  action: Extract<RuleAction, { type: "cancel-timer" }>,
  state: ExecutionState,
): void {
  const { type, timerId } = action
  void type
  state.effects.push({ type: "cancel-timer", id: timerId })
  state.call = { ...state.call, timers: state.call.timers.filter((t) => t.id !== timerId) }
}

// ── terminate-leg (primitive) ─────────────────────────────────────────────

function executeTerminateLeg(
  action: Extract<RuleAction, { type: "terminate-leg" }>,
  state: ExecutionState,
): void {
  const { type, legId, byeDisposition } = action
  void type
  // Reach: legs.{legId}.state → "terminated"; legs.{legId}.byeDisposition
  // → byeDisposition (only when set). No call-level mutation, no peer touch.
  state.call = setLegState(state.call, legId, "terminated")
  if (byeDisposition !== undefined) {
    state.call = setByeDisposition(state.call, legId, byeDisposition)
  }
}

// ── add-cdr-event ─────────────────────────────────────────────────────────

function executeAddCdrEvent(
  action: Extract<RuleAction, { type: "add-cdr-event" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, eventType, legId, statusCode, reason } = action
  void type
  state.call = addCdrEvent(state.call, {
    type: eventType,
    timestamp: ctx.nowMs,
    legId,
    statusCode,
    reason,
  })
}

// ── add-tag-mapping ───────────────────────────────────────────────────────

function executeAddTagMapping(
  action: Extract<RuleAction, { type: "add-tag-mapping" }>,
  state: ExecutionState,
): void {
  const { type, aTag, bLegId, bTag } = action
  void type
  state.call = addTagMapping(state.call, { aTag, bLegId, bTag })
}

// ── send-raw (escape hatch) ───────────────────────────────────────────────

function executeSendRaw(
  action: Extract<RuleAction, { type: "send-raw" }>,
  state: ExecutionState,
): void {
  const { type, message, destination, label } = action
  void type
  state.outbound.push({
    message,
    destination: { host: destination.address, port: destination.port },
    label,
  })
}

// ── refer-async-http ──────────────────────────────────────────────────────

function executeReferAsyncHttp(
  action: Extract<RuleAction, { type: "refer-async-http" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const { type, request } = action
  void type
  state.effects.push({ type: "refer-async-http", callRef: ctx.callRef, request })
}
