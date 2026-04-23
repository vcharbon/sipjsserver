/**
 * CdrWriter service — appends one JSON line per call to a CDR file on termination.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { Clock, Effect, Layer, Schema, ServiceMap } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import type { Call } from "../call/CallModel.js"
import { CdrEvent, LegDisposition, LegState } from "../call/CallModel.js"

const CdrRecord = Schema.Struct({
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

const JsonCdrRecord = Schema.fromJsonString(CdrRecord)

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CdrWriter extends ServiceMap.Service<
  CdrWriter,
  {
    /** Write a completed call's CDR events as a single JSON line. */
    readonly write: (call: Call) => Effect.Effect<void>
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
        const record = {
          callRef: call.callRef,
          createdAt: call.createdAt,
          terminatedAt,
          aLeg: {
            callId: call.aLeg.callId,
            fromTag: call.aLeg.fromTag,
            state: call.aLeg.state
          },
          bLegs: call.bLegs.map((leg) => ({
            legId: leg.legId,
            callId: leg.callId,
            state: leg.state,
            disposition: leg.disposition
          })),
          events: call.cdrEvents,
          ...(call.billingContext !== undefined ? { billingContext: call.billingContext } : {}),
        }
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

      return { write }
    })
  )
}
