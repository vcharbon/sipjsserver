/**
 * Shared mandatory-header extraction. Every parser adapter (custom,
 * jssip, sip-parser) feeds its decoded `headers` array through these
 * helpers to produce the eagerly-parsed `parsed` block on every
 * `SipMessage`.
 *
 * RFC 3261 §8.1.1 — From, To, Call-ID, CSeq, and at least one Via are
 * mandatory in every SIP message; requests additionally carry a
 * Request-URI in the start line. Absent or malformed → parse error.
 */

import { Result } from "effect"
import type {
  SipHeader,
  SipRequest,
  SipResponse,
  RequestParsedFields,
  ResponseParsedFields,
} from "../types.js"
import { SipParseError } from "./errors.js"
import { LazyHeaders } from "./custom/lazy-headers.js"
import {
  parseNameAddr,
  parseVia,
  parseContact,
  parseCSeq,
  parseSipUriString,
} from "./custom/structured-headers.js"

function getHeaderValue(headers: ReadonlyArray<SipHeader>, name: string): string | undefined {
  const lower = name.toLowerCase()
  return headers.find((h) => h.name.toLowerCase() === lower)?.value
}

function getHeaderValues(headers: ReadonlyArray<SipHeader>, name: string): string[] {
  const lower = name.toLowerCase()
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value)
}

export function extractCommonFields(
  headers: ReadonlyArray<SipHeader>
): Result.Result<ResponseParsedFields, SipParseError> {
  // Mandatory headers — presence is enforced; internal field parsing is
  // best-effort. Empty `uri` / `host` slots are surfaced as-is so the
  // parser stays tolerant of partially-malformed but routable peers.

  const fromVal = getHeaderValue(headers, "From")
  if (fromVal === undefined) {
    return Result.fail(new SipParseError({ reason: "Missing mandatory From header" }))
  }
  const fromParsed = parseNameAddr(fromVal)

  const toVal = getHeaderValue(headers, "To")
  if (toVal === undefined) {
    return Result.fail(new SipParseError({ reason: "Missing mandatory To header" }))
  }
  const toParsed = parseNameAddr(toVal)

  const callId = getHeaderValue(headers, "Call-ID")
  if (callId === undefined || callId.length === 0) {
    return Result.fail(new SipParseError({ reason: "Missing mandatory Call-ID header" }))
  }

  const cseqVal = getHeaderValue(headers, "CSeq")
  if (cseqVal === undefined) {
    return Result.fail(new SipParseError({ reason: "Missing mandatory CSeq header" }))
  }
  const cseqParsed = parseCSeq(cseqVal)

  const viaValues = getHeaderValues(headers, "Via")
  if (viaValues.length === 0) {
    return Result.fail(new SipParseError({ reason: "Missing mandatory Via header" }))
  }
  const viasParsed = viaValues.map(parseVia)
  const topVia = viasParsed[0]!

  const contactVal = getHeaderValue(headers, "Contact")
  const contactParsed = contactVal ? parseContact(contactVal) : undefined

  return Result.succeed({
    from: {
      displayName: fromParsed.displayName,
      uri: fromParsed.uri,
      tag: fromParsed.tag,
      params: fromParsed.params,
    },
    to: {
      displayName: toParsed.displayName,
      uri: toParsed.uri,
      tag: toParsed.tag,
      params: toParsed.params,
    },
    callId,
    cseq: cseqParsed,
    via: {
      transport: topVia.transport,
      host: topVia.host,
      port: topVia.port,
      branch: topVia.branch,
      params: topVia.params,
    },
    vias: viasParsed.map((v) => ({
      transport: v.transport,
      host: v.host,
      port: v.port,
      branch: v.branch,
      params: v.params,
    })),
    contact: contactParsed,
  })
}

/**
 * Hydrate a `SipRequest` from raw fields (used by generators and by call
 * sites that reconstruct a request from a snapshot). The headers are
 * assumed to be well-formed; on extraction failure this throws since the
 * caller is responsible for producing valid headers.
 */
export function hydrateRequest(args: {
  readonly method: string
  readonly uri: string
  readonly version?: string
  readonly headers: SipHeader[]
  readonly body: Uint8Array
  readonly raw: Buffer
}): SipRequest {
  const fields = extractRequestFields(args.headers, args.uri)
  if (Result.isFailure(fields)) {
    throw new Error(`hydrateRequest: malformed headers — ${fields.failure.reason}`)
  }
  return {
    type: "request",
    method: args.method,
    uri: args.uri,
    version: args.version ?? "SIP/2.0",
    headers: args.headers,
    body: args.body,
    raw: args.raw,
    parsed: fields.success,
    lazy: new LazyHeaders(args.headers),
  }
}

/**
 * Hydrate a `SipResponse` from raw fields. Same contract as
 * `hydrateRequest` — throws on malformed headers.
 */
export function hydrateResponse(args: {
  readonly status: number
  readonly reason: string
  readonly version?: string
  readonly headers: SipHeader[]
  readonly body: Uint8Array
  readonly raw: Buffer
}): SipResponse {
  const fields = extractCommonFields(args.headers)
  if (Result.isFailure(fields)) {
    throw new Error(`hydrateResponse: malformed headers — ${fields.failure.reason}`)
  }
  return {
    type: "response",
    version: args.version ?? "SIP/2.0",
    status: args.status,
    reason: args.reason,
    headers: args.headers,
    body: args.body,
    raw: args.raw,
    parsed: fields.success,
    lazy: new LazyHeaders(args.headers),
  }
}

export function extractRequestFields(
  headers: ReadonlyArray<SipHeader>,
  requestUri: string
): Result.Result<RequestParsedFields, SipParseError> {
  const common = extractCommonFields(headers)
  if (Result.isFailure(common)) return Result.fail(common.failure)
  const requestUriParsed = parseSipUriString(requestUri)
  if (requestUriParsed === undefined) {
    return Result.fail(
      new SipParseError({ reason: `Malformed Request-URI: "${requestUri}"` })
    )
  }
  return Result.succeed({
    ...common.success,
    requestUri: {
      scheme: requestUriParsed.scheme,
      user: requestUriParsed.user,
      host: requestUriParsed.host,
      port: requestUriParsed.port,
      params: requestUriParsed.params,
    },
  })
}

/**
 * Extract response-specific parsed fields with status-aware validation.
 *
 * RFC 3261 §8.2.6.2 / §17.1.3: every response except 100 Trying MUST carry
 * a To-tag — for 1xx > 100 and final responses, the To-tag identifies the
 * dialog (or the would-be dialog for non-2xx). 100 Trying is purely a
 * hop-by-hop progress indicator and may omit the tag.
 *
 * Failing here keeps the rest of the B2BUA free of defensive `to.tag ?? ""`
 * fallbacks: every parsed response with `status > 100` is guaranteed to
 * have a non-empty To-tag.
 */
export function extractResponseFields(
  headers: ReadonlyArray<SipHeader>,
  status: number,
): Result.Result<ResponseParsedFields, SipParseError> {
  const common = extractCommonFields(headers)
  if (Result.isFailure(common)) return common
  if (status > 100 && common.success.to.tag === undefined) {
    return Result.fail(
      new SipParseError({
        reason: `Non-100 response (status=${status}) missing mandatory To-tag`,
      })
    )
  }
  return common
}
