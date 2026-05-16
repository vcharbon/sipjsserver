/**
 * Phase 5 regression — `CallState.update` auto-installs the
 * `terminating_timeout` safety net on every transition into
 * `terminating`, atomically (under `Effect.uninterruptibleMask`),
 * with NO rule-chain involvement.
 *
 * This locks the structural guarantee from
 * docs/adr/0003-must-run-effects-under-interruption.md and the plan
 * docs/plan/this-kind-of-issue-flickering-moth.md. Pre-Phase-5 the
 * rule chain emitted `schedule-timer(terminating_timeout)` as a
 * separate effect that the interpreter could skip if a slow outbound
 * yield blew the per-handler budget; now the install is part of
 * `update` itself.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { CallState } from "../../src/call/CallState.js"
import { TimerService } from "../../src/call/TimerService.js"
import type { Call, Leg } from "../../src/call/CallModel.js"
import { fakeStackLayer } from "../support/fakeStack.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

const stack = fakeStackLayer({
  config: testAppConfigDefaults({
    sipLocalIp: "127.0.0.1",
    sipLocalPort: 15082,
  }),
})

function makeActiveCall(callRef: string): Call {
  const aLeg: Leg = {
    legId: "a",
    callId: "callid-A",
    fromTag: "uac-tag",
    source: { address: "127.0.0.1", port: 5060 },
    state: "confirmed",
    disposition: "confirmed",
    dialogs: [],
  }
  return {
    callRef,
    aLeg,
    bLegs: [],
    activePeer: null,
    limiterEntries: [],
    timers: [],
    cdrEvents: [],
    state: "active",
    createdAt: 0,
    sampled: false,
  }
}

describe("CallState.update — structural safety-net install on transition to terminating", () => {
  it.effect(
    "an active → terminating transition arms a terminating_timeout fiber in TimerService and appends the matching entry to call.timers",
    () =>
      Effect.gen(function* () {
        const callState = yield* CallState
        const timers = yield* TimerService

        const callRef = "self|call-auto-arm"
        yield* callState.create(makeActiveCall(callRef))

        // Pre-transition: no timer scheduled.
        expect(yield* timers.activeCount()).toBe(0)

        // Transition directly via `update` — no rule chain at all.
        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }))

        // Post-transition: safety fiber present in TimerService.
        expect(yield* timers.activeCount()).toBe(1)

        // And the timer entry is in `call.timers` so `flushToRedis`
        // persists it for crash recovery.
        const after = yield* callState.peek(callRef)
        const safety = after?.timers.find((t) => t.type === "terminating_timeout")
        expect(safety).toBeDefined()
        expect(safety?.id).toBe(`terminating-timeout-${callRef}`)
      }).pipe(Effect.provide(stack)),
  )

  it.effect(
    "Stage 4: updates while in `terminating` REFRESH the safety timer fireAt (replaces former idempotent contract)",
    () =>
      Effect.gen(function* () {
        const callState = yield* CallState
        const timers = yield* TimerService

        const callRef = "self|call-refresh-on-update"
        yield* callState.create(makeActiveCall(callRef))

        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }))
        const firstSafetyId = `terminating-timeout-${callRef}`
        const firstFireAt = (yield* callState.peek(callRef))?.timers.find(
          (t) => t.id === firstSafetyId,
        )?.fireAt

        // Advance virtual clock so the refreshed fireAt is provably later.
        yield* TestClock.adjust("10 seconds")
        yield* Effect.yieldNow

        // Another mutation while still terminating — refreshes fireAt.
        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }))

        const after = yield* callState.peek(callRef)
        const refreshed = after?.timers.find((t) => t.id === firstSafetyId)
        expect(refreshed?.fireAt).toBeGreaterThan(firstFireAt ?? 0)
        // Still exactly one timer fiber — replaceTimerById + schedule
        // cancels the prior fiber and installs a new one under the same id.
        expect(yield* timers.activeCount()).toBe(1)
      }).pipe(Effect.provide(stack)),
  )

  it.effect(
    "advancing past TERMINATING_TIMEOUT_MS fires the safety handler and force-purges the call",
    () =>
      Effect.gen(function* () {
        const callState = yield* CallState

        const callRef = "self|call-safety-fires"
        yield* callState.create(makeActiveCall(callRef))
        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }))

        // Drive past TERMINATING_TIMEOUT_MS (17 min). 30 s slices keep
        // virtual-clock progress visible to each sleeping fiber.
        for (let i = 0; i < 36; i++) {
          yield* TestClock.adjust("30 seconds")
          yield* Effect.yieldNow
        }

        // Call has been removed by forcePurge.
        const after = yield* callState.peek(callRef)
        expect(after).toBeUndefined()
      }).pipe(Effect.provide(stack)),
  )

  it.effect(
    "Stage 4: orphan sweep refreshes on peer activity — late update inside `terminating` postpones the safety fire",
    () =>
      Effect.gen(function* () {
        const callState = yield* CallState

        const callRef = "self|call-refresh-postpones-safety"
        yield* callState.create(makeActiveCall(callRef))
        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }))

        // 8 minutes in — half-way through the 17-min window. The call
        // simulates an in-flight peer response: stays terminating but
        // gets a mutating update (e.g. byeDisposition flip on one leg).
        for (let i = 0; i < 16; i++) {
          yield* TestClock.adjust("30 seconds")
          yield* Effect.yieldNow
        }
        yield* callState.update(callRef, (c) => ({
          ...c,
          state: "terminating",
          // Touch some inert field so the update is non-trivial.
          cdrEvents: [...c.cdrEvents],
        }))

        // Now advance another 16 min total (8 min from refresh point).
        // Without refresh, safety would have fired at minute 17 — the
        // call would be gone here. With refresh (re-armed at minute 8
        // for +17), it survives until ~minute 25.
        for (let i = 0; i < 16; i++) {
          yield* TestClock.adjust("30 seconds")
          yield* Effect.yieldNow
        }

        const stillPresent = yield* callState.peek(callRef)
        expect(stillPresent).toBeDefined()
        expect(stillPresent?.state).toBe("terminating")

        // Drive past the refreshed deadline.
        for (let i = 0; i < 36; i++) {
          yield* TestClock.adjust("30 seconds")
          yield* Effect.yieldNow
        }
        const after = yield* callState.peek(callRef)
        expect(after).toBeUndefined()
      }).pipe(Effect.provide(stack)),
  )
})
