/**
 * Effect Schema definitions for the SIP Call Control API.
 *
 * Matches the OpenAPI spec in docs/sip-call-control.yaml.
 */

import { Schema } from "effect"

// ── Shared types ─────────────────────────────────────────────────────────────

export const SipDestination = Schema.Struct({
  host: Schema.String,
  port: Schema.optional(Schema.Int),
  transport: Schema.optional(Schema.Literals(["udp", "tcp", "tls", "ws", "wss"]))
})

export const CallLimiterEntry = Schema.Struct({
  id: Schema.String,
  limit: Schema.Int
})

/**
 * Header name → value map. null value means "remove this header".
 */
export const SipHeaderUpdates = Schema.Record(Schema.String, Schema.NullOr(Schema.String))

export const DialogSubscription = Schema.Struct({
  method: Schema.String,
  content_type: Schema.optional(Schema.String)
})

// ── /call/new ─────────────────────────────────────────────────────────────────

export const NewCallRequest = Schema.Struct({
  call_id: Schema.String,
  ruri: Schema.String,
  from: Schema.String,
  to: Schema.String,
  via: Schema.Array(Schema.String),
  contact: Schema.optional(Schema.String),
  content_type: Schema.optional(Schema.String),
  sip_headers: Schema.optional(SipHeaderUpdates),
  sip_body: Schema.optional(Schema.String)
})

export const NewCallRouteResponse = Schema.Struct({
  action: Schema.Literal("route"),
  destination: SipDestination,
  new_ruri: Schema.optional(Schema.String),
  update_headers: Schema.optional(SipHeaderUpdates),
  update_body: Schema.optional(Schema.NullOr(Schema.String)),
  no_answer_timeout_sec: Schema.optional(Schema.Int),
  call_limiter: Schema.optional(Schema.Array(CallLimiterEntry)),
  callback_context: Schema.optional(Schema.String),
  subscribe_to: Schema.optional(Schema.Array(DialogSubscription)),
  /** When true, transform first 18x to bare 180, suppress subsequent, force tag consistency. */
  relay_first_18x_to_180: Schema.optional(Schema.Boolean),
})

export const NewCallRejectResponse = Schema.Struct({
  action: Schema.Literal("reject"),
  reject_code: Schema.Int,
  reject_reason: Schema.optional(Schema.String)
})

export const NewCallResponse = Schema.Union([NewCallRouteResponse, NewCallRejectResponse])

// ── /call/failure ─────────────────────────────────────────────────────────────

export const FailureDetail = Schema.Union([
  Schema.Struct({
    origin: Schema.Literal("external"),
    sip_code: Schema.optional(Schema.Int),
    sip_reason: Schema.optional(Schema.String),
    sip_response_headers: Schema.optional(SipHeaderUpdates)
  }),
  Schema.Struct({
    origin: Schema.Literal("no_answer_timeout")
  }),
  Schema.Struct({
    origin: Schema.Literal("call_limiter"),
    limiter_id: Schema.optional(Schema.String)
  })
])

export const CallFailureRequest = Schema.Struct({
  call_id: Schema.String,
  callback_context: Schema.optional(Schema.String),
  failure: FailureDetail
})

export const CallFailureFailoverResponse = Schema.Struct({
  action: Schema.Literal("failover"),
  destination: SipDestination,
  new_ruri: Schema.optional(Schema.String),
  update_headers: Schema.optional(SipHeaderUpdates),
  update_body: Schema.optional(Schema.NullOr(Schema.String)),
  no_answer_timeout_sec: Schema.optional(Schema.Int),
  call_limiter: Schema.optional(Schema.Array(CallLimiterEntry)),
  callback_context: Schema.optional(Schema.String),
  /** Propagate relay_first_18x_to_180 policy to failover b-legs. */
  relay_first_18x_to_180: Schema.optional(Schema.Boolean),
})

export const CallFailureTerminateResponse = Schema.Struct({
  action: Schema.Literal("terminate")
})

export const CallFailureResponse = Schema.Union([
  CallFailureFailoverResponse,
  CallFailureTerminateResponse
])

// ── /call/refer ───────────────────────────────────────────────────────────────

/**
 * POST /call/refer — REFER authorisation request.
 *
 * `call_id` is the **A-leg Call-ID** (the call the REFER targets, identified
 * from the B2BUA's bridge perspective). The B-leg Call-ID is derived from the
 * dialog on which the REFER arrived. `dialog_id` uniquely identifies that
 * dialog (Call-ID;to-tag=...;from-tag=...).
 */
export const CallReferRequest = Schema.Struct({
  call_id: Schema.String,
  dialog_id: Schema.String,
  callback_context: Schema.optional(Schema.String),
  refer_to: Schema.String,
  referred_by: Schema.optional(Schema.String),
  sip_headers: Schema.optional(SipHeaderUpdates)
})

/**
 * Allow response — superset of NewCallRouteResponse. The C leg is placed
 * reusing the same routing/policy levers as a fresh inbound call.
 *
 * `new_refer_to` overrides the original Refer-To URI when set; the resulting
 * URI is what the B2BUA dials.
 */
export const CallReferAllowResponse = Schema.Struct({
  action: Schema.Literal("allow"),
  destination: SipDestination,
  new_refer_to: Schema.optional(Schema.String),
  update_headers: Schema.optional(SipHeaderUpdates),
  no_answer_timeout_sec: Schema.optional(Schema.Int),
  call_limiter: Schema.optional(Schema.Array(CallLimiterEntry)),
  callback_context: Schema.optional(Schema.String),
  /** When true, transform first 18x to bare 180, suppress subsequent, force tag consistency. */
  relay_first_18x_to_180: Schema.optional(Schema.Boolean),
})

export const CallReferRejectResponse = Schema.Struct({
  action: Schema.Literal("reject"),
  reject_code: Schema.optional(Schema.Int),
  reject_reason: Schema.optional(Schema.String)
})

export const CallReferResponse = Schema.Union([CallReferAllowResponse, CallReferRejectResponse])

// ── Inferred TypeScript types ─────────────────────────────────────────────────

export type NewCallRequest = typeof NewCallRequest.Type
export type NewCallResponse = typeof NewCallResponse.Type
export type CallFailureRequest = typeof CallFailureRequest.Type
export type CallFailureResponse = typeof CallFailureResponse.Type
export type CallReferRequest = typeof CallReferRequest.Type
export type CallReferResponse = typeof CallReferResponse.Type
