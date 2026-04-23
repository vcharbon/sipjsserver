/**
 * Canonical request payloads sent to a CallDecisionEngine adapter.
 *
 * v1 scope: same shape as today's HTTP payloads — richer structured shapes
 * (D10 in SplitServiceLogic.md) arrive in Slice B.
 */

import { Schema } from "effect"
import { SipHeaderUpdates } from "./common.js"

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
  sip_body: Schema.optional(Schema.String),
})

// ── /call/failure ─────────────────────────────────────────────────────────────

export const FailureDetail = Schema.Union([
  Schema.Struct({
    origin: Schema.Literal("external"),
    sip_code: Schema.optional(Schema.Int),
    sip_reason: Schema.optional(Schema.String),
    sip_response_headers: Schema.optional(SipHeaderUpdates),
  }),
  Schema.Struct({
    origin: Schema.Literal("no_answer_timeout"),
  }),
  Schema.Struct({
    origin: Schema.Literal("call_limiter"),
    limiter_id: Schema.optional(Schema.String),
  }),
])

export const CallFailureRequest = Schema.Struct({
  call_id: Schema.String,
  callback_context: Schema.optional(Schema.String),
  failure: FailureDetail,
})

// ── /call/refer ───────────────────────────────────────────────────────────────

/**
 * REFER authorisation request.
 *
 * `call_id` is the A-leg Call-ID; `dialog_id` is the B-leg dialog id
 * (Call-ID;to-tag=...;from-tag=...) that carried the REFER.
 */
export const CallReferRequest = Schema.Struct({
  call_id: Schema.String,
  dialog_id: Schema.String,
  callback_context: Schema.optional(Schema.String),
  refer_to: Schema.String,
  referred_by: Schema.optional(Schema.String),
  sip_headers: Schema.optional(SipHeaderUpdates),
})

// ── Inferred TypeScript types ─────────────────────────────────────────────────

export type NewCallRequest = typeof NewCallRequest.Type
export type CallFailureRequest = typeof CallFailureRequest.Type
export type CallReferRequest = typeof CallReferRequest.Type
