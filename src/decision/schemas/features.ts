/**
 * Canonical FeatureActivations — the closed TypeScript union described by
 * SplitServiceLogic.md §D5.
 *
 * Shape:
 *   platform (MANDATORY)       maxDurationSec + keepalive
 *   features  (optional set)   refer / relayFirst18xTo180 / noAnswerTimeoutSec
 *                              / callLimiters
 *
 * Rules:
 *   - Vendor adapters cannot invent new feature entries — anything outside
 *     this union is a schema violation.
 *   - Absence means "explicitly disabled," not "default enabled." The
 *     caller-facing PolicyModule guard keys on `features.X !== undefined`.
 *   - `/call/failure` and `/call/refer` responses may override the whole
 *     feature set on the new leg — no merge.
 *
 * This file is the canonical source of truth. The wire schemas in
 * `src/decision/schemas/responses.ts` are still the v1 flat-field vendor
 * shape; B.7 migrates the HTTP Reference Adapter to emit canonical features
 * via this schema so core SIP code only ever sees `Call.features`.
 */

import { Schema } from "effect"

// ── Platform-mandatory cap/keepalive ──────────────────────────────────────

export const KeepaliveActivation = Schema.Struct({
  /** Seconds between OPTIONS pokes (or whatever keepalive mechanism is used). */
  intervalSec: Schema.Int,
  /** Tear down the leg after this many unanswered keepalives. */
  maxMissed: Schema.Int,
})
export type KeepaliveActivation = typeof KeepaliveActivation.Type

export const PlatformActivations = Schema.Struct({
  /**
   * Overall call ceiling (seconds). Adapter supplies; platform enforces an
   * upper cap of `appConfig.callMaxDurationSec` if the adapter exceeds it.
   */
  maxDurationSec: Schema.Int,
  keepalive: KeepaliveActivation,
})
export type PlatformActivations = typeof PlatformActivations.Type

// ── Optional feature arms ─────────────────────────────────────────────────

export const ReferFeature = Schema.Struct({
  /** Caps REFER chain depth across attended transfers. Undefined → unlimited. */
  maxChainDepth: Schema.optional(Schema.Int),
})
export type ReferFeature = typeof ReferFeature.Type

export const RelayFirst18xTo180Feature = Schema.Struct({
  /**
   * `drop-sdp` (default) — first 18x becomes a bare 180 with no SDP.
   * `keep-sdp` — preserve the SDP body while still masking tags/forks.
   * `fake-prack` — same Alice-facing shape as `drop-sdp`, plus the B2BUA
   *   originates PRACK locally toward Bob on every reliable 18x, caches
   *   Bob's SDP per b-leg dialog, locally answers any UPDATE Bob sends,
   *   and substitutes the cached SDP into the 200 OK relayed to Alice.
   * `promote-pem-to-200` — the first 183 carrying SDP and a P-Early-Media
   *   header is promoted into a synthetic 200 OK toward Alice. Used so that
   *   constrained UACs (which only emit DTMF after their INVITE is
   *   confirmed) can interact with Bob's already-running early-media leg.
   *   When Bob finally answers, SDP is diff'd against what Alice received;
   *   on mismatch a B2BUA-originated re-INVITE realigns Alice. Mutually
   *   exclusive with the other strategies (single Schema variant).
   */
  strategy: Schema.Literals(["drop-sdp", "keep-sdp", "fake-prack", "promote-pem-to-200"]),
})
export type RelayFirst18xTo180Feature = typeof RelayFirst18xTo180Feature.Type

export const CallLimiterFeatureEntry = Schema.Struct({
  id: Schema.String,
  limit: Schema.Int,
})
export type CallLimiterFeatureEntry = typeof CallLimiterFeatureEntry.Type

// ── FeatureActivations union ──────────────────────────────────────────────

export const FeatureActivations = Schema.Struct({
  platform: PlatformActivations,
  refer: Schema.optional(ReferFeature),
  relayFirst18xTo180: Schema.optional(RelayFirst18xTo180Feature),
  noAnswerTimeoutSec: Schema.optional(Schema.Int),
  callLimiters: Schema.optional(Schema.Array(CallLimiterFeatureEntry)),
})
export type FeatureActivations = typeof FeatureActivations.Type
