/**
 * Shared mandatory-header extraction. Every parser adapter (custom,
 * jssip, sip-parser) feeds its decoded `headers` array through these
 * helpers to produce an `EagerHeaderSlots` record that backs the
 * `msg.getHeader()` fast path.
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
  ParsedRequestUriField,
} from "../types.js"
import { SipParseError } from "./errors.js"
import { makeGetHeader, type EagerHeaderSlots } from "../header-registry.js"
import {
  parseNameAddr,
  parseVia,
  parseContact,
  parseCSeq,
  parseSipUriString,
  splitTopLevelCommas,
} from "./custom/structured-headers.js"

/** Eager slots plus a parsed Request-URI for requests. */
interface RequestEager extends EagerHeaderSlots {
  readonly requestUri: ParsedRequestUriField
}

function getHeaderValue(headers: ReadonlyArray<SipHeader>, name: string): string | undefined {
  const lower = name.toLowerCase()
  return headers.find((h) => h.name.toLowerCase() === lower)?.value
}

function getHeaderValues(headers: ReadonlyArray<SipHeader>, name: string): string[] {
  const lower = name.toLowerCase()
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value)
}

export function extractCommonFields(
  headers: ReadonlyArray<SipHeader>,
): Result.Result<EagerHeaderSlots, SipParseError> {
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
  // RFC 3261 §7.3.1 allows the same header field name to appear once per
  // message with values comma-separated, OR multiple times with one value
  // per line. Both encodings are equivalent. Sipp echoing `[last_Via:]`
  // emits the multi-Via case as a single comma-list line, which is the
  // canonical case for a UAS responding through a proxy that prepended a
  // Via on the request. Split each header value at top-level commas before
  // parsing so the response-relay path sees `vias[0]` = our top stamp and
  // `vias[1]` = the next hop, regardless of which encoding the peer used.
  const viasParsed = viaValues.flatMap((v) =>
    splitTopLevelCommas(v).map(parseVia),
  )
  const vias = viasParsed.map((v) => ({
    transport: v.transport,
    host: v.host,
    port: v.port,
    branch: v.branch,
    params: v.params,
  }))

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
    vias,
    contact: contactParsed,
  })
}

/**
 * Extract request-specific parsed fields (common + Request-URI).
 */
export function extractRequestFields(
  headers: ReadonlyArray<SipHeader>,
  requestUri: string,
): Result.Result<RequestEager, SipParseError> {
  const common = extractCommonFields(headers)
  if (Result.isFailure(common)) return Result.fail(common.failure)
  const requestUriParsed = parseSipUriString(requestUri)
  if (requestUriParsed === undefined) {
    return Result.fail(
      new SipParseError({ reason: `Malformed Request-URI: "${requestUri}"` }),
    )
  }
  const parsedRequestUri: ParsedRequestUriField = {
    scheme: requestUriParsed.scheme,
    user: requestUriParsed.user,
    host: requestUriParsed.host,
    port: requestUriParsed.port,
    params: requestUriParsed.params,
  }
  return Result.succeed({
    ...common.success,
    requestUri: parsedRequestUri,
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
): Result.Result<EagerHeaderSlots, SipParseError> {
  const common = extractCommonFields(headers)
  if (Result.isFailure(common)) return common
  if (status > 100 && common.success.to.tag === undefined) {
    return Result.fail(
      new SipParseError({
        reason: `Non-100 response (status=${status}) missing mandatory To-tag`,
      }),
    )
  }
  return common
}

// Shared convenience methods attached to every finalized SipRequest /
// SipResponse so tests and rule code can avoid re-implementing body /
// header presence checks inline. The TextDecoder instance is module-
// scoped — decoders are stateless for UTF-8 and reuse is recommended.
const bodyDecoder = new TextDecoder()

function makeMessageHelpers(
  headers: ReadonlyArray<SipHeader>,
  body: Uint8Array,
): {
  hasBody: () => boolean
  bodyText: () => string | undefined
  bodyEquals: (other: Uint8Array) => boolean
  hasHeader: (name: string) => boolean
} {
  return {
    hasBody: () => body.length > 0,
    bodyText: () => (body.length === 0 ? undefined : bodyDecoder.decode(body)),
    bodyEquals: (other) => {
      if (body.byteLength !== other.byteLength) return false
      for (let i = 0; i < body.byteLength; i++) {
        if (body[i] !== other[i]) return false
      }
      return true
    },
    hasHeader: (name) => {
      const lower = name.toLowerCase()
      return headers.some((h) => h.name.toLowerCase() === lower)
    },
  }
}

/**
 * Construct a finalized `SipRequest` from parsed pieces. Attaches the
 * top-level `requestUri` and the `getHeader` accessor.
 */
export function finalizeRequest(args: {
  readonly method: string
  readonly uri: string
  readonly version: string
  readonly headers: ReadonlyArray<SipHeader>
  readonly body: Uint8Array
  readonly raw: Buffer
  readonly eager: RequestEager
}): SipRequest {
  const getHeader = makeGetHeader(args.headers, args.eager) as
    SipRequest["getHeader"]
  return {
    type: "request",
    method: args.method,
    uri: args.uri,
    requestUri: args.eager.requestUri,
    version: args.version,
    headers: args.headers,
    body: args.body,
    raw: args.raw,
    getHeader,
    ...makeMessageHelpers(args.headers, args.body),
  }
}

/** Construct a finalized `SipResponse` from parsed pieces. */
export function finalizeResponse(args: {
  readonly status: number
  readonly reason: string
  readonly version: string
  readonly headers: ReadonlyArray<SipHeader>
  readonly body: Uint8Array
  readonly raw: Buffer
  readonly eager: EagerHeaderSlots
}): SipResponse {
  const getHeader = makeGetHeader(args.headers, args.eager) as
    SipResponse["getHeader"]
  return {
    type: "response",
    version: args.version,
    status: args.status,
    reason: args.reason,
    headers: args.headers,
    body: args.body,
    raw: args.raw,
    getHeader,
    ...makeMessageHelpers(args.headers, args.body),
  }
}

/**
 * Hydrate a `SipRequest` from raw fields. Throws on malformed headers —
 * callers must produce a well-formed envelope.
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
  return finalizeRequest({
    method: args.method,
    uri: args.uri,
    version: args.version ?? "SIP/2.0",
    headers: args.headers,
    body: args.body,
    raw: args.raw,
    eager: fields.success,
  })
}

/** Hydrate a `SipResponse` from raw fields. Throws on malformed headers. */
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
  return finalizeResponse({
    status: args.status,
    reason: args.reason,
    version: args.version ?? "SIP/2.0",
    headers: args.headers,
    body: args.body,
    raw: args.raw,
    eager: fields.success,
  })
}
