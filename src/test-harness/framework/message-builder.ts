/**
 * Message builder — generates SIP messages from Step AST nodes.
 *
 * Provides sensible defaults for all SIP headers (Via, From, To, CSeq, etc.)
 * and applies the three-layer override chain:
 *   1. Computed defaults
 *   2. Declarative overrides (HeaderOverrides)
 *   3. build(ctx) callback result
 *
 * Reuses MessageHelpers helpers (newCallId, newTag, newBranch) and
 * Serializer.serialize() from the main codebase.
 */

import type { SipHeader, SipMessage, SipRequest, SipResponse } from "../../sip/types.js"
import { newBranch, newTag, newCallId, getHeader, getHeaders } from "../../sip/MessageHelpers.js"
import { serialize } from "../../sip/Serializer.js"
import { hydrateRequest, hydrateResponse } from "../../sip/parsers/extract-fields.js"
import { parseNameAddr, parseCSeq } from "../../sip/parsers/custom/structured-headers.js"
import type {
  AgentInfo,
  HeaderOverrides,
  LastMessageInfo,
  MessageContext,
  SendStep,
} from "./types.js"
import type { PendingRequest, SentRequestRecord } from "./validation.js"

// ---------------------------------------------------------------------------
// Agent dialog state (maintained by the interpreter across steps)
// ---------------------------------------------------------------------------

export interface AgentDialogState {
  callId: string
  localTag: string
  /** All tags this agent has used (including localTag and custom To-tags from forking). */
  localTags: Set<string>
  remoteTag: string
  /** Highest CSeq received from the remote party. Undefined until first message received. */
  remoteCSeq: number | undefined
  /**
   * Baseline CSeq of the INVITE this agent *received* on a given Call-ID.
   * Populated only on receive (see interpreter.ts) and used by the CSeq
   * validator to check that peer in-dialog requests start at baseline + 1.
   * Not used for outbound CSeq generation — see sentInviteCSeqByCallId.
   */
  inviteCSeqByCallId: Map<string, number>
  /**
   * Baseline CSeq of the INVITE this agent *sent* on a given Call-ID. Set
   * once when the initial INVITE is built and never rewritten. Seeds the
   * per-dialog UAC counters so forked early dialogs all start from the same
   * baseline (RFC 3261 §12.2.1.1).
   */
  sentInviteCSeqByCallId: Map<string, number>
  /**
   * High-water CSeq for out-of-dialog requests per Call-ID (INVITE, OPTIONS,
   * REGISTER, etc.). Kept separate from the INVITE baselines so out-of-dialog
   * traffic on the same Call-ID can't corrupt the per-dialog baseline that
   * forked early dialogs rely on.
   */
  outOfDialogCSeq: Map<string, number>
  /**
   * Highest CSeq received per dialog, keyed by `${callId}|${fromTag}|${toTag}`
   * (as present on the received request). Used to enforce per-dialog strictly
   * monotonic CSeq across PRACK / re-INVITE / UPDATE / INFO / BYE — each
   * forked early dialog has its own sequence independent of siblings.
   */
  remoteCSeqByDialog: Map<string, number>
  /**
   * Highest CSeq sent per dialog, keyed by `${callId}|${localTag}|${remoteTag}`
   * (as stamped on outgoing requests). RFC 3261 §12.2.1.1: each dialog
   * maintains its own UAC sequence-number namespace. Forked early dialogs
   * share the INVITE baseline but advance independently.
   */
  localCSeqByDialog: Map<string, number>
  routeSet: string[]
  /** Messages indexed by StepRef id for inResponseTo lookups. */
  messagesByRef: Map<number, SipMessage>
  /** Most recent message this agent sent or received. */
  lastMessage: SipMessage | undefined
  /** Via branch of the last INVITE sent — needed for CANCEL matching. */
  lastInviteBranch: string
  /** Request-URI of the last INVITE sent — CANCEL must reuse it. */
  lastInviteUri: string
  /** Remote party's Contact URI — used as Request-URI for in-dialog requests. */
  remoteContact: string
  /**
   * Remote URI for the To header in in-dialog requests (RFC 3261 §12.2.1.1).
   * For UAC: the To URI from the original INVITE sent.
   * For UAS: the From URI from the received INVITE.
   * Ensures the To header preserves the user part across the dialog.
   */
  dialogRemoteUri: string
  /**
   * Local URI for the From header in in-dialog requests (RFC 3261 §12.2.1.1).
   * For UAC: the From URI from the original INVITE sent.
   * For UAS: the To URI from the received INVITE.
   * Without this, a UAS sending a re-INVITE / BYE inside the dialog would
   * default From to its agent identity (`ctx.local.uri`) rather than the
   * dialog's local URI — a §12.2.1.1 violation that breaks any peer that
   * authenticates / authorises on the From-URI.
   */
  dialogLocalUri: string
  /** True once callId has been confirmed by a received message (for B-side agents). */
  callIdConfirmed: boolean
  /** Request-URI from received INVITE (UAS side) — for CANCEL validation (RFC 3261 §9.1). */
  receivedInviteUri: string
  /** Via branch from received INVITE (UAS side) — for CANCEL validation (RFC 3261 §9.1). */
  receivedInviteBranch: string
  /** Received requests awaiting a final response (for inResponseTo auto-resolution). */
  pendingRequests: PendingRequest[]
  /** Sent requests (for correlating received responses with what we sent). */
  sentRequests: SentRequestRecord[]
  /**
   * Sent reliable provisional 1xx (Require:100rel + RSeq) awaiting PRACK from peer.
   * RFC 3262 §3–4: every reliable provisional MUST be acknowledged with a PRACK;
   * entries are cleared when a PRACK arrives with matching RAck. Leftovers at
   * scenario end indicate the peer (usually the B2BUA) failed to PRACK.
   */
  pendingReliableProvisionals: Array<{
    rseq: number
    inviteCSeq: number
    statusCode: number
    branch: string
  }>
  /**
   * Per-Call-ID outgoing SDP origin state — RFC 3264 §8 / RFC 4566 §5.2.
   *
   * The first SDP this agent emits in a session anchors `(username,
   * sessionId, sessionAddr)`; subsequent emissions reuse them and bump
   * `version` by 1 when the body changed (or keep it when byte-identical).
   * Without this, scenarios that re-offer (e.g. Bob's re-INVITE after a
   * prior 200-OK answer) emit a fresh `o=` tuple and trip
   * `rfc.sdpOriginContinuity`.
   */
  outgoingSdpState: Map<string, {
    username: string
    sessionId: string
    sessionAddr: string
    nettype: string
    addrtype: string
    lastVersion: number
    /** SDP body without the o= line — used to decide whether anything changed. */
    lastDigestExcludingOrigin: string
  }>
}

export function createAgentDialogState(localIp: string): AgentDialogState {
  const tag = newTag()
  return {
    callId: newCallId(localIp),
    localTag: tag,
    localTags: new Set([tag]),
    remoteTag: "",
    remoteCSeq: undefined,
    inviteCSeqByCallId: new Map(),
    sentInviteCSeqByCallId: new Map(),
    outOfDialogCSeq: new Map(),
    remoteCSeqByDialog: new Map(),
    localCSeqByDialog: new Map(),
    routeSet: [],
    messagesByRef: new Map(),
    lastMessage: undefined,
    lastInviteBranch: "",
    lastInviteUri: "",
    remoteContact: "",
    dialogRemoteUri: "",
    dialogLocalUri: "",
    callIdConfirmed: false,
    receivedInviteUri: "",
    receivedInviteBranch: "",
    pendingRequests: [],
    sentRequests: [],
    pendingReliableProvisionals: [],
    outgoingSdpState: new Map(),
  }
}

// ---------------------------------------------------------------------------
// Outgoing SDP origin rewrite — RFC 3264 §8 / RFC 4566 §5.2.
// ---------------------------------------------------------------------------

const SDP_DECODER = new TextDecoder()
const SDP_ENCODER = new TextEncoder()

/**
 * If `body` is an SDP, rewrite its `o=` line to honour origin continuity
 * across this agent's emissions in the same session, and update
 * `dialogState.outgoingSdpState` accordingly. No-op when `body` is empty
 * or not SDP. The first emission anchors `(username, sessionId, addr)`
 * from the body itself; subsequent emissions reuse those fields and pick
 * the next monotonic version.
 */
function applyOutgoingSdpOriginRewrite(
  body: Uint8Array,
  dialogState: AgentDialogState,
  callId: string
): Uint8Array {
  if (body.byteLength === 0) return body
  const text = SDP_DECODER.decode(body)
  if (!text.startsWith("v=0")) return body
  const lines = text.split(/\r?\n/)
  const oIdx = lines.findIndex((l) => l.startsWith("o="))
  if (oIdx < 0) return body
  const oLine = lines[oIdx]!
  const parts = oLine.slice(2).trim().split(/\s+/)
  if (parts.length < 6) return body
  const incomingVersion = Number.parseInt(parts[2]!, 10)
  if (!Number.isFinite(incomingVersion)) return body

  const digestExcludingOrigin = lines.filter((_, i) => i !== oIdx).join("\n")
  const prior = dialogState.outgoingSdpState.get(callId)

  let username: string
  let sessionId: string
  let sessionAddr: string
  let nettype: string
  let addrtype: string
  let version: number

  if (!prior) {
    // Anchor on the first emission — the helper-provided values become
    // this agent's stable tuple for the rest of the session.
    username = parts[0]!
    sessionId = parts[1]!
    nettype = parts[3]!
    addrtype = parts[4]!
    sessionAddr = parts[5]!
    version = incomingVersion
  } else {
    username = prior.username
    sessionId = prior.sessionId
    nettype = prior.nettype
    addrtype = prior.addrtype
    sessionAddr = prior.sessionAddr
    version = digestExcludingOrigin === prior.lastDigestExcludingOrigin
      ? prior.lastVersion
      : prior.lastVersion + 1
  }

  dialogState.outgoingSdpState.set(callId, {
    username,
    sessionId,
    sessionAddr,
    nettype,
    addrtype,
    lastVersion: version,
    lastDigestExcludingOrigin: digestExcludingOrigin,
  })

  // If nothing differs from what's already on the wire, return the
  // original bytes (preserves CRLF style + ordering exactly).
  if (
    prior === undefined &&
    parts[0] === username &&
    parts[1] === sessionId &&
    parts[2] === String(version) &&
    parts[3] === nettype &&
    parts[4] === addrtype &&
    parts[5] === sessionAddr
  ) {
    return body
  }

  const newOLine = `o=${username} ${sessionId} ${version} ${nettype} ${addrtype} ${sessionAddr}`
  if (lines[oIdx] === newOLine) return body
  const rewritten = lines.map((l, i) => (i === oIdx ? newOLine : l)).join("\r\n")
  return SDP_ENCODER.encode(rewritten)
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export function buildMessageContext(
  agentInfo: AgentInfo & { tag: string; callId: string },
  target: { ip: string; port: number },
  dialogState: AgentDialogState,
  resolvedMessage: SipMessage | undefined,
  allAgents: Record<string, AgentInfo>,
  renameMap: Record<string, string>,
  callNumber: number
): MessageContext {
  const lastMsg = resolvedMessage ?? dialogState.lastMessage
  const lastInfo = lastMsg ? extractLastInfo(lastMsg) : emptyLastInfo()

  return {
    local: agentInfo,
    remote: target,
    last: lastInfo,
    dialog: {
      localTag: dialogState.localTag,
      remoteTag: dialogState.remoteTag,
      routeSet: dialogState.routeSet,
      remoteCSeq: dialogState.remoteCSeq,
      remoteUri: dialogState.dialogRemoteUri,
    },
    call: {
      number: callNumber,
      branch: () => newBranch(),
    },
    agent: (name: string) => {
      const resolved = renameMap[name] ?? name
      const info = allAgents[resolved]
      if (!info) throw new Error(`Unknown agent "${name}" (resolved: "${resolved}")`)
      return info
    },
  }
}

function extractLastInfo(msg: SipMessage): LastMessageInfo {
  const headers = msg.headers

  const base = {
    from: getHeader(headers, "from") ?? "",
    to: getHeader(headers, "to") ?? "",
    via: getHeaders(headers, "via"),
    cseq: msg.parsed.cseq.seq,
    cseqMethod: msg.parsed.cseq.method,
    callId: msg.parsed.callId,
    headers,
    body: msg.body,
  }

  if (msg.type === "request") {
    return { ...base, method: msg.method }
  }
  return { ...base, statusCode: msg.status }
}

function emptyLastInfo(): LastMessageInfo {
  return {
    from: "",
    to: "",
    via: [],
    cseq: 0,
    cseqMethod: "",
    callId: "",
    headers: [],
    body: new Uint8Array(0),
  }
}

// ---------------------------------------------------------------------------
// SIP message construction
// ---------------------------------------------------------------------------

/**
 * Default Allow: methods advertised on every INVITE / 2xx-INVITE
 * (RFC 3261 §13.2.1). Methods listed here are the ones the simulated UA
 * is willing to accept from a peer; scenarios that test other methods
 * can override via `HeaderOverrides.headers["Allow"]`.
 */
const DEFAULT_ALLOW = "INVITE, ACK, CANCEL, BYE, OPTIONS, UPDATE, INFO, REFER, PRACK"

/**
 * Default Supported: extensions advertised on every INVITE / 2xx-INVITE
 * (RFC 3261 §20.37). The simulated UA understands `100rel` (RFC 3262),
 * `timer` (RFC 4028) and `replaces` (RFC 3891) — peers may Require any
 * of these. Scenarios that need to advertise a different set override
 * via `HeaderOverrides.headers["Supported"]`.
 */
const DEFAULT_SUPPORTED = "100rel, timer, replaces"

function h(name: string, value: string): SipHeader {
  return { name, value }
}

/**
 * Build a SIP request from a send step (agent sending a request method).
 */
export function buildRequest(
  step: SendStep,
  ctx: MessageContext,
  dialogState: AgentDialogState
): { msg: SipRequest; buf: Buffer } {
  const method = step.method!

  // CANCEL must reuse the original INVITE's Via branch (RFC 3261 §9.1)
  const branch = method === "CANCEL" && dialogState.lastInviteBranch
    ? dialogState.lastInviteBranch
    : ctx.call.branch()

  // Evaluate the build(ctx) callback up front so we can peek at user-supplied
  // To/CSeq overrides before we pick the CSeq. This is the only way to know
  // which early dialog an in-dialog request targets (the To-tag selects the
  // dialog). The merged overrides are reused below; build() runs only once.
  const merged = mergeOverrides(step.overrides, step.build ? step.build(ctx) : undefined)

  // Determine the target remote tag for this request. For in-dialog requests
  // the agent usually passes `to: ctx.last.to` which carries the remote tag
  // that identifies the dialog (e.g. each forked early dialog has its own).
  const targetRemoteTag = extractTag(merged?.to) ?? dialogState.remoteTag

  // RFC 3261 §12.2.1.1: CSeq is scoped to the dialog. Forked early dialogs
  // share the INVITE baseline but each advances its own counter. Track
  // per-dialog local CSeq keyed by `callId|localTag|remoteTag`.
  const dialogKey = targetRemoteTag
    ? `${ctx.local.callId}|${ctx.local.tag}|${targetRemoteTag}`
    : undefined

  const sentBaseline = dialogState.sentInviteCSeqByCallId.get(ctx.local.callId) ?? 0

  let cseqNumber: number
  if (method === "CANCEL") {
    // CANCEL reuses the original INVITE's CSeq — does not bump any counter.
    cseqNumber = ctx.last.cseq || sentBaseline
  } else if (method === "ACK") {
    // ACK for 2xx reuses the INVITE's CSeq — does not bump any counter.
    cseqNumber = ctx.last.cseq || sentBaseline
  } else if (dialogKey !== undefined) {
    // In-dialog request: use the per-dialog counter, seeded from the agent's
    // own sent-INVITE baseline. Forked early dialogs advance independently.
    const prior = dialogState.localCSeqByDialog.get(dialogKey) ?? sentBaseline
    cseqNumber = prior + 1
    dialogState.localCSeqByDialog.set(dialogKey, cseqNumber)
  } else {
    // Out-of-dialog request (initial INVITE, OPTIONS, etc.): advance the
    // out-of-dialog high-water mark per Call-ID. Start from the sent-INVITE
    // baseline if one exists so the first non-INVITE out-of-dialog request
    // lands at baseline + 1.
    const priorOutOfDialog = dialogState.outOfDialogCSeq.get(ctx.local.callId) ?? sentBaseline
    cseqNumber = priorOutOfDialog + 1
    dialogState.outOfDialogCSeq.set(ctx.local.callId, cseqNumber)
    // The first INVITE on a Call-ID establishes the baseline that all
    // forked early dialogs inherit (RFC 3261 §12.2.1.1).
    if (method === "INVITE" && !dialogState.sentInviteCSeqByCallId.has(ctx.local.callId)) {
      dialogState.sentInviteCSeqByCallId.set(ctx.local.callId, cseqNumber)
    }
  }

  // RFC 3261 §12.2.1.1: in-dialog requests must carry the dialog's local URI
  // in From. dialogLocalUri is populated on the first sent INVITE (UAC) or
  // first received INVITE (UAS). Out-of-dialog (no dialogLocalUri yet) falls
  // back to the agent's configured identity.
  const fromUri = dialogState.dialogLocalUri || ctx.local.uri

  // Compute defaults
  const defaultHeaders: SipHeader[] = [
    h("Via", `SIP/2.0/UDP ${ctx.local.ip}:${ctx.local.port};branch=${branch}`),
    h("Max-Forwards", "70"),
    h("From", `<${fromUri}>;tag=${ctx.local.tag}`),
    h("To", buildToHeader(method, step.uri, ctx, dialogState)),
    h("Call-ID", ctx.local.callId),
    h("CSeq", `${cseqNumber} ${method}`),
    h("Contact", `<sip:${ctx.local.ip}:${ctx.local.port};transport=udp>`),
  ]

  // RFC 3261 §13.2.1 / §20.37: INVITE SHOULD declare Allow: and Supported:
  // so the peer can negotiate methods and Require-able extensions.
  if (method === "INVITE") {
    defaultHeaders.push(h("Allow", DEFAULT_ALLOW))
    defaultHeaders.push(h("Supported", DEFAULT_SUPPORTED))
  }

  // RFC 3261 §12.2.1 / §16.12: in-dialog request routing.
  //   - remoteTarget = peer's Contact URI (already tracked as `remoteContact`).
  //   - routeSet from R-R: reversed for UAC, kept for UAS (see updateDialogState).
  //   - If routeSet[0] carries `;lr` → loose-route: R-URI = remoteTarget,
  //     Route = full routeSet in order.
  //   - Else (strict-route, legacy) → R-URI = first route URI (params stripped),
  //     Route = remaining route set + remoteTarget appended.
  const remoteTarget = step.uri
    ?? (dialogState.remoteContact || undefined)
    ?? `sip:${ctx.remote.ip}:${ctx.remote.port}`
  // RFC 3261 §12.2.1.1: every in-dialog request honours the route set.
  // Initial INVITE has no remoteTag yet; re-INVITE does — distinguish by
  // dialog state, not by method, so re-INVITE picks up Route headers.
  const isInitialInvite = method === "INVITE" && dialogState.remoteTag === ""
  const inDialogWithRoutes =
    method !== "CANCEL" && !isInitialInvite && dialogState.routeSet.length > 0
  let routeHeaders: SipHeader[] = []
  let uri = remoteTarget
  if (inDialogWithRoutes) {
    if (firstRouteIsLoose(dialogState.routeSet[0]!)) {
      // Loose-route: R-URI stays at remoteTarget; Route headers carry the
      // full routeSet in order so the first hop sees its own URI on top.
      uri = remoteTarget
      routeHeaders = dialogState.routeSet.map((r) => h("Route", r))
    } else {
      // Strict-route fallback (RFC 3261 §16.12): R-URI = first route URI
      // with non-R-URI params stripped; Route = rest of route set, with the
      // remoteTarget appended as the final Route value.
      uri = stripRouteUriToRequestUri(dialogState.routeSet[0]!)
      const tail = dialogState.routeSet.slice(1)
      routeHeaders = [
        ...tail.map((r) => h("Route", r)),
        h("Route", `<${remoteTarget}>`),
      ]
    }
  }

  let headers = [...defaultHeaders, ...routeHeaders]
  let body: Uint8Array = new Uint8Array(0)

  // Apply the overrides we already merged above (build() ran once).
  if (merged) {
    headers = applyOverrides(headers, merged)
    if (merged.body) body = merged.body
    // If the caller forced an explicit CSeq, keep the per-dialog counter in
    // sync so the next in-dialog request doesn't regress below what was sent.
    if (merged.cseq !== undefined && dialogKey !== undefined && method !== "CANCEL" && method !== "ACK") {
      const prior = dialogState.localCSeqByDialog.get(dialogKey) ?? 0
      if (merged.cseq > prior) {
        dialogState.localCSeqByDialog.set(dialogKey, merged.cseq)
      }
    }
  }

  // RFC 3264 §8 / RFC 4566 §5.2: keep the SDP origin tuple stable across
  // this agent's emissions in the same Call-ID and bump version monotonically.
  body = applyOutgoingSdpOriginRewrite(body, dialogState, ctx.local.callId)

  // RFC 3261 §7.4.1: Content-Type MUST be present when a body is included
  if (body.byteLength > 0 && !headers.some((hdr) => hdr.name.toLowerCase() === "content-type")) {
    headers.push(h("Content-Type", "application/sdp"))
  }
  headers.push(h("Content-Length", String(body.byteLength)))

  const finalUri = step.uri ?? uri ?? `sip:${ctx.remote.ip}:${ctx.remote.port}`

  // Track INVITE branch/URI for subsequent CANCEL
  if (method === "INVITE") {
    dialogState.lastInviteBranch = branch
    dialogState.lastInviteUri = finalUri
  }

  const msg: SipRequest = hydrateRequest({
    method,
    uri: method === "CANCEL" && dialogState.lastInviteUri
      ? dialogState.lastInviteUri
      : finalUri,
    headers,
    body,
    raw: Buffer.alloc(0),
  })

  const buf = serialize(msg)
  return {
    msg: hydrateRequest({ method: msg.method, uri: msg.uri, headers: [...msg.headers], body: msg.body, raw: buf }),
    buf,
  }
}

/**
 * Build a SIP response from a send step (agent replying to a received request).
 */
export function buildResponse(
  step: SendStep,
  ctx: MessageContext,
  dialogState: AgentDialogState
): { msg: SipResponse; buf: Buffer } {
  const statusCode = step.statusCode!
  const reason = step.reason ?? defaultReason(statusCode)

  // Copy headers from the request we're responding to
  // Record-Route headers must be echoed back in responses (RFC 3261 §12.1.1)
  const recordRouteHeaders = getHeaders(ctx.last.headers, "record-route")
    .map((v) => h("Record-Route", v))

  const defaultHeaders: SipHeader[] = [
    // Via headers from the request (all of them, in order)
    ...ctx.last.via.map((v) => h("Via", v)),
    ...recordRouteHeaders,
    h("From", ctx.last.from),
    h("To", addToTag(ctx.last.to, dialogState.localTag)),
    h("Call-ID", ctx.last.callId),
    h("CSeq", `${ctx.last.cseq} ${ctx.last.cseqMethod}`),
    h("Contact", `<sip:${ctx.local.ip}:${ctx.local.port};transport=udp>`),
  ]

  // RFC 3261 §13.2.1 / §20.37: 2xx to INVITE SHOULD declare Allow: and
  // Supported: so the peer knows the UA's accepted methods and extensions.
  if (statusCode >= 200 && statusCode < 300 && ctx.last.cseqMethod === "INVITE") {
    defaultHeaders.push(h("Allow", DEFAULT_ALLOW))
    defaultHeaders.push(h("Supported", DEFAULT_SUPPORTED))
  }

  let headers = [...defaultHeaders]
  let body: Uint8Array = new Uint8Array(0)

  // Apply overrides
  const merged = mergeOverrides(step.overrides, step.build ? step.build(ctx) : undefined)
  if (merged) {
    headers = applyOverrides(headers, merged)
    if (merged.body) body = merged.body
  }

  // RFC 3264 §8 / RFC 4566 §5.2: keep the SDP origin tuple stable across
  // this agent's emissions in the same Call-ID and bump version monotonically.
  body = applyOutgoingSdpOriginRewrite(body, dialogState, ctx.last.callId || ctx.local.callId)

  // RFC 3261 §7.4.1: Content-Type MUST be present when a body is included
  if (body.byteLength > 0 && !headers.some((hdr) => hdr.name.toLowerCase() === "content-type")) {
    headers.push(h("Content-Type", "application/sdp"))
  }
  headers.push(h("Content-Length", String(body.byteLength)))

  const msg: SipResponse = hydrateResponse({
    status: statusCode,
    reason,
    headers,
    body,
    raw: Buffer.alloc(0),
  })

  const buf = serialize(msg)
  return {
    msg: hydrateResponse({ status: msg.status, reason: msg.reason, headers: [...msg.headers], body: msg.body, raw: buf }),
    buf,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildToHeader(
  method: string,
  uri: string | undefined,
  ctx: MessageContext,
  dialogState: AgentDialogState
): string {
  // RFC 3261 §12.2.1.1: In-dialog requests use the dialog's remote URI
  const toUri = uri
    ?? (dialogState.dialogRemoteUri || undefined)
    ?? `sip:${ctx.remote.ip}:${ctx.remote.port}`
  // CANCEL must NOT include a To tag — it's outside the dialog (RFC 3261 §9.1)
  if (method === "CANCEL") {
    return `<${toUri}>`
  }
  if (dialogState.remoteTag) {
    return `<${toUri}>;tag=${dialogState.remoteTag}`
  }
  return `<${toUri}>`
}

function addToTag(toHeader: string, localTag: string): string {
  if (parseNameAddr(toHeader).tag !== undefined) return toHeader
  return `${toHeader};tag=${localTag}`
}

function extractTag(header: string | undefined): string | undefined {
  if (!header) return undefined
  return parseNameAddr(header).tag
}

function mergeOverrides(
  base: HeaderOverrides | undefined,
  build: HeaderOverrides | undefined
): HeaderOverrides | undefined {
  if (!base && !build) return undefined
  if (!base) return build
  if (!build) return base

  const result: Record<string, unknown> = {}
  const cseq = build.cseq ?? base.cseq
  if (cseq !== undefined) result.cseq = cseq
  const from = build.from ?? base.from
  if (from !== undefined) result.from = from
  const to = build.to ?? base.to
  if (to !== undefined) result.to = to
  const contact = build.contact ?? base.contact
  if (contact !== undefined) result.contact = contact
  const headers = (base.headers || build.headers)
    ? { ...base.headers, ...build.headers }
    : undefined
  if (headers !== undefined) result.headers = headers
  const extraHeaders = (base.extraHeaders || build.extraHeaders)
    ? [...(base.extraHeaders ?? []), ...(build.extraHeaders ?? [])]
    : undefined
  if (extraHeaders !== undefined) result.extraHeaders = extraHeaders
  const body = build.body ?? base.body
  if (body !== undefined) result.body = body

  return result as HeaderOverrides
}

// Runtime safety net: detect misspelled top-level keys that the TypeScript
// structural-typing doesn't catch (excess properties pass through spreads).
// Every key that isn't one of the documented override fields is reported so
// the author can fix the call site instead of silently losing the intent.
const VALID_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  "cseq",
  "from",
  "to",
  "contact",
  "headers",
  "extraHeaders",
  "body",
])

function warnUnknownOverrideKeys(overrides: HeaderOverrides): void {
  for (const key of Object.keys(overrides)) {
    if (!VALID_OVERRIDE_KEYS.has(key)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[e2e] HeaderOverrides: unknown top-level key "${key}" — ignored. ` +
        `Did you mean to put it under \`headers\`? ` +
        `Valid top-level keys: ${Array.from(VALID_OVERRIDE_KEYS).join(", ")}.`
      )
    }
  }
}

function applyOverrides(headers: SipHeader[], overrides: HeaderOverrides): SipHeader[] {
  warnUnknownOverrideKeys(overrides)

  const result = [...headers]

  if (overrides.cseq !== undefined) {
    const idx = result.findIndex((h) => h.name.toLowerCase() === "cseq")
    if (idx >= 0) {
      const existing = parseCSeq(result[idx]!.value)
      const method = existing.method.length > 0 ? existing.method : "INVITE"
      result[idx] = h("CSeq", `${overrides.cseq} ${method}`)
    }
  }

  if (overrides.from !== undefined) {
    const idx = result.findIndex((h) => h.name.toLowerCase() === "from")
    if (idx >= 0) result[idx] = h("From", overrides.from)
  }

  if (overrides.to !== undefined) {
    const idx = result.findIndex((h) => h.name.toLowerCase() === "to")
    if (idx >= 0) result[idx] = h("To", overrides.to)
  }

  if (overrides.contact !== undefined) {
    const idx = result.findIndex((h) => h.name.toLowerCase() === "contact")
    if (idx >= 0) result[idx] = h("Contact", overrides.contact)
    else result.push(h("Contact", overrides.contact))
  }

  if (overrides.headers) {
    for (const [name, value] of Object.entries(overrides.headers)) {
      const lower = name.toLowerCase()
      const idx = result.findIndex((hdr) => hdr.name.toLowerCase() === lower)
      if (idx >= 0) {
        result[idx] = h(name, value)
      } else {
        result.push(h(name, value))
      }
    }
  }

  // Append extra headers (supports multi-valued headers like Record-Route)
  if (overrides.extraHeaders) {
    for (const extra of overrides.extraHeaders) {
      result.push(h(extra.name, extra.value))
    }
  }

  return result
}

function defaultReason(statusCode: number): string {
  const reasons: Record<number, string> = {
    100: "Trying",
    180: "Ringing",
    183: "Session Progress",
    200: "OK",
    202: "Accepted",
    302: "Moved Temporarily",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    408: "Request Timeout",
    480: "Temporarily Unavailable",
    481: "Call/Transaction Does Not Exist",
    486: "Busy Here",
    487: "Request Terminated",
    488: "Not Acceptable Here",
    500: "Server Internal Error",
    503: "Service Unavailable",
    603: "Decline",
  }
  return reasons[statusCode] ?? "Unknown"
}

// ---------------------------------------------------------------------------
// Loose-route helpers (RFC 3261 §16.12)
// ---------------------------------------------------------------------------

/**
 * True if the given Record-Route / Route header value carries the `;lr`
 * loose-route flag in its URI parameters. Loose-route is the modern
 * default; strict-route is the legacy fallback we still implement for
 * RFC completeness.
 */
function firstRouteIsLoose(routeValue: string): boolean {
  // Match `;lr` followed by `>`, `;`, `,`, end-of-string, or whitespace —
  // i.e. as a URI parameter, not a substring of something else.
  return /;lr(?=[;>,\s]|$)/i.test(routeValue)
}

/**
 * Extract the URI portion of a Route header value for use as a Request-URI
 * (strict-route case). Strips surrounding angle brackets and any
 * header-level parameters that follow `>`.
 *
 * Per RFC 3261 §16.12 the resulting Request-URI MUST omit URI parameters
 * not allowed in a Request-URI, but for the test DSL this is unused in
 * practice (the proxy in this codebase always emits `;lr`); we keep the
 * simpler trim and rely on the receiving side to ignore unknown params.
 */
function stripRouteUriToRequestUri(routeValue: string): string {
  const trimmed = routeValue.trim()
  const m = trimmed.match(/^<([^>]+)>/)
  return m ? m[1]! : trimmed
}

/**
 * Resolve agent contact placeholders ({{agent:name:contact}}) in header values.
 */
export function resolvePlaceholders(
  headers: SipHeader[],
  allAgents: Record<string, AgentInfo>
): SipHeader[] {
  return headers.map((header) => {
    const resolved = header.value.replace(
      /\{\{agent:([^:}]+):contact\}\}/g,
      (_match, agentName: string) => {
        const info = allAgents[agentName]
        if (!info) throw new Error(`Unknown agent "${agentName}" in placeholder`)
        return info.contact
      }
    )
    return resolved !== header.value ? h(header.name, resolved) : header
  })
}
