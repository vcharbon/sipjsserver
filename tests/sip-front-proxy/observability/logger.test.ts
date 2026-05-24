/**
 * PR6 — ProxyLogger structured-logging surface.
 *
 * Captures the log record by installing a custom `Logger` that pushes
 * each entry into an array, then asserts the routing-decision log
 * carries the canonical correlation fields under `annotations`.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Logger, References } from "effect"
import { ProxyLogger } from "../../../src/sip-front-proxy/index.js"

interface CapturedLog {
  readonly level: string
  readonly message: unknown
  readonly annotations: Readonly<Record<string, unknown>>
}

/** Build a logger that pushes each entry into `sink`. */
const makeCapturingLogger = (sink: CapturedLog[]) =>
  Logger.make((opts) => {
    const annotations = opts.fiber.getRef(References.CurrentLogAnnotations)
    sink.push({
      level: opts.logLevel,
      message: opts.message,
      annotations: { ...(annotations as Readonly<Record<string, unknown>>) },
    })
  })

describe("sip-front-proxy/observability — ProxyLogger", () => {
  it.effect("routingDecision log emits at Debug level with annotations", () =>
    Effect.gen(function* () {
      const sink: CapturedLog[] = []
      yield* Effect.gen(function* () {
        const logger = yield* ProxyLogger
        yield* logger.routingDecision({
          callId: "call-abc@host",
          method: "INVITE",
          decision: "select_new",
          strategy: "TestStrategy",
          target: "10.0.1.0:5060",
          message: "forwarded INVITE",
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Logger.layer([makeCapturingLogger(sink)]),
            ProxyLogger.Default
          )
        ),
        // Hot-path routing-decision was demoted Info→Debug to drop ~3.9k
        // records/sec at 10 CAPS. The annotated fields remain — they're
        // also covered by the routing-decision metrics.
        Effect.provideService(References.MinimumLogLevel, "Debug")
      )

      expect(sink.length).toBe(1)
      const entry = sink[0]!
      expect(entry.level).toBe("Debug")
      // Effect wraps the log message in an array (it accepts variadic args).
      expect(entry.message).toEqual(["forwarded INVITE"])
      expect(entry.annotations["sip.callid"]).toBe("call-abc@host")
      expect(entry.annotations["sip.method"]).toBe("INVITE")
      expect(entry.annotations["routing.decision"]).toBe("select_new")
      expect(entry.annotations["routing.strategy"]).toBe("TestStrategy")
      expect(entry.annotations["worker.target"]).toBe("10.0.1.0:5060")
    })
  )

  it.effect("withCallCorrelation propagates annotations to inner logs", () =>
    Effect.gen(function* () {
      const sink: CapturedLog[] = []
      yield* Effect.gen(function* () {
        const logger = yield* ProxyLogger
        yield* logger.withCallCorrelation(
          "call-xyz@host",
          "BYE",
          Effect.logInfo("inner")
        )
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Logger.layer([makeCapturingLogger(sink)]),
            ProxyLogger.Default
          )
        ),
        Effect.provideService(References.MinimumLogLevel, "Info")
      )
      expect(sink.length).toBe(1)
      expect(sink[0]!.annotations["sip.callid"]).toBe("call-xyz@host")
      expect(sink[0]!.annotations["sip.method"]).toBe("BYE")
    })
  )
})
