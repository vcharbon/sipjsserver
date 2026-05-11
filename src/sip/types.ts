/**
 * Core SIP message types for the B2BUA.
 *
 * Headers are stored as an ordered array to preserve multiplicity and
 * order (multiple Via headers, etc.). The user-facing access pattern is
 * `msg.getHeader<K>(name)` — see `SipHeaderTypes` for the typed registry
 * and `header-registry.ts` for the runtime side.
 *
 * Mandatory header fields (From, To, Call-ID, CSeq, top Via, plus
 * Request-URI on requests) are eagerly parsed by the parser pipeline;
 * the parser rejects messages that lack them. Optional structured
 * headers (P-Asserted-Identity, Diversion, History-Info, Geolocation,
 * …) are parsed lazily on first `getHeader` access and memoized.
 */

import type { Result } from "effect"
import type {
  ParsedNameAddr,
  ParsedRack,
  ParsedReferTo,
} from "./parsers/custom/structured-headers.js"
import type { SipParseError } from "./parsers/errors.js"

export interface SipHeader {
  readonly name: string   // original case
  readonly value: string  // trimmed value
}

/** Non-empty readonly array — `[0]` is `T`, not `T | undefined`. */
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]]

// ---------------------------------------------------------------------------
// Parsed structured fields — exposed as registry value types
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

// ---------------------------------------------------------------------------
// Header-access registry — typed map of canonical names → parsed value type
// ---------------------------------------------------------------------------

/**
 * Typed registry consulted by `SipMessage.getHeader`. Each key is the
 * canonical lowercase long-form header name. The value type encodes both
 * the parsed shape and any error/multiplicity semantics:
 *   - guaranteed single: `T`
 *   - guaranteed non-empty multi: `NonEmptyReadonlyArray<T>`
 *   - optional single: `T | undefined`
 *   - lazy / can-fail: `Result.Result<T, SipParseError>`
 *
 * Third parties extend the registry via TypeScript declaration merging
 * (`declare module "..."`) and the runtime via
 * `SipHeaderRegistry.register(...)`. See header-registry.ts.
 */
export interface SipHeaderTypes {
  // Mandatory single-valued — parser rejects messages that omit these.
  "from": ParsedNameAddrField
  "to": ParsedNameAddrField
  "call-id": string
  "cseq": ParsedCSeqField

  // Mandatory multi-valued — `[0]` is the top Via (response-routing hop).
  "via": NonEmptyReadonlyArray<ParsedViaField>

  // Optional single-valued.
  "contact": ParsedContactField | undefined

  // Lazy single-valued — parse can fail without invalidating the message.
  "geolocation-routing": Result.Result<boolean | undefined, SipParseError>
  "rack": Result.Result<ParsedRack | undefined, SipParseError>
  "refer-to": Result.Result<ParsedReferTo | undefined, SipParseError>

  // Lazy multi-valued — parse can fail without invalidating the message.
  "p-asserted-identity": Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
  "p-preferred-identity": Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
  "diversion": Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
  "history-info": Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
  "remote-party-id": Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
  "geolocation": Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
  "geolocation-error": Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
}

// ---------------------------------------------------------------------------
// Message shape
// ---------------------------------------------------------------------------

export interface SipRequest {
  readonly type: "request"
  readonly method: string        // INVITE, ACK, BYE, CANCEL, OPTIONS…
  readonly uri: string           // Request-URI (raw string, on the wire)
  /** Request-URI parsed into its constituent parts. */
  readonly requestUri: ParsedRequestUriField
  readonly version: string       // SIP/2.0
  readonly headers: ReadonlyArray<SipHeader>
  readonly body: Uint8Array      // raw bytes — opaque to B2BUA
  readonly raw: Buffer           // original packet bytes
  /**
   * Typed header access. Registered keys return their `SipHeaderTypes[K]`
   * value; unknown names fall back to a raw `ReadonlyArray<string>`.
   *
   * NOTE on union access: when the receiver is a *union* of message types
   * (e.g. `B2BUAMessage = SipRequest | SipResponseTagged`), TypeScript's
   * overload resolution doesn't pick the best per-branch signature — it
   * picks the *last* compatible signature, which is the raw-string
   * fallback. Narrow the receiver with `msg.type === "request"` (or
   * `"response"`) before calling `getHeader("from")` etc. on a union.
   */
  getHeader<K extends keyof SipHeaderTypes>(name: K): SipHeaderTypes[K]
  getHeader(name: string): ReadonlyArray<string>
}

export interface SipResponse {
  readonly type: "response"
  readonly version: string       // SIP/2.0
  readonly status: number        // 100, 180, 200…
  readonly reason: string
  readonly headers: ReadonlyArray<SipHeader>
  readonly body: Uint8Array      // raw bytes — opaque to B2BUA
  readonly raw: Buffer           // original packet bytes
  /** Typed header access — see `SipRequest.getHeader` for the union-access caveat. */
  getHeader<K extends keyof SipHeaderTypes>(name: K): SipHeaderTypes[K]
  getHeader(name: string): ReadonlyArray<string>
}

export type SipMessage = SipRequest | SipResponse

// ---------------------------------------------------------------------------
// Narrowed message subtypes — zero-copy refinements
// ---------------------------------------------------------------------------
//
// These interfaces describe the SAME runtime objects as `SipRequest` /
// `SipResponse` but carry stronger compile-time guarantees the dispatcher
// (and parser) enforces at runtime.

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
 *
 * `getHeader` overloads tighten the return for `'from'` / `'to'` so
 * callers see `TaggedNameAddrField` (with `tag: string`) instead of the
 * unrefined `ParsedNameAddrField` (with `tag: string | undefined`).
 */
export interface InDialogRequest extends SipRequest {
  getHeader(name: "from"): TaggedNameAddrField
  getHeader(name: "to"): TaggedNameAddrField
  getHeader<K extends keyof SipHeaderTypes>(name: K): SipHeaderTypes[K]
  getHeader(name: string): ReadonlyArray<string>
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
  getHeader(name: "to"): TaggedNameAddrField
  getHeader<K extends keyof SipHeaderTypes>(name: K): SipHeaderTypes[K]
  getHeader(name: string): ReadonlyArray<string>
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
