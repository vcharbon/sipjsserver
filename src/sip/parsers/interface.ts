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

export { SipParseError } from "./errors.js"
