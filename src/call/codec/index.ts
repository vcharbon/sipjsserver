/**
 * Public surface for the codec module. Re-exports the Tag, the impls,
 * and the boot-time `selectCallBodyCodecLayer` Layer that consumers
 * compose into their stack.
 */

import type { Layer } from "effect"
import {
  CallBodyCodec,
  CODEC_MODE,
} from "./CallBodyCodec.js"
import { MsgpackLayer, MsgpackRecordsLayer } from "./msgpack.js"

export {
  CallBodyCodec,
  CODEC_MODE,
  type CallBodyCodecApi,
  type CodecMode,
} from "./CallBodyCodec.js"
export {
  MsgpackLayer,
  MsgpackRecordsLayer,
  CALL_STRUCTURES_HARDCODED,
  makeMsgpackUnsafe,
} from "./msgpack.js"
export {
  CallBodyCodecContracts,
  propertyTest,
  paranoidInputs,
  parity,
  scopedAudit,
  PropertyViolation,
  ParanoidInputViolation,
  ParityViolation,
  AuditViolation,
  type CodecPropertyId,
  type CodecProperty,
  type PropertyTestOptions,
  type AuditOptions,
  type AuditRecord,
} from "./contracts.js"

/**
 * Boot-time codec selector. Returns the matching Layer for the active
 * `B2BUA_CODEC` env var. All workers in a cluster MUST wire the same
 * Layer at boot (drain + FLUSHDB + redeploy on swap).
 */
export const selectCallBodyCodecLayer: Layer.Layer<CallBodyCodec> =
  CODEC_MODE === "MSGPACK_RECORDS" ? MsgpackRecordsLayer : MsgpackLayer
