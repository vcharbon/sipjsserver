/**
 * TimerService.schedule — fiber-leak regression (Slice 1.3 of
 * docs/plan/endurance-stuck-terminating-and-overload-hardening.md).
 *
 * The historical bug: re-scheduling a timer with the same id overwrote
 * the `fibersMap` entry but left the previous sleeping fiber alive.
 * Both fibers eventually fired their handler, and the older one was
 * never reaped — one leaked sleeping fiber per re-schedule. With
 * keepalive scheduling on every cycle, this added one fiber per ~15
 * minutes per call, indefinitely.
 *
 * The test schedules the same timer id twice; advances past the
 * deadline; asserts the handler fires exactly once and that
 * `activeCount()` reports a single live entry.
 */

import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { TimerService } from "../../src/call/TimerService.js"
import type { TimerEntry } from "../../src/call/CallModel.js"
import { AppConfig } from "../../src/config/AppConfig.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"

describe("TimerService.schedule — id collision cancels the prior fiber", () => {
  it.effect(
    "two schedules with the same id yield exactly one handler invocation; activeCount() === 1",
    () =>
      Effect.gen(function* () {
        const timers = yield* TimerService
        const fired = yield* Ref.make<string[]>([])

        const callRef = "call-collision"
        const baseAt = yield* Clock.currentTimeMillis

        // First schedule: fireAt = base + 5s.
        const e1: TimerEntry = {
          id: `keepalive-${callRef}`,
          type: "keepalive",
          fireAt: baseAt + 5_000,
        }
        yield* timers.schedule(callRef, e1, (_cr, _tt, _lid) =>
          Ref.update(fired, (xs) => [...xs, "first"]),
        )

        // Second schedule with the SAME id, slightly later fireAt. The
        // prior fiber must be interrupted so it never fires its handler.
        const e2: TimerEntry = {
          id: `keepalive-${callRef}`,
          type: "keepalive",
          fireAt: baseAt + 10_000,
        }
        yield* timers.schedule(callRef, e2, (_cr, _tt, _lid) =>
          Ref.update(fired, (xs) => [...xs, "second"]),
        )

        // Only one entry registered after the collision.
        const countAfterReschedule = yield* timers.activeCount()
        expect(countAfterReschedule).toBe(1)

        // Advance past both deadlines. Yield a few times so the timer
        // fiber, the handler, and `onExit`'s map removal all run.
        yield* TestClock.adjust("11 seconds")
        for (let i = 0; i < 4; i++) yield* Effect.yieldNow

        const events = yield* Ref.get(fired)
        expect(events).toEqual(["second"])

        const countAfterFire = yield* timers.activeCount()
        expect(countAfterFire).toBe(0)
      }).pipe(
        Effect.provide(
          TimerService.layer.pipe(
            Layer.provide(MetricsRegistry.layer),
            Layer.provide(Layer.succeed(AppConfig, testAppConfigDefaults())),
          ),
        ),
      ),
  )
})
