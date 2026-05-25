/**
 * **TEST-ONLY exports.** Production composition uses the bare
 * `CallBodyCodec.{MsgpackLayer,MsgpackRecordsLayer}` directly. Every
 * wrapper here adds `Recorder | RunContext` to the dependency
 * channel — services production does not provide, so applying any
 * wrapper inside `src/main.ts` will refuse to build the layer at
 * startup. No automated guard; reviewers must reject any import of
 * these symbols from `src/main.ts` / `bin/*`. See SURPRISES T2.
 *
 * Codec contract wrappers — each wraps a `CallBodyCodec` Layer with
 * additional checks that fire on every encode/decode call. The wrapped
 * Layer keeps the same `CallBodyCodec` tag, so consumers are unaware
 * which combination is active.
 *
 * Composition (outer wraps inner):
 *
 *   propertyTest(paranoidInputs(MsgpackLayer))
 *   scopedAudit(propertyTest(MsgpackRecordsLayer))
 *   paranoidInputs(parity(MsgpackLayer, ProtobufLayer))
 *
 * Failure model — encode/decode are SYNCHRONOUS pure functions, so
 * runtime contract violations throw synchronous exceptions. The only
 * exception is `scopedAudit`'s scope-close finalizer, which runs in
 * Effect context and surfaces via the Effect error channel.
 *
 * Recording
 * ---------
 * Every encode/decode call records a typed event on the per-Tag
 * channel `Recorder.forTag(CallBodyCodec)`. Violations additionally
 * push a `codec*` anomaly through the registered projector BEFORE the
 * synchronous throw / Effect.fail. The throw shape is unchanged — code
 * that catches `PropertyViolation` / `ParanoidInputViolation` /
 * `ParityViolation` / `AuditViolation` continues to work; recording is
 * purely additive. Severity is `fatal` in every `RunContext` kind
 * because the wrappers always throw (no deferred-fail path).
 */

import { Clock, Data, Effect, Layer, Schema, ServiceMap } from "effect"
import { CallBodyCodec, type CallBodyCodecApi } from "./CallBodyCodec.js"
import { Call as CallSchema } from "../CallModel.js"
import type { Call } from "../CallModel.js"
import { createHash } from "node:crypto"
import { Recorder } from "../../test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../../test-harness/framework/RunContext.js"
import type {
  Projector,
  RecordedAnomaly,
  TaggedChannel,
} from "../../test-harness/framework/report-recorder/types.js"
import {
  withCanonicalContracts,
  type CanonicalContractsOptions,
} from "../../test-harness/framework/effectLayerTest.js"

// ---------------------------------------------------------------------------
// Failure shapes
// ---------------------------------------------------------------------------

export class PropertyViolation extends Error {
  readonly _tag = "CodecPropertyViolation"
  constructor(
    readonly propertyId: string,
    readonly detail: string,
    readonly inputHint?: string,
  ) {
    super(`codec ${propertyId}: ${detail}`)
  }
}

export class ParanoidInputViolation extends Error {
  readonly _tag = "CodecParanoidInputViolation"
  constructor(
    readonly check: string,
    readonly detail: string,
  ) {
    super(`codec ${check}: ${detail}`)
  }
}

export class ParityViolation extends Error {
  readonly _tag = "CodecParityViolation"
  constructor(
    readonly side: "blue-vs-input" | "green-vs-input" | "blue-vs-green",
    readonly detail: string,
  ) {
    super(`codec parity ${side}: ${detail}`)
  }
}

export class AuditViolation extends Data.TaggedError("CodecAuditViolation")<{
  readonly check: string
  readonly detail: string
}> {}

// ---------------------------------------------------------------------------
// Typed event union
// ---------------------------------------------------------------------------

/**
 * One observation on the `CallBodyCodec` typed channel. The Recorder
 * stamps `seq` + `atMs` on every entry. `encode.result` and
 * `decode.called` carry the byte size + sha256 so projectors and rules
 * can correlate without holding raw buffers.
 */
export type CallBodyCodecEvent =
  | { readonly tag: "encode.called"; readonly input: Call }
  | {
      readonly tag: "encode.result"
      readonly outBytes: number
      readonly outHash?: string
    }
  | {
      readonly tag: "decode.called"
      readonly inBytes: number
      readonly inHash?: string
    }
  | { readonly tag: "decode.result"; readonly output: Call }

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export type CodecPropertyId =
  | "P1_roundTrip"
  | "P2_encodeDeterminism"
  | "P3_decodeDeterminism"
  | "P4_valueEqualityStability"
  | "P5_undefinedPreservation"
  | "P6_nullPreservation"
  | "P7_uint8ArrayIntegrity"
  | "P8_emptyCollectionPreservation"
  | "P9_numericFidelity"
  | "P10_noInputMutationOnEncode"
  | "P11_noInputMutationOnDecode"
  | "P12_outputIndependence"
  | "P13_schemaConformance"
  | "P14_nonEmptyOutput"

export interface CodecProperty {
  readonly id: CodecPropertyId | string
  readonly check: (codec: CallBodyCodecApi, input: Call | Buffer) => string | null
}

export interface PropertyTestOptions {
  readonly only?: ReadonlyArray<CodecPropertyId | string>
  readonly extra?: ReadonlyArray<CodecProperty>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isCall: (v: unknown) => v is Call = Schema.is(CallSchema)

const bufferEquals = (a: Buffer, b: Buffer): boolean => a.equals(b)

const hashBuffer = (buf: Buffer): string =>
  createHash("sha256").update(buf).digest("hex")

const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>()
  const visit = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v
    // Normalise binary types BEFORE the seen-check — the same byte
    // slice may legitimately appear at two field paths (e.g. an SDP
    // shared between aLegInvite.body and a dialog's cachedSdp); the
    // codec decodes those as distinct buffers, so identity equality
    // on the input would mis-flag the second occurrence as circular.
    if (v instanceof Uint8Array) {
      return { __bin: Buffer.from(v).toString("hex") }
    }
    if (seen.has(v as object)) return "[circular]"
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(visit)
    const obj = v as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const out: Record<string, unknown> = {}
    for (const k of keys) out[k] = visit(obj[k])
    return out
  }
  return JSON.stringify(visit(value))
}

const hashCall = (call: Call): string =>
  createHash("sha256").update(stableStringify(call)).digest("hex")

const deepEqual = (a: unknown, b: unknown): boolean =>
  stableStringify(a) === stableStringify(b)

// Wrappers are sync (encode/decode are pure). Anomaly recording and
// channel.record both yield Effects — we drive them with runSync since
// the underlying store is an in-memory array.
const pushChannel = (
  channel: TaggedChannel<CallBodyCodecEvent>,
  event: CallBodyCodecEvent,
): void => {
  Effect.runSync(channel.record(event))
}

// Anomalies surface through a per-Tag projector. The wrapper stores
// them locally and returns them on snapshot.
const installCodecProjector = (
  recorder: Recorder["Service"],
  store: RecordedAnomaly[],
): Effect.Effect<void> => {
  const projector: Projector<CallBodyCodecEvent> = () => ({
    anomalies: store.slice(),
  })
  return recorder.registerProjector(CallBodyCodec, projector)
}

// ---------------------------------------------------------------------------
// 1. propertyTest
// ---------------------------------------------------------------------------

const BUILT_IN_PROPERTIES: ReadonlyArray<CodecProperty> = [
  {
    id: "P1_roundTrip",
    check: (codec, input) => {
      if (Buffer.isBuffer(input)) return null
      const round = codec.decode(codec.encode(input))
      return deepEqual(round, input)
        ? null
        : `round-trip differs (callRef=${input.callRef})`
    },
  },
  {
    id: "P2_encodeDeterminism",
    check: (codec, input) => {
      if (Buffer.isBuffer(input)) return null
      const a = codec.encode(input)
      const b = codec.encode(input)
      return bufferEquals(a, b)
        ? null
        : `non-deterministic encode (callRef=${input.callRef})`
    },
  },
  {
    id: "P3_decodeDeterminism",
    check: (codec, input) => {
      const buf = Buffer.isBuffer(input) ? input : codec.encode(input)
      const a = codec.decode(buf)
      const b = codec.decode(buf)
      return deepEqual(a, b) ? null : `non-deterministic decode`
    },
  },
  {
    id: "P13_schemaConformance",
    check: (codec, input) => {
      if (Buffer.isBuffer(input)) return null
      const round = codec.decode(codec.encode(input))
      return isCall(round)
        ? null
        : `decoded value fails Schema.is(CallSchema)`
    },
  },
  {
    id: "P14_nonEmptyOutput",
    check: (codec, input) => {
      if (Buffer.isBuffer(input)) return null
      const buf = codec.encode(input)
      return buf.length > 0 ? null : `encode returned empty buffer`
    },
  },
  {
    id: "P10_noInputMutationOnEncode",
    check: (codec, input) => {
      if (Buffer.isBuffer(input)) return null
      const before = hashCall(input)
      codec.encode(input)
      const after = hashCall(input)
      return before === after
        ? null
        : `encode mutated its input (callRef=${input.callRef})`
    },
  },
]

const selectProperties = (
  options: PropertyTestOptions | undefined,
): ReadonlyArray<CodecProperty> => {
  const allBuiltIn = options?.only
    ? BUILT_IN_PROPERTIES.filter((p) => options.only!.includes(p.id))
    : BUILT_IN_PROPERTIES
  return options?.extra ? [...allBuiltIn, ...options.extra] : allBuiltIn
}

/**
 * Wraps a Layer; the returned Layer's encode/decode runs the selected
 * properties on every call. A violation throws synchronously after the
 * call + violation are written to the typed channel + anomaly store.
 *
 * NOTE: this is intentionally expensive (per-call hashing + round-trip
 * verification). It is for tests, not the hot path. Compose it OUTSIDE
 * `paranoidInputs` so input validation fires first.
 */
export const propertyTest = (
  wrapped: Layer.Layer<CallBodyCodec>,
  options?: PropertyTestOptions,
): Layer.Layer<CallBodyCodec, never, Recorder | RunContext> => {
  const properties = selectProperties(options)
  return Layer.effect(
    CallBodyCodec,
    Effect.gen(function* () {
      const innerMap = yield* Layer.build(wrapped)
      const inner = ServiceMap.get(innerMap, CallBodyCodec)
      const recorder = yield* Recorder
      yield* RunContext // RunContext is part of the contract but severity is fatal everywhere
      const channel = recorder.forTag<CallBodyCodec, CallBodyCodecEvent>(
        CallBodyCodec,
      )
      const anomalies: RecordedAnomaly[] = []
      yield* installCodecProjector(recorder, anomalies)

      const recordPropertyAnomaly = (
        propertyId: string,
        detail: string,
        callRef?: string,
      ): void => {
        anomalies.push({
          kind: "codecPropertyViolation",
          propertyId,
          detail,
          ...(callRef !== undefined ? { callRef } : {}),
          severity: "fatal",
        })
      }

      const encode = (call: Call): Buffer => {
        pushChannel(channel, { tag: "encode.called", input: call })
        const buf = inner.encode(call)
        pushChannel(channel, {
          tag: "encode.result",
          outBytes: buf.length,
          outHash: hashBuffer(buf),
        })
        for (const p of properties) {
          const detail = p.check(inner, call)
          if (detail !== null) {
            recordPropertyAnomaly(p.id, detail, call.callRef)
            throw new PropertyViolation(p.id, detail)
          }
        }
        return buf
      }
      const decode = (buf: Buffer): Call => {
        pushChannel(channel, {
          tag: "decode.called",
          inBytes: buf.length,
          inHash: hashBuffer(buf),
        })
        const call = inner.decode(buf)
        pushChannel(channel, { tag: "decode.result", output: call })
        for (const p of properties) {
          if (p.id === "P3_decodeDeterminism") {
            const detail = p.check(inner, buf)
            if (detail !== null) {
              recordPropertyAnomaly(p.id, detail, call.callRef)
              throw new PropertyViolation(p.id, detail)
            }
          }
        }
        return call
      }
      return { encode, decode }
    }),
  )
}

// ---------------------------------------------------------------------------
// 2. paranoidInputs
// ---------------------------------------------------------------------------

/**
 * Cheap runtime checks on every call. PA1 (Schema.is on encode input)
 * is opt-in via `B2BUA_PARANOID=1` because it's the only ~µs-scale
 * cost; PA2–PA5 are always on. Each violation records an anomaly +
 * typed event BEFORE the synchronous throw.
 */
export const paranoidInputs = (
  wrapped: Layer.Layer<CallBodyCodec>,
): Layer.Layer<CallBodyCodec, never, Recorder | RunContext> => {
  const PA1_ENABLED = process.env["B2BUA_PARANOID"] === "1"
  return Layer.effect(
    CallBodyCodec,
    Effect.gen(function* () {
      const innerMap = yield* Layer.build(wrapped)
      const inner = ServiceMap.get(innerMap, CallBodyCodec)
      const recorder = yield* Recorder
      yield* RunContext
      const channel = recorder.forTag<CallBodyCodec, CallBodyCodecEvent>(
        CallBodyCodec,
      )
      const anomalies: RecordedAnomaly[] = []
      yield* installCodecProjector(recorder, anomalies)

      const recordParanoidAnomaly = (check: string, detail: string): void => {
        anomalies.push({
          kind: "codecParanoidInput",
          check,
          detail,
          severity: "fatal",
        })
      }

      const encode = (call: Call): Buffer => {
        pushChannel(channel, { tag: "encode.called", input: call })
        if (PA1_ENABLED && !isCall(call)) {
          const detail = `Schema.is(CallSchema) rejected encode input (callRef=${
            (call as { callRef?: unknown } | null)?.callRef ?? "?"
          })`
          recordParanoidAnomaly("PA1_schemaIsOnEncode", detail)
          throw new ParanoidInputViolation("PA1_schemaIsOnEncode", detail)
        }
        if (
          call._topology !== undefined &&
          !Number.isFinite(call._topology.gen)
        ) {
          const detail = `_topology.gen is not finite (callRef=${call.callRef})`
          recordParanoidAnomaly("PA5_topologyGenFinite", detail)
          throw new ParanoidInputViolation("PA5_topologyGenFinite", detail)
        }
        const buf = inner.encode(call)
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
          const detail = `encode returned empty/non-Buffer`
          recordParanoidAnomaly("PA3_encodePostcondition", detail)
          throw new ParanoidInputViolation("PA3_encodePostcondition", detail)
        }
        pushChannel(channel, {
          tag: "encode.result",
          outBytes: buf.length,
          outHash: hashBuffer(buf),
        })
        return buf
      }
      const decode = (buf: Buffer): Call => {
        pushChannel(channel, {
          tag: "decode.called",
          inBytes: Buffer.isBuffer(buf) ? buf.length : 0,
          ...(Buffer.isBuffer(buf) && buf.length > 0
            ? { inHash: hashBuffer(buf) }
            : {}),
        })
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
          const detail = `decode received empty/non-Buffer input`
          recordParanoidAnomaly("PA2_decodePrecondition", detail)
          throw new ParanoidInputViolation("PA2_decodePrecondition", detail)
        }
        const call = inner.decode(buf)
        if (
          call === null ||
          typeof call !== "object" ||
          typeof (call as { callRef?: unknown }).callRef !== "string"
        ) {
          const detail = `decode produced non-Call shape`
          recordParanoidAnomaly("PA4_decodePostcondition", detail)
          throw new ParanoidInputViolation("PA4_decodePostcondition", detail)
        }
        pushChannel(channel, { tag: "decode.result", output: call })
        return call
      }
      return { encode, decode }
    }),
  )
}

// ---------------------------------------------------------------------------
// 3. parity
// ---------------------------------------------------------------------------

export interface ParityOptions {
  readonly returnSide?: "blue" | "green"
}

/**
 * Wraps two codec Layers. The returned Layer's encode runs both, decodes
 * each through its OWN decoder, and asserts the decoded Calls deep-equal
 * each other AND the input.
 *
 * The encoded bytes themselves are not compared (different formats are
 * legitimately incompatible). The "blue" side's bytes are returned by
 * default — change with `options.returnSide`.
 */
export const parity = (
  blue: Layer.Layer<CallBodyCodec>,
  green: Layer.Layer<CallBodyCodec>,
  options?: ParityOptions,
): Layer.Layer<CallBodyCodec, never, Recorder | RunContext> => {
  const returnSide = options?.returnSide ?? "blue"
  return Layer.effect(
    CallBodyCodec,
    Effect.gen(function* () {
      const blueMap = yield* Layer.build(blue)
      const greenMap = yield* Layer.build(green)
      const blueApi = ServiceMap.get(blueMap, CallBodyCodec)
      const greenApi = ServiceMap.get(greenMap, CallBodyCodec)
      const recorder = yield* Recorder
      yield* RunContext
      const channel = recorder.forTag<CallBodyCodec, CallBodyCodecEvent>(
        CallBodyCodec,
      )
      const anomalies: RecordedAnomaly[] = []
      yield* installCodecProjector(recorder, anomalies)

      const recordParityAnomaly = (
        side: "blue-vs-input" | "green-vs-input" | "blue-vs-green",
        detail: string,
        callRef?: string,
      ): void => {
        anomalies.push({
          kind: "codecParity",
          side,
          detail,
          ...(callRef !== undefined ? { callRef } : {}),
          severity: "fatal",
        })
      }

      const encode = (call: Call): Buffer => {
        pushChannel(channel, { tag: "encode.called", input: call })
        const bbytes = blueApi.encode(call)
        const gbytes = greenApi.encode(call)
        const bcall = blueApi.decode(bbytes)
        const gcall = greenApi.decode(gbytes)
        if (!deepEqual(bcall, call)) {
          const detail = `blue round-trip diverged (callRef=${call.callRef})`
          recordParityAnomaly("blue-vs-input", detail, call.callRef)
          throw new ParityViolation("blue-vs-input", detail)
        }
        if (!deepEqual(gcall, call)) {
          const detail = `green round-trip diverged (callRef=${call.callRef})`
          recordParityAnomaly("green-vs-input", detail, call.callRef)
          throw new ParityViolation("green-vs-input", detail)
        }
        if (!deepEqual(bcall, gcall)) {
          const detail = `blue and green decoded to different Calls (callRef=${call.callRef})`
          recordParityAnomaly("blue-vs-green", detail, call.callRef)
          throw new ParityViolation("blue-vs-green", detail)
        }
        const out = returnSide === "blue" ? bbytes : gbytes
        pushChannel(channel, {
          tag: "encode.result",
          outBytes: out.length,
          outHash: hashBuffer(out),
        })
        return out
      }
      const decode = (buf: Buffer): Call => {
        pushChannel(channel, {
          tag: "decode.called",
          inBytes: buf.length,
          ...(Buffer.isBuffer(buf) && buf.length > 0
            ? { inHash: hashBuffer(buf) }
            : {}),
        })
        const call = (returnSide === "blue" ? blueApi : greenApi).decode(buf)
        pushChannel(channel, { tag: "decode.result", output: call })
        return call
      }
      return { encode, decode }
    }),
  )
}

// ---------------------------------------------------------------------------
// 4. scopedAudit
// ---------------------------------------------------------------------------

export interface AuditRecord {
  readonly encodes: ReadonlyArray<{
    readonly bytes: Buffer
    readonly bytesHashAtCall: string
    readonly inferredStructureId: number | null
  }>
  readonly decodes: ReadonlyArray<{ readonly bytes: number }>
}

export interface AuditOptions {
  readonly recordsModeFloor?: number
  readonly sizeBudget?: {
    readonly medianBytes: number
    readonly p99Bytes: number
  }
  readonly aliasCheck?: boolean
  readonly extra?: (
    record: AuditRecord,
  ) => Effect.Effect<void, AuditViolation>
}

const percentile = (sorted: ReadonlyArray<number>, p: number): number => {
  if (sorted.length === 0) return 0
  const idx = Math.min(
    sorted.length - 1,
    Math.floor(p * sorted.length),
  )
  return sorted[idx]!
}

/**
 * Records every encode/decode in scope and runs aggregate invariants on
 * scope close. Failures surface as `AuditViolation` on the SURROUNDING
 * scope's error channel — and as a `codecAudit` anomaly recorded BEFORE
 * the failure.
 */
export const scopedAudit = (
  wrapped: Layer.Layer<CallBodyCodec>,
  options?: AuditOptions,
): Layer.Layer<CallBodyCodec, never, Recorder | RunContext> => {
  const aliasCheck = options?.aliasCheck ?? true
  return Layer.effect(
    CallBodyCodec,
    Effect.gen(function* () {
      const innerMap = yield* Layer.build(wrapped)
      const inner = ServiceMap.get(innerMap, CallBodyCodec)
      const recorder = yield* Recorder
      yield* RunContext
      const channel = recorder.forTag<CallBodyCodec, CallBodyCodecEvent>(
        CallBodyCodec,
      )
      const anomalies: RecordedAnomaly[] = []
      yield* installCodecProjector(recorder, anomalies)

      const recordAuditAnomaly = (check: string, detail: string): void => {
        anomalies.push({
          kind: "codecAudit",
          check,
          detail,
          severity: "fatal",
        })
      }

      const encodes: Array<{
        bytes: Buffer
        bytesHashAtCall: string
        inferredStructureId: number | null
      }> = []
      const decodes: Array<{ bytes: number }> = []

      const encode = (call: Call): Buffer => {
        pushChannel(channel, { tag: "encode.called", input: call })
        const bytes = inner.encode(call)
        const bytesHashAtCall = aliasCheck ? hashBuffer(bytes) : ""
        encodes.push({
          bytes,
          bytesHashAtCall,
          inferredStructureId: bytes.length > 0 ? bytes[0]! : null,
        })
        pushChannel(channel, {
          tag: "encode.result",
          outBytes: bytes.length,
          outHash: aliasCheck ? bytesHashAtCall : hashBuffer(bytes),
        })
        return bytes
      }
      const decode = (buf: Buffer): Call => {
        pushChannel(channel, {
          tag: "decode.called",
          inBytes: buf.length,
          ...(Buffer.isBuffer(buf) && buf.length > 0
            ? { inHash: hashBuffer(buf) }
            : {}),
        })
        decodes.push({ bytes: buf.length })
        const call = inner.decode(buf)
        pushChannel(channel, { tag: "decode.result", output: call })
        return call
      }

      // Finalizers can't fail with typed errors; surface AuditViolation
      // as a defect so the surrounding scope sees it on Exit.cause.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (encodes.length === 0) return
          // Touch Clock for symmetry with other scopedAudit finalizers;
          // unused here since the anomaly carries the failing check name.
          yield* Clock.currentTimeMillis

          if (aliasCheck) {
            for (const e of encodes) {
              const now = hashBuffer(e.bytes)
              if (now !== e.bytesHashAtCall) {
                const detail = `encoder buffer mutated between call and scope-exit`
                recordAuditAnomaly("R3_aliasCheck", detail)
                return yield* new AuditViolation({
                  check: "R3_aliasCheck",
                  detail,
                })
              }
            }
          }

          if (options?.sizeBudget !== undefined) {
            const sizes = encodes.map((e) => e.bytes.length).sort((a, b) => a - b)
            const median = percentile(sizes, 0.5)
            const p99 = percentile(sizes, 0.99)
            if (median > options.sizeBudget.medianBytes) {
              const detail = `median ${median}B > budget ${options.sizeBudget.medianBytes}B`
              recordAuditAnomaly("R2_sizeBudget_median", detail)
              return yield* new AuditViolation({
                check: "R2_sizeBudget_median",
                detail,
              })
            }
            if (p99 > options.sizeBudget.p99Bytes) {
              const detail = `p99 ${p99}B > budget ${options.sizeBudget.p99Bytes}B`
              recordAuditAnomaly("R2_sizeBudget_p99", detail)
              return yield* new AuditViolation({
                check: "R2_sizeBudget_p99",
                detail,
              })
            }
          }

          if (options?.extra !== undefined) {
            yield* options.extra({ encodes, decodes }).pipe(
              Effect.tapError((e) =>
                Effect.sync(() => {
                  recordAuditAnomaly(e.check, e.detail)
                }),
              ),
            )
          }
        }).pipe(Effect.orDie),
      )

      return { encode, decode }
    }),
  )
}

// ---------------------------------------------------------------------------
// Tag.withAllContracts — canonical-order forwarder
// ---------------------------------------------------------------------------

export interface CallBodyCodecContractsOptions {
  readonly propertyTest?: PropertyTestOptions | true
  readonly paranoidInputs?: boolean
  readonly scopedAudit?: AuditOptions | true
}

/**
 * Thin forwarder around the generic `withCanonicalContracts` helper.
 * Composes wrappers in canonical order:
 *
 *   propertyTest(paranoidInputs(scopedAudit(impl)))
 *
 * `parity` stays outside the helper (per D7) — build the parity layer
 * first and pass it as `impl`.
 */
export const withAllContracts = (
  impl: Layer.Layer<CallBodyCodec>,
  options?: CallBodyCodecContractsOptions,
): Layer.Layer<CallBodyCodec, never, Recorder | RunContext> => {
  const opts: CanonicalContractsOptions<
    CallBodyCodec,
    PropertyTestOptions,
    never,
    AuditOptions
  > = {
    ...(options?.propertyTest !== undefined
      ? {
          propertyTest: {
            wrap: propertyTest as never,
            ...(options.propertyTest === true
              ? {}
              : { opts: options.propertyTest }),
          },
        }
      : {}),
    ...(options?.paranoidInputs !== false
      ? { paranoidInputs: { wrap: paranoidInputs as never } }
      : {}),
    ...(options?.scopedAudit !== undefined
      ? {
          scopedAudit: {
            wrap: scopedAudit as never,
            ...(options.scopedAudit === true
              ? {}
              : { opts: options.scopedAudit }),
          },
        }
      : {}),
  }
  return withCanonicalContracts(CallBodyCodec, impl, opts) as Layer.Layer<
    CallBodyCodec,
    never,
    Recorder | RunContext
  >
}

// ---------------------------------------------------------------------------
// Namespace export — sugar for stack-composition at call sites.
// ---------------------------------------------------------------------------

export const CallBodyCodecContracts = {
  propertyTest,
  paranoidInputs,
  parity,
  scopedAudit,
  withAllContracts,
} as const
