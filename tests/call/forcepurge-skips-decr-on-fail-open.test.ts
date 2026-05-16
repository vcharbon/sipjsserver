/**
 * Stage 2 of docs/plan/to-review-and-properly-swift-moler.md.
 *
 * When a limiter entry is admitted fail-open (Redis unreachable at INCR
 * time, recorded as `incrementSucceeded: false`), the matching DECR on
 * termination MUST be skipped — otherwise the cluster-wide counter
 * drifts negative (cause (2b) in the 2026-05-15 cascade post-mortem).
 *
 * This test sets up a `terminating` call with two limiter entries:
 *   - one with `incrementSucceeded: true`   → must DECR
 *   - one with `incrementSucceeded: false`  → must NOT DECR
 * Triggers `forcePurge` and asserts the limiter saw exactly one
 * decrement.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
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

const makeTerminatingCallWithMixedEntries = (callId: string, fromTag: string): Call => ({
  callRef: `${callId}|${fromTag}`,
  aLeg: makeLeg(callId, fromTag),
  bLegs: [],
  activePeer: null,
  limiterEntries: [
    // healthy INCR — must DECR on terminate
    { limiterId: "lim-ok", limit: 1, originWindow: 0, incrementSucceeded: true },
    // fail-open admission — INCR never landed, must NOT DECR
    { limiterId: "lim-fail-open", limit: 1, originWindow: 0, incrementSucceeded: false },
  ],
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

/** CallLimiter stub that records which limiterIds saw a DECR. */
function makeCountingLimiter(): {
  layer: Layer.Layer<CallLimiter>
  decrementedIds: () => ReadonlyArray<string>
} {
  const decremented: string[] = []
  const api: CallLimiter["Service"] = {
    checkAndIncrement: () => Effect.succeed({ _tag: "Allowed", currentWindow: 0 } as const),
    decrement: (limiterId: string) =>
      Effect.sync(() => {
        decremented.push(limiterId)
      }),
    refresh: () => Effect.succeed(0),
  } as unknown as CallLimiter["Service"]
  return {
    layer: Layer.succeed(CallLimiter, api),
    decrementedIds: () => decremented.slice(),
  }
}

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

describe("forcePurge — skips DECR on fail-open entries", () => {
  it.effect("decrement called only for incrementSucceeded === true entries", () => {
    const config = testAppConfigDefaults({ limiterDecrementTimeoutMs: 100 })
    const AppCfg = Layer.succeed(AppConfig, config)
    const counting = makeCountingLimiter()

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
      Layer.provide(counting.layer),
      Layer.provide(AppCfg),
    )

    return Effect.gen(function* () {
      const state = yield* CallState
      const call = makeTerminatingCallWithMixedEntries("call-mix", "tagMix")
      yield* state.create(call)
      yield* state.forcePurge(call.callRef, "test-fail-open-skip")

      const observed = counting.decrementedIds()
      expect(observed).toEqual(["lim-ok"])
      // explicit negative: the fail-open entry must NOT have been DECRed
      expect(observed.includes("lim-fail-open")).toBe(false)
    }).pipe(Effect.provide(CallStateL))
  })
})
