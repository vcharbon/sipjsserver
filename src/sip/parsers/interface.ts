/**
 * Shared pure-TypeScript parser interface.
 * All parser implementations conform to this contract.
 * No Effect, no async, no exceptions — designed for benchmarking and
 * swappability. Parse failures are returned as `Result.fail(SipParseError)`.
 */

import type { Result } from "effect"
import type { SipMessage } from "../types.js"
import type { SipParseError } from "./errors.js"

/** Pure synchronous SIP parser function. Returns a Result; never throws. */
export type SipParseFn = (raw: Buffer) => Result.Result<SipMessage, SipParseError>

/** Named parser implementation for benchmark reporting and compliance matrices. */
export interface SipParserImpl {
  readonly name: string
  readonly parse: SipParseFn
}

/**
 * Length caps and grammar policy the parser enforces to keep adversarial
 * inputs bounded. Lengths are measured against decoded (unfolded, trimmed)
 * values.
 *
 * - `maxHeaderLength`: max bytes of a single header, counted as
 *   `name + ": " + value` after unfolding. Bounds memory cost per header.
 * - `maxUriLength`: max bytes of the Request-URI in the start line.
 * - `allowedTransports`: case-insensitive Via transport allowlist. RFC 3261
 *   §7.1 admits `other-transport` extensibility, but operationally every
 *   deployment fixes the supported set. Default is fail-closed; override
 *   per deployment when introducing a new transport.
 * - `wireGrammar`: when `true` (default) the parser enforces the ADR-0007
 *   strict-grammar gates (Via magic cookie, transport allowlist, sent-
 *   protocol structure, strict host, strict SIP-URI, paranoid numeric
 *   header, CSeq method presence). Set to `false` for test-harness or
 *   rule-validator scenarios that need to inspect malformed-but-parseable
 *   messages without the parser pre-rejecting them.
 */
export interface SipParserLimits {
  readonly maxHeaderLength: number
  readonly maxUriLength: number
  readonly allowedTransports: ReadonlySet<string>
  readonly wireGrammar: boolean
}

/** Defaults applied when no overrides are provided. */
export const DEFAULT_SIP_PARSER_LIMITS: SipParserLimits = {
  maxHeaderLength: 2048,
  maxUriLength: 2048,
  allowedTransports: new Set(["UDP", "TCP", "TLS", "SCTP", "WS", "WSS"]),
  wireGrammar: true,
}

export { SipParseError } from "./errors.js"
