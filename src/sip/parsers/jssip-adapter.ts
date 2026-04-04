/**
 * JsSIP parser adapter — wraps JsSIP's internal Parser.parseMessage()
 * and adapts its output to the shared SipParserImpl interface.
 */

import { createRequire } from "node:module"
import type { SipHeader, SipMessage, SipRequest, SipResponse } from "../types.js"
import type { SipParserImpl } from "./interface.js"

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
    for (const entry of entries) {
      result.push({ name, value: entry.raw })
    }
  }
  return result
}

function adaptMessage(msg: JsSIPIncomingMessage, raw: Buffer): SipMessage {
  const headers = adaptHeaders(msg.headers)
  const body = msg.body ? Buffer.from(msg.body, "utf-8") : new Uint8Array(0)

  if (msg.status_code !== undefined) {
    const response: SipResponse = {
      type: "response",
      version: "SIP/2.0",
      status: msg.status_code,
      reason: msg.reason_phrase ?? "",
      headers,
      body,
      raw
    }
    return response
  }

  const request: SipRequest = {
    type: "request",
    method: (msg.method ?? "").toUpperCase(),
    uri: msg.ruri?.toString() ?? "",
    version: "SIP/2.0",
    headers,
    body,
    raw
  }
  return request
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const jssipParser: SipParserImpl = {
  name: "jssip",
  parse(raw: Buffer): SipMessage {
    const data = raw.toString("utf-8")
    const result = JsSIPParser.parseMessage(data, null)
    if (result === undefined) {
      const firstLine = data.split(/\r?\n/)[0] ?? "(empty)"
      throw new Error(
        `JsSIP returned undefined — first line: "${firstLine.slice(0, 120)}", length: ${data.length} bytes`
      )
    }
    return adaptMessage(result, raw)
  }
}
