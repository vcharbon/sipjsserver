/**
 * sip-parser (Formup) adapter — wraps the npm `sip-parser` package
 * and adapts its output to the shared SipParserImpl interface.
 */

import { parse as sipParserParse, types } from "sip-parser"
import type { SipHeader, SipMessage, SipRequest, SipResponse } from "../types.js"
import type { SipParserImpl } from "./interface.js"

// ---------------------------------------------------------------------------
// sip-parser → SipMessage adapter
// ---------------------------------------------------------------------------

function isResponse(msg: types.SIPMessage): msg is types.SIPResponse {
  return "statusCode" in msg
}

function adaptHeaders(headers: types.Header[]): SipHeader[] {
  return headers.map((h) => ({ name: h.fieldName, value: h.fieldValue }))
}

function adaptMessage(msg: types.SIPMessage, raw: Buffer): SipMessage {
  const headers = adaptHeaders(msg.headers)
  const body = msg.content ? Buffer.from(msg.content, "utf-8") : new Uint8Array(0)

  if (isResponse(msg)) {
    const response: SipResponse = {
      type: "response",
      version: msg.version,
      status: msg.statusCode,
      reason: msg.reason,
      headers,
      body,
      raw
    }
    return response
  }

  const request: SipRequest = {
    type: "request",
    method: msg.method.toUpperCase(),
    uri: stringifyUri(msg.requestUri),
    version: msg.version,
    headers,
    body,
    raw
  }
  return request
}

/** Reconstruct the Request-URI string from the parsed SipUri object. */
function stringifyUri(uri: types.SipUri): string {
  const scheme = uri.secure ? "sips" : "sip"
  const userPart = uri.user ? `${uri.user}@` : ""
  const portPart = uri.port ? `:${uri.port}` : ""
  const params = uri.parameters
    ? uri.parameters.map((p) => (p.value != null ? `;${p.name}=${p.value}` : `;${p.name}`)).join("")
    : ""
  return `${scheme}:${userPart}${uri.host}${portPart}${params}`
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const sipParserNpm: SipParserImpl = {
  name: "sip-parser",
  parse(raw: Buffer): SipMessage {
    const data = raw.toString("utf-8")
    const result = sipParserParse(data)
    return adaptMessage(result, raw)
  }
}
