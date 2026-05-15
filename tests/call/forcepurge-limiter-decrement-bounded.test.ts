/**
 * Phase 7 of docs/plan/2026-05-15-StructuralEffectGuarantees-moth.md.
 *
 * `forcePurgeOne` calls `limiter.decrement` for every limiter slot the
 * purged call held. A stalled Redis here used to wedge force-purge
 * indefinitely. Trap 4 + Phase 7: wrap each DECR in
 * `Effect.timeoutOrElse({ duration: limiterDecrementTimeoutMs })` so a
 * slow leak (acceptable per limiter window rotation semantics) cannot
 * become a stalled worker fiber.
 */

import { describe, expect, it } from "@effect/vitest"
import { TestClock } from "effect/testing"
import { Effect, Fiber, Layer, MutableHashMap, Schema, ServiceMap } from "effect"
import { AppConfig } from "../../src/config/AppConfig.js"
import { CallLimiter } from "../../src/call/CallLimiter.js"
import { CallState } from "../../src/call/CallState.js"
import {
  PartitionedRelayStorage,
  type PartitionedRelayStorageApi,
} from "../../src/cache/PartitionedRelayStorage.js"
import { BufferedTerminateWriter } from "../../src/cache/BufferedTerminateWriter.js"
import { TimerService } from "../../src/call/TimerService.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { CdrWriter } from "../../src/cdr/CdrWriter.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"
import type { Call, Leg } from "../../src/call/CallModel.js"
import { Stream } from "effect"

void Schema
void ServiceMap
void MutableHashMap

const makeLeg = (callId: string, fromTag: string): Leg => ({
  legId: "a",
  callId,
  fromTag,
  source: { address: "127.0.0.1", port: 5060 },
  state: "confirmed",
  disposition: "bridged",
  dialogs: [],
  byeDisposition: "bye_sent",
})

const makeTerminatingCall = (callId: string, fromTag: string): Call => ({
  callRef: `${callId}|${fromTag}`,
  aLeg: makeLeg(callId, fromTag),
  bLegs: [],
  activePeer: null,
  limiterEntries: [{ limiterId: "lim-1", limit: 1, originWindow: 0 }],
  timers: [],
  cdrEvents: [],
  state: "terminating",
  createdAt: 0,
  aLegInvite: {
    uri: "sip:bob@example.com",
    headers: [],
    body: new Uint8Array(),
  },
  tagMap: [],
})

/** A CallLimiter whose `decrement` blocks forever — to exercise the timeout. */
function makeBlockingLimiter(): {
  layer: Layer.Layer<CallLimiter>
  decrementCount: () => number
} {
  let decrementCount = 0
  const api: CallLimiter["Service"] = {
    checkAndIncrement: () => Effect.succeed({ allowed: true, currentWindow: 0 }),
    decrement: () =>
      Effect.callback<void>((_resume) => {
        decrementCount++
        // Never resume — simulates a hung Redis.
      }),
    refresh: () => Effect.succeed(0),
  } as unknown as CallLimiter["Service"]
  return {
    layer: Layer.succeed(CallLimiter, api),
    decrementCount: () => decrementCount,
  }
}

/** No-op storage stub. */
const noopStorage: Layer.Layer<PartitionedRelayStorage> = Layer.succeed(
  PartitionedRelayStorage,
  {
    getCall: () => Effect.succeed(null),
    getIndex: () => Effect.succeed(null),
    putCall: () => Effect.void,
    refreshCall: () => Effect.void,
    deleteCall: () => Effect.void,
    scanCalls: () => Stream.empty,
  } satisfies PartitionedRelayStorageApi,
)

const noopCdr: Layer.Layer<CdrWriter> = Layer.succeed(CdrWriter, {
  write: () => Effect.void,
  readAll: Effect.succeed([]),
} as unknown as CdrWriter["Service"])

describe("forcePurgeOne — limiter decrement is bounded", () => {
  it.effect("hung limiter.decrement does not pin force-purge", () => {
    const config = testAppConfigDefaults({
      limiterDecrementTimeoutMs: 100,
    })
    const AppCfg = Layer.succeed(AppConfig, config)

    const blocking = makeBlockingLimiter()

    const TimerL = TimerService.layer.pipe(
      Layer.provide(MetricsRegistry.layer),
      Layer.provide(AppCfg),
    )
    const BufferedTerminateL = BufferedTerminateWriter.layer.pipe(
      Layer.provide(noopStorage),
      Layer.provide(AppCfg),
      Layer.provide(MetricsRegistry.layer),
    )
    const CallStateL = CallState.layer.pipe(
      Layer.provide(noopStorage),
      Layer.provide(BufferedTerminateL),
      Layer.provide(noopCdr),
      Layer.provide(MetricsRegistry.layer),
      Layer.provide(TimerL),
      Layer.provide(blocking.layer),
      Layer.provide(AppCfg),
    )

    return Effect.gen(function* () {
      const state = yield* CallState
      const call = makeTerminatingCall("call-bound", "tagBound")
      yield* state.create(call)

      // Force-purge with a hung limiter — the timeout MUST cut the
      // decrement short and let the purge complete.
      const purgeFiber = yield* Effect.forkChild(
        state.forcePurge(call.callRef, "test"),
      )

      // Advance past the limiter timeout window.
      yield* TestClock.adjust("200 millis")

      // The purge fiber should now have completed.
      const exit = yield* Fiber.await(purgeFiber)
      expect(exit._tag).toBe("Success")

      // limiter.decrement was attempted exactly once.
      expect(blocking.decrementCount()).toBe(1)
    }).pipe(Effect.provide(CallStateL))
  })
})
