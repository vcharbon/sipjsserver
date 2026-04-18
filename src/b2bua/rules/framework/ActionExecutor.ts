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
import type { BodyUpdate, HeaderUpdates } from "./actions/types.js"
import type { HandlerResult, OutboundEnvelope, SideEffect } from "../../../sip/SipRouter.js"
import type { SipHeader, SipRequest, SipResponse } from "../../../sip/types.js"
import type { TimerEntry, Leg, Dialog, TransferState } from "../../../call/CallModel.js"
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
} from "../../../call/CallModel.js"
import {
  buildAck,
  buildBye,
  buildCancel,
  buildNotify,
  buildRejectResponse,
  buildRelayedAck,
  buildRelayedBye,
  buildPrack,
  buildRelayedPrack,
  buildRelayedRequest,
  extractHostPort,
  getHeader,
  getHeaders,
  newTag,
  relayResponse,
  stripTag,
  buildOptions,
} from "../../../sip/MessageFactory.js"
import { createBLegFromRoute } from "../../helpers.js"

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
  if (dialog !== undefined && dialog.contact) {
    const hp = extractHostPort(dialog.contact)
    if (hp) return hp
  }
  return { host: leg.source.address, port: leg.source.port }
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
  if (dialog === undefined || dialog.routeSet.length === 0) return { msg, target }

  const firstRoute = dialog.routeSet[0]!
  const firstUri = extractUriFromRoute(firstRoute)
  const isLoose = /;lr(?![a-zA-Z0-9_-])/i.test(firstUri)
  if (!isLoose) return { msg, target }

  const routeHeaders: SipHeader[] = dialog.routeSet.map((uri) => ({ name: "Route", value: uri }))
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
  return { fromTag: targetLeg.fromTag, toTag: targetDialog.toTag }
}

/**
 * Build a CANCEL envelope for a b-leg's outstanding INVITE.
 *
 * RFC 3261 §9.1: CANCEL must copy Request-URI, CSeq number, and Via branch
 * from the original INVITE. Request-URI and CSeq are restored from the leg's
 * stored fields here; the Via branch is reused at stamp time by SipRouter
 * via the stored `inviteBranch`.
 */
function buildCancelEnvelope(
  leg: Leg,
  target: { host: string; port: number },
  labelSuffix: string,
): OutboundEnvelope {
  // RFC 3261 §9.1: CANCEL CSeq number equals the INVITE's CSeq.
  // Stored on the b-leg's placeholder/first dialog (seeded at leg creation
  // with the INVITE's CSeq — see createBLegFromRoute).
  const inviteCSeq = leg.dialogs[0]?.lastInviteCSeq ?? leg.dialogs[0]?.localCSeq ?? 1
  return {
    message: buildCancel(
      leg.callId,
      leg.fromTag,
      leg.inviteRequestUri ?? `sip:${target.host}:${target.port}`,
      inviteCSeq,
      leg.localUri,
      leg.remoteUri,
    ),
    destination: target,
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
      // Reach (Slice C audit — primitive): call.activePeer → { legA, legB }.
      // Both legs are named in the action parameters; no leg-level mutation.
      state.call = mergeLeg(state.call, action.legA, action.legB)
      break
    case "split":
      // Reach (Slice C audit — primitive): call.activePeer → null when the
      // named leg was part of the current pair. Clearing `activePeer`
      // structurally un-peers both sides — that is inherent to the singleton
      // representation, not a hidden mutation of another leg's own state.
      state.call = splitLeg(state.call, action.legId)
      break
    case "schedule-timer":
      executeScheduleTimer(action, ctx, state)
      break
    case "cancel-timer":
      state.effects.push({ type: "cancel-timer", id: action.timerId })
      state.call = { ...state.call, timers: state.call.timers.filter((t) => t.id !== action.timerId) }
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
      // Reach (Slice C audit — primitive):
      //   legs.{action.legId}.state          → "terminated"
      //   legs.{action.legId}.byeDisposition → action.byeDisposition (when set)
      // No call-level mutation, no peer touch, no outbound.
      state.call = setLegState(state.call, action.legId, "terminated")
      if (action.byeDisposition !== undefined) {
        state.call = setByeDisposition(state.call, action.legId, action.byeDisposition)
      }
      break
    case "add-cdr-event":
      state.call = addCdrEvent(state.call, {
        type: action.eventType,
        timestamp: ctx.nowMs,
        legId: action.legId,
        statusCode: action.statusCode,
        reason: action.reason,
      })
      break
    case "deactivate-rule":
      state.call = deactivateRule(state.call, ruleId)
      break
    case "add-tag-mapping":
      state.call = addTagMapping(state.call, {
        aTag: action.aTag, bLegId: action.bLegId, bTag: action.bTag,
      })
      break
    case "send-raw":
      state.outbound.push({
        message: action.message,
        destination: { host: action.destination.address, port: action.destination.port },
        label: action.label,
      })
      break
    case "send-notify":
      executeSendNotify(action, ctx, state)
      break
    case "update-transfer":
      executeUpdateTransfer(action, ctx, state)
      break
    case "clear-transfer":
      state.call = { ...state.call, transfer: null }
      break
    case "refer-async-http":
      state.effects.push({
        type: "refer-async-http",
        callRef: ctx.callRef,
        request: action.request,
      })
      break
  }
}

// ── respond ────────────────────────────────────────────────────────────────

function executeRespond(
  action: Extract<RuleAction, { type: "respond" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  if (ctx.event.type !== "sip") return
  const msg = ctx.event.message
  if (msg.type !== "request") return

  const response = buildRejectResponse(msg, action.status, action.reason ?? "")
  state.outbound.push({
    message: response,
    destination: { host: ctx.event.rinfo.address, port: ctx.event.rinfo.port },
    label: `respond ${action.status}`,
    legId: ctx.sourceLeg.legId,
  })
}

// ── relay-to-peer ──────────────────────────────────────────────────────────

function executeRelayToPeer(
  action: Extract<RuleAction, { type: "relay-to-peer" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
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

  executeRelayToTarget(peerLegId, action.transform, ctx, state, targetToTag)
}

// ── relay-to-leg ───────────────────────────────────────────────────────────

function executeRelayToLeg(
  action: Extract<RuleAction, { type: "relay-to-leg" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  executeRelayToTarget(action.legId, action.transform, ctx, state)
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
    ? targetLeg.dialogs.find((d) => d.toTag === targetToTag) ?? targetLeg.dialogs[0]
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
  const delta = isAck ? 0 : relayCSeqDelta(inboundCSeq, sourceDialog?.remoteCSeq ?? null)
  const outboundCSeq = targetDialog.localCSeq + delta

  if (!isAck) {
    // Update source leg's remoteCSeq
    if (sourceDialog) {
      state.call = updateRemoteCSeq(state.call, ctx.sourceLeg.legId, sourceDialog.toTag, inboundCSeq)
    }
    // Bump target leg's localCSeq
    state.call = bumpLocalCSeq(state.call, targetLeg.legId, targetDialog.toTag, delta)
  }

  const targetUri = targetDialog.contact || `sip:${target.host}:${target.port}`

  let relayed: SipRequest | SipResponse
  const { fromTag: dirFromTag, toTag: dirToTag } = directionalTags(state.call, targetLeg, targetDialog)

  switch (req.method) {
    case "INVITE": {
      relayed = buildRelayedRequest("INVITE", req, targetLeg.callId, dirFromTag, dirToTag, targetUri, outboundCSeq, targetLeg.localUri, targetLeg.remoteUri)
      // Remember this INVITE's CSeq so the ACK-for-2xx can echo it.
      state.call = updateDialog(state.call, targetLeg.legId, targetDialog.toTag, (d) => ({
        ...d, lastInviteCSeq: outboundCSeq,
      }))
      // Track pending request for response correlation
      state.call = addPendingRequest(state.call, targetLeg.legId, targetDialog.toTag, {
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
      // the dialog's localCSeq between the INVITE and the 2xx. lastInviteCSeq
      // tracks the most recent INVITE's CSeq (initial or re-INVITE) — always
      // populated at dialog creation (placeholder or forked 1xx).
      const ackCSeq = targetDialog.lastInviteCSeq ?? targetDialog.localCSeq
      relayed = buildRelayedAck(req, targetLeg.callId, dirFromTag, dirToTag, targetUri, ackCSeq, targetLeg.localUri, targetLeg.remoteUri)
      break
    }
    case "BYE": {
      relayed = buildRelayedBye(
        req, targetLeg.callId, dirFromTag, dirToTag, targetUri,
        `${outboundCSeq} BYE`,
        targetLeg.legId === "a" ? "b-to-a" : "a-to-b",
        targetLeg.localUri, targetLeg.remoteUri,
      )
      break
    }
    case "PRACK": {
      // RFC 3262 §7.2: RAck's CSeq must reference the CSeq of the INVITE that
      // produced the reliable 1xx on this leg. Rewrite the middle token of
      // "<RSeq> <CSeq> <Method>" to the target dialog's INVITE CSeq, tracked
      // as lastInviteCSeq (seeded at dialog creation from the 1xx's CSeq,
      // which echoes the INVITE's CSeq).
      const rackIn = getHeader(req.headers, "rack") ?? ""
      const rackParts = rackIn.split(/\s+/)
      const targetInviteCSeq = targetDialog.lastInviteCSeq ?? targetDialog.localCSeq
      const rack = rackParts.length >= 3
        ? `${rackParts[0]} ${targetInviteCSeq} ${rackParts.slice(2).join(" ")}`
        : rackIn
      relayed = buildRelayedPrack(req, targetLeg.callId, dirFromTag, dirToTag, targetUri, outboundCSeq, rack, targetLeg.localUri, targetLeg.remoteUri)
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
      relayed = buildRelayedRequest(
        req.method, req, targetLeg.callId, dirFromTag, dirToTag, targetUri,
        outboundCSeq, targetLeg.localUri, targetLeg.remoteUri,
      )
      state.call = addPendingRequest(state.call, targetLeg.legId, targetDialog.toTag, {
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

  // Apply transform if provided
  if (transform && relayed.type === "request") {
    if (transform.headers) {
      let headers = relayed.headers
      for (const [name, value] of Object.entries(transform.headers)) {
        headers = value === null
          ? headers.filter((h) => h.name.toLowerCase() !== name.toLowerCase())
          : [...headers.filter((h) => h.name.toLowerCase() !== name.toLowerCase()), { name, value }]
      }
      relayed = { ...relayed, headers }
    }
    if (transform.body !== undefined) {
      const newBody = transform.body ?? new Uint8Array(0)
      relayed = {
        ...relayed,
        body: newBody,
        headers: relayed.headers.map((hdr) =>
          hdr.name.toLowerCase() === "content-length"
            ? { name: hdr.name, value: String(newBody.byteLength) }
            : hdr
        ),
      }
    }
  }

  // RFC 3261 §12.2.1.1: apply dialog route set to outbound in-dialog requests
  // on the b-leg (the B2BUA is the UAC there). ACK, BYE, re-INVITE, PRACK and
  // any other in-dialog method get Route headers and, for loose routers, a
  // destination rewrite to the first route URI.
  let finalTarget = target
  if (targetLeg.legId !== "a" && relayed.type === "request") {
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
  const cseqHeader = getHeader(resp.headers, "cseq") ?? ""
  const cseqMethod = cseqHeader.split(/\s+/)[1]?.toUpperCase() ?? "INVITE"
  const cseqNum = parseInt(cseqHeader, 10)
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
    relayed = relayResponse(
      resp,
      pending.sourceCallId,
      pending.sourceVias,
      pending.sourceFrom,
      pending.sourceTo,
      `${pending.inboundCSeq} ${cseqMethod}`,
    )
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
    const viasForRelay = state.call.aLegPendingVias ?? state.call.aLegVias
    const toWithTag = aFacingToTag
      ? `${stripTag(state.call.aLegTo)};tag=${aFacingToTag}`
      : undefined

    // Non-INVITE responses to a-leg must echo the inbound a-leg request's CSeq
    // (RFC 3261 §8.1.3.3). For PRACK/UPDATE/INFO we tracked this as aLegPendingCSeq
    // when the request was relayed to b-leg.
    const aLegCSeq = targetLeg.legId === "a"
      ? cseqMethod === "INVITE"
        ? `${state.call.aLegInviteCSeq} INVITE`
        : `${state.call.aLegPendingCSeq ?? state.call.aLegInviteCSeq} ${cseqMethod}`
      : undefined

    relayed = relayResponse(resp, targetLeg.callId, viasForRelay, state.call.aLegFrom, toWithTag, aLegCSeq)

    // Track early dialog on source leg for provisional responses.
    // RFC 3261 §12.2.1.1: each forked early dialog maintains its own CSeq
    // sequence, all starting from the shared INVITE's CSeq (which the
    // response echoes in its CSeq header).
    if (resp.status >= 100 && resp.status < 200 && toTag && ctx.sourceLeg.legId !== "a") {
      const sourceLeg = ctx.sourceLeg
      if (!sourceLeg.dialogs.some((d) => d.toTag === toTag)) {
        const contact = resp.parsed?.contact?.uri ?? ""
        // The response's CSeq number equals the INVITE's CSeq (responses
        // echo the request's CSeq — RFC 3261 §8.1.3.3). Seed this new
        // forked dialog independently from any sibling fork's counter.
        const inviteCSeq = Number.isFinite(cseqNum) ? cseqNum : randomInitialCSeq()
        const dialog = {
          ...makeEmptyDialog(toTag), contact, localCSeq: inviteCSeq,
          lastInviteCSeq: inviteCSeq,
        }
        // Drop any empty-toTag placeholder once the first real early
        // dialog exists so it doesn't shadow dialogs[0] in downstream lookups.
        const withoutPlaceholder = sourceLeg.dialogs.filter((d) => d.toTag !== "")
        state.call = updateLeg(state.call, sourceLeg.legId, (l) => ({
          ...l, state: "early" as const, dialogs: [...withoutPlaceholder, dialog],
        }))
      }
    }

    // Ensure a-leg has a dialog when relaying provisional/answer
    if (targetLeg.legId === "a" && state.call.aLeg.dialogs.length === 0 && aFacingToTag) {
      state.call = updateLeg(state.call, "a", (l) => ({
        ...l, dialogs: [makeDialogFromIncoming(aFacingToTag!, state.call.aLegInviteCSeq)],
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

  // Apply header transform
  if (transform?.headers) {
    let headers = relayed.headers
    for (const [name, value] of Object.entries(transform.headers)) {
      headers = value === null
        ? headers.filter((h) => h.name.toLowerCase() !== name.toLowerCase())
        : [...headers.filter((h) => h.name.toLowerCase() !== name.toLowerCase()), { name, value }]
    }
    relayed = { ...relayed, headers }
  }

  // Apply body transform — also update Content-Length to match
  if (transform?.body !== undefined) {
    const newBody = transform.body ?? new Uint8Array(0)
    relayed = {
      ...relayed,
      body: newBody,
      headers: relayed.headers.map((hdr) =>
        hdr.name.toLowerCase() === "content-length"
          ? { name: hdr.name, value: String(newBody.byteLength) }
          : hdr
      ),
    }
  }

  const destination = targetLeg.legId === "a"
    ? { host: state.call.aLeg.source.address, port: state.call.aLeg.source.port }
    : legTarget(targetLeg)

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
    if (resp.status < 300) {
      const newContact = resp.parsed?.contact?.uri ?? ""
      if (newContact) {
        state.call = updateDialog(state.call, ctx.sourceLeg.legId, ctx.sourceDialog.toTag, (d) => ({
          ...d, contact: newContact,
        }))
      }
    }
    state.call = removePendingRequest(state.call, ctx.sourceLeg.legId, ctx.sourceDialog.toTag, pending.outboundCSeq)
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
  if (ctx.event.type !== "sip") return
  const resp = ctx.event.message
  if (resp.type !== "response") return

  const leg = findLeg(state.call, action.legId)
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
  // echoes the INVITE CSeq explicitly via lastInviteCSeq, so dialog.localCSeq
  // only needs to be a floor for the next request we originate on this dialog.
  const placeholder = leg.dialogs.find((d) => d.toTag === "")
  const respCSeqHeader = getHeader(resp.headers, "cseq") ?? ""
  const respCSeqNum = parseInt(respCSeqHeader, 10)
  const baseCSeq = Number.isFinite(respCSeqNum) && respCSeqNum > 0
    ? respCSeqNum
    : placeholder?.lastInviteCSeq ?? placeholder?.localCSeq ?? randomInitialCSeq()
  const existingDialog = leg.dialogs.find((d) => d.toTag === toTag)
  const nextCSeq = existingDialog !== undefined
    ? Math.max(baseCSeq, existingDialog.localCSeq)
    : baseCSeq
  const dialog = existingDialog
    ? { ...existingDialog, contact: legContact, localCSeq: nextCSeq, routeSet,
        lastInviteCSeq: existingDialog.lastInviteCSeq ?? baseCSeq }
    : { ...makeEmptyDialog(toTag), contact: legContact, localCSeq: nextCSeq, routeSet,
        lastInviteCSeq: baseCSeq }

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
  const leg = findLeg(state.call, action.legId)
  if (leg === undefined) return
  state.call = setLegState(state.call, action.legId, action.state)
  if (action.disposition !== undefined) {
    state.call = setLegDisposition(state.call, action.legId, action.disposition)
  }
}

// ── stamp-dialog-to-tag (primitive) ───────────────────────────────────────

/**
 * Stamp an explicit toTag onto the named leg's dialog[0]. Used on the a-leg
 * (UAS side) when the B2BUA picks the a-facing tag at 200-OK time and needs
 * to align the a-leg dialog with it.
 *
 * When the leg has no dialog yet:
 *   - legId === "a" → uses makeDialogFromIncoming(toTag, call.aLegInviteCSeq)
 *     so Alice's inbound CSeq floor is preserved.
 *   - other legs    → uses makeEmptyDialog(toTag).
 *
 * Reach: legs.{action.legId}.dialogs[0].toTag (or a freshly created dialog[0]).
 */
function executeStampDialogToTag(
  action: Extract<RuleAction, { type: "stamp-dialog-to-tag" }>,
  state: ExecutionState,
): void {
  const leg = findLeg(state.call, action.legId)
  if (leg === undefined) return

  if (leg.dialogs.length === 0) {
    const dialog = action.legId === "a"
      ? makeDialogFromIncoming(action.toTag, state.call.aLegInviteCSeq)
      : { ...makeEmptyDialog(action.toTag) }
    state.call = updateLeg(state.call, action.legId, (l) => ({
      ...l,
      dialogs: [dialog],
    }))
    return
  }

  const existing = leg.dialogs[0]!
  state.call = updateLeg(state.call, action.legId, (l) => ({
    ...l,
    dialogs: [{ ...existing, toTag: action.toTag }, ...l.dialogs.slice(1)],
  }))
}

// ── ack-leg ────────────────────────────────────────────────────────────────

function executeAckLeg(
  action: Extract<RuleAction, { type: "ack-leg" }>,
  _ctx: RuleContext,
  state: ExecutionState,
): void {
  const leg = findLeg(state.call, action.legId)
  if (leg === undefined) return
  const dialog = leg.dialogs[0]
  if (dialog === undefined) return

  const target = legTarget(leg)
  const targetUri = dialog.contact || `sip:${target.host}:${target.port}`
  // RFC 3261 §13.2.2.4: ACK for 2xx echoes the INVITE's CSeq (tracked on
  // the dialog as lastInviteCSeq).
  const ackCSeq = dialog.lastInviteCSeq ?? dialog.localCSeq ?? 1

  const ackMsg = buildAck(leg.callId, leg.fromTag, dialog.toTag, targetUri, ackCSeq, leg.localUri, leg.remoteUri)
  const routed = leg.legId !== "a" ? applyRouteSet(ackMsg, dialog, target) : { msg: ackMsg, target }

  state.outbound.push({
    message: routed.msg,
    destination: routed.target,
    label: `ACK ${action.legId}`,
    legId: action.legId,
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
  _ctx: RuleContext,
  state: ExecutionState,
): void {
  const leg = findLeg(state.call, action.legId)
  if (leg === undefined || leg.state === "terminated") return
  const dialog = leg.dialogs[0]
  if (dialog === undefined) return

  const target = legTarget(leg)
  const targetUri = dialog.contact || `sip:${target.host}:${target.port}`

  // Bump CSeq for the new request
  state.call = bumpLocalCSeq(state.call, leg.legId, dialog.toTag)
  const cseq = dialog.localCSeq + 1

  // Build the request based on method
  const { fromTag, toTag } = directionalTags(state.call, leg, dialog)

  if (action.method === "OPTIONS") {
    const optMsg = buildOptions(leg.callId, fromTag, toTag, targetUri, cseq, leg.localUri, leg.remoteUri)
    const routed = leg.legId !== "a" ? applyRouteSet(optMsg, dialog, target) : { msg: optMsg, target }
    state.outbound.push({
      message: routed.msg,
      destination: routed.target,
      label: `${action.method} to ${action.legId}`,
      legId: action.legId,
    })
  } else {
    // Generic request construction for INFO, UPDATE, etc.
    // Uses OPTIONS builder as base (no body by default) — can be extended
    const msg = buildOptions(leg.callId, fromTag, toTag, targetUri, cseq, leg.localUri, leg.remoteUri)
    // Override method and CSeq
    const updatedMsg = {
      ...msg,
      method: action.method,
      headers: msg.headers.map((h) =>
        h.name.toLowerCase() === "cseq" ? { ...h, value: `${cseq} ${action.method}` } : h,
      ),
    }
    if (action.body !== undefined && action.body !== null) {
      updatedMsg.body = action.body
      updatedMsg.headers = updatedMsg.headers.map((hdr) =>
        hdr.name.toLowerCase() === "content-length"
          ? { name: hdr.name, value: String(action.body!.byteLength) }
          : hdr
      )
    }
    const routed = leg.legId !== "a" ? applyRouteSet(updatedMsg, dialog, target) : { msg: updatedMsg, target }
    state.outbound.push({
      message: routed.msg,
      destination: routed.target,
      label: `${action.method} to ${action.legId}`,
      legId: action.legId,
    })
  }
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
  _ctx: RuleContext,
  state: ExecutionState,
): void {
  const leg = findLeg(state.call, action.legId)
  if (leg === undefined || leg.state === "terminated") return
  const dialog = leg.dialogs.find((d) => d.toTag === action.bTag) ?? leg.dialogs[0]
  if (dialog === undefined) return

  const target = legTarget(leg)
  const targetUri = dialog.contact || `sip:${target.host}:${target.port}`

  state.call = bumpLocalCSeq(state.call, leg.legId, dialog.toTag)
  const cseq = dialog.localCSeq + 1
  const rack = `${action.rseq} ${action.inviteCSeq} INVITE`

  const prack = buildPrack(
    leg.callId,
    leg.fromTag,
    action.bTag,
    targetUri,
    cseq,
    rack,
    leg.localUri,
    leg.remoteUri,
  )

  const routed = applyRouteSet(prack, dialog, target)
  state.outbound.push({
    message: routed.msg,
    destination: routed.target,
    label: `PRACK to ${action.legId}`,
    legId: action.legId,
  })
}

// ── create-leg ─────────────────────────────────────────────────────────────

function executeCreateLeg(
  action: Extract<RuleAction, { type: "create-leg" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  // Resolve the base INVITE to clone.
  let baseInvite: SipRequest | undefined
  if (action.fromInvite === "snapshot" && state.call.aLegInviteSnapshot) {
    const snapshot = state.call.aLegInviteSnapshot
    baseInvite = {
      type: "request", method: "INVITE", uri: snapshot.uri,
      version: "SIP/2.0",
      headers: snapshot.headers.map((h) => ({ name: h.name, value: h.value })),
      body: snapshot.body, raw: Buffer.from(snapshot.body),
    }
  } else if (action.fromInvite !== undefined && action.fromInvite !== "snapshot") {
    baseInvite = action.fromInvite
  }

  // ── Body: new ADT takes precedence over the legacy `updateBody` string. ──
  const normalizedBodyUpdate: BodyUpdate | undefined =
    action.bodyUpdate !== undefined
      ? action.bodyUpdate
      : action.updateBody === undefined
        ? undefined
        : action.updateBody === null
          ? { kind: "drop" }
          : { kind: "set", value: new TextEncoder().encode(action.updateBody) }

  if (
    baseInvite !== undefined
    && normalizedBodyUpdate !== undefined
    && normalizedBodyUpdate.kind !== "inherit"
  ) {
    baseInvite = applyBodyUpdate(baseInvite, normalizedBodyUpdate)
    baseInvite = { ...baseInvite, raw: Buffer.from(baseInvite.body) }
  }

  // ── Request-URI: new `ruri` ADT takes precedence over legacy `newRuri`. ──
  // `kind:"inherit"` collapses to undefined so createBLegFromRoute falls
  // back to the base INVITE's URI.
  const legacyNewRuri: string | undefined =
    action.ruri !== undefined
      ? action.ruri.kind === "set" ? (action.ruri.value as string) : undefined
      : action.newRuri

  // ── Header updates: ADT path is applied *after* the INVITE is built, so
  // multi-valued headers (Diversion, Supported) are not collapsed by the
  // legacy Record<string, string | null> shape in createBLegFromRoute. ──
  const newHeaderUpdates: HeaderUpdates | undefined = action.headerUpdates
  const legacyUpdateHeaders: Record<string, string | null> | undefined =
    newHeaderUpdates !== undefined ? undefined : action.updateHeaders

  const port = action.destination.port ?? 5060
  const result = createBLegFromRoute({
    call: state.call,
    baseInvite,
    route: {
      destination: { host: action.destination.host, port },
      new_ruri: legacyNewRuri,
      update_headers: legacyUpdateHeaders,
      no_answer_timeout_sec: action.noAnswerTimeoutSec,
      callback_context: action.callbackContext,
    },
    config: ctx.config,
    nowMs: ctx.nowMs,
  })

  state.call = result.call

  // Apply the new ADT header updates to the outbound INVITE envelope.
  let outbound = result.outbound
  if (newHeaderUpdates !== undefined && outbound.length > 0) {
    const first = outbound[0]!
    if (first.message.type === "request") {
      const patched = applyHeaderUpdates(first.message, newHeaderUpdates)
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
  _ctx: RuleContext,
  state: ExecutionState,
): void {
  const leg = findLeg(state.call, action.legId)
  if (leg === undefined || leg.state === "terminated") return

  const target = legTarget(leg)

  if (leg.state === "confirmed") {
    // BYE a confirmed leg
    const dialog = leg.dialogs[0]
    if (dialog !== undefined) {
      const targetUri = dialog.contact || `sip:${target.host}:${target.port}`
      const byeMsg = buildBye(leg.callId, leg.fromTag, dialog.toTag, targetUri, dialog.localCSeq + 1, leg.localUri, leg.remoteUri)
      const routed = leg.legId !== "a" ? applyRouteSet(byeMsg, dialog, target) : { msg: byeMsg, target }
      state.outbound.push({
        message: routed.msg,
        destination: routed.target,
        label: `BYE ${action.legId}`,
        legId: action.legId,
      })
    }
    state.call = setByeDisposition(state.call, action.legId, "bye_sent")
  } else if (leg.disposition === "cancelling") {
    // CANCEL already in flight via executeCancelLeg — do not re-emit
    // (RFC 3261 §9.1 / §17.1.3: each CANCEL is a separate transaction with
    // a distinct branch, but the UAS key is CallId+branch of the target
    // INVITE, so a second CANCEL with the reused INVITE branch would either
    // be absorbed as a retransmit or rejected). Just record disposition and
    // let resolveCancelResponseRule/cancel200CrossingRule finish cleanup.
    state.call = setByeDisposition(state.call, action.legId, "cancelled")
  } else {
    // CANCEL an early/trying leg
    state.outbound.push(buildCancelEnvelope(leg, target, ""))
    state.call = setByeDisposition(state.call, action.legId, "cancelled")
    state.call = setLegDisposition(state.call, action.legId, "cancelling")
  }

  state.call = setLegState(state.call, action.legId, "terminated")
  // Split from peer if peered
  state.call = splitLeg(state.call, action.legId)
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
  const leg = findLeg(state.call, action.legId)
  if (leg === undefined) return
  if (leg.state === "terminated") return
  if (leg.state === "confirmed") return // caller should have used destroy-leg

  const target = legTarget(leg)
  state.outbound.push(buildCancelEnvelope(leg, target, ""))
  state.call = setLegDisposition(state.call, action.legId, "cancelling")
}

// ── schedule-timer ─────────────────────────────────────────────────────────

function executeScheduleTimer(
  action: Extract<RuleAction, { type: "schedule-timer" }>,
  ctx: RuleContext,
  state: ExecutionState,
): void {
  const timerId = `${action.timerType}-${ctx.callRef}${action.legId ? `-${action.legId}` : ""}`
  const timer: TimerEntry = {
    id: timerId,
    type: action.timerType,
    fireAt: ctx.nowMs + action.delaySec * 1000,
    legId: action.legId,
  }
  state.call = { ...state.call, timers: [...state.call.timers, timer] }
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
  _ctx: RuleContext,
  state: ExecutionState,
): void {
  // BYE or CANCEL all legs that are still alive and peered
  for (const leg of [state.call.aLeg, ...state.call.bLegs]) {
    if (leg.state === "terminated") continue

    if (leg.state === "confirmed") {
      const dialog = leg.dialogs[0]
      if (dialog !== undefined) {
        const target = legTarget(leg)
        const targetUri = dialog.contact || `sip:${target.host}:${target.port}`
        const { fromTag, toTag } = directionalTags(state.call, leg, dialog)
        const byeMsg = buildBye(leg.callId, fromTag, toTag, targetUri, dialog.localCSeq + 1, leg.localUri, leg.remoteUri)
        const routed = leg.legId !== "a" ? applyRouteSet(byeMsg, dialog, target) : { msg: byeMsg, target }
        state.outbound.push({
          message: routed.msg,
          destination: routed.target,
          label: `BYE ${leg.legId} (terminate)`,
          legId: leg.legId,
        })
      }
    } else if (leg.state === "trying" || leg.state === "early") {
      if (leg.legId !== "a") {
        const target = legTarget(leg)
        state.outbound.push(buildCancelEnvelope(leg, target, " (terminate)"))
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
        const targetUri = dialog.contact || `sip:${target.host}:${target.port}`
        const { fromTag, toTag } = directionalTags(state.call, leg, dialog)
        const byeMsg = buildBye(leg.callId, fromTag, toTag, targetUri, dialog.localCSeq + 1, leg.localUri, leg.remoteUri)
        const routed = leg.legId !== "a" ? applyRouteSet(byeMsg, dialog, target) : { msg: byeMsg, target }
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
        const target = legTarget(leg)
        state.outbound.push(buildCancelEnvelope(leg, target, " (begin-termination)"))
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

  // Write CDR and flush to Redis for crash recovery
  state.effects.push({ type: "write-cdr" })
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
  _ctx: RuleContext,
  state: ExecutionState,
): void {
  const leg = findLeg(state.call, action.legId)
  if (leg === undefined || leg.state === "terminated") return
  const dialog = leg.dialogs[0]
  if (dialog === undefined) return

  const target = legTarget(leg)
  const targetUri = dialog.contact || `sip:${target.host}:${target.port}`

  state.call = bumpLocalCSeq(state.call, leg.legId, dialog.toTag)
  const cseq = dialog.localCSeq + 1

  const { fromTag, toTag } = directionalTags(state.call, leg, dialog)

  const notifyMsg = buildNotify({
    callId: leg.callId,
    fromTag,
    toTag,
    requestUri: targetUri,
    cseq,
    ...(leg.localUri !== undefined ? { fromUri: leg.localUri } : {}),
    ...(leg.remoteUri !== undefined ? { dialogToUri: leg.remoteUri } : {}),
    event: action.event,
    subscriptionState: action.subscriptionState,
    ...(action.contentType !== undefined ? { contentType: action.contentType } : {}),
    ...(action.body !== undefined ? { body: action.body } : {}),
  })

  const routed = leg.legId !== "a" ? applyRouteSet(notifyMsg, dialog, target) : { msg: notifyMsg, target }
  state.outbound.push({
    message: routed.msg,
    destination: routed.target,
    label: `NOTIFY ${action.legId}`,
    legId: action.legId,
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
  const existing = state.call.transfer ?? null
  const merged = (existing === null
    ? (action.update as TransferState)
    : { ...existing, ...action.update }) satisfies TransferState
  state.call = { ...state.call, transfer: merged }
}
