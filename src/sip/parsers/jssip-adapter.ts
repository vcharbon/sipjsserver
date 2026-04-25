/**
 * JsSIP parser adapter — wraps JsSIP's internal Parser.parseMessage()
 * and adapts its output to the shared SipParserImpl interface.
 *
 * Returns `Result<SipMessage, SipParseError>`. Never throws.
 */

import { createRequire } from "node:module"
import { Result } from "effect"
import type { SipHeader, SipMessage, SipRequest, SipResponse } from "../types.js"
import type { SipParserImpl } from "./interface.js"
import { SipParseError } from "./errors.js"
import { extractResponseFields, extractRequestFields } from "./extract-fields.js"
import { LazyHeaders } from "./custom/lazy-headers.js"
import { expandCompactForm } from "./custom/compact-forms.js"

const require = createRequire(import.meta.url)
const JsSIPParser = require("jssip/lib/Parser.js") as {
  parseMessage: (data: string, ua: unknown) => JsSIPIncomingMessage | undefined
}

// ---------------------------------------------------------------------------
// JsSIP internal types (minimal surface we depend on)
// ---------------------------------------------------------------------------

interface JsSIPHeaderEntry {
  readonly raw: string
}

interface JsSIPIncomingMessage {
  readonly method?: string
  readonly ruri?: { toString(): string }
  readonly status_code?: number
  readonly reason_phrase?: string
  readonly headers: Record<string, ReadonlyArray<JsSIPHeaderEntry>>
  readonly body: string | null
}

// ---------------------------------------------------------------------------
// JsSIP → SipMessage adapter
// ---------------------------------------------------------------------------

function adaptHeaders(jssipHeaders: Record<string, ReadonlyArray<JsSIPHeaderEntry>>): SipHeader[] {
  const result: SipHeader[] = []
  for (const [name, entries] of Object.entries(jssipHeaders)) {
    const canonicalName = expandCompactForm(name)
    for (const entry of entries) {
      result.push({ name: canonicalName, value: entry.raw })
    }
  }
  return result
}

function adaptMessage(
  msg: JsSIPIncomingMessage,
  raw: Buffer
): Result.Result<SipMessage, SipParseError> {
  const headers = adaptHeaders(msg.headers)
  const body = msg.body ? Buffer.from(msg.body, "utf-8") : new Uint8Array(0)
  const lazy = new LazyHeaders(headers)

  if (msg.status_code !== undefined) {
    const fields = extractResponseFields(headers, msg.status_code)
    if (Result.isFailure(fields)) return Result.fail(fields.failure)
    const response: SipResponse = {
      type: "response",
      version: "SIP/2.0",
      status: msg.status_code,
      reason: msg.reason_phrase ?? "",
      headers,
      body,
      raw,
      parsed: fields.success,
      lazy,
    }
    return Result.succeed(response)
  }

  const requestUri = msg.ruri?.toString() ?? ""
  const fields = extractRequestFields(headers, requestUri)
  if (Result.isFailure(fields)) return Result.fail(fields.failure)
  const request: SipRequest = {
    type: "request",
    method: (msg.method ?? "").toUpperCase(),
    uri: requestUri,
    version: "SIP/2.0",
    headers,
    body,
    raw,
    parsed: fields.success,
    lazy,
  }
  return Result.succeed(request)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const jssipParser: SipParserImpl = {
  name: "jssip",
  parse(raw: Buffer): Result.Result<SipMessage, SipParseError> {
    const data = raw.toString("utf-8")
    let result: JsSIPIncomingMessage | undefined
    try {
      result = JsSIPParser.parseMessage(data, null)
    } catch (err) {
      return Result.fail(
        new SipParseError({ reason: err instanceof Error ? err.message : String(err) })
      )
    }
    if (result === undefined) {
      const firstLine = data.split(/\r?\n/)[0] ?? "(empty)"
      return Result.fail(
        new SipParseError({
          reason: `JsSIP returned undefined — first line: "${firstLine.slice(0, 120)}", length: ${data.length} bytes`,
        })
      )
    }
    return adaptMessage(result, raw)
  },
}
