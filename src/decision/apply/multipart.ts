/**
 * Pure multipart assembly for `BodyIntent.kind === "multipart"`
 * (SplitServiceLogic.md §D4).
 *
 * The stack — not the adapter — owns multipart envelope formatting so that
 * a vendor adapter cannot produce malformed MIME (missing boundary, wrong
 * CRLFs, unbalanced close delimiter). The adapter only declares the parts;
 * this module produces the serialized bytes + the outbound Content-Type.
 *
 * RFC 2046 §5.1 format:
 *   CRLF "--" boundary CRLF
 *     part-headers CRLF
 *     CRLF
 *     part-bytes CRLF
 *   "--" boundary "--" CRLF
 *
 * Boundary generation:
 *   - Randomised per message, 24 hex chars, prefixed "b2bua-" for traceability.
 *   - Collision check against every part body ensures the boundary token
 *     never appears verbatim inside a part — if it does (astronomically
 *     unlikely), we regenerate up to 3 times before failing loudly.
 *
 * Binary safety: all byte operations go through `Uint8Array` / `Buffer`.
 * We never round-trip parts through `utf-8` text, so PIDF-LO, raw PCMU
 * waveforms, image/*, etc. pass through verbatim.
 */

import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import type { BodyPart, BodyIntentMultipart } from "../schemas/body.js"

const CRLF = "\r\n"
const CRLF_BYTES = Buffer.from(CRLF, "ascii")

export interface IncomingBodyContext {
  /** Raw incoming INVITE body (for `incoming-sdp` / `incoming-body` part backings). */
  readonly rawBody: Uint8Array
  /** SDP segment of the incoming body, or the entire body if no multipart envelope. */
  readonly sdp?: Uint8Array
}

export interface AssembledMultipart {
  /** The full MIME body, ready to become the outbound Content-Length payload. */
  readonly bytes: Uint8Array
  /** Outbound `Content-Type` header value including the boundary parameter. */
  readonly contentType: string
  /** Boundary string actually used (without the leading `--`). */
  readonly boundary: string
}

export class MultipartAssemblyError extends Schema.TaggedErrorClass<MultipartAssemblyError>()(
  "MultipartAssemblyError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `multipart assembly failed: ${this.reason}`
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export function assembleMultipart(
  intent: BodyIntentMultipart,
  ctx: IncomingBodyContext,
): AssembledMultipart {
  if (intent.parts.length === 0) {
    throw new MultipartAssemblyError({ reason: "multipart must contain at least one part" })
  }

  const materialized = intent.parts.map((p) => materializePart(p, ctx))

  const boundary = generateBoundary(materialized.map((p) => p.bytes))
  const boundaryOpen = Buffer.from(`--${boundary}${CRLF}`, "ascii")
  const boundaryClose = Buffer.from(`--${boundary}--${CRLF}`, "ascii")

  const chunks: Buffer[] = []
  for (const part of materialized) {
    chunks.push(boundaryOpen)
    chunks.push(Buffer.from(serializeHeaders(part.headers), "ascii"))
    chunks.push(CRLF_BYTES)
    chunks.push(Buffer.from(part.bytes))
    chunks.push(CRLF_BYTES)
  }
  chunks.push(boundaryClose)

  return {
    bytes: new Uint8Array(Buffer.concat(chunks)),
    contentType: `multipart/${intent.subtype}; boundary="${boundary}"`,
    boundary,
  }
}

// ── Boundary generation with collision guard ──────────────────────────────

function generateBoundary(partBytes: ReadonlyArray<Uint8Array>): string {
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = `b2bua-${randomBytes(12).toString("hex")}`
    const probe = Buffer.from(candidate, "ascii")
    const collides = partBytes.some((b) => indexOfBuffer(b, probe) >= 0)
    if (!collides) return candidate
  }
  throw new MultipartAssemblyError({
    reason: "failed to generate collision-free multipart boundary after 3 attempts",
  })
}

function indexOfBuffer(hay: Uint8Array, needle: Uint8Array): number {
  return Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).indexOf(needle)
}

// ── Part materialisation ──────────────────────────────────────────────────

interface MaterializedPart {
  readonly bytes: Uint8Array
  readonly headers: ReadonlyArray<readonly [string, string]>
}

function materializePart(part: BodyPart, ctx: IncomingBodyContext): MaterializedPart {
  const body = materializePartBody(part, ctx)
  const headers: Array<readonly [string, string]> = [
    ["Content-Type", part.contentType],
  ]
  if (part.contentId !== undefined) {
    // Content-ID values are wrapped in angle brackets per RFC 2045 §7.
    const cid = part.contentId.trim()
    if (cid.length === 0) {
      throw new MultipartAssemblyError({ reason: "part contentId must be non-empty" })
    }
    headers.push(["Content-ID", wrapContentId(cid)])
  }
  if (part.contentDisposition !== undefined) {
    headers.push(["Content-Disposition", part.contentDisposition])
  }
  return { bytes: body, headers }
}

function materializePartBody(part: BodyPart, ctx: IncomingBodyContext): Uint8Array {
  switch (part.body.kind) {
    case "bytes":
      return part.body.value
    case "incoming-sdp":
      if (ctx.sdp === undefined) {
        throw new MultipartAssemblyError({
          reason: "part references incoming-sdp but no SDP segment available in incoming body",
        })
      }
      return ctx.sdp
    case "incoming-body":
      return ctx.rawBody
  }
}

function wrapContentId(id: string): string {
  if (id.startsWith("<") && id.endsWith(">")) return id
  return `<${id}>`
}

function serializeHeaders(headers: ReadonlyArray<readonly [string, string]>): string {
  return headers.map(([k, v]) => `${k}: ${v}${CRLF}`).join("")
}
