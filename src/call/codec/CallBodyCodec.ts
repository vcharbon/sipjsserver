/**
 * CallBodyCodec — pure-function codec for Call bodies on the replication
 * hot path. Codec is dependency-injected via an Effect Layer; the
 * resolved value is a plain record of pure functions so the encode/decode
 * hot path stays non-Effectful (no Effect.gen overhead per call).
 *
 * Adding a codec = one new file + one switch arm in `selectCallBodyCodecLayer`.
 * Codec swaps are fresh-cluster events (drain + FLUSHDB + redeploy); no
 * live-switch contract.
 */

import { ServiceMap } from "effect"
import type { Call } from "../CallModel.js"

/**
 * The codec service — a plain record of pure functions.
 *
 *   encode(call): produces opaque bytes a peer can write to Redis
 *                 verbatim. Throws synchronously on contract violations.
 *   decode(buf):  reverses encode for a Call. Throws synchronously on
 *                 malformed input or schema mismatch (when paranoid mode
 *                 is wrapped on top).
 *
 * Both methods are SYNCHRONOUS pure functions — the codec interface
 * intentionally avoids Effect on the hot path because per-call encode is
 * thousands of ops/sec.
 */
export interface CallBodyCodecApi {
  readonly encode: (call: Call) => Buffer
  readonly decode: (buf: Buffer) => Call
}

export class CallBodyCodec extends ServiceMap.Service<CallBodyCodec, CallBodyCodecApi>()(
  "@sipjsserver/call/codec/CallBodyCodec",
) {}

export type CodecMode = "MSGPACK" | "MSGPACK_RECORDS" | "PROTOBUF"

/**
 * Read `B2BUA_CODEC` once at module load. Same default as the legacy
 * `CallCodec.CODEC_MODE` (MSGPACK) so worker boot is unchanged.
 */
const readCodecMode = (): CodecMode => {
  const raw = process.env["B2BUA_CODEC"]
  if (raw === "MSGPACK_RECORDS") return "MSGPACK_RECORDS"
  if (raw === "PROTOBUF") return "PROTOBUF"
  return "MSGPACK"
}

export const CODEC_MODE: CodecMode = readCodecMode()

// `selectCallBodyCodecLayer` lives in ./index.ts so this module
// (CallBodyCodec.ts) doesn't depend on the impl module. Avoids a
// load-time circular import that breaks the Tag definition.
