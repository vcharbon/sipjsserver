/**
 * Custom SIP parser — RFC 3261 compliant, zero regex, state-machine based.
 *
 * Parses request/response lines, headers (with folding + compact forms),
 * body extraction, and eagerly extracts structured fields from key headers
 * (From, To, Via, Contact, CSeq, Call-ID, Request-URI).
 */

import type { SipMessage, SipRequest, SipResponse, SipHeader, ParsedFields } from "../../types.js"
import type { SipParserImpl } from "../interface.js"
import { Scanner } from "./scanner.js"
import { parseStartLine } from "./start-line.js"
import { parseHeaders } from "./headers.js"
import {
  parseNameAddr,
  parseVia,
  parseContact,
  parseCSeq,
  parseSipUriString,
} from "./structured-headers.js"

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function getHeaderValue(headers: SipHeader[], name: string): string | undefined {
  const lower = name.toLowerCase()
  return headers.find((h) => h.name.toLowerCase() === lower)?.value
}

function getHeaderValues(headers: SipHeader[], name: string): string[] {
  const lower = name.toLowerCase()
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value)
}

/** Extract the method from a CSeq header value like "1 INVITE". No regex. */
function extractCSeqMethod(value: string): string | undefined {
  let i = 0
  while (i < value.length && (value.charCodeAt(i) === 0x20 || value.charCodeAt(i) === 0x09)) i++
  while (i < value.length && value.charCodeAt(i) >= 0x30 && value.charCodeAt(i) <= 0x39) i++
  while (i < value.length && (value.charCodeAt(i) === 0x20 || value.charCodeAt(i) === 0x09)) i++
  const method = value.slice(i).trim()
  return method.length > 0 ? method : undefined
}

// -------------------------------------------------------------------------
// Eager structured extraction
// -------------------------------------------------------------------------

function extractParsedFields(
  headers: SipHeader[],
  requestUri: string | undefined
): ParsedFields {
  // From
  const fromVal = getHeaderValue(headers, "From")
  const fromParsed = fromVal ? parseNameAddr(fromVal) : undefined

  // To
  const toVal = getHeaderValue(headers, "To")
  const toParsed = toVal ? parseNameAddr(toVal) : undefined

  // Call-ID
  const callId = getHeaderValue(headers, "Call-ID")

  // CSeq
  const cseqVal = getHeaderValue(headers, "CSeq")
  const cseqParsed = cseqVal ? parseCSeq(cseqVal) : undefined

  // Via (all)
  const viaValues = getHeaderValues(headers, "Via")
  const viasParsed = viaValues.map(parseVia)
  const topVia = viasParsed[0]

  // Contact
  const contactVal = getHeaderValue(headers, "Contact")
  const contactParsed = contactVal ? parseContact(contactVal) : undefined

  // Request-URI
  const requestUriParsed = requestUri ? parseSipUriString(requestUri) : undefined

  return {
    from: fromParsed
      ? { displayName: fromParsed.displayName, uri: fromParsed.uri, tag: fromParsed.tag, params: fromParsed.params }
      : undefined,
    to: toParsed
      ? { displayName: toParsed.displayName, uri: toParsed.uri, tag: toParsed.tag, params: toParsed.params }
      : undefined,
    callId,
    cseq: cseqParsed,
    via: topVia
      ? { transport: topVia.transport, host: topVia.host, port: topVia.port, branch: topVia.branch, params: topVia.params }
      : undefined,
    vias: viasParsed.map((v) => ({
      transport: v.transport, host: v.host, port: v.port, branch: v.branch, params: v.params,
    })),
    contact: contactParsed,
    requestUri: requestUriParsed
      ? { scheme: requestUriParsed.scheme, user: requestUriParsed.user, host: requestUriParsed.host, port: requestUriParsed.port, params: requestUriParsed.params }
      : undefined,
  }
}

// -------------------------------------------------------------------------
// Parser entry point
// -------------------------------------------------------------------------

export const customParser: SipParserImpl = {
  name: "custom",
  parse(raw: Buffer): SipMessage {
    const s = new Scanner(raw)

    const startLine = parseStartLine(s)
    const { headers, contentLength } = parseHeaders(s)

    // Body extraction
    let body: Uint8Array
    if (contentLength > 0) {
      if (s.remaining() < contentLength) {
        throw new Error(
          `Content-Length ${contentLength} exceeds remaining bytes ${s.remaining()}`
        )
      }
      body = raw.subarray(s.pos, s.pos + contentLength)
    } else {
      body = new Uint8Array(0)
    }

    // Cross-validate CSeq method matches start-line method (3.1.2.17, 3.1.2.18)
    if (startLine.type === "request") {
      const cseqHeader = headers.find((h) => h.name.toLowerCase() === "cseq")
      if (cseqHeader) {
        const cseqMethod = extractCSeqMethod(cseqHeader.value)
        if (cseqMethod && cseqMethod.toUpperCase() !== startLine.method) {
          throw new Error(
            `CSeq method "${cseqMethod}" does not match request method "${startLine.method}"`
          )
        }
      }
    }

    // Eager structured extraction
    const parsed = extractParsedFields(
      headers,
      startLine.type === "request" ? startLine.uri : undefined
    )

    if (startLine.type === "request") {
      const request: SipRequest = {
        type: "request",
        method: startLine.method,
        uri: startLine.uri,
        version: startLine.version,
        headers,
        body,
        raw,
        parsed,
      }
      return request
    }

    const response: SipResponse = {
      type: "response",
      version: startLine.version,
      status: startLine.status,
      reason: startLine.reason,
      headers,
      body,
      raw,
      parsed,
    }
    return response
  }
}
