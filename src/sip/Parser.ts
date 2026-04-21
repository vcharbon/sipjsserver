/**
 * SipParser Effect service — thin wrapper around a pure SipParserImpl.
 *
 * The actual parsing logic lives in `parsers/` adapters. This module
 * provides the Effect service interface consumed by the rest of the
 * codebase (TransactionLayer, etc.).
 */

import { Effect, Layer, Schema, ServiceMap } from "effect"
import type { SipMessage } from "./types.js"
import type { SipParserImpl } from "./parsers/interface.js"
import { customParser } from "./parsers/custom/index.js"

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class SipParseError extends Schema.TaggedErrorClass<SipParseError>()(
  "SipParseError",
  { reason: Schema.String }
) {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

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
    return Layer.sync(SipParser, () => {
      const parse = Effect.fnUntraced(function* (raw: Buffer) {
        return yield* Effect.try({
          try: () => impl.parse(raw),
          catch: (err) =>
            new SipParseError({ reason: err instanceof Error ? err.message : String(err) })
        })
      })
      return { parse }
    })
  }
}
