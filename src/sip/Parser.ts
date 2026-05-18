/**
 * SipParser Effect service — thin wrapper around a pure SipParserImpl.
 *
 * The actual parsing logic lives in `parsers/` adapters and is exposed as
 * a pure `(Buffer) => Result<SipMessage, SipParseError>` function. This
 * service simply lifts that Result into Effect for use inside `Effect.gen`.
 */

import { Effect, Layer, ServiceMap } from "effect"
import type { SipMessage } from "./types.js"
import { SipParseError } from "./parsers/errors.js"
import type { SipParserImpl, SipParserLimits } from "./parsers/interface.js"
import { customParser, createCustomParser } from "./parsers/custom/index.js"

export { SipParseError } from "./parsers/errors.js"

export class SipParser extends ServiceMap.Service<
  SipParser,
  {
    readonly parse: (raw: Buffer) => Effect.Effect<SipMessage, SipParseError>
  }
>()("@sipjsserver/SipParser") {
  /** Default layer using the custom parser (zero-regex, RFC 3261 compliant). */
  static readonly layer = SipParser.fromImpl(customParser)

  /**
   * Lenient layer that bypasses the ADR-0007 wire-grammar gates. Used by
   * the test harness's rule-self-tests to feed deliberately-mutated raw
   * recordings into the rule engine — the parser must accept the mutated
   * message so the rule under test can observe and report the violation,
   * instead of the parser pre-rejecting it.
   */
  static readonly lenientLayer = SipParser.withLimits({ wireGrammar: false })

  /** Build a layer from any pure parser implementation. */
  static fromImpl(impl: SipParserImpl) {
    return Layer.sync(SipParser, () => ({
      parse: (raw: Buffer) => Effect.fromResult(impl.parse(raw)),
    }))
  }

  /** Build a layer using the custom parser with caller-supplied length caps. */
  static withLimits(limits: Partial<SipParserLimits>) {
    return SipParser.fromImpl(createCustomParser(limits))
  }
}
