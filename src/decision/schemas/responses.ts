/**
 * Canonical response payloads returned by a CallDecisionEngine adapter.
 *
 * v1 scope: the wire-facing fields still mirror today's HTTP shape (the
 * HTTP Reference Adapter decodes a vendor-flat payload verbatim). The
 * canonical response adds one structured field on top — `features:
 * FeatureActivations` — that the adapter synthesizes from the vendor's
 * flat flags. Core SIP code consumes `features` through
 * `Call.features`; it never pokes at the flat flags.
 *
 * Slice C will reshape the remaining flat fields (`update_body`,
 * `update_headers`, `new_ruri`, etc.) into richer canonical structures
 * (`BodyIntent`, partitioned header maps). In v1 they stay flat so
 * downstream consumers (`applyRoute`, `FailureRules`, `TransferRules`)
 * don't need to re-learn their inputs on day one.
 */

import { Schema } from "effect"
import { CallLimiterEntry, SipDestination, SipHeaderUpdates } from "./common.js"
import { FeatureActivations } from "./features.js"

// ── /call/new ─────────────────────────────────────────────────────────────────

export const NewCallRouteResponse = Schema.Struct({
  action: Schema.Literal("route"),
  destination: SipDestination,
  new_ruri: Schema.optional(Schema.String),
  update_headers: Schema.optional(SipHeaderUpdates),
  update_body: Schema.optional(Schema.NullOr(Schema.String)),
  no_answer_timeout_sec: Schema.optional(Schema.Int),
  call_limiter: Schema.optional(Schema.Array(CallLimiterEntry)),
  callback_context: Schema.optional(Schema.String),
  /** When true, transform first 18x to bare 180, suppress subsequent, force tag consistency. */
  relay_first_18x_to_180: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      Schema.Literals(["drop-sdp", "keep-sdp", "fake-prack"]),
    ]),
  ),
  /** Canonical feature activations. Adapter-synthesized; always present on success. */
  features: Schema.optional(FeatureActivations),
})

export const NewCallRejectResponse = Schema.Struct({
  action: Schema.Literal("reject"),
  reject_code: Schema.Int,
  reject_reason: Schema.optional(Schema.String),
})

export const NewCallResponse = Schema.Union([NewCallRouteResponse, NewCallRejectResponse])

// ── /call/failure ─────────────────────────────────────────────────────────────

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
  relay_first_18x_to_180: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      Schema.Literals(["drop-sdp", "keep-sdp", "fake-prack"]),
    ]),
  ),
  /** Canonical feature activations active on the new (failover) leg. */
  features: Schema.optional(FeatureActivations),
})

export const CallFailureTerminateResponse = Schema.Struct({
  action: Schema.Literal("terminate"),
})

export const CallFailureResponse = Schema.Union([
  CallFailureFailoverResponse,
  CallFailureTerminateResponse,
])

// ── /call/refer ───────────────────────────────────────────────────────────────

/**
 * Allow response — superset of NewCallRouteResponse. The C-leg reuses the
 * same routing/policy levers as a fresh inbound call. `new_refer_to` overrides
 * the original Refer-To URI when set.
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
  relay_first_18x_to_180: Schema.optional(
    Schema.Union([
      Schema.Boolean,
      Schema.Literals(["drop-sdp", "keep-sdp", "fake-prack"]),
    ]),
  ),
  /** Canonical feature activations active on the C-leg. */
  features: Schema.optional(FeatureActivations),
})

export const CallReferRejectResponse = Schema.Struct({
  action: Schema.Literal("reject"),
  reject_code: Schema.optional(Schema.Int),
  reject_reason: Schema.optional(Schema.String),
})

export const CallReferResponse = Schema.Union([CallReferAllowResponse, CallReferRejectResponse])

// ── Inferred TypeScript types ─────────────────────────────────────────────────

export type NewCallResponse = typeof NewCallResponse.Type
export type CallFailureResponse = typeof CallFailureResponse.Type
export type CallReferResponse = typeof CallReferResponse.Type
