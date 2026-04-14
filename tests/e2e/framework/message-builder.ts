/**
 * Message builder — generates SIP messages from Step AST nodes.
 *
 * Provides sensible defaults for all SIP headers (Via, From, To, CSeq, etc.)
 * and applies the three-layer override chain:
 *   1. Computed defaults
 *   2. Declarative overrides (HeaderOverrides)
 *   3. build(ctx) callback result
 *
 * Reuses MessageFactory helpers (newCallId, newTag, newBranch) and
 * Serializer.serialize() from the main codebase.
 */

import type { SipHeader, SipMessage, SipRequest, SipResponse } from "../../../src/sip/types.js"
import { newBranch, newTag, newCallId, getHeader, getHeaders } from "../../../src/sip/MessageFactory.js"
import { serialize } from "../../../src/sip/Serializer.js"
import type {
  AgentInfo,
  HeaderOverrides,
  LastMessageInfo,
  MessageContext,
  SendStep,
  StepRef,
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
  localCSeq: number
  /** Highest CSeq received from the remote party. Undefined until first message received. */
  remoteCSeq: number | undefined
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
}

export function createAgentDialogState(localIp: string): AgentDialogState {
  const tag = newTag()
  return {
    callId: newCallId(localIp),
    localTag: tag,
    localTags: new Set([tag]),
    remoteTag: "",
    localCSeq: 0,
    remoteCSeq: undefined,
    routeSet: [],
    messagesByRef: new Map(),
    lastMessage: undefined,
    lastInviteBranch: "",
    lastInviteUri: "",
    remoteContact: "",
    dialogRemoteUri: "",
    callIdConfirmed: false,
    receivedInviteUri: "",
    receivedInviteBranch: "",
    pendingRequests: [],
    sentRequests: [],
    pendingReliableProvisionals: [],
  }
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export function buildMessageContext(
  agentName: string,
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
      localCSeq: dialogState.localCSeq,
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
  const cseqRaw = getHeader(headers, "cseq") ?? "1 INVITE"
  const cseqParts = cseqRaw.split(/\s+/)
  const cseqNum = parseInt(cseqParts[0] ?? "1", 10)
  const cseqMethod = cseqParts[1] ?? "INVITE"

  const base = {
    from: getHeader(headers, "from") ?? "",
    to: getHeader(headers, "to") ?? "",
    via: getHeaders(headers, "via"),
    cseq: cseqNum,
    cseqMethod,
    callId: getHeader(headers, "call-id") ?? "",
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

  // Compute defaults
  const defaultHeaders: SipHeader[] = [
    h("Via", `SIP/2.0/UDP ${ctx.local.ip}:${ctx.local.port};branch=${branch}`),
    h("Max-Forwards", "70"),
    h("From", `<${ctx.local.uri}>;tag=${ctx.local.tag}`),
    h("To", buildToHeader(method, step.uri, ctx, dialogState)),
    h("Call-ID", ctx.local.callId),
    h("CSeq", `${dialogState.localCSeq + 1} ${method}`),
    h("Contact", `<sip:${ctx.local.ip}:${ctx.local.port};transport=udp>`),
  ]

  // For CANCEL, reuse the original INVITE's CSeq number
  if (method === "CANCEL") {
    const cancelCSeq = ctx.last.cseq || dialogState.localCSeq
    defaultHeaders[5] = h("CSeq", `${cancelCSeq} CANCEL`)
  } else if (method === "ACK") {
    // ACK for 2xx uses the INVITE's CSeq number
    const ackCSeq = ctx.last.cseq || dialogState.localCSeq
    defaultHeaders[5] = h("CSeq", `${ackCSeq} ACK`)
  } else {
    // Increment CSeq for new requests
    dialogState.localCSeq++
  }

  // For in-dialog requests (BYE, ACK, re-INVITE), use the remote Contact as Request-URI
  const uri = step.uri
    ?? (dialogState.remoteContact || undefined)
    ?? `sip:${ctx.remote.ip}:${ctx.remote.port}`

  // Add Route headers for in-dialog requests (from Record-Route in responses)
  const routeHeaders = (method !== "INVITE" && method !== "CANCEL" && dialogState.routeSet.length > 0)
    ? dialogState.routeSet.map((r) => h("Route", r))
    : []

  let headers = [...defaultHeaders, ...routeHeaders]
  let body: Uint8Array = new Uint8Array(0)

  // Apply overrides
  const merged = mergeOverrides(step.overrides, step.build ? step.build(ctx) : undefined)
  if (merged) {
    headers = applyOverrides(headers, merged)
    if (merged.body) body = merged.body
  }

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

  const msg: SipRequest = {
    type: "request",
    method,
    uri: method === "CANCEL" && dialogState.lastInviteUri
      ? dialogState.lastInviteUri
      : finalUri,
    version: "SIP/2.0",
    headers,
    body,
    raw: Buffer.alloc(0),
  }

  const buf = serialize(msg)
  return { msg: { ...msg, raw: buf }, buf }
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

  let headers = [...defaultHeaders]
  let body: Uint8Array = new Uint8Array(0)

  // Apply overrides
  const merged = mergeOverrides(step.overrides, step.build ? step.build(ctx) : undefined)
  if (merged) {
    headers = applyOverrides(headers, merged)
    if (merged.body) body = merged.body
  }

  // RFC 3261 §7.4.1: Content-Type MUST be present when a body is included
  if (body.byteLength > 0 && !headers.some((hdr) => hdr.name.toLowerCase() === "content-type")) {
    headers.push(h("Content-Type", "application/sdp"))
  }
  headers.push(h("Content-Length", String(body.byteLength)))

  const msg: SipResponse = {
    type: "response",
    version: "SIP/2.0",
    status: statusCode,
    reason,
    headers,
    body,
    raw: Buffer.alloc(0),
  }

  const buf = serialize(msg)
  return { msg: { ...msg, raw: buf }, buf }
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
  if (/;tag=/i.test(toHeader)) return toHeader
  return `${toHeader};tag=${localTag}`
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

function applyOverrides(headers: SipHeader[], overrides: HeaderOverrides): SipHeader[] {
  const result = [...headers]

  if (overrides.cseq !== undefined) {
    const idx = result.findIndex((h) => h.name.toLowerCase() === "cseq")
    if (idx >= 0) {
      const parts = result[idx]!.value.split(/\s+/)
      result[idx] = h("CSeq", `${overrides.cseq} ${parts[1] ?? "INVITE"}`)
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
