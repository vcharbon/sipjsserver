/**
 * WorkerReadiness — slice 6 supporting primitive.
 *
 * Asserts the not-ready-by-default invariant (D9) and idempotent
 * mark transitions. Production wiring (kubelet probe binding to
 * `currentReady && !isDraining`) lands with slice 9.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { WorkerReadiness } from "../../src/cache/WorkerReadiness.js"

describe("WorkerReadiness", () => {
  it.effect("Default layer starts not-ready (D9 — pod stays out of K8s service until reclaim completes)", () =>
    Effect.gen(function* () {
      const readiness = yield* WorkerReadiness
      expect(yield* readiness.currentReady).toBe(false)
    }).pipe(Effect.provide(WorkerReadiness.Default))
  )

  it.effect("markReady(true) flips the flag; markReady(false) flips it back", () =>
    Effect.gen(function* () {
      const readiness = yield* WorkerReadiness
      expect(yield* readiness.currentReady).toBe(false)
      yield* readiness.markReady(true)
      expect(yield* readiness.currentReady).toBe(true)
      yield* readiness.markReady(false)
      expect(yield* readiness.currentReady).toBe(false)
    }).pipe(Effect.provide(WorkerReadiness.Default))
  )

  it.effect("markReady is idempotent — repeated calls with the same value are no-ops", () =>
    Effect.gen(function* () {
      const readiness = yield* WorkerReadiness
      yield* readiness.markReady(true)
      yield* readiness.markReady(true)
      yield* readiness.markReady(true)
      expect(yield* readiness.currentReady).toBe(true)
    }).pipe(Effect.provide(WorkerReadiness.Default))
  )

  it.effect("test layer accepts an initial-ready override for happy-path scenarios", () =>
    Effect.gen(function* () {
      const readiness = yield* WorkerReadiness
      expect(yield* readiness.currentReady).toBe(true)
    }).pipe(Effect.provide(WorkerReadiness.test(true)))
  )
})
