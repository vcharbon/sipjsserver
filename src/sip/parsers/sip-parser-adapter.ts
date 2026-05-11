/**
 * sip-parser (Formup) adapter — wraps the npm `sip-parser` package
 * and adapts its output to the shared SipParserImpl interface.
 *
 * Returns `Result<SipMessage, SipParseError>`. Never throws.
 */

import { Result } from "effect"
import { parse as sipParserParse, types } from "sip-parser"
import type { SipHeader, SipMessage } from "../types.js"
import type { SipParserImpl } from "./interface.js"
import { SipParseError } from "./errors.js"
import {
  extractResponseFields,
  extractRequestFields,
  finalizeRequest,
  finalizeResponse,
} from "./extract-fields.js"
import { expandCompactForm } from "./custom/compact-forms.js"

// ---------------------------------------------------------------------------
// sip-parser → SipMessage adapter
// ---------------------------------------------------------------------------

function isResponse(msg: types.SIPMessage): msg is types.SIPResponse {
  return "statusCode" in msg
}

function adaptHeaders(headers: types.Header[]): SipHeader[] {
  return headers.map((h) => ({ name: expandCompactForm(h.fieldName), value: h.fieldValue }))
}

function adaptMessage(
  msg: types.SIPMessage,
  raw: Buffer
): Result.Result<SipMessage, SipParseError> {
  const headers = adaptHeaders(msg.headers)
  const body = msg.content ? Buffer.from(msg.content, "utf-8") : new Uint8Array(0)

  if (isResponse(msg)) {
    const fields = extractResponseFields(headers, msg.statusCode)
    if (Result.isFailure(fields)) return Result.fail(fields.failure)
    return Result.succeed(finalizeResponse({
      version: msg.version,
      status: msg.statusCode,
      reason: msg.reason,
      headers,
      body,
      raw,
      eager: fields.success,
    }))
  }

  const requestUri = stringifyUri(msg.requestUri)
  const fields = extractRequestFields(headers, requestUri)
  if (Result.isFailure(fields)) return Result.fail(fields.failure)
  return Result.succeed(finalizeRequest({
    method: msg.method.toUpperCase(),
    uri: requestUri,
    version: msg.version,
    headers,
    body,
    raw,
    eager: fields.success,
  }))
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
  parse(raw: Buffer): Result.Result<SipMessage, SipParseError> {
    const data = raw.toString("utf-8")
    let result: types.SIPMessage
    try {
      result = sipParserParse(data)
    } catch (err) {
      return Result.fail(
        new SipParseError({ reason: err instanceof Error ? err.message : String(err) })
      )
    }
    return adaptMessage(result, raw)
  },
}
