/**
 * Core SIP message types for the B2BUA.
 * Headers are stored as an ordered array to preserve multiplicity and order
 * (multiple Via headers, etc.).
 *
 * Mandatory header fields (From, To, Call-ID, CSeq, top Via, plus
 * Request-URI on requests) are eagerly parsed and guaranteed present on
 * every well-formed message — the parser rejects messages that lack them.
 *
 * Optional structured headers (P-Asserted-Identity, Diversion, History-Info,
 * Geolocation, …) are exposed via the lazy `lazy` accessor and parsed on
 * first access only.
 */

import type { LazyHeaders } from "./parsers/custom/lazy-headers.js"

export interface SipHeader {
  readonly name: string   // original case
  readonly value: string  // trimmed value
}

// ---------------------------------------------------------------------------
// Eagerly-parsed structured fields
// ---------------------------------------------------------------------------

export interface ParsedNameAddrField {
  readonly displayName: string | undefined
  readonly uri: string
  readonly tag: string | undefined
  readonly params: Record<string, string | true>
}

export interface ParsedViaField {
  readonly transport: string
  readonly host: string
  readonly port: number | undefined
  readonly branch: string | undefined
  readonly params: Record<string, string | true>
}

export interface ParsedContactField {
  readonly displayName: string | undefined
  readonly uri: string
  readonly params: Record<string, string | true>
}

export interface ParsedCSeqField {
  readonly seq: number
  readonly method: string
}

export interface ParsedRequestUriField {
  readonly scheme: string
  readonly user: string | undefined
  readonly host: string
  readonly port: number | undefined
  readonly params: Record<string, string>
}

/** Common mandatory parsed fields shared by requests and responses. */
export interface ParsedFieldsCommon {
  /** From — RFC 3261 §8.1.1.3 mandates presence; tag is independently optional on initial requests. */
  readonly from: ParsedNameAddrField
  /** To — mandatory; tag is absent on initial requests, present on responses and in-dialog requests. */
  readonly to: ParsedNameAddrField
  /** Call-ID — mandatory. */
  readonly callId: string
  /** CSeq — mandatory. */
  readonly cseq: ParsedCSeqField
  /** Top Via — mandatory. `branch` is independently optional (legacy non-3261 hops). */
  readonly via: ParsedViaField
  /** All Via headers, in received order. Always at least one entry. */
  readonly vias: ReadonlyArray<ParsedViaField>
  /** Contact — optional (mandatory on INVITE / 200 OK / REGISTER, absent elsewhere). */
  readonly contact: ParsedContactField | undefined
}

export interface RequestParsedFields extends ParsedFieldsCommon {
  /** Request-URI — required on every request. */
  readonly requestUri: ParsedRequestUriField
}

export type ResponseParsedFields = ParsedFieldsCommon

export interface SipRequest {
  readonly type: "request"
  readonly method: string        // INVITE, ACK, BYE, CANCEL, OPTIONS…
  readonly uri: string           // Request-URI (raw string)
  readonly version: string       // SIP/2.0
  readonly headers: ReadonlyArray<SipHeader>
  readonly body: Uint8Array      // raw bytes — opaque to B2BUA
  readonly raw: Buffer           // original packet bytes
  readonly parsed: RequestParsedFields
  readonly lazy: LazyHeaders
}

export interface SipResponse {
  readonly type: "response"
  readonly version: string       // SIP/2.0
  readonly status: number        // 100, 180, 200…
  readonly reason: string
  readonly headers: ReadonlyArray<SipHeader>
  readonly body: Uint8Array      // raw bytes — opaque to B2BUA
  readonly raw: Buffer           // original packet bytes
  readonly parsed: ResponseParsedFields
  readonly lazy: LazyHeaders
}

export type SipMessage = SipRequest | SipResponse

// ---------------------------------------------------------------------------
// Narrowed message subtypes — zero-copy refinements
// ---------------------------------------------------------------------------
//
// These interfaces describe the SAME runtime objects as `SipRequest` /
// `SipResponse` but carry stronger compile-time guarantees the dispatcher
// (and parser) enforces at runtime. Code paths that have already established
// the runtime invariants cast their `SipRequest` / `SipResponse` references
// to the narrower view; no allocation, no copy.
//
// See docs/AdvancedCallModel.md for the dispatch-time invariants and
// docs/typescript-effect.md for the projection rationale.

/** Tag-bearing parsed name-addr — `tag` is guaranteed present. */
export interface TaggedNameAddrField extends ParsedNameAddrField {
  readonly tag: string
}

/**
 * Request known to be in-dialog at dispatch time.
 *
 * Both `From.tag` and `To.tag` are guaranteed present:
 * - From-tag is set by every UAC on the initial request.
 * - To-tag is added by the UAS when the dialog is created and echoed by
 *   every subsequent in-dialog request (RFC 3261 §12.2).
 *
 * The router only resolves the request to an existing dialog/leg when both
 * tags match a confirmed dialog, so by the time a rule sees it gated by
 * `legState: "confirmed"` (or any in-dialog-implying match), this is the
 * runtime-true type.
 */
export interface InDialogRequest extends SipRequest {
  readonly parsed: RequestParsedFields & {
    readonly from: TaggedNameAddrField
    readonly to: TaggedNameAddrField
  }
}

/** Request whose `method` is the literal type `M` (matches a `RequestMatch.method` gate). */
export interface MethodRequest<M extends string> extends SipRequest {
  readonly method: M
}

/** In-dialog request whose `method` is the literal type `M`. */
export type InDialogMethodRequest<M extends string> = InDialogRequest & MethodRequest<M>

/**
 * Response surfaced to the B2BUA application layer.
 *
 * `To.tag` is guaranteed present because:
 * - The parser rejects any non-100 response missing a To-tag
 *   (see `extractResponseFields`).
 * - The TransactionLayer absorbs all `100 Trying` responses (RFC 3261:
 *   100 is hop-by-hop only) before they reach the application.
 *
 * Together these two boundaries mean every response a rule sees has a
 * non-empty To-tag, so this view is the runtime truth.
 */
export interface SipResponseTagged extends SipResponse {
  readonly parsed: ResponseParsedFields & {
    readonly to: TaggedNameAddrField
  }
}

/** Message that may be surfaced to the B2BUA application layer (post-txn-layer). */
export type B2BUAMessage = SipRequest | SipResponseTagged

/** Remote address from which a UDP packet was received. */
export interface RemoteInfo {
  readonly address: string
  readonly port: number
}

/** State machine for a single B2BUA call. */
export interface CallRecord {
  readonly aLegCallId: string
  readonly aLegFromTag: string
  aLegToTag: string             // filled when 200 OK arrives from b-leg
  readonly aLegSource: RemoteInfo
  readonly aLegVia: string      // original Via header value from first INVITE

  readonly bLegCallId: string
  readonly bLegFromTag: string  // B2BUA-generated From tag on outgoing INVITE

  bLegToTag: string             // filled from b-leg 200 OK To tag
  bLegContact: string           // filled from b-leg 200 OK Contact

  state: "early" | "confirmed" | "terminated"
  readonly startedAt: number
}
