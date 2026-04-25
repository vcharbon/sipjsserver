/**
 * Custom SIP parser — RFC 3261 compliant, zero regex, state-machine based.
 *
 * The function is observationally pure: internal helpers (start-line,
 * headers, body) still use throws as fast unwinding control flow, but
 * every escape is caught at this entry point and translated into a
 * `Result.fail(SipParseError)`. No exception ever crosses the boundary.
 */

import { Result } from "effect"
import type { SipMessage, SipRequest, SipResponse, SipHeader } from "../../types.js"
import type { SipParserImpl } from "../interface.js"
import { SipParseError } from "../errors.js"
import { extractCommonFields, extractRequestFields } from "../extract-fields.js"
import { Scanner } from "./scanner.js"
import { parseStartLine } from "./start-line.js"
import { parseHeaders } from "./headers.js"
import { LazyHeaders } from "./lazy-headers.js"

/** Extract the method from a CSeq header value like "1 INVITE". No regex. */
function extractCSeqMethod(value: string): string | undefined {
  let i = 0
  while (i < value.length && (value.charCodeAt(i) === 0x20 || value.charCodeAt(i) === 0x09)) i++
  while (i < value.length && value.charCodeAt(i) >= 0x30 && value.charCodeAt(i) <= 0x39) i++
  while (i < value.length && (value.charCodeAt(i) === 0x20 || value.charCodeAt(i) === 0x09)) i++
  const method = value.slice(i).trim()
  return method.length > 0 ? method : undefined
}

export const customParser: SipParserImpl = {
  name: "custom",
  parse(raw: Buffer): Result.Result<SipMessage, SipParseError> {
    let startLine
    let headers: ReadonlyArray<SipHeader>
    let contentLength: number
    let body: Uint8Array
    try {
      const s = new Scanner(raw)
      startLine = parseStartLine(s)
      const parsedHeaders = parseHeaders(s)
      headers = parsedHeaders.headers
      contentLength = parsedHeaders.contentLength

      if (contentLength > 0) {
        if (s.remaining() < contentLength) {
          return Result.fail(
            new SipParseError({
              reason: `Content-Length ${contentLength} exceeds remaining bytes ${s.remaining()}`,
            })
          )
        }
        body = raw.subarray(s.pos, s.pos + contentLength)
      } else {
        body = new Uint8Array(0)
      }

      // Cross-validate CSeq method matches start-line method (RFC 4475 §3.1.2.17 / §3.1.2.18)
      if (startLine.type === "request") {
        const cseqHeader = headers.find((h) => h.name.toLowerCase() === "cseq")
        if (cseqHeader) {
          const cseqMethod = extractCSeqMethod(cseqHeader.value)
          if (cseqMethod && cseqMethod.toUpperCase() !== startLine.method) {
            return Result.fail(
              new SipParseError({
                reason: `CSeq method "${cseqMethod}" does not match request method "${startLine.method}"`,
              })
            )
          }
        }
      }
    } catch (err) {
      return Result.fail(
        new SipParseError({
          reason: err instanceof Error ? err.message : String(err),
        })
      )
    }

    if (startLine.type === "request") {
      const fields = extractRequestFields(headers, startLine.uri)
      if (Result.isFailure(fields)) return Result.fail(fields.failure)
      const request: SipRequest = {
        type: "request",
        method: startLine.method,
        uri: startLine.uri,
        version: startLine.version,
        headers,
        body,
        raw,
        parsed: fields.success,
        lazy: new LazyHeaders(headers),
      }
      return Result.succeed(request)
    }

    const fields = extractCommonFields(headers)
    if (Result.isFailure(fields)) return Result.fail(fields.failure)
    const response: SipResponse = {
      type: "response",
      version: startLine.version,
      status: startLine.status,
      reason: startLine.reason,
      headers,
      body,
      raw,
      parsed: fields.success,
      lazy: new LazyHeaders(headers),
    }
    return Result.succeed(response)
  },
}
