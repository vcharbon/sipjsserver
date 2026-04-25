/**
 * LazyHeaders — Scala `lazy val`-equivalent memoization for optional
 * structured SIP headers that are not parsed eagerly by the main parser.
 *
 * Each getter returns `Result<ReadonlyArray<Parsed>, SipParseError>`:
 *   - `Result.succeed([])` when the header is absent
 *   - `Result.succeed([entry, ...])` when one or more values parse cleanly
 *   - `Result.fail(SipParseError)` when at least one value is malformed
 *
 * Memoization uses private nullable fields populated on first call.
 * Per-message overhead when no lazy header is touched: one class instance
 * (~20 B) plus eight `undefined` slots in a stable hidden class (~64 B).
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  headerName: string
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
          })
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
  headers: ReadonlyArray<SipHeader>
): Result.Result<boolean | undefined, SipParseError> {
  const values = getHeaderValues(headers, "Geolocation-Routing")
  if (values.length === 0) return Result.succeed(undefined)
  const v = values[0]!.trim().toLowerCase()
  if (v === "yes") return Result.succeed(true)
  if (v === "no") return Result.succeed(false)
  return Result.fail(
    new SipParseError({ reason: `Invalid Geolocation-Routing value: "${v}"` })
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
  parser: (value: string) => T | undefined
): Result.Result<T | undefined, SipParseError> {
  const values = getHeaderValues(headers, headerName)
  if (values.length === 0) return Result.succeed(undefined)
  const parsed = parser(values[0]!)
  if (parsed === undefined) {
    return Result.fail(
      new SipParseError({ reason: `Malformed ${headerName}: "${values[0]}"` })
    )
  }
  return Result.succeed(parsed)
}

// ---------------------------------------------------------------------------
// LazyHeaders class
// ---------------------------------------------------------------------------

export class LazyHeaders {
  // Private memoization slots — one per supported header. Initialised to
  // `undefined` so V8 keeps a stable hidden class for every message.
  private _pAssertedIdentity: Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> | undefined = undefined
  private _pPreferredIdentity: Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> | undefined = undefined
  private _diversion: Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> | undefined = undefined
  private _historyInfo: Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> | undefined = undefined
  private _remotePartyId: Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> | undefined = undefined
  private _geolocation: Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> | undefined = undefined
  private _geolocationError: Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> | undefined = undefined
  private _geolocationRouting: Result.Result<boolean | undefined, SipParseError> | undefined = undefined
  private _rack: Result.Result<ParsedRack | undefined, SipParseError> | undefined = undefined
  private _referTo: Result.Result<ParsedReferTo | undefined, SipParseError> | undefined = undefined

  constructor(private readonly headers: ReadonlyArray<SipHeader>) {}

  /** RFC 3325 §9.1 — P-Asserted-Identity (one or two name-addr values). */
  pAssertedIdentity(): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> {
    if (this._pAssertedIdentity !== undefined) return this._pAssertedIdentity
    const r = parseNameAddrListHeader(this.headers, "P-Asserted-Identity")
    this._pAssertedIdentity = r
    return r
  }

  /** RFC 3325 §9.2 — P-Preferred-Identity. */
  pPreferredIdentity(): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> {
    if (this._pPreferredIdentity !== undefined) return this._pPreferredIdentity
    const r = parseNameAddrListHeader(this.headers, "P-Preferred-Identity")
    this._pPreferredIdentity = r
    return r
  }

  /** RFC 5806 — Diversion (per-entry params include reason, counter, limit, privacy, screen). */
  diversion(): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> {
    if (this._diversion !== undefined) return this._diversion
    const r = parseNameAddrListHeader(this.headers, "Diversion")
    this._diversion = r
    return r
  }

  /** RFC 7044 — History-Info (per-entry params include `index`, `mp`, `rc`). */
  historyInfo(): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> {
    if (this._historyInfo !== undefined) return this._historyInfo
    const r = parseNameAddrListHeader(this.headers, "History-Info")
    this._historyInfo = r
    return r
  }

  /** draft-ietf-sip-privacy-04 — Remote-Party-ID (per-entry params include party, id-type, privacy, screen). */
  remotePartyId(): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> {
    if (this._remotePartyId !== undefined) return this._remotePartyId
    const r = parseNameAddrListHeader(this.headers, "Remote-Party-ID")
    this._remotePartyId = r
    return r
  }

  /** RFC 6442 §4.1 — Geolocation (one or more locationValue entries). */
  geolocation(): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> {
    if (this._geolocation !== undefined) return this._geolocation
    const r = parseNameAddrListHeader(this.headers, "Geolocation")
    this._geolocation = r
    return r
  }

  /** RFC 7378 — Geolocation-Error (error-value with code + URI list). Parsed as name-addr list; numeric `code` is exposed via `params["code"]`. */
  geolocationError(): Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> {
    if (this._geolocationError !== undefined) return this._geolocationError
    const r = parseNameAddrListHeader(this.headers, "Geolocation-Error")
    this._geolocationError = r
    return r
  }

  /** RFC 6442 §4.2 — Geolocation-Routing token "yes"/"no". `undefined` when absent. */
  geolocationRouting(): Result.Result<boolean | undefined, SipParseError> {
    if (this._geolocationRouting !== undefined) return this._geolocationRouting
    const r = parseGeolocationRoutingHeader(this.headers)
    this._geolocationRouting = r
    return r
  }

  /**
   * RFC 3262 §7.2 — RAck header on PRACK requests: `<response-num> <CSeq-num> <method>`.
   * `undefined` when absent (e.g. on non-PRACK messages); `Result.fail` on malformed value.
   */
  rack(): Result.Result<ParsedRack | undefined, SipParseError> {
    if (this._rack !== undefined) return this._rack
    const r = parseSingleValueHeader(this.headers, "RAck", parseRack)
    this._rack = r
    return r
  }

  /**
   * RFC 3515 — Refer-To on REFER requests, with RFC 3891 Replaces support
   * exposed through `parsed.replaces`. `undefined` when absent; `Result.fail`
   * when parseNameAddr cannot extract a URI.
   */
  referTo(): Result.Result<ParsedReferTo | undefined, SipParseError> {
    if (this._referTo !== undefined) return this._referTo
    const r = parseSingleValueHeader(this.headers, "Refer-To", parseReferTo)
    this._referTo = r
    return r
  }
}
