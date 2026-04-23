/**
 * Canonical `BodyIntent` union (SplitServiceLogic.md §D4).
 *
 *   inherit    — passthrough incoming body + Content-Type (default)
 *   drop       — emit no body (Content-Length: 0)
 *   sdp        — replace with raw SDP; Content-Type locked to application/sdp
 *   multipart  — stack assembles boundary, Content-Length; adapter declares parts
 *   raw        — binary-safe escape hatch (metrics-tracked)
 *
 * The stack assembles multipart — the adapter cannot produce a malformed
 * envelope. `Content-Type` never appears in the header delta map (it lives
 * in the structured slot instead).
 *
 * cid validation: before wire serialisation, the stack scans headers for
 * `cid:<id>` URIs; every such id must match a part's `contentId`. Any
 * mismatch becomes a `CallDecisionError(kind: "semantic-violation")`. This
 * protects Geolocation ↔ PIDF-LO linkage.
 */

import { Schema } from "effect"

// ── Part bodies ───────────────────────────────────────────────────────────

export const PartBodyBytes = Schema.Struct({
  kind: Schema.Literal("bytes"),
  value: Schema.Uint8ArrayFromBase64,
})
export type PartBodyBytes = typeof PartBodyBytes.Type

export const PartBodyIncomingSdp = Schema.Struct({
  kind: Schema.Literal("incoming-sdp"),
})
export type PartBodyIncomingSdp = typeof PartBodyIncomingSdp.Type

export const PartBodyIncomingBody = Schema.Struct({
  kind: Schema.Literal("incoming-body"),
})
export type PartBodyIncomingBody = typeof PartBodyIncomingBody.Type

export const PartBody = Schema.Union([
  PartBodyBytes,
  PartBodyIncomingSdp,
  PartBodyIncomingBody,
])
export type PartBody = typeof PartBody.Type

// ── Single multipart part ─────────────────────────────────────────────────

export const BodyPart = Schema.Struct({
  contentType: Schema.String,
  /** cid-addressable id (see Geolocation / CID pointers in RFC 6442). */
  contentId: Schema.optional(Schema.String),
  contentDisposition: Schema.optional(Schema.String),
  body: PartBody,
})
export type BodyPart = typeof BodyPart.Type

// ── BodyIntent union ──────────────────────────────────────────────────────

export const BodyIntentInherit = Schema.Struct({ kind: Schema.Literal("inherit") })
export const BodyIntentDrop = Schema.Struct({ kind: Schema.Literal("drop") })

export const BodyIntentSdp = Schema.Struct({
  kind: Schema.Literal("sdp"),
  sdp: Schema.Uint8ArrayFromBase64,
})
export type BodyIntentSdp = typeof BodyIntentSdp.Type

export const BodyIntentMultipart = Schema.Struct({
  kind: Schema.Literal("multipart"),
  subtype: Schema.Literals(["mixed", "alternative"]),
  parts: Schema.Array(BodyPart),
})
export type BodyIntentMultipart = typeof BodyIntentMultipart.Type

export const BodyIntentRaw = Schema.Struct({
  kind: Schema.Literal("raw"),
  bytes: Schema.Uint8ArrayFromBase64,
  contentType: Schema.String,
})
export type BodyIntentRaw = typeof BodyIntentRaw.Type

export const BodyIntent = Schema.Union([
  BodyIntentInherit,
  BodyIntentDrop,
  BodyIntentSdp,
  BodyIntentMultipart,
  BodyIntentRaw,
])
export type BodyIntent = typeof BodyIntent.Type
