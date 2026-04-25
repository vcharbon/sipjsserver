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
import type { SipParserImpl } from "./parsers/interface.js"
import { customParser } from "./parsers/custom/index.js"

export { SipParseError } from "./parsers/errors.js"

export class SipParser extends ServiceMap.Service<
  SipParser,
  {
    readonly parse: (raw: Buffer) => Effect.Effect<SipMessage, SipParseError>
  }
>()("@sipjsserver/SipParser") {
  /** Default layer using the custom parser (zero-regex, RFC 3261 compliant). */
  static readonly layer = SipParser.fromImpl(customParser)

  /** Build a layer from any pure parser implementation. */
  static fromImpl(impl: SipParserImpl) {
    return Layer.sync(SipParser, () => ({
      parse: (raw: Buffer) => Effect.fromResult(impl.parse(raw)),
    }))
  }
}
