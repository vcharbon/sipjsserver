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
 * Length caps the parser enforces to keep adversarial inputs bounded.
 * Lengths are measured against decoded (unfolded, trimmed) values.
 *
 * - `maxHeaderLength`: max bytes of a single header, counted as
 *   `name + ": " + value` after unfolding. Bounds memory cost per header.
 * - `maxUriLength`: max bytes of the Request-URI in the start line.
 */
export interface SipParserLimits {
  readonly maxHeaderLength: number
  readonly maxUriLength: number
}

/** Defaults applied when no overrides are provided. */
export const DEFAULT_SIP_PARSER_LIMITS: SipParserLimits = {
  maxHeaderLength: 2048,
  maxUriLength: 2048,
}

export { SipParseError } from "./errors.js"
