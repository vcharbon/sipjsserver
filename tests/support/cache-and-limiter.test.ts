/**
 * Tests for the in-memory service layer variants (`CallLimiter.memoryLayer`,
 * `CallStateCache.memoryLayer`).
 *
 * These tests run under @effect/vitest's TestClock so window rollover and
 * cache TTL expiration can be advanced deterministically without sleeping.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AppConfig } from "../../src/config/AppConfig.js"
import { CallLimiter } from "../../src/call/CallLimiter.js"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"
import { CallState } from "../../src/call/CallState.js"
import { TimerService } from "../../src/call/TimerService.js"
import type { Call, Leg } from "../../src/call/CallModel.js"
import { NoOpCdrLayer } from "./networkLeaves.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"

const limiterLayer = CallLimiter.memoryLayer.pipe(Layer.provideMerge(AppConfig.layer))
// Slice 1.5: CallState now drops timer fibers as part of every cleanup
// path (remove / orphan sweep / force-purge), so it depends on
// TimerService. Provide the same MetricsRegistry instance to both so
// timer counters and call-state buckets land in one place.
const timerLayer = TimerService.layer.pipe(
  Layer.provide(MetricsRegistry.layer),
  Layer.provide(AppConfig.layer),
)
// CallState's orphan-sweep decrement path needs the SAME CallLimiter instance
// the test asserts against, so expose it upstream via `provideMerge`.
// Slice 4 endurance hardening: CallState now publishes terminating-bucket
// metrics into the registry, so a registry instance must be in scope.
const callStateLayer = CallState.layer.pipe(
  Layer.provide(PartitionedRelayStorage.memoryLayer),
  Layer.provide(NoOpCdrLayer),
  Layer.provide(MetricsRegistry.layer),
  Layer.provide(timerLayer),
  Layer.provideMerge(limiterLayer)
)

const makeLeg = (callId: string, fromTag: string): Leg => ({
  legId: "a",
  callId,
  fromTag,
  source: { address: "127.0.0.1", port: 5060 },
  state: "trying",
  disposition: "pending",
  dialogs: []
})

const makeCall = (callId: string, fromTag: string): Call => ({
  callRef: `${callId}|${fromTag}`,
  aLeg: makeLeg(callId, fromTag),
  bLegs: [],
  activePeer: null,
  limiterEntries: [],
  timers: [],
  cdrEvents: [],
  state: "active",
  createdAt: 0,
  aLegInvite: {
    uri: "sip:test@example.com",
    headers: [],
    body: new Uint8Array(),
  },
  tagMap: []
})

describe("CallLimiter.memoryLayer", () => {
  it.effect("rejects after limit is hit and recovers after windows expire", () =>
    Effect.gen(function* () {
      const lim = yield* CallLimiter
      const config = yield* AppConfig

      // Limit 2 — fill it
      const r1 = yield* lim.checkAndIncrement("foo", 2)
      const r2 = yield* lim.checkAndIncrement("foo", 2)
      const r3 = yield* lim.checkAndIncrement("foo", 2)
      expect(r1.allowed).toBe(true)
      expect(r2.allowed).toBe(true)
      expect(r3.allowed).toBe(false)

      // Advance past all active windows worth of time
      const advanceSec = config.limiterWindowSeconds * config.limiterActiveWindows + 1
      yield* TestClock.adjust(`${advanceSec} seconds`)

      // Old window counts should no longer contribute (TTL is much longer than
      // window*active, but the *summed* windows have rolled out of the active set)
      const r4 = yield* lim.checkAndIncrement("foo", 2)
      expect(r4.allowed).toBe(true)
    }).pipe(Effect.provide(limiterLayer))
  )

  it.effect("refresh migrates count from origin window to current window across rollover", () =>
    Effect.gen(function* () {
      const lim = yield* CallLimiter
      const config = yield* AppConfig

      const first = yield* lim.checkAndIncrement("bar", 5)
      expect(first.allowed).toBe(true)

      // Roll over one window
      yield* TestClock.adjust(`${config.limiterWindowSeconds + 1} seconds`)

      const newWin = yield* lim.refresh("bar", first.currentWindow)
      expect(newWin).not.toBe(first.currentWindow)

      // After refresh, the count lives in the new window and still counts toward limit
      const r = yield* lim.checkAndIncrement("bar", 1)
      expect(r.allowed).toBe(false) // already 1 in current → at limit
    }).pipe(Effect.provide(limiterLayer))
  )
})

describe("PartitionedRelayStorage.memoryLayer via real CallState", () => {
  it.effect("flushed call reloads via checkout from cache", () =>
    Effect.gen(function* () {
      const state = yield* CallState
      const call = makeCall("call-A", "tagA")

      yield* state.create(call)
      yield* state.flushToRedis(call.callRef)

      // Peek confirms it's in memory
      const inMemory = yield* state.peek(call.callRef)
      expect(inMemory?.callRef).toBe(call.callRef)
    }).pipe(Effect.provide(callStateLayer))
  )

  it.effect("remove() immediately deletes from both memory and cache", () =>
    Effect.gen(function* () {
      // After the terminating-state redesign, remove() does an immediate
      // delete (not expire) because the "terminating" state already waited
      // for all BYE transactions to resolve before calling remove().
      const state = yield* CallState
      const call = makeCall("call-B", "tagB")

      yield* state.create(call)
      yield* state.flushToRedis(call.callRef)
      yield* state.remove(call.callRef)

      // Call is gone from both memory and cache — withCall sees undefined
      const reloaded = yield* state.withCall(call.callRef, (c) => Effect.succeed(c))
      expect(reloaded).toBeUndefined()
    }).pipe(Effect.provide(callStateLayer))
  )

  it.effect("orphan sweep decrements limiterEntries for stuck terminating calls", () =>
    // Regression: production endurance run 2026-05-05 leaked one limiter
    // INCR per orphan-swept call. The rule path's `InvariantEnforcer`
    // emits `decrement-limiter` on the terminating→terminated promotion,
    // but the CallState orphan sweep took a different code path (CDR +
    // delete only) and skipped the decrement. With ~10 orphans every
    // 15 min, the probe `inflight` ratcheted up to 2× cap.
    Effect.gen(function* () {
      const lim = yield* CallLimiter
      const state = yield* CallState

      // 1. Admit a call against a fresh limiter id — count = 1, limit = 1.
      const admitted = yield* lim.checkAndIncrement("orphan-sweep-leak", 1)
      expect(admitted.allowed).toBe(true)

      // 2. Confirm the limiter is saturated (no further admissions).
      const denied = yield* lim.checkAndIncrement("orphan-sweep-leak", 1)
      expect(denied.allowed).toBe(false)

      // 3. Build a `terminating` call that holds the limiter slot —
      //    mirrors the on-the-wire state between BYE-arrival and the
      //    BYE-200-OK that never comes back.
      const base = makeCall("call-leak", "tagL")
      const stuck: Call = {
        ...base,
        state: "terminating",
        aLeg: { ...base.aLeg, byeDisposition: "bye_sent" },
        limiterEntries: [{
          limiterId: "orphan-sweep-leak",
          limit: 1,
          originWindow: admitted.currentWindow,
        }],
      }
      yield* state.create(stuck)

      // 4. Drive the orphan sweep daemon (60s interval). +1s margin so
      //    the next loop tick fully completes its sweep body.
      yield* TestClock.adjust("61 seconds")

      // 5. Limiter slot must be released — a fresh admission proves it.
      const after = yield* lim.checkAndIncrement("orphan-sweep-leak", 1)
      expect(after.allowed).toBe(true)
    }).pipe(Effect.provide(callStateLayer))
  )
})
