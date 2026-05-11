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
  parseNameAddr,
  parseRack,
  parseReferTo,
  splitTopLevelCommas,
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
