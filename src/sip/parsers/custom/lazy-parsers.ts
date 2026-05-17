/**
 * Standalone parsers for optional structured SIP headers that are not
 * parsed eagerly. Each parser returns `Result<T, SipParseError>` and is
 * driven by the runtime header registry from a single per-message memo.
 *
 * Previously these lived as methods on a `LazyHeaders` class (one method
 * per header, each with its own private memo slot). The class is gone;
 * memoization is handled centrally by `makeGetHeader` in the registry.
 */

import { Result } from "effect"
import type { SipHeader } from "../../types.js"
import { SipParseError } from "../errors.js"
import {
  parseContact,
  parseNameAddr,
  parseRack,
  parseReferTo,
  splitTopLevelCommas,
  type ParsedContact,
  type ParsedNameAddr,
  type ParsedRack,
  type ParsedReferTo,
} from "./structured-headers.js"

function getHeaderValues(headers: ReadonlyArray<SipHeader>, name: string): string[] {
  const lower = name.toLowerCase()
  const out: string[] = []
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) out.push(h.value)
  }
  return out
}

/**
 * Parse a multi-value name-addr header. Returns the flattened list across
 * every header instance and every comma-separated entry. Empty header set →
 * empty list. Any malformed entry → SipParseError.
 *
 * Note: `parseNameAddr` itself is lenient and returns its best effort, so
 * "malformed" here means "the entry produced no recognisable URI". This
 * keeps the contract aligned with the main parser, which has the same
 * forgiveness for trailing junk in From/To.
 */
function parseNameAddrListHeader(
  headers: ReadonlyArray<SipHeader>,
  headerName: string,
): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> {
  const values = getHeaderValues(headers, headerName)
  if (values.length === 0) return Result.succeed([])
  const out: ParsedNameAddr[] = []
  for (const v of values) {
    for (const entry of splitTopLevelCommas(v)) {
      if (entry.length === 0) continue
      const parsed = parseNameAddr(entry)
      if (parsed.uri.length === 0) {
        return Result.fail(
          new SipParseError({
            reason: `Malformed ${headerName} entry: "${entry}"`,
          }),
        )
      }
      out.push(parsed)
    }
  }
  return Result.succeed(out)
}

/**
 * Parse `Geolocation-Routing` per RFC 6442 §4.2 — token "yes" / "no",
 * case-insensitive. Absent header → `Result.succeed(undefined)`.
 */
function parseGeolocationRoutingHeader(
  headers: ReadonlyArray<SipHeader>,
): Result.Result<boolean | undefined, SipParseError> {
  const values = getHeaderValues(headers, "Geolocation-Routing")
  if (values.length === 0) return Result.succeed(undefined)
  const v = values[0]!.trim().toLowerCase()
  if (v === "yes") return Result.succeed(true)
  if (v === "no") return Result.succeed(false)
  return Result.fail(
    new SipParseError({ reason: `Invalid Geolocation-Routing value: "${v}"` }),
  )
}

/**
 * Generic single-value lazy parse: take the first header instance, run a
 * structured parser, return `succeed(undefined)` for absent header,
 * `succeed(parsed)` on success, `fail(SipParseError)` when the parser
 * rejects the value.
 */
function parseSingleValueHeader<T>(
  headers: ReadonlyArray<SipHeader>,
  headerName: string,
  parser: (value: string) => T | undefined,
): Result.Result<T | undefined, SipParseError> {
  const values = getHeaderValues(headers, headerName)
  if (values.length === 0) return Result.succeed(undefined)
  const parsed = parser(values[0]!)
  if (parsed === undefined) {
    return Result.fail(
      new SipParseError({ reason: `Malformed ${headerName}: "${values[0]}"` }),
    )
  }
  return Result.succeed(parsed)
}

// ── Per-header exports ────────────────────────────────────────────────────

export const parsePAssertedIdentity = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> =>
  parseNameAddrListHeader(headers, "P-Asserted-Identity")

export const parsePPreferredIdentity = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> =>
  parseNameAddrListHeader(headers, "P-Preferred-Identity")

export const parseDiversion = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> =>
  parseNameAddrListHeader(headers, "Diversion")

export const parseHistoryInfo = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> =>
  parseNameAddrListHeader(headers, "History-Info")

export const parseRemotePartyId = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> =>
  parseNameAddrListHeader(headers, "Remote-Party-ID")

export const parseGeolocation = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> =>
  parseNameAddrListHeader(headers, "Geolocation")

export const parseGeolocationError = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> =>
  parseNameAddrListHeader(headers, "Geolocation-Error")

export const parseGeolocationRouting = parseGeolocationRoutingHeader

export const parseRackHeader = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<ParsedRack | undefined, SipParseError> =>
  parseSingleValueHeader(headers, "RAck", parseRack)

export const parseReferToHeader = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<ParsedReferTo | undefined, SipParseError> =>
  parseSingleValueHeader(headers, "Refer-To", parseReferTo)

// =========================================================================
// Strict re-parsers — used by parser-compliance tests (and any opt-in
// strict-mode caller) to reject messages that the lenient eager pipeline
// accepts. These run AFTER the eager parser succeeds, on the raw header
// values; failure here means "header content malformed per RFC grammar".
// =========================================================================

/**
 * RFC 3261 §20.17 / RFC 2616 §3.3.1 strict Date — `Day, DD Mon YYYY HH:MM:SS GMT`.
 * RFC 3261 explicitly requires the GMT timezone literal; any other zone
 * (including the legacy obsoleted RFC 822 forms like `EST`, numeric `+0000`,
 * etc.) is a syntax violation.
 */
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39
}

function parseDateValueStrict(value: string): Result.Result<Date, SipParseError> {
  const v = value.trim()
  // Day-of-week: 3 letters, COMMA, SP
  if (v.length < 29) {
    return Result.fail(new SipParseError({ reason: `Malformed Date: too short "${v}"` }))
  }
  const dow = v.slice(0, 3)
  if (!DOW.includes(dow)) {
    return Result.fail(new SipParseError({ reason: `Malformed Date: bad day-of-week "${dow}"` }))
  }
  if (v.charCodeAt(3) !== 0x2c || v.charCodeAt(4) !== 0x20) {
    return Result.fail(new SipParseError({ reason: `Malformed Date: missing ", " after day-of-week` }))
  }
  // DD SP
  if (!isDigit(v.charCodeAt(5)) || !isDigit(v.charCodeAt(6)) || v.charCodeAt(7) !== 0x20) {
    return Result.fail(new SipParseError({ reason: `Malformed Date: bad day-of-month` }))
  }
  const day = parseInt(v.slice(5, 7), 10)
  // Mon SP
  const mon = v.slice(8, 11)
  const monIdx = MON.indexOf(mon)
  if (monIdx === -1 || v.charCodeAt(11) !== 0x20) {
    return Result.fail(new SipParseError({ reason: `Malformed Date: bad month "${mon}"` }))
  }
  // YYYY SP
  for (let i = 12; i < 16; i++) {
    if (!isDigit(v.charCodeAt(i))) {
      return Result.fail(new SipParseError({ reason: `Malformed Date: bad year` }))
    }
  }
  const year = parseInt(v.slice(12, 16), 10)
  if (v.charCodeAt(16) !== 0x20) {
    return Result.fail(new SipParseError({ reason: `Malformed Date: missing SP before time` }))
  }
  // HH:MM:SS SP
  if (
    !isDigit(v.charCodeAt(17)) || !isDigit(v.charCodeAt(18)) || v.charCodeAt(19) !== 0x3a ||
    !isDigit(v.charCodeAt(20)) || !isDigit(v.charCodeAt(21)) || v.charCodeAt(22) !== 0x3a ||
    !isDigit(v.charCodeAt(23)) || !isDigit(v.charCodeAt(24)) || v.charCodeAt(25) !== 0x20
  ) {
    return Result.fail(new SipParseError({ reason: `Malformed Date: bad HH:MM:SS` }))
  }
  const hh = parseInt(v.slice(17, 19), 10)
  const mm = parseInt(v.slice(20, 22), 10)
  const ss = parseInt(v.slice(23, 25), 10)
  // GMT — and nothing after it
  if (v.slice(26) !== "GMT") {
    return Result.fail(new SipParseError({ reason: `Malformed Date: expected "GMT", got "${v.slice(26)}"` }))
  }
  if (day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 59) {
    return Result.fail(new SipParseError({ reason: `Malformed Date: out-of-range field` }))
  }
  const ms = Date.UTC(year, monIdx, day, hh, mm, ss)
  if (Number.isNaN(ms)) {
    return Result.fail(new SipParseError({ reason: `Malformed Date: produced NaN` }))
  }
  return Result.succeed(new Date(ms))
}

export const parseDateHeaderStrict = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<Date | undefined, SipParseError> => {
  const values = getHeaderValues(headers, "Date")
  if (values.length === 0) return Result.succeed(undefined)
  // sip-parser splits the RFC 1123 Date at the day-of-week comma, surfacing
  // two header instances. Rejoin with ", " before strict re-parse so the
  // strict pass is parser-agnostic.
  const joined = values.length === 1 ? values[0]! : values.join(", ")
  return parseDateValueStrict(joined)
}

// ── token-grammar predicates (RFC 3261 §25.1) ────────────────────────────

/**
 * RFC 3261 token = 1*( alphanum / "-" / "." / "!" / "%" / "*" / "_" /
 *                      "+" / "`" / "'" / "~" ).
 * Returns false for empty input.
 */
function isTokenChar(c: number): boolean {
  if (c >= 0x30 && c <= 0x39) return true // 0-9
  if (c >= 0x41 && c <= 0x5a) return true // A-Z
  if (c >= 0x61 && c <= 0x7a) return true // a-z
  // - . ! % * _ + ` ' ~
  return c === 0x2d || c === 0x2e || c === 0x21 || c === 0x25 || c === 0x2a ||
    c === 0x5f || c === 0x2b || c === 0x60 || c === 0x27 || c === 0x7e
}

/**
 * Validate an UNQUOTED display name (sequence of `token` joined by LWS).
 * `Bell, Alexander` fails because `,` is not a token char (catches 3.1.2.15).
 * `J Rosenberg` passes (SP between tokens is the grammar's LWS).
 */
function isValidUnquotedDisplayName(s: string): boolean {
  if (s.length === 0) return true // omitted display name is fine
  let i = 0
  while (i < s.length) {
    const c = s.charCodeAt(i)
    if (c === 0x20 || c === 0x09) { i++; continue }
    if (!isTokenChar(c)) return false
    i++
  }
  return true
}

/**
 * Re-scan a From/To/Contact value with stricter rules than `parseNameAddr`.
 * Catches:
 *   - unquoted display name with non-token chars (3.1.2.15)
 *   - LWS inside the `<...>` envelope around the URI (3.1.2.14)
 *   - bare addr-spec carrying `?embedded=...` headers — those require
 *     name-addr form per RFC 3261 §20.10 (3.1.2.13)
 */
function validateNameAddrStrict(
  value: string,
  headerName: string,
): Result.Result<void, SipParseError> {
  let i = 0
  const len = value.length
  // skip leading LWS
  while (i < len && (value.charCodeAt(i) === 0x20 || value.charCodeAt(i) === 0x09)) i++

  // Quoted display name? RFC 4475 wsinv exercises pathological backslash
  // escape sequences inside the quoted-string, so we tolerate trailing
  // bytes between the close-quote and the `<` (a stricter parser would
  // reject 3.1.1.1, which the eager parser deliberately accepts). The
  // strict check we need from this branch is the angle-section validation
  // — i.e., when name-addr form is used, `<...>` must not have LWS inside.
  if (i < len && value.charCodeAt(i) === 0x22) {
    i++
    let closed = false
    while (i < len) {
      const c = value.charCodeAt(i)
      if (c === 0x5c && i + 1 < len) { i += 2; continue }
      if (c === 0x22) { i++; closed = true; break }
      i++
    }
    if (!closed) {
      return Result.fail(new SipParseError({
        reason: `Strict ${headerName}: unterminated quoted display name`,
      }))
    }
    const lt = value.indexOf("<", i)
    if (lt === -1) return Result.succeed(undefined)
    return validateAngleSection(value, lt, headerName)
  }

  // Find < — everything before it is an (unquoted) display name.
  const lt = value.indexOf("<", i)
  if (lt !== -1) {
    const dn = value.slice(i, lt).trimEnd()
    if (!isValidUnquotedDisplayName(dn)) {
      return Result.fail(new SipParseError({
        reason: `Strict ${headerName}: non-token char in unquoted display name "${dn}"`,
      }))
    }
    return validateAngleSection(value, lt, headerName)
  }

  // Bare addr-spec (no `<>`). RFC 3261 §20.10: when the URI carries `?` or
  // `;`-params and the surrounding context could swallow them, name-addr is
  // mandatory. We catch the unambiguous case: `?` in the URI head (which
  // would otherwise be silently absorbed as header-level params).
  const semiOrEnd = (() => {
    const s = value.indexOf(";", i)
    return s === -1 ? len : s
  })()
  for (let k = i; k < semiOrEnd; k++) {
    if (value.charCodeAt(k) === 0x3f) {
      return Result.fail(new SipParseError({
        reason: `Strict ${headerName}: bare addr-spec with embedded "?headers"; name-addr "<sip:...>" form required`,
      }))
    }
  }
  // An addr-spec MUST contain a scheme — i.e., a `:` after a token prefix.
  // A bare token like `Bell` (no `:`) is neither display name (needs `<...>`)
  // nor URI (needs scheme). RFC 3261 §20.20/§20.39 require an addr-spec.
  let hasColon = false
  for (let k = i; k < semiOrEnd; k++) {
    if (value.charCodeAt(k) === 0x3a) { hasColon = true; break }
  }
  if (!hasColon) {
    const trimmed = value.slice(i).trim()
    if (trimmed.length > 0) {
      return Result.fail(new SipParseError({
        reason: `Strict ${headerName}: addr-spec required, got "${trimmed}"`,
      }))
    }
  }
  return Result.succeed(undefined)
}

/** Validate the `< ... >` envelope starting at position `lt` (which must be `<`). */
function validateAngleSection(
  value: string,
  lt: number,
  headerName: string,
): Result.Result<void, SipParseError> {
  if (value.charCodeAt(lt) !== 0x3c) {
    return Result.fail(new SipParseError({ reason: `Strict ${headerName}: expected "<"` }))
  }
  const gt = value.indexOf(">", lt + 1)
  if (gt === -1) {
    return Result.fail(new SipParseError({ reason: `Strict ${headerName}: unterminated "<...>"` }))
  }
  // RFC 3261 LAQUOT/RAQUOT productions explicitly forbid LWS between the
  // bracket and the addr-spec. `< sip:...` and `... >` both reject.
  const first = value.charCodeAt(lt + 1)
  if (first === 0x20 || first === 0x09) {
    return Result.fail(new SipParseError({
      reason: `Strict ${headerName}: LWS inside "<...>" addr-spec`,
    }))
  }
  const last = value.charCodeAt(gt - 1)
  if (last === 0x20 || last === 0x09) {
    return Result.fail(new SipParseError({
      reason: `Strict ${headerName}: LWS inside "<...>" addr-spec`,
    }))
  }
  return Result.succeed(undefined)
}

/**
 * Strict From — validates the raw header value, then returns the same
 * `ParsedNameAddr` shape the eager parser produced. Returns
 * `Result.succeed(undefined)` only when no From header is present (the
 * eager parser already enforces presence, so this branch is unreachable
 * in practice; kept defensive).
 */
export const parseFromStrict = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<ParsedNameAddr | undefined, SipParseError> => {
  const values = getHeaderValues(headers, "From")
  if (values.length === 0) return Result.succeed(undefined)
  const v = values[0]!
  const ok = validateNameAddrStrict(v, "From")
  if (Result.isFailure(ok)) return Result.fail(ok.failure)
  return Result.succeed(parseNameAddr(v))
}

export const parseToStrict = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<ParsedNameAddr | undefined, SipParseError> => {
  const values = getHeaderValues(headers, "To")
  if (values.length === 0) return Result.succeed(undefined)
  const v = values[0]!
  const ok = validateNameAddrStrict(v, "To")
  if (Result.isFailure(ok)) return Result.fail(ok.failure)
  return Result.succeed(parseNameAddr(v))
}

export const parseContactStrict = (
  headers: ReadonlyArray<SipHeader>,
): Result.Result<ReadonlyArray<ParsedContact>, SipParseError> => {
  const values = getHeaderValues(headers, "Contact")
  if (values.length === 0) return Result.succeed([])
  const out: ParsedContact[] = []
  for (const v of values) {
    for (const entry of splitTopLevelCommas(v)) {
      if (entry.length === 0) continue
      const ok = validateNameAddrStrict(entry, "Contact")
      if (Result.isFailure(ok)) return Result.fail(ok.failure)
      out.push(parseContact(entry))
    }
  }
  return Result.succeed(out)
}

/**
 * Run every strict lazy parser plus every existing lazy parser that returns
 * `Result`. Returns `Result.fail` on the first failure, `Result.succeed`
 * when all parsers accept (or the header is absent). Used by the
 * parser-compliance test to upgrade lenient eager-parse acceptance into
 * an overall rejection when any header is grammatically malformed.
 */
export function runAllStrictLazyParsers(
  headers: ReadonlyArray<SipHeader>,
): Result.Result<void, SipParseError> {
  const checks: Array<Result.Result<unknown, SipParseError>> = [
    parseDateHeaderStrict(headers),
    parseFromStrict(headers),
    parseToStrict(headers),
    parseContactStrict(headers),
    parsePAssertedIdentity(headers),
    parsePPreferredIdentity(headers),
    parseDiversion(headers),
    parseHistoryInfo(headers),
    parseRemotePartyId(headers),
    parseGeolocation(headers),
    parseGeolocationError(headers),
    parseGeolocationRouting(headers),
    parseRackHeader(headers),
    parseReferToHeader(headers),
  ]
  for (const r of checks) {
    if (Result.isFailure(r)) return Result.fail(r.failure)
  }
  return Result.succeed(undefined)
}
