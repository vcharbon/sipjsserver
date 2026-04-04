/**
 * Shared pure-TypeScript parser interface.
 * All parser implementations conform to this contract.
 * No Effect, no async — designed for benchmarking and swappability.
 */

import type { SipMessage } from "../types.js"

/** Pure synchronous SIP parser function. Throws on parse failure. */
export type SipParseFn = (raw: Buffer) => SipMessage

/** Named parser implementation for benchmark reporting and compliance matrices. */
export interface SipParserImpl {
  readonly name: string
  readonly parse: SipParseFn
}
