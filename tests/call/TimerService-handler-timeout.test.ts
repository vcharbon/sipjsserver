/**
 * TimerService handler safety timeout (Slice 1.4 / handler-timeout
 * follow-up to docs/plan/endurance-stuck-terminating-and-overload-hardening.md).
 *
 * The wrap added in `TimerService.schedule` converts a hung handler
 * into a clean log + counter bump after `timerHandlerTimeoutMs`,
 * instead of the fiber sleeping forever and only surfacing in a heap
 * snapshot. The two tests pin both halves of the contract:
 *
 *   1. A handler that returns `Effect.never` is force-released after
 *      the configured budget; `handlerTimeoutTotal` increments.
 *   2. A handler that returns promptly does NOT trip the timeout, so
 *      legitimate fast handlers stay invisible to the counter.
 */

import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { TimerService } from "../../src/call/TimerService.js"
import type { TimerEntry } from "../../src/call/CallModel.js"
import { AppConfig } from "../../src/config/AppConfig.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

const stack = (timerHandlerTimeoutMs: number) =>
  Layer.mergeAll(
    TimerService.layer.pipe(
      Layer.provideMerge(MetricsRegistry.layer),
      Layer.provide(
        Layer.succeed(AppConfig, testAppConfigDefaults({ timerHandlerTimeoutMs })),
      ),
    ),
  )

describe("TimerService.schedule — per-handler safety timeout", () => {
  it.effect(
    "a hung handler trips timerHandlerTimeoutMs; counter increments; fiber unblocks",
    () =>
      Effect.gen(function* () {
        const timers = yield* TimerService
        const registry = yield* MetricsRegistry
        const baseAt = yield* Clock.currentTimeMillis

        const entry: TimerEntry = {
          id: "hang-test",
          type: "keepalive",
          fireAt: baseAt + 1_000,
        }

        // Handler is `never` — without the safety wrap the fiber would
        // park forever and never reach `onExit`.
        yield* timers.schedule("call-hang", entry, () => Effect.never)

        // Step past the fireAt so the handler starts.
        yield* TestClock.adjust("1 second")
        for (let i = 0; i < 4; i++) yield* Effect.yieldNow

        // Counter still zero — handler is hung but inside the budget.
        expect(registry.timers?.handlerTimeoutTotal()).toBe(0)

        // Step past the configured 2 s budget. The wrap converts the
        // hang into a clean log + counter bump; the fiber finishes
        // and `onExit` removes it from the map.
        yield* TestClock.adjust("3 seconds")
        for (let i = 0; i < 4; i++) yield* Effect.yieldNow

        expect(registry.timers?.handlerTimeoutTotal()).toBe(1)
        expect(yield* timers.activeCount()).toBe(0)
      }).pipe(Effect.provide(stack(2_000))),
  )

  it.effect(
    "a fast handler completes without tripping the safety counter",
    () =>
      Effect.gen(function* () {
        const timers = yield* TimerService
        const registry = yield* MetricsRegistry
        const fired = yield* Ref.make(0)
        const baseAt = yield* Clock.currentTimeMillis

        const entry: TimerEntry = {
          id: "fast-test",
          type: "keepalive",
          fireAt: baseAt + 500,
        }
        yield* timers.schedule("call-fast", entry, () =>
          Ref.update(fired, (n) => n + 1),
        )

        yield* TestClock.adjust("1 second")
        for (let i = 0; i < 4; i++) yield* Effect.yieldNow

        expect(yield* Ref.get(fired)).toBe(1)
        expect(registry.timers?.handlerTimeoutTotal()).toBe(0)
        expect(yield* timers.activeCount()).toBe(0)
      }).pipe(Effect.provide(stack(2_000))),
  )
})

describe("TimerService.cancel — self-cancel is safe", () => {
  it.effect(
    "a handler that calls cancel(self.id) does not deadlock",
    () =>
      Effect.gen(function* () {
        const timers = yield* TimerService
        const reached = yield* Ref.make(false)
        const baseAt = yield* Clock.currentTimeMillis

        const id = "self-cancel"
        const entry: TimerEntry = {
          id,
          type: "keepalive",
          fireAt: baseAt + 500,
        }

        // Handler tries to cancel its own timer entry. Without the
        // self-protection added in TimerService.cancel this would
        // deadlock on Fiber.interrupt(self).
        yield* timers.schedule("call-self", entry, () =>
          Effect.gen(function* () {
            yield* timers.cancel(id)
            yield* Ref.set(reached, true)
          }),
        )

        yield* TestClock.adjust("1 second")
        for (let i = 0; i < 6; i++) yield* Effect.yieldNow

        expect(yield* Ref.get(reached)).toBe(true)
        expect(yield* timers.activeCount()).toBe(0)
      }).pipe(Effect.provide(stack(2_000))),
  )
})
