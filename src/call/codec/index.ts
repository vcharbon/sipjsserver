/**
 * Public surface for the codec module. Re-exports the Tag (augmented
 * with the four `effect-layer-test` static-method wrappers), the impls,
 * and the boot-time `selectCallBodyCodecLayer` Layer.
 *
 * The wrappers (`propertyTest` / `paranoidInputs` / `parity` /
 * `scopedAudit`) live in `./contracts.js` to keep the impl file small.
 * We bolt them onto the Tag class here — `CallBodyCodec.ts` can't do it
 * directly without a load-time cycle, since `contracts.ts` imports the
 * Tag to type its arguments. Composition is the canonical form:
 *
 *   CallBodyCodec.propertyTest(
 *     CallBodyCodec.paranoidInputs(ProtobufLayer),
 *   )
 */

import type { Layer } from "effect"
import { CallBodyCodec as CallBodyCodecTag, CODEC_MODE } from "./CallBodyCodec.js"
import { MsgpackLayer, MsgpackRecordsLayer } from "./msgpack.js"
import { ProtobufLayer } from "./protobuf.js"
import * as contracts from "./contracts.js"

/**
 * Static-method bolt-on. Done at module load so by the time any
 * consumer imports the Tag through this file, the wrappers are wired.
 */
const CallBodyCodec = Object.assign(CallBodyCodecTag, {
  propertyTest: contracts.propertyTest,
  paranoidInputs: contracts.paranoidInputs,
  parity: contracts.parity,
  scopedAudit: contracts.scopedAudit,
})

type CallBodyCodec = CallBodyCodecTag

export { CallBodyCodec }

export {
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
  ProtobufLayer,
  makeProtobufUnsafe,
} from "./protobuf.js"
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
  CODEC_MODE === "PROTOBUF"
    ? ProtobufLayer
    : CODEC_MODE === "MSGPACK_RECORDS"
      ? MsgpackRecordsLayer
      : MsgpackLayer
