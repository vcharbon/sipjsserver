/**
 * generators — pure, correct-by-default SIP message builders.
 *
 * Every returned `SipRequest` / `SipResponse` is immediately sendable: no
 * sentinels, no post-processing. Via and Contact are materialised from the
 * `ViaSpec` / `ContactSpec` passed in by the caller.
 *
 * All generators are pure functions — Call-ID, branch, tag, local address, and
 * CSeq are arguments, never side effects. Tests inject deterministic
 * identifiers by passing them in.
 *
 * The generators cover four shapes:
 *   - out-of-dialog request  (initial INVITE, one-shot OPTIONS, …)
 *   - in-dialog request      (BYE, re-INVITE, PRACK, NOTIFY, …)
 *   - ACK / CANCEL           (specialised because they borrow identifiers
 *                             from a sibling transaction)
 *   - response               (`generateResponse` echoes a request's dialog
 *                             identifiers; `generateRelayedResponse` rebuilds
 *                             a response from snapshotted B2BUA-side fields)
 */

import type { SipHeader, SipMessage, SipRequest, SipResponse } from "./types.js"
import type { StackDialog } from "./Dialog.js"
import type { InviteClientTransactionHandle } from "./TransactionLayer.js"
import { getHeader } from "./MessageHelpers.js"
import { hydrateRequest, hydrateResponse } from "./parsers/extract-fields.js"
import { parseNameAddr } from "./parsers/custom/structured-headers.js"

// ---------------------------------------------------------------------------
// Public input shapes
// ---------------------------------------------------------------------------

export type SipTransport = "UDP" | "TCP" | "TLS" | "WS" | "WSS"

/** Structured Via input. `customParams` are B2BUA-opaque (e.g. `cr`, `lg`, `em`). */
export interface ViaSpec {
  readonly localIp: string
  readonly localPort: number
  readonly transport: SipTransport
  readonly branch: string
  readonly customParams?: Record<string, string>
}

/** Structured Contact input. `uriParams` are B2BUA-opaque (e.g. `callRef`, `leg`, `emerg`). */
export interface ContactSpec {
  readonly user: string
  readonly host: string
  readonly port: number
  readonly uriParams?: Record<string, string>
}

/** Method literals the in-dialog generator accepts (ACK excluded — it has its own primitive). */
export type InDialogMethod =
  | "BYE"
  | "INVITE"
  | "PRACK"
  | "NOTIFY"
  | "OPTIONS"
  | "INFO"
  | "UPDATE"
  | "MESSAGE"

/** Method literals the out-of-dialog generator accepts. */
export type OutOfDialogMethod =
  | "INVITE"
  | "OPTIONS"
  | "MESSAGE"
  | "REGISTER"
  | "SUBSCRIBE"
  | "PUBLISH"

// ---------------------------------------------------------------------------
// Structural header set (RFC 3261 §16.6 — stack-owned; never copied transparently)
// ---------------------------------------------------------------------------

const STRUCTURAL_HEADERS: ReadonlySet<string> = new Set([
  "via",
  "contact",
  "from",
  "to",
  "call-id",
  "cseq",
  "max-forwards",
  "content-length",
  "content-type",
  "record-route",
  "route",
])

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const EMPTY_BODY = new Uint8Array(0)
const EMPTY_RAW = Buffer.alloc(0)

// RFC 3261 §13.2.1 / §20.37 — methods the B2BUA accepts on a confirmed
// dialog and the SIP extensions it supports. Advertised on every
// B2BUA-originated INVITE (initial + re-INVITE) so the peer can
// negotiate accepted methods and Require-able extensions.
export const B2BUA_ALLOW = "INVITE, ACK, CANCEL, BYE, OPTIONS, UPDATE, INFO, REFER, NOTIFY, PRACK"
export const B2BUA_SUPPORTED = "100rel, timer, replaces"

function h(name: string, value: string): SipHeader {
  return { name, value }
}

function makeRequest(
  method: string,
  uri: string,
  headers: SipHeader[],
  body: Uint8Array = EMPTY_BODY,
): SipRequest {
  return hydrateRequest({ method, uri, headers, body, raw: EMPTY_RAW })
}

function makeResponse(
  status: number,
  reason: string,
  headers: SipHeader[],
  body: Uint8Array = EMPTY_BODY,
): SipResponse {
  return hydrateResponse({ status, reason, headers, body, raw: EMPTY_RAW })
}

/**
 * Serialize a ViaSpec into a Via header value.
 * `customParams` are appended verbatim — callers already URL-encode values
 * that need escaping (see SipRouter's cr/lg/em handling).
 */
function buildViaValue(v: ViaSpec): string {
  let out = `SIP/2.0/${v.transport} ${v.localIp}:${v.localPort};branch=${v.branch}`
  if (v.customParams) {
    for (const [k, val] of Object.entries(v.customParams)) {
      // RFC 3581 §3: a flag parameter (e.g. `rport` on a UAC request) is
      // serialised without `=value`. Empty-string values map to that shape.
      out += val.length > 0 ? `;${k}=${val}` : `;${k}`
    }
  }
  return out
}

/**
 * Serialize a ContactSpec into a Contact header value (angle-bracketed).
 * `uriParams` are appended verbatim (callers encode as needed).
 */
function buildContactValue(c: ContactSpec): string {
  let uri = `sip:${c.user}@${c.host}:${c.port}`
  if (c.uriParams) {
    for (const [k, val] of Object.entries(c.uriParams)) {
      uri += `;${k}=${val}`
    }
  }
  return `<${uri}>`
}

/**
 * Wrap a bare URI in angle brackets. If the input already contains `<`
 * (e.g. a full name-addr with display name), pass it through unchanged.
 */
function wrapUri(uriOrNameAddr: string): string {
  if (uriOrNameAddr.includes("<")) return uriOrNameAddr
  return `<${uriOrNameAddr}>`
}

/**
 * Extract the numeric CSeq from a request. Returns 0 when absent or malformed
 * (shouldn't happen for well-formed RFC 3261 messages — callers supply parsed
 * or stack-generated requests).
 */
function cseqNumber(req: SipRequest): number {
  const raw = getHeader(req.headers, "cseq")
  if (raw === undefined) return 0
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * Append Content-Type (when body is non-empty and caller didn't already
 * include one in `headers`) + Content-Length. Enforces RFC 3261 §7.4.1.
 */
function appendBodyHeaders(
  headers: SipHeader[],
  body: Uint8Array,
  contentType: string | undefined,
): void {
  const hasCT = headers.some((hdr) => hdr.name.toLowerCase() === "content-type")
  if (body.byteLength > 0 && !hasCT) {
    headers.push(h("Content-Type", contentType ?? "application/sdp"))
  }
  headers.push(h("Content-Length", String(body.byteLength)))
}

// ---------------------------------------------------------------------------
// extractNonStructuralHeaders
// ---------------------------------------------------------------------------

/**
 * Return every header from `msg` whose name is NOT in the stack-owned
 * structural set. Callers pass the result through `extraHeaders` when
 * relaying so transparent fields (Allow, Supported, P-Asserted-Identity, …)
 * flow through unchanged while the generator owns the dialog headers.
 */
export function extractNonStructuralHeaders(msg: SipMessage): ReadonlyArray<SipHeader> {
  const out: SipHeader[] = []
  for (const hdr of msg.headers) {
    if (!STRUCTURAL_HEADERS.has(hdr.name.toLowerCase())) out.push(hdr)
  }
  return out
}

// ---------------------------------------------------------------------------
// Out-of-dialog request (initial INVITE, OPTIONS, …)
// ---------------------------------------------------------------------------

export interface GenerateOutOfDialogRequestOpts {
  readonly requestUri: string
  readonly callId: string
  readonly fromUri: string
  readonly fromTag: string
  readonly toUri: string
  readonly toTag?: string
  readonly cseq: number
  readonly via: ViaSpec
  readonly contact: ContactSpec
  readonly maxForwards?: number
  readonly body?: Uint8Array
  readonly contentType?: string
  readonly extraHeaders?: ReadonlyArray<SipHeader>
}

/**
 * Build an out-of-dialog request — initial INVITE, one-shot OPTIONS, MESSAGE,
 * REGISTER, SUBSCRIBE, PUBLISH.
 *
 * RFC 3261 §8.1.1: Via, Max-Forwards (default 70), From-tag, Call-ID, CSeq,
 * To (tag normally absent), Contact.
 */
export function generateOutOfDialogRequest(
  method: OutOfDialogMethod,
  opts: GenerateOutOfDialogRequestOpts,
): SipRequest {
  const body = opts.body ?? EMPTY_BODY
  const maxForwards = opts.maxForwards ?? 70

  const headers: SipHeader[] = [
    h("Via", buildViaValue(opts.via)),
    h("Max-Forwards", String(maxForwards)),
    h("From", `${wrapUri(opts.fromUri)};tag=${opts.fromTag}`),
    h("To", opts.toTag !== undefined
        ? `${wrapUri(opts.toUri)};tag=${opts.toTag}`
        : wrapUri(opts.toUri)),
    h("Call-ID", opts.callId),
    h("CSeq", `${opts.cseq} ${method}`),
    h("Contact", buildContactValue(opts.contact)),
  ]
  if (opts.extraHeaders) {
    for (const hdr of opts.extraHeaders) headers.push(hdr)
  }
  appendBodyHeaders(headers, body, opts.contentType)

  return makeRequest(method, opts.requestUri, headers, body)
}

// ---------------------------------------------------------------------------
// In-dialog request (BYE, re-INVITE, PRACK, NOTIFY, INFO, UPDATE, MESSAGE)
// ---------------------------------------------------------------------------

export interface GenerateInDialogRequestOpts {
  readonly via: ViaSpec
  readonly contact: ContactSpec
  readonly body?: Uint8Array
  readonly contentType?: string
  readonly extraHeaders?: ReadonlyArray<SipHeader>
  /** Required when method === "PRACK" (RFC 3262). */
  readonly rack?: string
  /** Required when method === "NOTIFY" (RFC 6665 §7.2). */
  readonly event?: string
  /** Required when method === "NOTIFY" (RFC 6665 §4.1.3). */
  readonly subscriptionState?: string
  /**
   * Explicit CSeq number. When omitted, the generator uses `dialog.localCSeq + 1`.
   * Set by B2BUA relay paths that mirror the inbound CSeq via `relayCSeqDelta`
   * (delta may be > 1 when the peer skipped sequence numbers).
   */
  readonly cseq?: number
  /**
   * Request-URI override. When omitted, the generator uses `dialog.remoteTarget`.
   * Callers provide a fallback here for legs whose dialog has no remote target
   * populated yet (e.g. placeholder dialogs before 2xx lands).
   */
  readonly requestUri?: string
}

/**
 * Build an in-dialog request. Enforces RFC 3261 §12.2.1.1: Call-ID from the
 * dialog, From/To swap tags, CSeq = dialog.localCSeq + 1 (or explicit override),
 * Request-URI = dialog.remoteTarget (or explicit override), Route headers
 * pulled from the dialog's route set.
 *
 * Returns both the request and the dialog with `localCSeq` bumped to the used
 * CSeq — callers persist the new dialog.
 */
export function generateInDialogRequest(
  method: InDialogMethod,
  dialog: StackDialog,
  opts: GenerateInDialogRequestOpts,
): { readonly request: SipRequest; readonly dialog: StackDialog } {
  const body = opts.body ?? EMPTY_BODY
  const nextCSeq = opts.cseq ?? dialog.localCSeq + 1
  const requestUri = opts.requestUri ?? dialog.remoteTarget

  const headers: SipHeader[] = [
    h("Via", buildViaValue(opts.via)),
    h("Max-Forwards", "70"),
    h("From", `${wrapUri(dialog.localUri)};tag=${dialog.localTag}`),
    h("To", `${wrapUri(dialog.remoteUri)};tag=${dialog.remoteTag}`),
    h("Call-ID", dialog.callId),
    h("CSeq", `${nextCSeq} ${method}`),
  ]

  // Contact is emitted for every in-dialog method EXCEPT BYE. BYE terminates
  // the dialog — target-refresh makes no sense, and a peer that keys dialog
  // state off Contact on BYE only adds churn. See RFC 3261 §15.1.
  if (method !== "BYE") {
    headers.push(h("Contact", buildContactValue(opts.contact)))
  }

  // Route set (RFC 3261 §12.2.1.1) — one Route header per entry, preserving order.
  for (const route of dialog.routeSet) {
    headers.push(h("Route", route))
  }

  if (method === "PRACK" && opts.rack !== undefined) {
    headers.push(h("RAck", opts.rack))
  }
  if (method === "NOTIFY") {
    if (opts.event !== undefined) headers.push(h("Event", opts.event))
    if (opts.subscriptionState !== undefined) {
      headers.push(h("Subscription-State", opts.subscriptionState))
    }
  }
  // RFC 3261 §13.2.1 / §20.37 — B2BUA-originated re-INVITEs advertise
  // accepted methods + supported extensions to the peer.
  if (method === "INVITE") {
    headers.push(h("Allow", B2BUA_ALLOW))
    headers.push(h("Supported", B2BUA_SUPPORTED))
  }

  if (opts.extraHeaders) {
    for (const hdr of opts.extraHeaders) headers.push(hdr)
  }
  appendBodyHeaders(headers, body, opts.contentType)

  const request = makeRequest(method, requestUri, headers, body)
  const nextDialog: StackDialog = { ...dialog, localCSeq: nextCSeq }
  return { request, dialog: nextDialog }
}

// ---------------------------------------------------------------------------
// ACK for 2xx (separate because CSeq is sourced from the INVITE txn handle)
// ---------------------------------------------------------------------------

export interface GenerateAckFor2xxOpts {
  readonly via: ViaSpec
  readonly body?: Uint8Array
  readonly contentType?: string
  readonly extraHeaders?: ReadonlyArray<SipHeader>
  /**
   * Explicit CSeq override. Required when `inviteTxn` is undefined (e.g. a
   * Redis-recovered call that lost the handle). When both are provided,
   * the explicit `cseq` wins.
   */
  readonly cseq?: number
  /**
   * Request-URI override. When omitted, uses `dialog.remoteTarget`. Callers
   * provide a fallback for dialogs whose `remoteTarget` may be empty.
   */
  readonly requestUri?: string
}

/**
 * Build an ACK for a 2xx response. RFC 3261 §13.2.2.4: the CSeq number comes
 * from the INVITE (not from the dialog's current localCSeq — a PRACK sent
 * between INVITE and 2xx will have bumped localCSeq). The handle carries the
 * original INVITE, so we read the CSeq straight off it.
 *
 * Own Via branch — the ACK for 2xx is its own hop (RFC 3261 §17.1.1.2).
 */
export function generateAckFor2xx(
  inviteTxn: InviteClientTransactionHandle | undefined,
  dialog: StackDialog,
  opts: GenerateAckFor2xxOpts,
): SipRequest {
  const body = opts.body ?? EMPTY_BODY
  const inviteCSeq = opts.cseq ?? (inviteTxn !== undefined ? cseqNumber(inviteTxn.originalInvite) : undefined)
  if (inviteCSeq === undefined) {
    throw new Error("generateAckFor2xx: either inviteTxn or opts.cseq must be provided")
  }
  const requestUri = opts.requestUri ?? dialog.remoteTarget

  const headers: SipHeader[] = [
    h("Via", buildViaValue(opts.via)),
    h("Max-Forwards", "70"),
    h("From", `${wrapUri(dialog.localUri)};tag=${dialog.localTag}`),
    h("To", `${wrapUri(dialog.remoteUri)};tag=${dialog.remoteTag}`),
    h("Call-ID", dialog.callId),
    h("CSeq", `${inviteCSeq} ACK`),
  ]

  for (const route of dialog.routeSet) {
    headers.push(h("Route", route))
  }

  if (opts.extraHeaders) {
    for (const hdr of opts.extraHeaders) headers.push(hdr)
  }
  appendBodyHeaders(headers, body, opts.contentType)

  return makeRequest("ACK", requestUri, headers, body)
}

// ---------------------------------------------------------------------------
// CANCEL
// ---------------------------------------------------------------------------

/**
 * Build a CANCEL for the outstanding INVITE described by `inviteTxn`.
 *
 * RFC 3261 §9.1: CANCEL must carry the INVITE's topmost Via **verbatim**
 * (same branch — server transaction matching). Request-URI, Call-ID, From,
 * To echo the INVITE. CSeq number reused, method "CANCEL".
 */
export function generateCancel(inviteTxn: InviteClientTransactionHandle): SipRequest {
  const invite = inviteTxn.originalInvite
  const via = getHeader(invite.headers, "via")
  const from = getHeader(invite.headers, "from")
  const to = getHeader(invite.headers, "to")
  const callId = getHeader(invite.headers, "call-id")
  if (via === undefined || from === undefined || to === undefined || callId === undefined) {
    throw new Error("generateCancel: INVITE missing required headers")
  }
  const inviteCSeq = cseqNumber(invite)

  const headers: SipHeader[] = [
    h("Via", via),
    h("Max-Forwards", "70"),
    h("From", from),
    h("To", to),
    h("Call-ID", callId),
    h("CSeq", `${inviteCSeq} CANCEL`),
    h("Content-Length", "0"),
  ]

  return makeRequest("CANCEL", invite.uri, headers)
}

// ---------------------------------------------------------------------------
// UAS response
// ---------------------------------------------------------------------------

export interface GenerateResponseOpts {
  /**
   * Tag added to To when status > 100. The UAS caller pins this on the first
   * non-100 response and reuses it for every subsequent response in the same
   * server transaction (RFC 3261 §12.1.1 / §17.2.1). Omit only for 100 Trying.
   */
  readonly toTag?: string
  /** Required on 2xx to dialog-creating requests (RFC 3261 §20.10). */
  readonly contact?: ContactSpec
  readonly body?: Uint8Array
  readonly contentType?: string
  readonly extraHeaders?: ReadonlyArray<SipHeader>
}

/**
 * Build a UAS response to `incomingRequest`. Echoes Via, From, To, Call-ID,
 * CSeq from the request (RFC 3261 §8.2.6.2). Adds the caller-provided To-tag
 * when the status is > 100 and the request's To header lacks one.
 */
export function generateResponse(
  incomingRequest: SipRequest,
  status: number,
  reason: string,
  opts: GenerateResponseOpts = {},
): SipResponse {
  const body = opts.body ?? EMPTY_BODY

  const rawTo = getHeader(incomingRequest.headers, "to") ?? ""
  const from = getHeader(incomingRequest.headers, "from") ?? ""
  const callId = getHeader(incomingRequest.headers, "call-id") ?? ""
  const cseq = getHeader(incomingRequest.headers, "cseq") ?? ""

  let to = rawTo
  if (status > 100 && opts.toTag !== undefined && parseNameAddr(rawTo).tag === undefined) {
    to = `${rawTo};tag=${opts.toTag}`
  }

  const headers: SipHeader[] = []

  // Echo every Via from the request in order — preserves the response path
  // (RFC 3261 §8.2.6.2). Request headers are stored top-down; iterate the
  // full list instead of relying on `parsed.vias` so this works for freshly
  // constructed requests too.
  for (const hdr of incomingRequest.headers) {
    if (hdr.name.toLowerCase() === "via") headers.push(h("Via", hdr.value))
  }

  // Echo Record-Route (RFC 3261 §16.6). Only proxies add them; B2BUA just
  // preserves them for downstream correctness.
  for (const hdr of incomingRequest.headers) {
    if (hdr.name.toLowerCase() === "record-route") headers.push(h("Record-Route", hdr.value))
  }

  headers.push(h("From", from))
  headers.push(h("To", to))
  headers.push(h("Call-ID", callId))
  headers.push(h("CSeq", cseq))

  if (opts.contact !== undefined) {
    headers.push(h("Contact", buildContactValue(opts.contact)))
  }

  if (opts.extraHeaders) {
    for (const hdr of opts.extraHeaders) headers.push(hdr)
  }
  appendBodyHeaders(headers, body, opts.contentType)

  return makeResponse(status, reason, headers, body)
}

// ---------------------------------------------------------------------------
// Relayed response — B2BUA rebuilds a response from snapshotted fields
// ---------------------------------------------------------------------------

export interface GenerateRelayedResponseOpts {
  /** Via headers from the target-facing request (one Via header per entry). */
  readonly vias: ReadonlyArray<string>
  readonly from: string
  readonly to: string
  readonly callId: string
  /** Full CSeq value (`"<number> <METHOD>"`). */
  readonly cseq: string
  readonly body?: Uint8Array
  readonly contentType?: string
  /** Non-structural headers to carry through from the source response (§16.6). */
  readonly transparentHeaders?: ReadonlyArray<SipHeader>
  /**
   * Record-Route headers to reflect verbatim onto the response. Only meaningful
   * for dialog-creating responses (RFC 3261 §12.1.1) — emit one per entry, in
   * the same order the request received them. The B2BUA's a-leg responder
   * passes `getHeaders(state.call.aLegInvite.headers, "record-route")` so the
   * UAC can reverse-build its route set per §12.1.2 and route subsequent
   * in-dialog requests through the upstream proxy.
   */
  readonly recordRoutes?: ReadonlyArray<string>
  /** Contact for the response. Required for dialog-creating 2xx (RFC 3261 §20.10). */
  readonly contact?: ContactSpec
}

/**
 * Rebuild a B2BUA-side response for relay to a peer leg.
 *
 * Contract:
 *   - Via headers replaced by caller-supplied `vias`.
 *   - From, To, Call-ID, CSeq rewritten from the caller-supplied values.
 *   - Body carried through (caller passes `resp.body`).
 *   - Transparent headers (Allow, Supported, P-Asserted-Identity, …) flow
 *     through via `transparentHeaders` — caller extracts them with
 *     `extractNonStructuralHeaders(resp)`.
 *   - Contact emitted when `contact` provided (B2BUA's own a-facing or b-facing
 *     identity so the peer target-refreshes to us, not the far side).
 */
export function generateRelayedResponse(
  status: number,
  reason: string,
  opts: GenerateRelayedResponseOpts,
): SipResponse {
  const body = opts.body ?? EMPTY_BODY

  const headers: SipHeader[] = []
  for (const via of opts.vias) headers.push(h("Via", via))
  // Record-Route reflected verbatim, in received order. Per RFC 3261
  // §12.1.1 the UAS preserves the request's R-R order; the UAC reverses
  // it (§12.1.2). Emitting before From/To groups it with the topology
  // headers as Via does.
  if (opts.recordRoutes) {
    for (const rr of opts.recordRoutes) headers.push(h("Record-Route", rr))
  }
  headers.push(h("From", opts.from))
  headers.push(h("To", opts.to))
  headers.push(h("Call-ID", opts.callId))
  headers.push(h("CSeq", opts.cseq))

  if (opts.transparentHeaders) {
    for (const hdr of opts.transparentHeaders) headers.push(hdr)
  }

  if (opts.contact !== undefined) {
    headers.push(h("Contact", buildContactValue(opts.contact)))
  }
  appendBodyHeaders(headers, body, opts.contentType)

  return makeResponse(status, reason, headers, body)
}

// ---------------------------------------------------------------------------
// ACK for non-2xx (stack-internal)
// ---------------------------------------------------------------------------

/**
 * Build an ACK for a non-2xx final response inside the INVITE client
 * transaction (RFC 3261 §17.1.1.3). Reuses the INVITE's topmost Via
 * (same branch — the ACK is part of the INVITE txn), copies From/To/Call-ID
 * from the response, sets CSeq method to ACK while keeping the INVITE's
 * sequence number.
 *
 * Stack-internal: called only by TransactionLayer's auto-ACK machinery.
 * Prefixed with `_` to signal the API contract.
 */
export function _generateAckForNon2xx(
  originalInvite: SipRequest,
  finalResponse: SipResponse,
): SipRequest {
  const via = getHeader(originalInvite.headers, "via")
  if (via === undefined) {
    throw new Error("_generateAckForNon2xx: INVITE missing Via")
  }
  const from = getHeader(finalResponse.headers, "from") ?? ""
  const to = getHeader(finalResponse.headers, "to") ?? ""
  const callId = getHeader(finalResponse.headers, "call-id") ?? ""
  const cseqNum = cseqNumber(originalInvite)

  const headers: SipHeader[] = [
    h("Via", via),
    h("Max-Forwards", "70"),
    h("From", from),
    h("To", to),
    h("Call-ID", callId),
    h("CSeq", `${cseqNum} ACK`),
    h("Content-Length", "0"),
  ]

  return makeRequest("ACK", originalInvite.uri, headers)
}

/**
 * Build the hop-by-hop ACK a stateless proxy must send to the downstream
 * UAS when forwarding a 3xx-6xx INVITE final response upstream
 * (RFC 3261 §17.1.1.3 / §17.2.6). The proxy doesn't retain the full
 * original INVITE — only the (downstream-target, our-egress-branch)
 * pair it cached when it forwarded the INVITE — so we rebuild the ACK
 * from that pair plus the final response itself:
 *
 *   RURI    = sip:<target.host>:<target.port>  (where the INVITE went)
 *   Via     = our advertised address with the SAME branch as the INVITE,
 *             so the downstream's INVITE server transaction matches and
 *             closes (§17.2.1 matches the ACK on top-Via branch).
 *   From    = response's From (carries the UAC's tag)
 *   To      = response's To  (carries the UAS's tag)
 *   Call-ID = response's Call-ID
 *   CSeq    = response's CSeq number, method=ACK
 *
 * Stack-internal: called only by ProxyCore's response forwarding path.
 */
export function _generateProxyAckForNon2xx(
  finalResponse: SipResponse,
  target: { readonly host: string; readonly port: number },
  ourBranch: string,
  ourAdvertised: { readonly ip: string; readonly port: number },
): SipRequest {
  const from = getHeader(finalResponse.headers, "from") ?? ""
  const to = getHeader(finalResponse.headers, "to") ?? ""
  const callId = getHeader(finalResponse.headers, "call-id") ?? ""
  const cseqNum = finalResponse.getHeader("cseq").seq

  const headers: SipHeader[] = [
    h(
      "Via",
      `SIP/2.0/UDP ${ourAdvertised.ip}:${ourAdvertised.port};branch=${ourBranch};rport`,
    ),
    h("Max-Forwards", "70"),
    h("From", from),
    h("To", to),
    h("Call-ID", callId),
    h("CSeq", `${cseqNum} ACK`),
    h("Content-Length", "0"),
  ]

  return makeRequest("ACK", `sip:${target.host}:${target.port}`, headers)
}
