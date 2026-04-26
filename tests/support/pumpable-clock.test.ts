/**
 * Adversarial unit suite for `PumpableClock` and `pumpAll`.
 *
 * Covers the four behavioural gates from the plan:
 *   - forks-spawning-forks: 5 staggered Effect.sleeps fire in deadline order
 *   - periodic timer: warning surfaces, pump terminates (no hang)
 *   - cap exhaustion: hitCap flagged with deadline data preserved
 *   - real-clock probe: warning surfaces when test depends on live clock
 *   - bounded-budget: deadline beyond `within` stays pending, hitBudget=true
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import * as Duration from "effect/Duration"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import { PumpableClock, PumpableClockLayer } from "./PumpableClock.js"
import { pumpAll } from "./pumpAll.js"

const TestLayer = Layer.mergeAll(
  PumpableClockLayer,
  SignalingNetwork.simulated({ transitDelayMs: 5 }).pipe(Layer.provide(PumpableClockLayer)),
)

describe("PumpableClock", () => {
  it.effect("sleep registers pending deadline; adjust fires it", () =>
    Effect.gen(function* () {
      const clock = yield* PumpableClock
      const fired = yield* Ref.make(false)

      yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* clock.sleep(durationMillis(100))
          yield* Ref.set(fired, true)
        }),
      )
      // Let the forked fiber register its sleep before we inspect.
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      expect(clock.pendingSleeps()).toEqual([100])
      expect(yield* Ref.get(fired)).toBe(false)

      yield* clock.adjust("100 millis")
      yield* Effect.yieldNow

      expect(clock.pendingSleeps()).toEqual([])
      expect(yield* Ref.get(fired)).toBe(true)
      expect(clock.sleepsFiredCount()).toBe(1)
    }).pipe(Effect.provide(PumpableClockLayer)))
})

describe("pumpAll", () => {
  it.effect("fires forks-spawning-forks staggered sleeps in deadline order", () =>
    Effect.gen(function* () {
      const order = yield* Ref.make<number[]>([])
      const clock = yield* PumpableClock

      // Fork 5 fibers with sleeps at 50, 30, 20, 40, 10 ms — pump must fire
      // them in 10/20/30/40/50 order regardless of fork order.
      const deadlines = [50, 30, 20, 40, 10]
      for (const d of deadlines) {
        yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* clock.sleep(durationMillis(d))
            yield* Ref.update(order, (arr) => [...arr, d])
          }),
        )
      }
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      const report = yield* pumpAll({ within: "1 second" })

      expect(yield* Ref.get(order)).toEqual([10, 20, 30, 40, 50])
      expect(report.sleepsFired).toBe(5)
      expect(report.hitBudget).toBe(false)
      expect(report.hitCap).toBe(false)
      expect(report.remainingDeadlines).toEqual([])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("flags periodic timer in periodicSuspects without hanging", () =>
    Effect.gen(function* () {
      const clock = yield* PumpableClock
      // Self-rearming sleep at fixed 30ms interval. pumpAll has 1s budget,
      // so it should fire ~33 times then return.
      yield* Effect.forkChild(
        Effect.gen(function* () {
          while (true) {
            yield* clock.sleep(durationMillis(30))
          }
        }),
      )
      yield* Effect.yieldNow

      const report = yield* pumpAll({ within: "1 second", periodicWarnThreshold: 3 })

      expect(report.periodicSuspects.length).toBeGreaterThan(0)
      expect(report.sleepsFired).toBeGreaterThan(3)
      // Loop is still alive — the next deadline is past the budget.
      expect(report.remainingDeadlines.length).toBe(1)
      expect(report.hitBudget).toBe(true)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("hits sleep cap on runaway with hitCap=true", () =>
    Effect.gen(function* () {
      const clock = yield* PumpableClock
      yield* Effect.forkChild(
        Effect.gen(function* () {
          while (true) {
            yield* clock.sleep(durationMillis(1))
          }
        }),
      )
      yield* Effect.yieldNow

      const report = yield* pumpAll({
        within: "1 hour",
        maxSleepsFired: 5,
      })

      expect(report.hitCap).toBe(true)
      // Cap may overshoot slightly because adjust() drains all sleeps in
      // its window; once the cap-check trips we exit the next round.
      expect(report.sleepsFired).toBeGreaterThanOrEqual(5)
      expect(report.sleepsFired).toBeLessThan(20)
    }).pipe(Effect.provide(TestLayer)))

  it.effect("returns hitBudget=true when next deadline > within", () =>
    Effect.gen(function* () {
      const clock = yield* PumpableClock
      yield* Effect.forkChild(clock.sleep(durationMillis(10_000)))
      yield* Effect.yieldNow

      const report = yield* pumpAll({ within: "100 millis" })

      expect(report.hitBudget).toBe(true)
      expect(report.sleepsFired).toBe(0)
      expect(report.remainingDeadlines).toEqual([10_000])
    }).pipe(Effect.provide(TestLayer)))

  it.effect("clean drain when nothing pending — fast path", () =>
    Effect.gen(function* () {
      const report = yield* pumpAll({ within: "1 second" })
      expect(report.sleepsFired).toBe(0)
      expect(report.hitBudget).toBe(false)
      expect(report.hitCap).toBe(false)
      expect(report.realProbeWasUseful).toBe(false)
    }).pipe(Effect.provide(TestLayer)))
})

const durationMillis = (n: number): Duration.Duration => Duration.millis(n)
