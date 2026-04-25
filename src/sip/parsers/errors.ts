/**
 * Pure-side parser error type. Lives outside Parser.ts so that pure parser
 * implementations (custom, jssip-adapter, sip-parser-adapter) can construct
 * it without depending on the Effect service definition.
 */

import { Schema } from "effect"

export class SipParseError extends Schema.TaggedErrorClass<SipParseError>()(
  "SipParseError",
  { reason: Schema.String }
) {}
