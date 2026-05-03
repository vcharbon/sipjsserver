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

/**
 * Route a new INVITE to a downstream peer.
 *
 * The TypeScript type extracted from this schema (`typeof
 * NewCallRouteResponse.Type` — re-exported via `NewCallResponse`) is
 * directly importable from `@vcharbon/sipjs/b2bua`; you do NOT need to
 * mirror the shape with a parallel `interface`.
 *
 * @example
 * ```ts
 * import { Effect, Layer } from "effect"
 * import { CallDecisionEngine } from "@vcharbon/sipjs/b2bua"
 * import type { NewCallRequest, NewCallResponse } from "@vcharbon/sipjs/b2bua"
 *
 * const engine = Layer.succeed(CallDecisionEngine, {
 *   newCall: (_req: NewCallRequest) =>
 *     Effect.succeed({
 *       action: "route",
 *       destination: { host: "10.0.1.5", port: 5060, transport: "udp" },
 *       new_ruri: "sip:bob@10.0.1.5:5060",
 *       update_headers: { "X-Trace-Id": "abc-123" },
 *     } satisfies NewCallResponse),
 *   callFailure: () => Effect.succeed({ action: "terminate" }),
 *   callRefer:   () => Effect.succeed({ action: "reject", reject_code: 403 }),
 * })
 * ```
 *
 * @see [docs/external-usage/decision-engine-contract.md](../../../docs/external-usage/decision-engine-contract.md)
 *      for the literals-only contract on `update_headers` / `new_ruri`.
 */
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

/**
 * Reject the INVITE with a SIP failure response.
 *
 * @example
 * ```ts
 * // 403 with a vendor-supplied Reason header (RFC 3326).
 * Effect.succeed({
 *   action: "reject",
 *   reject_code: 403,
 *   reject_reason: "Carrier blocked",
 *   update_headers: {
 *     Reason: 'SIP ;cause=403;text="Carrier blocked"',
 *     "X-Trace-Id": "abc-123",
 *   },
 * } satisfies NewCallResponse)
 * ```
 *
 * @example
 * ```ts
 * // 302 redirect — Contact is required by RFC 3261 §21.3 and is the
 * // ONLY case where update_headers["Contact"] is permitted.
 * Effect.succeed({
 *   action: "reject",
 *   reject_code: 302,
 *   reject_reason: "Moved Temporarily",
 *   update_headers: { Contact: "<sip:alt@10.0.0.42:5060>" },
 * } satisfies NewCallResponse)
 * ```
 */
export const NewCallRejectResponse = Schema.Struct({
  action: Schema.Literal("reject"),
  reject_code: Schema.Int,
  reject_reason: Schema.optional(Schema.String),
  /**
   * Extra headers to include on the rejection response we emit toward the
   * A-leg peer. Purely additive — no called-side response exists to merge
   * with. Common uses:
   *
   *   - `Reason: SIP ;cause=403;text="…"` (RFC 3326)
   *   - `Retry-After: 60` (RFC 3261 §20.33, on 503/486/600)
   *   - `Contact: <sip:…>` (REQUIRED on 3xx redirects, per RFC 3261 §21.3)
   *   - `Warning: 399 example.com "…"`
   *   - `P-Asserted-Identity: …` (RFC 3325)
   *   - any `X-…` proprietary header
   *
   * Forbidden (rejected at the validator with a 500): `Via`, `To`, `From`,
   * `Call-ID`, `CSeq` — the B2BUA copies these from the request per
   * RFC 3261 §8.2.6.2 and the consumer must not rewrite them.
   *
   * `null`-valued entries are no-ops on reject (nothing to delete).
   */
  update_headers: Schema.optional(SipHeaderUpdates),
})

export const NewCallResponse = Schema.Union([NewCallRouteResponse, NewCallRejectResponse])

// ── /call/failure ─────────────────────────────────────────────────────────────

/**
 * Failover the call to a different downstream peer after the first
 * B-leg attempt failed.
 *
 * @example
 * ```ts
 * import type { CallFailureRequest, CallFailureResponse } from "@vcharbon/sipjs/b2bua"
 *
 * const callFailure = (_req: CallFailureRequest) =>
 *   Effect.succeed({
 *     action: "failover",
 *     destination: { host: "10.0.1.6", port: 5060, transport: "udp" },
 *     new_ruri: "sip:bob@10.0.1.6:5060",
 *   } satisfies CallFailureResponse)
 * ```
 */
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

/**
 * Terminate the call with no further routing attempts.
 *
 * @example
 * ```ts
 * Effect.succeed({ action: "terminate" } satisfies CallFailureResponse)
 * ```
 */
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
 *
 * @example
 * ```ts
 * import type { CallReferRequest, CallReferResponse } from "@vcharbon/sipjs/b2bua"
 *
 * const callRefer = (_req: CallReferRequest) =>
 *   Effect.succeed({
 *     action: "allow",
 *     destination: { host: "10.0.1.7", port: 5060, transport: "udp" },
 *     new_refer_to: "sip:charlie@10.0.1.7:5060",
 *   } satisfies CallReferResponse)
 * ```
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

/**
 * Reject the transfer attempt.
 *
 * **Important:** the REFER itself is always 200-OK'd at the SIP layer;
 * `reject_code` / `reject_reason` populate the **status line of the
 * NOTIFY sipfrag body**, NOT a 4xx response on the REFER. See
 * [docs/external-usage/refer-and-sipfrag.md](../../../docs/external-usage/refer-and-sipfrag.md)
 * for the rationale.
 *
 * @example
 * ```ts
 * Effect.succeed({
 *   action: "reject",
 *   reject_code: 403,
 *   reject_reason: "Carrier blocked transfers",
 * } satisfies CallReferResponse)
 * ```
 */
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
