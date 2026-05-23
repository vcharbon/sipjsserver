/**
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
 */

import { Data, Effect, Layer, Schema, ServiceMap } from "effect"
import { CallBodyCodec, type CallBodyCodecApi } from "./CallBodyCodec.js"
import { Call as CallSchema } from "../CallModel.js"
import type { Call } from "../CallModel.js"
import { createHash } from "node:crypto"

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
 * properties on every call. A violation throws synchronously.
 *
 * NOTE: this is intentionally expensive (per-call hashing + round-trip
 * verification). It is for tests, not the hot path. Compose it OUTSIDE
 * `paranoidInputs` so input validation fires first.
 */
export const propertyTest = (
  wrapped: Layer.Layer<CallBodyCodec>,
  options?: PropertyTestOptions,
): Layer.Layer<CallBodyCodec> => {
  const properties = selectProperties(options)
  const wrapApi = (api: CallBodyCodecApi): CallBodyCodecApi => {
    const encode = (call: Call): Buffer => {
      const buf = api.encode(call)
      for (const p of properties) {
        const detail = p.check(api, call)
        if (detail !== null) throw new PropertyViolation(p.id, detail)
      }
      return buf
    }
    const decode = (buf: Buffer): Call => {
      const call = api.decode(buf)
      for (const p of properties) {
        if (p.id === "P3_decodeDeterminism") {
          const detail = p.check(api, buf)
          if (detail !== null) throw new PropertyViolation(p.id, detail)
        }
      }
      return call
    }
    return { encode, decode }
  }
  return Layer.effect(
    CallBodyCodec,
    Effect.gen(function* () {
      const innerMap = yield* Layer.build(wrapped)
      const inner = ServiceMap.get(innerMap, CallBodyCodec)
      return wrapApi(inner)
    }),
  )
}

// ---------------------------------------------------------------------------
// 2. paranoidInputs
// ---------------------------------------------------------------------------

/**
 * Cheap runtime checks on every call. PA1 (Schema.is on encode input)
 * is opt-in via `B2BUA_PARANOID=1` because it's the only ~µs-scale
 * cost; PA2–PA5 are always on.
 */
export const paranoidInputs = (
  wrapped: Layer.Layer<CallBodyCodec>,
): Layer.Layer<CallBodyCodec> => {
  const PA1_ENABLED = process.env["B2BUA_PARANOID"] === "1"
  const wrapApi = (api: CallBodyCodecApi): CallBodyCodecApi => {
    const encode = (call: Call): Buffer => {
      if (PA1_ENABLED && !isCall(call)) {
        throw new ParanoidInputViolation(
          "PA1_schemaIsOnEncode",
          `Schema.is(CallSchema) rejected encode input (callRef=${
            (call as { callRef?: unknown } | null)?.callRef ?? "?"
          })`,
        )
      }
      if (
        call._topology !== undefined &&
        !Number.isFinite(call._topology.gen)
      ) {
        throw new ParanoidInputViolation(
          "PA5_topologyGenFinite",
          `_topology.gen is not finite (callRef=${call.callRef})`,
        )
      }
      const buf = api.encode(call)
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        throw new ParanoidInputViolation(
          "PA3_encodePostcondition",
          `encode returned empty/non-Buffer`,
        )
      }
      return buf
    }
    const decode = (buf: Buffer): Call => {
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        throw new ParanoidInputViolation(
          "PA2_decodePrecondition",
          `decode received empty/non-Buffer input`,
        )
      }
      const call = api.decode(buf)
      if (
        call === null ||
        typeof call !== "object" ||
        typeof (call as { callRef?: unknown }).callRef !== "string"
      ) {
        throw new ParanoidInputViolation(
          "PA4_decodePostcondition",
          `decode produced non-Call shape`,
        )
      }
      return call
    }
    return { encode, decode }
  }
  return Layer.effect(
    CallBodyCodec,
    Effect.gen(function* () {
      const innerMap = yield* Layer.build(wrapped)
      const inner = ServiceMap.get(innerMap, CallBodyCodec)
      return wrapApi(inner)
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
): Layer.Layer<CallBodyCodec> => {
  const returnSide = options?.returnSide ?? "blue"
  return Layer.effect(
    CallBodyCodec,
    Effect.gen(function* () {
      const blueMap = yield* Layer.build(blue)
      const greenMap = yield* Layer.build(green)
      const blueApi = ServiceMap.get(blueMap, CallBodyCodec)
      const greenApi = ServiceMap.get(greenMap, CallBodyCodec)
      const encode = (call: Call): Buffer => {
        const bbytes = blueApi.encode(call)
        const gbytes = greenApi.encode(call)
        const bcall = blueApi.decode(bbytes)
        const gcall = greenApi.decode(gbytes)
        if (!deepEqual(bcall, call)) {
          throw new ParityViolation(
            "blue-vs-input",
            `blue round-trip diverged (callRef=${call.callRef})`,
          )
        }
        if (!deepEqual(gcall, call)) {
          throw new ParityViolation(
            "green-vs-input",
            `green round-trip diverged (callRef=${call.callRef})`,
          )
        }
        if (!deepEqual(bcall, gcall)) {
          throw new ParityViolation(
            "blue-vs-green",
            `blue and green decoded to different Calls (callRef=${call.callRef})`,
          )
        }
        return returnSide === "blue" ? bbytes : gbytes
      }
      const decode = (buf: Buffer): Call =>
        (returnSide === "blue" ? blueApi : greenApi).decode(buf)
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
 * scope's error channel.
 */
export const scopedAudit = (
  wrapped: Layer.Layer<CallBodyCodec>,
  options?: AuditOptions,
): Layer.Layer<CallBodyCodec> => {
  const aliasCheck = options?.aliasCheck ?? true
  return Layer.effect(
    CallBodyCodec,
    Effect.gen(function* () {
      const innerMap = yield* Layer.build(wrapped)
      const inner = ServiceMap.get(innerMap, CallBodyCodec)
      const encodes: Array<{
        bytes: Buffer
        bytesHashAtCall: string
        inferredStructureId: number | null
      }> = []
      const decodes: Array<{ bytes: number }> = []

      const encode = (call: Call): Buffer => {
        const bytes = inner.encode(call)
        encodes.push({
          bytes,
          bytesHashAtCall: aliasCheck ? hashBuffer(bytes) : "",
          inferredStructureId: bytes.length > 0 ? bytes[0]! : null,
        })
        return bytes
      }
      const decode = (buf: Buffer): Call => {
        decodes.push({ bytes: buf.length })
        return inner.decode(buf)
      }

      // Finalizers can't fail with typed errors; surface AuditViolation
      // as a defect so the surrounding scope sees it on Exit.cause.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (encodes.length === 0) return

          if (aliasCheck) {
            for (const e of encodes) {
              const now = hashBuffer(e.bytes)
              if (now !== e.bytesHashAtCall) {
                return yield* new AuditViolation({
                  check: "R3_aliasCheck",
                  detail: `encoder buffer mutated between call and scope-exit`,
                })
              }
            }
          }

          if (options?.sizeBudget !== undefined) {
            const sizes = encodes.map((e) => e.bytes.length).sort((a, b) => a - b)
            const median = percentile(sizes, 0.5)
            const p99 = percentile(sizes, 0.99)
            if (median > options.sizeBudget.medianBytes) {
              return yield* new AuditViolation({
                check: "R2_sizeBudget_median",
                detail: `median ${median}B > budget ${options.sizeBudget.medianBytes}B`,
              })
            }
            if (p99 > options.sizeBudget.p99Bytes) {
              return yield* new AuditViolation({
                check: "R2_sizeBudget_p99",
                detail: `p99 ${p99}B > budget ${options.sizeBudget.p99Bytes}B`,
              })
            }
          }

          if (options?.extra !== undefined) {
            yield* options.extra({ encodes, decodes })
          }
        }).pipe(Effect.orDie),
      )

      return { encode, decode }
    }),
  )
}

// ---------------------------------------------------------------------------
// Namespace export — sugar for stack-composition at call sites.
// ---------------------------------------------------------------------------

export const CallBodyCodecContracts = {
  propertyTest,
  paranoidInputs,
  parity,
  scopedAudit,
} as const
