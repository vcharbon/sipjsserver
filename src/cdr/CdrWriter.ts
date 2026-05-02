/**
 * CdrWriter service — appends one JSON line per call to a CDR file on termination.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { Clock, Effect, Layer, Schema, ServiceMap } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import type { Call } from "../call/CallModel.js"
import { CdrEvent, LegDisposition, LegState } from "../call/CallModel.js"

export const CdrRecord = Schema.Struct({
  callRef: Schema.String,
  createdAt: Schema.Number,
  terminatedAt: Schema.Number,
  aLeg: Schema.Struct({
    callId: Schema.String,
    fromTag: Schema.String,
    state: LegState
  }),
  bLegs: Schema.Array(Schema.Struct({
    legId: Schema.String,
    callId: Schema.String,
    state: LegState,
    disposition: LegDisposition
  })),
  events: Schema.Array(CdrEvent),
  /**
   * Adapter-owned attribution blob (SplitServiceLogic.md §D9). Populated from
   * the latest-wins `Call.billingContext` set by Route / RejectA / ReferAllow
   * responses. Omitted from the record when the adapter never supplied one.
   */
  billingContext: Schema.optional(Schema.NullOr(Schema.String)),
})

export type CdrRecord = typeof CdrRecord.Type

const JsonCdrRecord = Schema.fromJsonString(CdrRecord)

const buildRecord = (call: Call, terminatedAt: number): CdrRecord => ({
  callRef: call.callRef,
  createdAt: call.createdAt,
  terminatedAt,
  aLeg: {
    callId: call.aLeg.callId,
    fromTag: call.aLeg.fromTag,
    state: call.aLeg.state,
  },
  bLegs: call.bLegs.map((leg) => ({
    legId: leg.legId,
    callId: leg.callId,
    state: leg.state,
    disposition: leg.disposition,
  })),
  events: call.cdrEvents,
  ...(call.billingContext !== undefined ? { billingContext: call.billingContext } : {}),
})

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CdrWriter extends ServiceMap.Service<
  CdrWriter,
  {
    /** Write a completed call's CDR events as a single JSON line. */
    readonly write: (call: Call) => Effect.Effect<void>
    /**
     * Read every CDR record produced so far. The file layer parses the
     * on-disk JSONL; the in-memory test layer returns its array. Used by
     * test harnesses to assert per-call termination cleanliness.
     */
    readonly readAll: Effect.Effect<ReadonlyArray<CdrRecord>>
  }
>()("@sipjsserver/CdrWriter") {
  static readonly layer = Layer.effect(
    CdrWriter,
    Effect.gen(function* () {
      const config = yield* AppConfig
      // In cluster mode, append worker index to CDR filename (e.g. cdr-worker-0.jsonl)
      const basePath = path.resolve(config.cdrFilePath)
      const filePath = config.workerIndex >= 0
        ? basePath.replace(/(\.[^.]+)$/, `-worker-${config.workerIndex}$1`)
        : basePath

      // Ensure parent directory exists
      yield* Effect.sync(() => {
        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
      })

      yield* Effect.logInfo(`CDR writer initialized → ${filePath}`)

      const write = Effect.fnUntraced(function* (call: Call) {
        const terminatedAt = yield* Clock.currentTimeMillis
        const record = buildRecord(call, terminatedAt)
        const encoded = yield* Schema.encodeEffect(JsonCdrRecord)(record).pipe(
          Effect.orDie,
        )
        const line = encoded + "\n"
        yield* Effect.callback<void>((resume) => {
          fs.appendFile(filePath, line, "utf8", (err) => {
            resume(err ? Effect.die(err) : Effect.void)
          })
        })
        yield* Effect.logDebug(`CDR written for call ${call.callRef}`)
      })

      const readAll: Effect.Effect<ReadonlyArray<CdrRecord>> = Effect.gen(function* () {
        const exists = yield* Effect.sync(() => fs.existsSync(filePath))
        if (!exists) return []
        const raw = yield* Effect.callback<string>((resume) => {
          fs.readFile(filePath, "utf8", (err, data) =>
            resume(err ? Effect.die(err) : Effect.succeed(data))
          )
        })
        const lines = raw.split("\n").filter((l) => l.length > 0)
        const decoded: CdrRecord[] = []
        for (const line of lines) {
          const r = yield* Schema.decodeEffect(JsonCdrRecord)(line).pipe(Effect.orDie)
          decoded.push(r)
        }
        return decoded
      })

      return { write, readAll }
    })
  )

  /**
   * In-memory CDR layer for fake-clock tests. `write` appends to a private
   * array; `readAll` returns it. The test harness uses this to assert that
   * every terminated call produced a CDR record (proves cleanup ran). Not
   * for production use — records vanish on layer teardown.
   *
   * Per-instance: each layer scope gets a fresh array. For multi-worker
   * SUTs that need to aggregate CDRs across all workers (failover, HA),
   * use `CdrWriter.sharedTestLayer(buffer)` with a pre-built shared buffer.
   */
  static readonly testLayer = Layer.effect(
    CdrWriter,
    Effect.sync(() => buildTestService(makeCdrRecordsBuffer()))
  )

  /**
   * Shared in-memory CDR layer — every worker stack provided this layer
   * writes into the same buffer. Multi-worker test SUTs (sipproxyHA,
   * k8sFailover, registrarFrontProxy) build one buffer at the SUT layer,
   * pass `sharedTestLayer(buffer)` to every worker's `b2buaWorkerStackLayer`,
   * AND merge the layer at the outer scope so the harness can read the
   * aggregated records via `yield* CdrWriter`.
   */
  static sharedTestLayer(buffer: CdrRecordsBuffer): Layer.Layer<CdrWriter> {
    return Layer.succeed(CdrWriter, buildTestService(buffer))
  }
}

/**
 * Mutable CDR record buffer. Exposed so multi-worker test SUTs can wire
 * the same buffer into every worker via `CdrWriter.sharedTestLayer`.
 */
export interface CdrRecordsBuffer {
  readonly records: CdrRecord[]
}

export const makeCdrRecordsBuffer = (): CdrRecordsBuffer => ({ records: [] })

const buildTestService = (
  buffer: CdrRecordsBuffer,
): { readonly write: (call: Call) => Effect.Effect<void>; readonly readAll: Effect.Effect<ReadonlyArray<CdrRecord>> } => {
  const write = Effect.fnUntraced(function* (call: Call) {
    const terminatedAt = yield* Clock.currentTimeMillis
    buffer.records.push(buildRecord(call, terminatedAt))
    yield* Effect.logDebug(`CDR recorded (test layer) for call ${call.callRef}`)
  })
  const readAll: Effect.Effect<ReadonlyArray<CdrRecord>> = Effect.sync(() => buffer.records.slice())
  return { write, readAll }
}
