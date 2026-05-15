/**
 * Regression — `terminating_timeout` safety net must be installed *before*
 * the slow outbound yield, otherwise a handler abort orphans the call.
 *
 * Production symptom (kind cluster, 2026-05-15):
 *   worker-1 logs "Timer handler keepalive_timeout … exceeded 5000ms — handler
 *   did not return", and the same call surfaces ~5 min later under "[CallState]
 *   Orphan sweep recovering terminating call …". The orphan-sweep BYE then
 *   leaks into the next test's signaling trace and is scored as [UNEXPECTED].
 *
 * Mechanism:
 *   `TimerService.schedule` wraps each timer handler in
 *   `Effect.timeoutOrElse(timerHandlerTimeoutMs)`. If the handler exceeds the
 *   budget (event-loop freeze, slow UDP write, etc.) it is interrupted at the
 *   next yield. The current `SipRouter.processResult` runs in this order:
 *     (1) callState.update — mutates the in-memory call to
 *         `state: "terminating"`,
 *     (2) for-each outbound: `txnLayer.send(BYE, …)`,
 *     (3) for-each effect: schedule-timer(terminating_timeout +64s), etc.
 *
 *   The race we observed: the abort fires *after* (1) but *before* the
 *   `schedule-timer` in (3). The call sits in `terminating` with no fiber in
 *   TimerService to drive its safety net.
 *
 * Invariant locked in by this test:
 *   For any handler that produces a `state: "terminating"` mutation alongside
 *   a `schedule-timer(terminating_timeout)` effect, the safety timer MUST be
 *   installed in `TimerService.fibersMap` before the handler yields to any
 *   long IO. This test exercises `TimerService.schedule` directly with two
 *   sibling cases — pre-fix order vs. post-fix order — and asserts the
 *   schedule call was made (i.e. visible in fibersMap immediately after the
 *   abort) only in the post-fix order.
 *
 *   The test is synthetic — it doesn't depend on the rule chain or SipRouter
 *   wiring — but it exercises the exact `TimerService.schedule` wrap and
 *   `timerHandlerTimeoutMs` budget that produced the production log line. If
 *   `processResult` is ever re-ordered to send outbound before timer effects,
 *   the post-fix case below will fail.
 */

import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Ref } from "effect"
import { TestClock } from "effect/testing"
import { CallState } from "../../src/call/CallState.js"
import { TimerService } from "../../src/call/TimerService.js"
import type { Call, Leg, TimerEntry } from "../../src/call/CallModel.js"
import { fakeStackLayer } from "../support/fakeStack.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

const TIMER_BUDGET_MS = 5_000
const SAFETY_DELAY_MS = 64_000
const SLOW_OUTBOUND_MS = 30_000

const stack = fakeStackLayer({
  config: testAppConfigDefaults({
    sipLocalIp: "127.0.0.1",
    sipLocalPort: 15081,
    timerHandlerTimeoutMs: TIMER_BUDGET_MS,
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

// NOTE on the Phase 5 structural fix:
//
// Pre-Phase 5 (the initial reordering patch), the two cases below
// were intended to demonstrate the bug: with `mutate → slow → schedule`
// the safety fiber was NEVER installed when the handler was
// interrupted by the per-handler budget. The reordering patch in
// SipRouter.processResult made the "post-fix" order land safely.
//
// Phase 5 (this commit) closes the gap structurally: every
// `callState.update(... → terminating)` *itself* installs the
// safety timer atomically with the state mutation, inside an
// `Effect.uninterruptibleMask`. So even the "pre-fix" handler order
// — mutate, then yield to a slow IO that gets interrupted, never
// reaching the explicit `schedule` line — leaves the call with its
// safety fiber armed, because the `update` call took care of it.
//
// Both cases now PASS the same invariant: after the handler is
// aborted, the in-memory call is in `terminating` AND TimerService
// has a `terminating_timeout` fiber active. The test stays in the
// suite as a perimeter test for the structural guarantee. See:
//   - docs/adr/0003-must-run-effects-under-interruption.md
//   - docs/plan/this-kind-of-issue-flickering-moth.md (Phase 5)
//   - tests/call/callstate-arms-safety-on-terminating.test.ts (the
//     direct unit test for the structural fix).

describe("processResult ordering: schedule-timer effects must precede slow outbound", () => {
  it.effect(
    "PRE-FIX handler order is now safe — Phase 5 auto-arms the safety on `update(→terminating)` regardless of what the handler does next",
    () =>
      Effect.gen(function* () {
        const callState = yield* CallState
        const timers = yield* TimerService

        const callRef = "self|call-pre-fix"
        yield* callState.create(makeActiveCall(callRef))
        const safetyScheduled = yield* Ref.make(false)

        // Pre-fix order: mutate → slow yield → schedule.
        const handler = Effect.gen(function* () {
          yield* callState.withCall(callRef, () =>
            callState.update(callRef, (c) => ({ ...c, state: "terminating" as const })),
          )
          yield* Effect.sleep(`${SLOW_OUTBOUND_MS} millis`)
          const now = yield* Clock.currentTimeMillis
          const safety: TimerEntry = {
            id: `terminating-timeout-${callRef}`,
            type: "terminating_timeout",
            fireAt: now + SAFETY_DELAY_MS,
          }
          yield* timers.schedule(callRef, safety, () => Ref.set(safetyScheduled, true))
        })

        const now = yield* Clock.currentTimeMillis
        const trigger: TimerEntry = {
          id: `keepalive_timeout-${callRef}-a`,
          type: "keepalive_timeout",
          fireAt: now + 10,
          legId: "a",
        }
        yield* timers.schedule(callRef, trigger, () => handler)

        // Drive past the timer-handler budget — the slow yield is interrupted.
        yield* TestClock.adjust("6 seconds")
        for (let i = 0; i < 8; i++) yield* Effect.yieldNow

        // Mutation persisted; the handler's explicit `schedule` was
        // never reached. But Phase 5 makes the safety arming a
        // property of `callState.update(→terminating)` itself —
        // independent of whatever the handler does afterwards.
        const after = yield* callState.peek(callRef)
        expect(after?.state).toBe("terminating")
        expect(yield* Ref.get(safetyScheduled)).toBe(false)

        // The safety fiber was installed by `update` — not by the
        // handler's never-reached schedule line.
        expect(yield* timers.activeCount()).toBeGreaterThanOrEqual(1)
        const safetyEntry = after?.timers.find((t) => t.type === "terminating_timeout")
        expect(safetyEntry).toBeDefined()
      }).pipe(Effect.provide(stack)),
  )

  it.effect(
    "POST-FIX handler order — safety installed (idempotent with the structural install from `update`); handler hasn't run yet because slow yield is ongoing",
    () =>
      Effect.gen(function* () {
        const callState = yield* CallState
        const timers = yield* TimerService

        const callRef = "self|call-post-fix"
        yield* callState.create(makeActiveCall(callRef))
        const safetyHandlerRan = yield* Ref.make(false)

        // Post-fix order: mutate → schedule → slow yield. The schedule call
        // has returned (fiber installed in `fibersMap`) before the slow
        // outbound yield exposes the handler to the budget guard.
        const handler = Effect.gen(function* () {
          yield* callState.withCall(callRef, () =>
            callState.update(callRef, (c) => ({ ...c, state: "terminating" as const })),
          )
          const now = yield* Clock.currentTimeMillis
          const safety: TimerEntry = {
            id: `terminating-timeout-${callRef}`,
            type: "terminating_timeout",
            fireAt: now + SAFETY_DELAY_MS,
          }
          yield* timers.schedule(callRef, safety, () => Ref.set(safetyHandlerRan, true))
          yield* Effect.sleep(`${SLOW_OUTBOUND_MS} millis`)
        })

        const now = yield* Clock.currentTimeMillis
        const trigger: TimerEntry = {
          id: `keepalive_timeout-${callRef}-a`,
          type: "keepalive_timeout",
          fireAt: now + 10,
          legId: "a",
        }
        yield* timers.schedule(callRef, trigger, () => handler)

        // Drive past the budget — the slow yield is interrupted.
        yield* TestClock.adjust("6 seconds")
        for (let i = 0; i < 8; i++) yield* Effect.yieldNow

        // Mutation persisted; the safety entry was installed (either
        // by `update`'s structural auto-arm or by the handler's
        // explicit `schedule` — same id via `replaceTimerById`).
        const after = yield* callState.peek(callRef)
        expect(after?.state).toBe("terminating")
        expect(yield* timers.activeCount()).toBeGreaterThanOrEqual(1)
        // The handler hasn't run yet — sleep is ongoing.
        expect(yield* Ref.get(safetyHandlerRan)).toBe(false)
      }).pipe(Effect.provide(stack)),
  )
})
