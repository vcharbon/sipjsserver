/**
 * CallCodec — thin compatibility shim over `src/call/codec/` for
 * pre-ADR-0011 consumers. The active codec is selected at boot by
 * `selectCallBodyCodecLayer` (reads `B2BUA_CODEC`); this module
 * mirrors that selection synchronously and exposes the same
 * encode/decode pair as plain functions.
 *
 * Post-ADR-0011:
 *   - No stamp prefix on body bytes. Bodies in Redis are bare codec
 *     output, byte-for-byte. The `writtenAtMs` field is dropped (the
 *     `latency_ms` metric was the only reader, and the puller can
 *     reconstruct that from received-time deltas if needed).
 *   - No legacy JSON first-byte dispatch. Codec swaps are
 *     fresh-cluster events (drain + FLUSHDB + redeploy), so the
 *     decoder never has to handle two formats at once.
 *
 * New code should consume the `CallBodyCodec` service directly from
 * `src/call/codec/`. This shim exists so the cross-cutting consumer
 * migration can land incrementally.
 */

import { Effect, Schema } from "effect"
import { Call as CallSchema } from "./CallModel.js"
import type { Call } from "./CallModel.js"
import { makeMsgpackUnsafe } from "./codec/msgpack.js"

export type { CodecMode } from "./codec/CallBodyCodec.js"
export { CODEC_MODE } from "./codec/CallBodyCodec.js"

import { CODEC_MODE } from "./codec/CallBodyCodec.js"

const codec = makeMsgpackUnsafe(CODEC_MODE === "MSGPACK_RECORDS")

/** Pack a Call (or any JS value) into msgpack bytes. */
export const mpPack = (value: unknown): Buffer => codec.encode(value as Call)

/** Unpack msgpack bytes into a JS value. */
export const mpUnpack = (buf: Uint8Array): unknown =>
  codec.decode(Buffer.isBuffer(buf) ? buf : Buffer.from(buf))

/** Encode a Call for storage — bare codec output, no prefix. */
export const encodeCall = (call: Call): Buffer => codec.encode(call)

const PARANOID_DECODE = process.env["B2BUA_PARANOID_DECODE"] === "1"
const isCall: (value: unknown) => value is Call = Schema.is(CallSchema)

/**
 * Decode a body buffer. ADR-0011 contract: bodies are bare msgpack
 * (whatever codec was active when written). Throws on malformed input
 * — callers wrap in `try/catch` or `Effect.try` and log the failure.
 *
 * Paranoid mode (`B2BUA_PARANOID_DECODE=1`) additionally runs
 * `Schema.is(CallSchema)` on the decoded value. Off by default in
 * production.
 */
export const decodeBodyAuto = (buf: Buffer): Call => {
  const value = codec.decode(buf) as unknown
  if (PARANOID_DECODE && !isCall(value)) {
    throw new Error(
      `CallCodec.decodeBodyAuto: paranoid mode rejected decoded value (callRef=${
        (value as { callRef?: unknown } | null)?.callRef ?? "?"
      })`,
    )
  }
  return value as Call
}

export class CallDecodeError extends Schema.TaggedErrorClass<CallDecodeError>()(
  "CallDecodeError",
  {
    reason: Schema.String,
    callRefHint: Schema.optional(Schema.String),
  },
) {}

export const decodeBodyAutoEffect = (
  buf: Buffer,
  callRefHint?: string,
): Effect.Effect<Call, CallDecodeError> =>
  Effect.try({
    try: () => decodeBodyAuto(buf),
    catch: (e) =>
      new CallDecodeError({
        reason: e instanceof Error ? e.message : String(e),
        callRefHint,
      }),
  })

/**
 * Legacy-JSON-decode counter — kept as a permanent zero post-ADR-0011
 * so the /debug/codec endpoint surface stays stable. The first-byte
 * JSON dispatch path is gone; this just gives operators a familiar
 * field to confirm no JSON path remains.
 */
export const getLegacyDecodeCount = (): number => 0
