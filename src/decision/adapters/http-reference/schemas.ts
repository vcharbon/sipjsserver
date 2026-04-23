/**
 * Wire schemas for the HTTP Reference Adapter.
 *
 * These describe the JSON exchanged with the vendor-specific HTTP backend.
 * They are deliberately **decoupled** from the canonical
 * `src/decision/schemas/*` module so a future vendor adapter (Slice C) can
 * speak a different wire shape while still producing the same canonical
 * `NewCallResponse` / `CallFailureResponse` / `CallReferResponse` that core
 * SIP code consumes.
 *
 * In v1 the wire shape is (by design) 1:1 with today's HTTP contract. The
 * translation layer in `translate.ts` is a thin "flat vendor JSON → rich
 * canonical" mapping that enriches the response with `FeatureActivations`.
 *
 * No consumer outside this folder should import from here.
 */

import { Schema } from "effect"
import {
  CallLimiterEntry,
  SipDestination,
  SipHeaderUpdates,
} from "../../schemas/common.js"

// Re-export request schemas — in v1 the vendor speaks the canonical request
// shape verbatim. (If that changes, add wire request schemas here and a
// canonical → wire encoder in translate.ts.)
export {
  NewCallRequest,
  CallFailureRequest,
  CallReferRequest,
} from "../../schemas/requests.js"
export type {
  NewCallRequest as NewCallRequestType,
  CallFailureRequest as CallFailureRequestType,
  CallReferRequest as CallReferRequestType,
} from "../../schemas/requests.js"

// ── Wire response schemas (vendor flat JSON) ──────────────────────────────
//
// Structural parity with `src/decision/schemas/responses.ts` is intentional
// for v1. The fields below are the vendor contract; richer canonical fields
// (`features`, structured `BodyIntent`) are synthesized in translate.ts.

export const WireNewCallRouteResponse = Schema.Struct({
  action: Schema.Literal("route"),
  destination: SipDestination,
  new_ruri: Schema.optional(Schema.String),
  update_headers: Schema.optional(SipHeaderUpdates),
  update_body: Schema.optional(Schema.NullOr(Schema.String)),
  no_answer_timeout_sec: Schema.optional(Schema.Int),
  call_limiter: Schema.optional(Schema.Array(CallLimiterEntry)),
  callback_context: Schema.optional(Schema.String),
  relay_first_18x_to_180: Schema.optional(Schema.Boolean),
})
export type WireNewCallRouteResponse = typeof WireNewCallRouteResponse.Type

export const WireNewCallRejectResponse = Schema.Struct({
  action: Schema.Literal("reject"),
  reject_code: Schema.Int,
  reject_reason: Schema.optional(Schema.String),
})
export type WireNewCallRejectResponse = typeof WireNewCallRejectResponse.Type

export const WireNewCallResponse = Schema.Union([
  WireNewCallRouteResponse,
  WireNewCallRejectResponse,
])
export type WireNewCallResponse = typeof WireNewCallResponse.Type

export const WireCallFailureFailoverResponse = Schema.Struct({
  action: Schema.Literal("failover"),
  destination: SipDestination,
  new_ruri: Schema.optional(Schema.String),
  update_headers: Schema.optional(SipHeaderUpdates),
  update_body: Schema.optional(Schema.NullOr(Schema.String)),
  no_answer_timeout_sec: Schema.optional(Schema.Int),
  call_limiter: Schema.optional(Schema.Array(CallLimiterEntry)),
  callback_context: Schema.optional(Schema.String),
  relay_first_18x_to_180: Schema.optional(Schema.Boolean),
})
export type WireCallFailureFailoverResponse = typeof WireCallFailureFailoverResponse.Type

export const WireCallFailureTerminateResponse = Schema.Struct({
  action: Schema.Literal("terminate"),
})
export type WireCallFailureTerminateResponse = typeof WireCallFailureTerminateResponse.Type

export const WireCallFailureResponse = Schema.Union([
  WireCallFailureFailoverResponse,
  WireCallFailureTerminateResponse,
])
export type WireCallFailureResponse = typeof WireCallFailureResponse.Type

export const WireCallReferAllowResponse = Schema.Struct({
  action: Schema.Literal("allow"),
  destination: SipDestination,
  new_refer_to: Schema.optional(Schema.String),
  update_headers: Schema.optional(SipHeaderUpdates),
  no_answer_timeout_sec: Schema.optional(Schema.Int),
  call_limiter: Schema.optional(Schema.Array(CallLimiterEntry)),
  callback_context: Schema.optional(Schema.String),
  relay_first_18x_to_180: Schema.optional(Schema.Boolean),
})
export type WireCallReferAllowResponse = typeof WireCallReferAllowResponse.Type

export const WireCallReferRejectResponse = Schema.Struct({
  action: Schema.Literal("reject"),
  reject_code: Schema.optional(Schema.Int),
  reject_reason: Schema.optional(Schema.String),
})
export type WireCallReferRejectResponse = typeof WireCallReferRejectResponse.Type

export const WireCallReferResponse = Schema.Union([
  WireCallReferAllowResponse,
  WireCallReferRejectResponse,
])
export type WireCallReferResponse = typeof WireCallReferResponse.Type

// Canonical response types — re-exported for adapter convenience.
export type {
  NewCallResponse as NewCallResponseType,
  CallFailureResponse as CallFailureResponseType,
  CallReferResponse as CallReferResponseType,
} from "../../schemas/responses.js"
