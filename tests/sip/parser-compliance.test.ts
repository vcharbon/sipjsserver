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
import { runAllStrictLazyParsers } from "../../src/sip/parsers/custom/lazy-parsers.js"

import * as valid from "./fixtures/rfc4475-valid.js"
import * as invalid from "./fixtures/rfc4475-invalid.js"
import * as cve from "./fixtures/cve-regression/index.js"
import * as paramGaps from "./fixtures/param-grammar-gaps.js"
import * as ipv6 from "./fixtures/rfc5118-ipv6.js"
import * as strictValid from "./fixtures/rfc-header-grammar-valid.js"

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

// Known-lenient cases per parser (parser accepts when RFC says reject).
//
// "Accepted" here means BOTH the eager parser AND the strict lazy
// re-parsers (Date, From, To, Contact, P-Asserted-Identity, …) pass on
// the message. Any tractable header-content malformation is caught by
// the lazy strict pass via `runAllStrictLazyParsers`; only fixtures
// whose only RFC violation is in a non-header surface (request-line
// shape, Request-URI escaping, etc.) should remain lenient.
//
// 3.1.2.5 (overlarge response scalars) is rejected by every parser
// because the response — a 503 — lacks a To-tag, and `extractResponseFields`
// rejects any non-100 response missing a To-tag (RFC 3261 §8.2.6.2).
const knownLenient: Record<string, Set<string>> = {
  jssip: new Set([
    "3.1.2.2", "3.1.2.4", "3.1.2.10",
    "3.1.2.11", "3.1.2.16", "3.1.2.17", "3.1.2.18",
  ]),
  "sip-parser": new Set([
    "3.1.2.2", "3.1.2.3", "3.1.2.4",
    "3.1.2.8", "3.1.2.10", "3.1.2.11",
    "3.1.2.17", "3.1.2.18",
  ]),
  custom: new Set([
    "3.1.2.1", "3.1.2.10", "3.1.2.11",
  ]),
}

/**
 * Eager parse + strict lazy pass: rejection at either step counts as
 * "parser rejected the message". The lazy pass only fires when the
 * eager parser succeeded — this is the wiring that turns header-content
 * malformations (bad Date timezone, non-token display name, etc.) into
 * test failures despite the lenient eager grammar.
 */
function parseStrict(impl: SipParserImpl, buf: Buffer): Result.Result<unknown, unknown> {
  const eager = impl.parse(buf)
  if (Result.isFailure(eager)) return eager
  const strict = runAllStrictLazyParsers(eager.success.headers)
  if (Result.isFailure(strict)) return strict
  return eager
}

// ---------------------------------------------------------------------------
// Strict lazy parsers — positive cases: every well-formed canonical input
// must pass BOTH the eager parser AND the strict re-parsers. Guards against
// the strict pass drifting into "reject everything".
// ---------------------------------------------------------------------------

const strictValidCases: Array<[string, Buffer]> = [
  ["Date — canonical GMT", strictValid.dateGmt],
  ["From — quoted display + name-addr", strictValid.fromQuotedDisplay],
  ["From — unquoted token display + name-addr", strictValid.fromTokenDisplay],
  ["Contact — name-addr, no LWS in <>", strictValid.contactNameAddr],
  ["Contact — bare addr-spec, no params", strictValid.contactBareUri],
]

describe.each(parsers)("$name — strict lazy parsers accept canonical inputs", (impl) => {
  for (const [name, buf] of strictValidCases) {
    test(`${name}`, () => {
      const eager = impl.parse(buf)
      if (Result.isFailure(eager)) {
        throw new Error(`${impl.name} failed eager parse: ${eager.failure.reason}`)
      }
      const strict = runAllStrictLazyParsers(eager.success.headers)
      if (Result.isFailure(strict)) {
        throw new Error(`${impl.name} strict lazy parse rejected canonical input: ${strict.failure.reason}`)
      }
    })
  }
})

describe.each(parsers)("$name — RFC 4475 invalid messages", (impl) => {
  for (const [name, buf] of invalidCases) {
    const caseId = name.split(" — ")[0]!
    const isLenient = knownLenient[impl.name]?.has(caseId) ?? false

    if (isLenient) {
      test(`${name} — should reject (known lenient)`, () => {
        const rejected = Result.isFailure(parseStrict(impl, buf))
        if (rejected) {
          // Parser (or strict lazy pass) started rejecting — remove from knownLenient!
          throw new Error(`${impl.name} now rejects ${caseId} — update knownLenient`)
        }
      })
    } else {
      test(`${name} — should reject`, () => {
        expect(Result.isFailure(parseStrict(impl, buf))).toBe(true)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// CVE-regression — every fixture is a malformed SIP message reconstructed
// from a public CVE advisory in an adjacent SIP stack. The ideal is "every
// parser rejects every case". In practice some parsers (including ours) are
// not strict enough; gaps are tracked in `knownCveLenient` with a TODO note
// on the parser-side fix that should retire each entry.
// ---------------------------------------------------------------------------

const cveCases: Array<[string, Buffer]> = [
  ["CVE-2023-27598 — OpenSIPS parse_via malformed Via", cve.cve_2023_27598],
  ["CVE-2023-27599 — OpenSIPS To-param unterminated quote", cve.cve_2023_27599],
  ["CVE-2023-28098 — OpenSIPS digest-auth parse_param_name", cve.cve_2023_28098],
]

// Gaps observed at fixture-introduction time. Tightening the affected parser
// will trip the regression-detector path below and prompt removal of the
// matching entry. Each gap is a real parser-strictness bug.
const knownCveLenient: Record<string, Set<string>> = {
  jssip: new Set([]),
  "sip-parser": new Set([
    "CVE-2023-27598", // tolerates \x16 control byte + malformed Via params
    "CVE-2023-27599", // tolerates unterminated quoted string in To-param
    "CVE-2023-28098", // tolerates bare-token param in Digest scheme
  ]),
  custom: new Set([]),
}

describe.each(parsers)("$name — CVE regression (must reject)", (impl) => {
  for (const [name, buf] of cveCases) {
    const caseId = name.split(" — ")[0]!
    const isLenient = knownCveLenient[impl.name]?.has(caseId) ?? false

    if (isLenient) {
      test(`${name} — should reject (known lenient)`, () => {
        const rejected = Result.isFailure(impl.parse(buf))
        if (rejected) {
          throw new Error(`${impl.name} now rejects ${caseId} — update knownCveLenient`)
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
// RFC 3261 parameter-grammar gaps — port range, mandatory non-empty values,
// duplicate single-occurrence params. Same leniency-table pattern as the
// CVE regression block: every parser should reject, but real-world parsers
// vary in strictness, so per-parser gaps are tracked explicitly.
// ---------------------------------------------------------------------------

const paramGapCases: Array<[string, Buffer]> = [
  ["PARAM-via-port-overflow — Via port > 65535", paramGaps.viaPortOverflow],
  ["PARAM-via-port-zero — Via port = 0", paramGaps.viaPortZero],
  ["PARAM-ruri-port-overflow — Request-URI port > 65535", paramGaps.requestUriPortOverflow],
  ["PARAM-via-empty-branch — Via with branch=", paramGaps.viaEmptyBranch],
  ["PARAM-from-empty-tag — From with tag=", paramGaps.fromEmptyTag],
  ["PARAM-from-duplicate-tag — From with two tag= params", paramGaps.fromDuplicateTag],
  ["PARAM-via-port-trailing-garbage — Via port 8080xyz", paramGaps.viaPortTrailingGarbage],
  ["PARAM-ruri-no-host — Request-URI with empty host", paramGaps.requestUriNoHost],
  ["PARAM-ruri-ipv6-unclosed — Request-URI [::1 with no ]", paramGaps.requestUriIpv6Unclosed],
  ["PARAM-ruri-port-trailing-garbage — Request-URI port 8080xyz", paramGaps.requestUriPortTrailingGarbage],
  ["PARAM-ruri-ctl-in-param — URI param name with \\x16", paramGaps.requestUriCtlInParamName],
]

// All three parsers feed their decoded header arrays through extract-fields.ts
// (jssip-adapter / sip-parser-adapter / customParser), so most param-gap
// validations apply universally. Exceptions:
//   - jssip rejects port-trailing-garbage in its own Via parser before
//     extract-fields sees the message — that surfaces as a hard reject.
//   - sip-parser canonicalises header values, dropping empty `;tag=` and
//     deduping duplicate params before extract-fields sees them, so our
//     post-parse checks can't fire on its output.
//   - The trailing-port-garbage case isn't caught by our extract-fields
//     check yet (TODO below).
const knownParamGapLenient: Record<string, Set<string>> = {
  jssip: new Set([]),
  "sip-parser": new Set([
    // sip-parser canonicalises these before extract-fields sees them.
    "PARAM-via-empty-branch",
    "PARAM-from-empty-tag",
    "PARAM-from-duplicate-tag",
    "PARAM-ruri-no-host",
    "PARAM-ruri-ipv6-unclosed",
    "PARAM-ruri-port-trailing-garbage",
    "PARAM-ruri-ctl-in-param",
  ]),
  custom: new Set([]),
}

// ---------------------------------------------------------------------------
// RFC 5118 — IPv6 SIP torture tests.
//
// All but §4.2 are valid (RFC 5118's principle is "be liberal in what you
// accept" for IPv6 surface). §4.2 carries an unbracketed IPv6 in the
// Request-URI and MUST be rejected.
// ---------------------------------------------------------------------------

const ipv6ValidCases: Array<[string, Buffer]> = [
  ["RFC5118-4.1 — basic IPv6 in URI / Via / Contact", ipv6.v41_basicIpv6],
  ["RFC5118-4.3 — port-ambiguous (parses as 6-group IPv6)", ipv6.v43_portAmbiguousInBrackets],
  ["RFC5118-4.4 — port unambiguous, outside brackets", ipv6.v44_portUnambiguous],
  ["RFC5118-4.5a — Via received= with bracket delimiters", ipv6.v45a_receivedBracketed],
  ["RFC5118-4.5b — Via received= bare (no brackets)", ipv6.v45b_receivedBare],
  ["RFC5118-4.6 — IPv6 in SDP body", ipv6.v46_ipv6InSdp],
  ["RFC5118-4.7 — mixed IPv4 / IPv6 Via chain", ipv6.v47_mixedIpv4Ipv6Vias],
  ["RFC5118-4.8 — multiple IP types in SDP", ipv6.v48_multipleIpInSdp],
  ["RFC5118-4.9 — IPv4-mapped IPv6 addresses", ipv6.v49_ipv4Mapped],
  ["RFC5118-4.10a — three colons before IPv4 segment (robust)", ipv6.v410a_extraColon],
  ["RFC5118-4.10b — correct RFC 4291 IPv4-in-IPv6 syntax", ipv6.v410b_correctIpv4InIpv6],
]

const ipv6InvalidCases: Array<[string, Buffer]> = [
  ["RFC5118-4.2 — unbracketed IPv6 in Request-URI", ipv6.v42_ipv6NoBrackets],
]

const knownIpv6ValidFail: Record<string, Set<string>> = {
  // jssip's URI parser rejects the lenient 3-colon RFC 2373 form (§4.10a).
  jssip: new Set(["RFC5118-4.10a"]),
  // sip-parser rejects `sip:[IPv6]` form (no user-part) — cases §4.1, §4.3,
  // §4.4, §4.5a, §4.5b all use that form. The `sip:user@[IPv6]` form parses
  // correctly.
  "sip-parser": new Set([
    "RFC5118-4.1",
    "RFC5118-4.3",
    "RFC5118-4.4",
    "RFC5118-4.5a",
    "RFC5118-4.5b",
  ]),
  custom: new Set([]),
}

const knownIpv6InvalidLenient: Record<string, Set<string>> = {
  jssip: new Set([]),
  // sip-parser canonicalises the URI before extract-fields sees it, so
  // our unbracketed-IPv6 check on the raw string never fires.
  "sip-parser": new Set(["RFC5118-4.2"]),
  custom: new Set([]),
}

describe.each(parsers)("$name — RFC 5118 IPv6 torture (valid, must parse)", (impl) => {
  for (const [name, buf] of ipv6ValidCases) {
    const caseId = name.split(" — ")[0]!
    const isKnownFail = knownIpv6ValidFail[impl.name]?.has(caseId) ?? false
    if (isKnownFail) {
      test(`${name} — must parse (known failure)`, () => {
        if (Result.isSuccess(impl.parse(buf))) {
          throw new Error(`${impl.name} now parses ${caseId} — update knownIpv6ValidFail`)
        }
      })
    } else {
      test(`${name} — must parse`, () => {
        const result = impl.parse(buf)
        if (Result.isFailure(result)) {
          throw new Error(`${impl.name} failed to parse ${caseId}: ${result.failure.reason}`)
        }
      })
    }
  }
})

describe.each(parsers)("$name — RFC 5118 IPv6 torture (invalid, must reject)", (impl) => {
  for (const [name, buf] of ipv6InvalidCases) {
    const caseId = name.split(" — ")[0]!
    const isLenient = knownIpv6InvalidLenient[impl.name]?.has(caseId) ?? false
    if (isLenient) {
      test(`${name} — should reject (known lenient)`, () => {
        if (Result.isFailure(impl.parse(buf))) {
          throw new Error(`${impl.name} now rejects ${caseId} — update knownIpv6InvalidLenient`)
        }
      })
    } else {
      test(`${name} — should reject`, () => {
        expect(Result.isFailure(impl.parse(buf))).toBe(true)
      })
    }
  }
})

describe.each(parsers)("$name — RFC 3261 param-grammar gaps (must reject)", (impl) => {
  for (const [name, buf] of paramGapCases) {
    const caseId = name.split(" — ")[0]!
    const isLenient = knownParamGapLenient[impl.name]?.has(caseId) ?? false

    if (isLenient) {
      test(`${name} — should reject (known lenient)`, () => {
        const rejected = Result.isFailure(impl.parse(buf))
        if (rejected) {
          throw new Error(`${impl.name} now rejects ${caseId} — update knownParamGapLenient`)
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
