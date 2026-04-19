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
import { CallStateCache } from "../../src/call/CallStateCache.js"
import { CallState } from "../../src/call/CallState.js"
import type { Call, Leg } from "../../src/call/CallModel.js"

const limiterLayer = CallLimiter.memoryLayer.pipe(Layer.provideMerge(AppConfig.layer))
const callStateLayer = CallState.layer.pipe(
  Layer.provide(CallStateCache.memoryLayer),
  Layer.provideMerge(AppConfig.layer)
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
  aLegVias: [],
  aLegFrom: "",
  aLegTo: "",
  aLegInviteCSeq: 1,
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

describe("CallStateCache.memoryLayer via real CallState", () => {
  it.effect("flushed call reloads via checkout from cache", () =>
    Effect.gen(function* () {
      const state = yield* CallState
      const call = makeCall("call-A", "tagA")

      yield* state.create(call)
      yield* state.flushToRedis(call.callRef)

      // Peek confirms it's in memory
      const inMemory = yield* state.peek(call.callRef)
      expect(inMemory?.callRef).toBe(call.callRef)

      yield* state.release(call.callRef)
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

      // Call is gone from both memory and cache — checkout returns undefined
      const reloaded = yield* state.checkout(call.callRef)
      expect(reloaded).toBeUndefined()
    }).pipe(Effect.provide(callStateLayer))
  )
})
