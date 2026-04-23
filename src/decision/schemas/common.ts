/**
 * Canonical shared schemas used by CallDecisionEngine requests and responses.
 *
 * v1 scope: these are 1:1 with today's CallControlSchemas shapes. Vendor
 * adapters translate canonical ↔ vendor JSON; core SIP code only ever sees
 * these canonical types.
 */

import { Schema } from "effect"

export const SipDestination = Schema.Struct({
  host: Schema.String,
  port: Schema.optional(Schema.Int),
  transport: Schema.optional(Schema.Literals(["udp", "tcp", "tls", "ws", "wss"])),
})

export const CallLimiterEntry = Schema.Struct({
  id: Schema.String,
  limit: Schema.Int,
})

/** Header name → value map. null value means "remove this header". */
export const SipHeaderUpdates = Schema.Record(Schema.String, Schema.NullOr(Schema.String))

export const DialogSubscription = Schema.Struct({
  method: Schema.String,
  content_type: Schema.optional(Schema.String),
})
