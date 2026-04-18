/**
 * SIP message serializer — converts structured SipMessage objects to wire-format Buffers.
 *
 * This is the single serialization point for all outbound SIP messages.
 * Headers are utf-8; body is raw bytes passed through unmodified.
 */

import type { SipHeader, SipMessage } from "./types.js"

/** Serialize a structured SIP message to a wire-format Buffer. */
export function serialize(msg: SipMessage): Buffer {
  const firstLine = msg.type === "request"
    ? `${msg.method} ${msg.uri} ${msg.version}`
    : `${msg.version} ${msg.status} ${msg.reason}`

  return serializeWithFirstLine(firstLine, msg.headers, msg.body)
}

/** Serialize from components (first line, headers, body). */
function serializeWithFirstLine(
  firstLine: string,
  headers: ReadonlyArray<SipHeader>,
  body: Uint8Array
): Buffer {
  // Enforce Content-Length correctness at the serialization boundary
  const actualLength = body.byteLength
  let correctedHeaders: ReadonlyArray<SipHeader> = headers
  const clIndex = headers.findIndex((h) => h.name.toLowerCase() === "content-length")

  if (clIndex >= 0) {
    const declared = parseInt(headers[clIndex]!.value, 10)
    if (declared !== actualLength) {
      console.warn(
        `[Serializer] Content-Length mismatch: header=${declared}, body=${actualLength}. Auto-correcting. ` +
        `First line: ${firstLine}`
      )
      correctedHeaders = headers.map((h, i) =>
        i === clIndex ? { name: h.name, value: String(actualLength) } : h
      )
    }
  } else if (actualLength > 0) {
    correctedHeaders = [...headers, { name: "Content-Length", value: String(actualLength) }]
  }

  const headerLines = correctedHeaders.map((h) => `${h.name}: ${h.value}`).join("\r\n")
  const headPart = Buffer.from(`${firstLine}\r\n${headerLines}\r\n\r\n`, "utf-8")
  if (body.byteLength === 0) return headPart
  return Buffer.concat([headPart, body])
}

/** One-line summary of a SIP message for debug logging. */
export function sipSummary(raw: Buffer): string {
  const end = Math.min(raw.indexOf(0x0d), raw.indexOf(0x0a), 200)
  const firstLine = raw.subarray(0, end > 0 ? end : Math.min(raw.length, 200)).toString("utf-8")
  return firstLine
}

/** One-line summary from a structured message (no buffer needed). */
export function messageSummary(msg: SipMessage): string {
  if (msg.type === "request") return `${msg.method} ${msg.uri}`
  return `${msg.status} ${msg.reason}`
}
