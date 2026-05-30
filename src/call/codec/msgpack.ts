/**
 * msgpackr-backed CallBodyCodec impl. Two Layers:
 *
 *   MsgpackLayer         — `useRecords: false`. Each buffer is self-
 *                          contained msgpack. The safe default.
 *   MsgpackRecordsLayer  — `useRecords: true` with hardcoded shared
 *                          structures. ~60 % smaller bodies on the
 *                          Call schema; requires cluster-wide drain on
 *                          schema change.
 *
 * Encoder configuration (common to both):
 *   - `copyBuffers: true` — unpacked Uint8Array fields point into fresh
 *     allocations, not the input Buffer's memory.
 *   - `encodeUndefinedAsNil: false` — `undefined` distinct from `null`
 *     on round-trip (Call schema relies on this).
 */

import { Effect, Layer } from "effect"
import { Encoder } from "msgpackr"
import { CallBodyCodec, type CallBodyCodecApi } from "./CallBodyCodec.js"
import type { Call } from "../CallModel.js"

/**
 * Hardcoded msgpackr records-mode shared structures for the Call schema
 * and every nested type it composes. Each worker boots with this exact
 * array — msgpackr assigns structure IDs by position, so two workers
 * decode each other's bodies correctly.
 *
 * Order matters; only append. Adding/removing/reordering fields on any
 * schema type listed below changes msgpackr's learned shape and forces a
 * cluster-wide drain + FLUSHDB + redeploy.
 *
 * Generated from a comprehensive Call fixture; do not hand-edit without
 * re-running the bootstrap.
 */
const CALL_STRUCTURES: ReadonlyArray<ReadonlyArray<string>> = [
  ["callRef","aLeg","bLegs","activePeer","callbackContext","billingContext","aLegInvite","limiterEntries","timers","cdrEvents","state","createdAt","aLegPendingVias","aLegPendingCSeq","tagMap","traceId","rootSpanId","sampled","workerIndex","_topology","emergency","features","policyUpdateHeaders","policyUpdateBody","activeRules","ruleState","messageCount","ext"],
  ["legId","callId","fromTag","source","state","disposition","dialogs","noAnswerTimeoutSec","byeDisposition","localUri","remoteUri","inviteRequestUri","pendingInviteTxn","ext"],
  ["address","port"],
  ["sip","ext"],
  ["callId","localTag","remoteTag","localUri","remoteUri","remoteTarget","localCSeq","routeSet"],
  ["remoteCSeq","inboundPendingRequests","ackBranch","pendingInviteTxn","cachedSdp"],
  ["method","outboundCSeq","inboundCSeq","sourceVias","sourceCallId","sourceFrom","sourceTo","direction"],
  ["kind","branch","originalInvite","destination"],
  ["host","port"],
  ["legA","legB"],
  ["uri","headers","body"],
  ["name","value"],
  ["limiterId","limit","originWindow","incrementSucceeded"],
  ["id","type","fireAt","legId"],
  ["type","timestamp","legId","statusCode","reason"],
  ["aTag","bLegId","bTag"],
  ["pri","bak","gen"],
  ["failoverAllowed"],
  ["X-Foo"],
  ["id","params","active"],
  [],
  ["ruleId","state"],
  // transfer state no longer rides as a dedicated Call field; it lives inside
  // the generic `ext` carry as the transfer service's call-ext slice (decoded
  // JSON, records-mode learns the shape on first encode). This row keeps the
  // transfer-call-ext shape so records-mode can compact Call.ext["transfer"].
  ["phase","referrerLegId","referToUri","effectiveReferToUri","callbackContext","cLegId","referCSeq","startedAtMs","lastCLegNotifiedStatus","cInitialSdp"],
  // promote-pem call-ext slice shape (records-mode compaction for Call.ext["promote-pem"]).
  ["promoted","promotedSdp","windowOpen","resyncReinviteCSeq"],
  // generic single-field `{ role }` leg-ext slice shape (records-mode compaction
  // for any Leg.ext[...] = { role } slice).
  ["role"],
]

export const CALL_STRUCTURES_HARDCODED: ReadonlyArray<ReadonlyArray<string>> =
  CALL_STRUCTURES

const makeMsgpackImpl = (useRecords: boolean): CallBodyCodecApi => {
  const encoder = new Encoder(
    useRecords
      ? {
          useRecords: true,
          structures: CALL_STRUCTURES.map((s) => s.slice()),
          maxSharedStructures: CALL_STRUCTURES.length,
          copyBuffers: true,
          encodeUndefinedAsNil: false,
        }
      : {
          useRecords: false,
          copyBuffers: true,
          encodeUndefinedAsNil: false,
        },
  )
  const encode = (call: Call): Buffer => encoder.pack(call) as Buffer
  const decode = (buf: Buffer): Call => encoder.unpack(buf) as Call
  return { encode, decode }
}

export const MsgpackLayer: Layer.Layer<CallBodyCodec> = Layer.effect(
  CallBodyCodec,
  Effect.sync(() => makeMsgpackImpl(false)),
)

export const MsgpackRecordsLayer: Layer.Layer<CallBodyCodec> = Layer.effect(
  CallBodyCodec,
  Effect.sync(() => makeMsgpackImpl(true)),
)

/** Synchronous factory for tests / one-off use that can't take a Layer. */
export const makeMsgpackUnsafe = (useRecords = false): CallBodyCodecApi =>
  makeMsgpackImpl(useRecords)
