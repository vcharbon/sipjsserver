/**
 * BufferedCdrLayer — drop-on-overload contract.
 *
 * Phase 3 of docs/plan/2026-05-15-StructuralEffectGuarantees-moth.md.
 *
 * Asserts the structural property: when the bounded CDR queue saturates,
 * `submit` returns immediately (does not block call termination), the
 * dropped count climbs, and once the drainer catches up no records are
 * permanently lost beyond the drops.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { AppConfig } from "../../src/config/AppConfig.js"
import { CdrWriter } from "../../src/cdr/CdrWriter.js"
import { BufferedCdrLayer } from "../../src/cdr/BufferedCdrLayer.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"
import type { Call } from "../../src/call/CallModel.js"

/** Minimal Call stub — only fields BufferedCdrLayer touches via inner.write. */
const makeCall = (callRef: string): Call =>
  ({
    callRef,
    aLeg: { callId: callRef, fromTag: "tagA", state: "terminated" },
    bLegs: [],
    cdrEvents: [],
    createdAt: 0,
  }) as unknown as Call

/** A blocking inner CDR writer driven by a manual gate. */
function makeBlockingInner(): {
  layer: Layer.Layer<CdrWriter>
  release: () => void
  count: () => number
} {
  let writeCount = 0
  const pending: Array<() => void> = []
  const layer = Layer.succeed(CdrWriter, {
    write: (_call: Call) =>
      Effect.callback<void>((resume) => {
        writeCount++
        pending.push(() => resume(Effect.void))
      }),
    readAll: Effect.succeed([]),
  } as unknown as CdrWriter["Service"])
  return {
    layer,
    release: () => {
      const next = pending.shift()
      if (next) next()
    },
    count: () => writeCount,
  }
}

describe("BufferedCdrLayer", () => {
  it.effect(
    "saturated queue: submits stay non-blocking, drops counted, no loss after drain",
    () => {
      const queueMax = 4
      const config = testAppConfigDefaults({ cdrBufferQueueMax: queueMax })

      const blocking = makeBlockingInner()
      const Stack = BufferedCdrLayer.pipe(
        Layer.provide(blocking.layer),
        Layer.provideMerge(Layer.succeed(AppConfig, config)),
        Layer.provideMerge(MetricsRegistry.layer),
      )

      return Effect.gen(function* () {
        const cdr = yield* CdrWriter
        const registry = yield* MetricsRegistry

        // Yield several times so the drainer fiber gets scheduled and
        // parks on its `Queue.take`. Without this, all submits race the
        // drainer start.
        for (let i = 0; i < 4; i++) yield* Effect.yieldNow

        // First submit + yield: drainer wakes, takes "c-0", calls
        // inner.write (which parks in pending). The queue can then
        // hold queueMax additional entries.
        yield* cdr.write(makeCall("c-0"))
        for (let i = 0; i < 4; i++) yield* Effect.yieldNow

        // Now fill the queue + emit 3 overflow submits.
        const overflow = 3
        for (let i = 0; i < queueMax + overflow; i++) {
          yield* cdr.write(makeCall(`c-${i + 1}`))
        }

        // Submit must not block — we got here.
        const m = registry.cdrBuffer
        expect(m).toBeDefined()
        expect(m!.queueCapacity).toBe(queueMax)
        expect(m!.submitDroppedTotal()).toBe(overflow)

        // Release the drainer — accepted submissions complete.
        for (let i = 0; i < queueMax + 1; i++) {
          blocking.release()
          for (let j = 0; j < 4; j++) yield* Effect.yieldNow
        }

        // After full drain, no further drops accumulated.
        expect(m!.submitDroppedTotal()).toBe(overflow)
        // Inner write was called exactly for the accepted set.
        expect(blocking.count()).toBe(queueMax + 1)
      }).pipe(Effect.provide(Stack))
    },
  )

  it.effect(
    "cdrBufferQueueMax === 0 falls through to inner writer",
    () => {
      const config = testAppConfigDefaults({ cdrBufferQueueMax: 0 })
      let calls = 0
      const inner = Layer.succeed(CdrWriter, {
        write: (_call: Call) => Effect.sync(() => { calls++ }),
        readAll: Effect.succeed([]),
      } as unknown as CdrWriter["Service"])

      const Stack = BufferedCdrLayer.pipe(
        Layer.provide(inner),
        Layer.provideMerge(Layer.succeed(AppConfig, config)),
        Layer.provideMerge(MetricsRegistry.layer),
      )

      return Effect.gen(function* () {
        const cdr = yield* CdrWriter
        yield* cdr.write(makeCall("direct-1"))
        yield* cdr.write(makeCall("direct-2"))
        expect(calls).toBe(2)

        const m = (yield* MetricsRegistry).cdrBuffer
        expect(m!.queueCapacity).toBe(0)
        expect(m!.submitDroppedTotal()).toBe(0)
      }).pipe(Effect.provide(Stack))
    },
  )
})
