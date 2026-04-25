/**
 * RFC 4475 SIP Torture Test — Parser Compliance Matrix.
 *
 * Runs all valid and invalid RFC 4475 fixtures against each parser
 * implementation to produce a pass/fail compliance comparison.
 *
 * Uses plain vitest (no @effect/vitest) since parsers are pure functions.
 */

import { describe, test, expect } from "vitest"
import { Result } from "effect"

import { jssipParser } from "../../src/sip/parsers/jssip-adapter.js"
import { sipParserNpm } from "../../src/sip/parsers/sip-parser-adapter.js"
import { customParser } from "../../src/sip/parsers/custom/index.js"
import type { SipParserImpl } from "../../src/sip/parsers/interface.js"

import * as valid from "./fixtures/rfc4475-valid.js"
import * as invalid from "./fixtures/rfc4475-invalid.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validCases: Array<[string, Buffer]> = [
  ["3.1.1.1 — short tortuous INVITE", valid.shortTorturousInvite],
  ["3.1.1.2 — wide range of valid characters", valid.wideRangeValidChars],
  ["3.1.1.3 — valid percent escaping", valid.validPercentEscaping],
  ["3.1.1.4 — escaped nulls in URIs", valid.escapedNulls],
  ["3.1.1.5 — percent when not an escape", valid.percentNotEscape],
  ["3.1.1.6 — no LWS before angle bracket", valid.noLwsBeforeAngleBracket],
  ["3.1.1.7 — long values in header fields", valid.longValues],
  ["3.1.1.8 — extra trailing octets", valid.extraTrailingOctets],
  ["3.1.1.9 — semicolon in URI user part", valid.semicolonInUserPart],
  ["3.1.1.10 — varied and unknown transports", valid.variedTransports],
  ["3.1.1.11 — multipart MIME message", valid.multipartMime],
  ["3.1.1.12 — unusual reason phrase", valid.unusualReasonPhrase],
  ["3.1.1.13 — empty reason phrase", valid.emptyReasonPhrase],
]

const invalidCases: Array<[string, Buffer]> = [
  ["3.1.2.1 — extraneous header separators", invalid.extraneousSeparators],
  ["3.1.2.2 — Content-Length too large", invalid.contentLengthTooLarge],
  ["3.1.2.3 — negative Content-Length", invalid.negativeContentLength],
  ["3.1.2.4 — overlarge request scalars", invalid.overlargRequestScalars],
  ["3.1.2.5 — overlarge response scalars", invalid.overlargResponseScalars],
  ["3.1.2.6 — unterminated quoted string", invalid.unterminatedQuotedString],
  ["3.1.2.7 — angle brackets around Request-URI", invalid.angleBracketRequestUri],
  ["3.1.2.8 — embedded LWS in Request-URI", invalid.embeddedLwsInUri],
  ["3.1.2.9 — multiple SP in request-line", invalid.multipleSPInRequestLine],
  ["3.1.2.10 — trailing spaces in request-line", invalid.trailingSpacesInRequestLine],
  ["3.1.2.11 — escaped headers in Request-URI", invalid.escapedHeadersInUri],
  ["3.1.2.12 — invalid timezone in Date", invalid.invalidTimezone],
  ["3.1.2.13 — unenclosed name-addr", invalid.unencloseNameAddr],
  ["3.1.2.14 — spaces within addr-spec", invalid.spacesInAddrSpec],
  ["3.1.2.15 — non-token display name", invalid.nonTokenDisplayName],
  ["3.1.2.16 — unknown protocol version", invalid.unknownProtocolVersion],
  ["3.1.2.17 — start-line/CSeq method mismatch", invalid.methodMismatch],
  ["3.1.2.18 — unknown method with CSeq mismatch", invalid.unknownMethodMismatch],
  ["3.1.2.19 — overlarge response code", invalid.overlargeResponseCode],
]

// ---------------------------------------------------------------------------
// All parsers under test
// ---------------------------------------------------------------------------

const parsers: SipParserImpl[] = [jssipParser, sipParserNpm, customParser]

// ---------------------------------------------------------------------------
// Valid message tests — MUST parse successfully
//
// Known failures per parser are annotated. If a parser starts passing
// a previously-failed case, the test will flag it for update.
// ---------------------------------------------------------------------------

const knownFailValid: Record<string, Set<string>> = {
  jssip: new Set(["3.1.1.1", "3.1.1.2", "3.1.1.12", "3.1.1.13"]),
  "sip-parser": new Set(["3.1.1.1", "3.1.1.2", "3.1.1.7", "3.1.1.12", "3.1.1.13"]),
  custom: new Set([]),
}

describe.each(parsers)("$name — RFC 4475 valid messages", (impl) => {
  for (const [name, buf] of validCases) {
    const caseId = name.split(" — ")[0]!
    const isKnownFail = knownFailValid[impl.name]?.has(caseId) ?? false

    if (isKnownFail) {
      test(`${name} — must parse (known failure)`, () => {
        const parsed = Result.isSuccess(impl.parse(buf))
        if (parsed) {
          throw new Error(`${impl.name} now parses ${caseId} — update knownFailValid`)
        }
      })
    } else {
      test(`${name} — must parse`, () => {
        const result = impl.parse(buf)
        if (Result.isFailure(result)) {
          throw new Error(`${impl.name} failed to parse ${caseId}: ${result.failure.reason}`)
        }
        const msg = result.success
        expect(msg.type).toMatch(/^(request|response)$/)
        expect(msg.headers.length).toBeGreaterThan(0)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// Invalid message tests — SHOULD reject
//
// This is an aspirational compliance matrix. Not all parsers reject all
// invalid messages. Test failures here document leniency, not bugs.
// We use test.fails() annotations where a parser is known to accept.
// ---------------------------------------------------------------------------

// Known-lenient cases per parser (parser accepts when RFC says reject)
const knownLenient: Record<string, Set<string>> = {
  jssip: new Set([
    "3.1.2.2", "3.1.2.4", "3.1.2.5", "3.1.2.10",
    "3.1.2.11", "3.1.2.12", "3.1.2.16", "3.1.2.17", "3.1.2.18",
  ]),
  "sip-parser": new Set([
    "3.1.2.2", "3.1.2.3", "3.1.2.4", "3.1.2.5", "3.1.2.6",
    "3.1.2.8", "3.1.2.10", "3.1.2.11", "3.1.2.12",
    "3.1.2.13", "3.1.2.14", "3.1.2.15", "3.1.2.17", "3.1.2.18",
  ]),
  custom: new Set([
    "3.1.2.1", "3.1.2.6", "3.1.2.10", "3.1.2.11",
    "3.1.2.12", "3.1.2.13", "3.1.2.14", "3.1.2.15",
  ]),
}

describe.each(parsers)("$name — RFC 4475 invalid messages", (impl) => {
  for (const [name, buf] of invalidCases) {
    const caseId = name.split(" — ")[0]!
    const isLenient = knownLenient[impl.name]?.has(caseId) ?? false

    if (isLenient) {
      test(`${name} — should reject (known lenient)`, () => {
        // Document that this parser accepts this invalid message
        const rejected = Result.isFailure(impl.parse(buf))
        if (rejected) {
          // Parser started rejecting — remove from knownLenient!
          throw new Error(`${impl.name} now rejects ${caseId} — update knownLenient`)
        }
      })
    } else {
      test(`${name} — should reject`, () => {
        expect(Result.isFailure(impl.parse(buf))).toBe(true)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// Output equivalence — for messages all parsers handle, compare output shape
// ---------------------------------------------------------------------------

describe("Output equivalence — custom vs jssip", () => {
  // Cases both JsSIP and custom should parse successfully
  const bothParseCases: Array<[string, Buffer]> = [
    ["3.1.1.3 — valid percent escaping", valid.validPercentEscaping],
    ["3.1.1.4 — escaped nulls in URIs", valid.escapedNulls],
    ["3.1.1.5 — percent when not an escape", valid.percentNotEscape],
    ["3.1.1.6 — no LWS before angle bracket", valid.noLwsBeforeAngleBracket],
    ["3.1.1.7 — long values in header fields", valid.longValues],
    ["3.1.1.8 — extra trailing octets", valid.extraTrailingOctets],
    ["3.1.1.9 — semicolon in URI user part", valid.semicolonInUserPart],
    ["3.1.1.10 — varied and unknown transports", valid.variedTransports],
    ["3.1.1.11 — multipart MIME message", valid.multipartMime],
  ]

  test.each(bothParseCases)("%s — equivalent output", (_name, buf) => {
    const jssipResult = Result.getOrThrow(jssipParser.parse(buf))
    const customResult = Result.getOrThrow(customParser.parse(buf))

    expect(customResult.type).toBe(jssipResult.type)
    if (customResult.type === "request" && jssipResult.type === "request") {
      expect(customResult.method).toBe(jssipResult.method)
      // URI may differ slightly (JsSIP may decode percent-encoding)
      // so we don't assert exact URI equality
    }
    if (customResult.type === "response" && jssipResult.type === "response") {
      expect(customResult.status).toBe(jssipResult.status)
    }
    // Header count should be equal
    expect(customResult.headers.length).toBe(jssipResult.headers.length)
  })
})
