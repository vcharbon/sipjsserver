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
    "calling update again on an already-terminating call does NOT re-install the timer (idempotent)",
    () =>
      Effect.gen(function* () {
        const callState = yield* CallState
        const timers = yield* TimerService

        const callRef = "self|call-idempotent"
        yield* callState.create(makeActiveCall(callRef))

        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }))
        const firstSafetyId = `terminating-timeout-${callRef}`
        const firstFireAt = (yield* callState.peek(callRef))?.timers.find(
          (t) => t.id === firstSafetyId,
        )?.fireAt

        // Advance virtual clock so any re-install would compute a later fireAt.
        yield* TestClock.adjust("10 seconds")
        yield* Effect.yieldNow

        // Another mutation while still terminating — must not re-arm.
        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }))

        const after = yield* callState.peek(callRef)
        const stillThere = after?.timers.find((t) => t.id === firstSafetyId)
        expect(stillThere?.fireAt).toBe(firstFireAt)
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

        // Drive past the 64 s safety deadline in 1 s slices to give
        // each sleeping fiber a yield boundary.
        for (let i = 0; i < 70; i++) {
          yield* TestClock.adjust("1 second")
          yield* Effect.yieldNow
        }

        // Call has been removed by forcePurge.
        const after = yield* callState.peek(callRef)
        expect(after).toBeUndefined()
      }).pipe(Effect.provide(stack)),
  )
})
