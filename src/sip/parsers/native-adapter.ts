/**
 * Native parser adapter — wraps the napi-rs binding over rvoip-sip-core
 * and adapts its output to the shared `SipParserImpl` interface.
 *
 * Phase 1 strategy: the native side handles wire-format framing (line
 * folding, header block, body extraction) in strict mode; the headers it
 * returns are run through the same `extractRequestFields` /
 * `extractResponseFields` pipeline the other adapters use, so the
 * ADR-0007 semantic gates (Via magic cookie, transport allowlist, strict
 * SIP-URI, etc.) fire identically. Both layers must pass for a message
 * to be accepted.
 *
 * Native module is loaded lazily on first `parse` so importing the
 * adapter on platforms without a prebuilt binary is non-fatal — calling
 * `parse` is what fails.
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

// ---------------------------------------------------------------------------
// Native binding types
// ---------------------------------------------------------------------------

interface NativeHeader {
  readonly name: string
  readonly value: string
}

interface NativeParsedMessage {
  readonly kind: "request" | "response"
  readonly version: string
  readonly method: string | null
  readonly uri: string | null
  readonly status: number | null
  readonly reason: string | null
  readonly headers: ReadonlyArray<NativeHeader>
  readonly body: Buffer
}

interface NativeBinding {
  parse(buf: Buffer): NativeParsedMessage
}

// ---------------------------------------------------------------------------
// Lazy load — addon resolution is per-platform; defer to call time so the
// adapter module itself can be imported on unsupported triples without
// crashing module init.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url)

let cachedBinding: NativeBinding | undefined
let cachedLoadError: Error | undefined

function loadBinding(): NativeBinding {
  if (cachedBinding !== undefined) return cachedBinding
  if (cachedLoadError !== undefined) throw cachedLoadError
  try {
    // src/sip/parsers → dist/sip/parsers is the same depth, so this
    // relative path resolves identically when running source or built.
    cachedBinding = require("../../../native/sip-parser/index.cjs") as NativeBinding
    return cachedBinding
  } catch (err) {
    cachedLoadError = err instanceof Error ? err : new Error(String(err))
    throw cachedLoadError
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function adaptHeaders(native: ReadonlyArray<NativeHeader>): SipHeader[] {
  const result: SipHeader[] = []
  for (const h of native) {
    result.push({ name: h.name, value: h.value })
  }
  return result
}

function adaptMessage(
  native: NativeParsedMessage,
  raw: Buffer,
): Result.Result<SipMessage, SipParseError> {
  const headers = adaptHeaders(native.headers)
  const body: Uint8Array = native.body.length === 0 ? new Uint8Array(0) : native.body

  if (native.kind === "response") {
    if (native.status === null) {
      return Result.fail(new SipParseError({ reason: "Native parser returned response without status code" }))
    }
    const fields = extractResponseFields(headers, native.status)
    if (Result.isFailure(fields)) return Result.fail(fields.failure)
    return Result.succeed(finalizeResponse({
      version: native.version,
      status: native.status,
      reason: native.reason ?? "",
      headers,
      body,
      raw,
      eager: fields.success,
    }))
  }

  if (native.method === null || native.uri === null) {
    return Result.fail(new SipParseError({ reason: "Native parser returned request without method or URI" }))
  }
  const method = native.method.toUpperCase()
  const fields = extractRequestFields(headers, native.uri, undefined, method)
  if (Result.isFailure(fields)) return Result.fail(fields.failure)
  return Result.succeed(finalizeRequest({
    method,
    uri: native.uri,
    version: native.version,
    headers,
    body,
    raw,
    eager: fields.success,
  }))
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const nativeParser: SipParserImpl = {
  name: "native",
  parse(raw: Buffer): Result.Result<SipMessage, SipParseError> {
    let binding: NativeBinding
    try {
      binding = loadBinding()
    } catch (err) {
      return Result.fail(
        new SipParseError({
          reason: `Native parser binding unavailable: ${err instanceof Error ? err.message : String(err)}`,
        }),
      )
    }

    let native: NativeParsedMessage
    try {
      native = binding.parse(raw)
    } catch (err) {
      return Result.fail(
        new SipParseError({ reason: err instanceof Error ? err.message : String(err) }),
      )
    }

    return adaptMessage(native, raw)
  },
}
