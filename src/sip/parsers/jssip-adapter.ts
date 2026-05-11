/**
 * JsSIP parser adapter — wraps JsSIP's internal Parser.parseMessage()
 * and adapts its output to the shared SipParserImpl interface.
 *
 * Returns `Result<SipMessage, SipParseError>`. Never throws.
 */

import { createRequire } from "node:module"
import { Result } from "effect"
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

  if (msg.status_code !== undefined) {
    const fields = extractResponseFields(headers, msg.status_code)
    if (Result.isFailure(fields)) return Result.fail(fields.failure)
    return Result.succeed(finalizeResponse({
      version: "SIP/2.0",
      status: msg.status_code,
      reason: msg.reason_phrase ?? "",
      headers,
      body,
      raw,
      eager: fields.success,
    }))
  }

  const requestUri = msg.ruri?.toString() ?? ""
  const fields = extractRequestFields(headers, requestUri)
  if (Result.isFailure(fields)) return Result.fail(fields.failure)
  return Result.succeed(finalizeRequest({
    method: (msg.method ?? "").toUpperCase(),
    uri: requestUri,
    version: "SIP/2.0",
    headers,
    body,
    raw,
    eager: fields.success,
  }))
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
