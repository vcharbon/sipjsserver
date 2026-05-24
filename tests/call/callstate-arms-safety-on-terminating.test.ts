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
import { TERMINATING_TIMEOUT_MS } from "../../src/call/timer-helpers.js"
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
    disposition: "bridged",
    dialogs: [],
  }
  return {
    callRef,
    aLeg,
    aLegInvite: { uri: "sip:dest@example.com", headers: [], body: new Uint8Array() },
    tagMap: [],
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
    "per-leg refresh budget: first update from a leg refreshes fireAt; second update from the same leg does NOT",
    () =>
      Effect.gen(function* () {
        const callState = yield* CallState
        const timers = yield* TimerService

        const callRef = "self|call-refresh-per-leg"
        yield* callState.create(makeActiveCall(callRef))

        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }))
        const safetyId = `terminating-timeout-${callRef}`
        const fireAtOnEntry = (yield* callState.peek(callRef))?.timers.find(
          (t) => t.id === safetyId,
        )?.fireAt

        // 1) First update from leg "a" while still terminating — refreshes.
        yield* TestClock.adjust("10 seconds")
        yield* Effect.yieldNow
        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }), "a")
        const fireAtAfterA1 = (yield* callState.peek(callRef))?.timers.find(
          (t) => t.id === safetyId,
        )?.fireAt
        expect(fireAtAfterA1).toBeGreaterThan(fireAtOnEntry ?? 0)

        // 2) Second update from leg "a" — budget consumed, no refresh.
        yield* TestClock.adjust("10 seconds")
        yield* Effect.yieldNow
        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }), "a")
        const fireAtAfterA2 = (yield* callState.peek(callRef))?.timers.find(
          (t) => t.id === safetyId,
        )?.fireAt
        expect(fireAtAfterA2).toBe(fireAtAfterA1)

        // 3) First update from leg "b" — its own budget, refreshes.
        yield* TestClock.adjust("10 seconds")
        yield* Effect.yieldNow
        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }), "b")
        const fireAtAfterB1 = (yield* callState.peek(callRef))?.timers.find(
          (t) => t.id === safetyId,
        )?.fireAt
        expect(fireAtAfterB1).toBeGreaterThan(fireAtAfterA2 ?? 0)

        // 4) Update with no sourceLegId — never refreshes (synthetic updates).
        yield* TestClock.adjust("10 seconds")
        yield* Effect.yieldNow
        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }))
        const fireAtAfterAnon = (yield* callState.peek(callRef))?.timers.find(
          (t) => t.id === safetyId,
        )?.fireAt
        expect(fireAtAfterAnon).toBe(fireAtAfterB1)

        // Still exactly one timer fiber throughout — replaceTimerById +
        // schedule cancels the prior fiber and installs a new one under
        // the same id on refreshes; non-refreshes leave the existing fiber.
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

        // Drive past TERMINATING_TIMEOUT_MS in fine-grained slices so
        // each sleeping fiber sees virtual-clock progress. Slice size
        // is one tenth of the timeout (min 100 ms) so the test scales
        // with the constant.
        const sliceMs = Math.max(100, Math.floor(TERMINATING_TIMEOUT_MS / 10))
        const advanceMs = TERMINATING_TIMEOUT_MS + sliceMs
        const slices = Math.ceil(advanceMs / sliceMs)
        for (let i = 0; i < slices; i++) {
          yield* TestClock.adjust(`${sliceMs} millis`)
          yield* Effect.yieldNow
        }

        // Call has been removed by forcePurge.
        const after = yield* callState.peek(callRef)
        expect(after).toBeUndefined()
      }).pipe(Effect.provide(stack)),
  )

  it.effect(
    "a first-time per-leg update inside `terminating` postpones the safety fire by one window",
    () =>
      Effect.gen(function* () {
        const callState = yield* CallState

        const callRef = "self|call-refresh-postpones-safety"
        yield* callState.create(makeActiveCall(callRef))
        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }))

        const sliceMs = Math.max(100, Math.floor(TERMINATING_TIMEOUT_MS / 10))
        const halfWindowMs = Math.floor(TERMINATING_TIMEOUT_MS / 2)
        const advanceBy = (totalMs: number) =>
          Effect.gen(function* () {
            const slices = Math.ceil(totalMs / sliceMs)
            for (let i = 0; i < slices; i++) {
              yield* TestClock.adjust(`${sliceMs} millis`)
              yield* Effect.yieldNow
            }
          })

        // Half-window in. The call simulates an in-flight peer response
        // from leg "a" (its first and only budgeted refresh).
        yield* advanceBy(halfWindowMs)
        yield* callState.update(callRef, (c) => ({
          ...c,
          state: "terminating",
          // Touch some inert field so the update is non-trivial.
          cdrEvents: [...c.cdrEvents],
        }), "a")

        // Advance another half-window. Without refresh, safety would
        // have fired at exactly one full window — call would be gone.
        // With the leg-"a" refresh (re-armed at the half-window mark),
        // it survives until ~1.5 windows from entry.
        yield* advanceBy(halfWindowMs)

        const stillPresent = yield* callState.peek(callRef)
        expect(stillPresent).toBeDefined()
        expect(stillPresent?.state).toBe("terminating")

        // Drive past the refreshed deadline.
        yield* advanceBy(TERMINATING_TIMEOUT_MS + sliceMs)
        const after = yield* callState.peek(callRef)
        expect(after).toBeUndefined()
      }).pipe(Effect.provide(stack)),
  )

  it.effect(
    "adversarial refresh: repeated updates from the SAME leg cannot keep a terminating call alive past TERMINATING_TIMEOUT_MS",
    () =>
      Effect.gen(function* () {
        const callState = yield* CallState

        const callRef = "self|call-adversarial-refresh"
        yield* callState.create(makeActiveCall(callRef))
        yield* callState.update(callRef, (c) => ({ ...c, state: "terminating" }))

        const sliceMs = Math.max(100, Math.floor(TERMINATING_TIMEOUT_MS / 10))
        const advanceBy = (totalMs: number) =>
          Effect.gen(function* () {
            const slices = Math.ceil(totalMs / sliceMs)
            for (let i = 0; i < slices; i++) {
              yield* TestClock.adjust(`${sliceMs} millis`)
              yield* Effect.yieldNow
            }
          })

        // Burn the per-leg refresh once at one slice in.
        yield* advanceBy(sliceMs)
        yield* callState.update(callRef, (c) => ({
          ...c,
          state: "terminating",
          cdrEvents: [...c.cdrEvents],
        }), "a")

        // Now hammer with further updates from the same leg every
        // slice. After the first refresh (above) the budget for "a"
        // is exhausted, so none of these should extend the window.
        // Advance enough to cover 2.5× the timeout — well past even
        // the post-refresh deadline.
        const advanceMs = Math.ceil(TERMINATING_TIMEOUT_MS * 2.5)
        const slices = Math.ceil(advanceMs / sliceMs)
        for (let i = 0; i < slices; i++) {
          yield* TestClock.adjust(`${sliceMs} millis`)
          yield* Effect.yieldNow
          yield* callState.update(callRef, (c) => ({
            ...c,
            state: "terminating",
            cdrEvents: [...c.cdrEvents],
          }), "a")
        }

        // Refreshed deadline was at (sliceMs + TERMINATING_TIMEOUT_MS);
        // we're past 2.5× the timeout → gone.
        const after = yield* callState.peek(callRef)
        expect(after).toBeUndefined()
      }).pipe(Effect.provide(stack)),
  )
})
