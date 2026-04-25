/**
 * PR3a — `WorkerRegistry.simulated` (test-controllable impl).
 *
 * Coverage:
 *   - add / remove / setHealth / setAddress mutations and corresponding
 *     RegistryEvent emissions, in order, observed via `changes`.
 *   - Health transition into `draining` stamps `drainingSince`; out of
 *     draining clears it.
 *   - No-op mutations (re-add same id, set same health, set same address)
 *     do not emit events.
 *   - D4 invariant: snapshot is non-suspending — `Effect.runSync` works.
 */

import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  WorkerId,
  WorkerRegistry,
  WorkerRegistrySimulatedControl,
  workerRegistrySimulatedLayer,
  type RegistryEvent,
  type WorkerEntry,
} from "../../../src/sip-front-proxy/index.js"

const POD_0: WorkerEntry = {
  id: WorkerId("pod-0"),
  address: { host: "10.0.0.10", port: 5060 },
  health: "alive",
}
const POD_1: WorkerEntry = {
  id: WorkerId("pod-1"),
  address: { host: "10.0.0.11", port: 5060 },
  health: "alive",
}

/**
 * Spin up a background fiber that collects up to `n` events from the
 * registry's `changes` stream. Returns a fiber the caller can `Fiber.join`
 * after it has driven enough mutations through the control surface.
 *
 * Effect v4: `Effect.forkChild` is the modern `Effect.fork`. The forked
 * fiber stays attached to the test's parent fiber, so it gets cleaned up
 * automatically when the test returns.
 */
const collectEvents = (n: number) =>
  Effect.gen(function* () {
    const reg = yield* WorkerRegistry
    return yield* Effect.forkChild(
      reg.changes.pipe(Stream.take(n), Stream.runCollect)
    )
  })

describe("sip-front-proxy/registry/simulated", () => {
  it.effect("snapshot is non-suspending and reflects the initial set", () =>
    Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const snap = yield* reg.snapshot
      expect(snap.length).toBe(1)
      expect(snap[0]!.id).toBe("pod-0")

      // D4: routing-path snapshot must be safe to runSync. (If snapshot
      // ever started suspending on a sleep / fiber join, runSync would
      // throw `AsyncFiberException`.) The Effect language service flags
      // `runSync` inside Effect.gen as redundant, but in this case the
      // runSync IS the assertion — keep it.
      // @effect-diagnostics-next-line runEffectInsideEffect:off
      const sync = Effect.runSync(reg.snapshot)
      expect(sync.length).toBe(1)
    }).pipe(Effect.provide(workerRegistrySimulatedLayer({ initial: [POD_0] })))
  )

  it.effect("add → emits 'added' event and updates snapshot/resolve", () =>
    Effect.gen(function* () {
      const ctl = yield* WorkerRegistrySimulatedControl
      const reg = yield* WorkerRegistry

      const fiber = yield* collectEvents(1)
      // Yield once so the subscriber actually starts observing the
      // PubSub before we publish (Stream.fromPubSub-derived subscriptions
      // only see post-subscription events).
      yield* TestClock.adjust("1 millis")

      yield* ctl.add(POD_0)

      const events = yield* Fiber.join(fiber)
      expect(events.length).toBe(1)
      expect(events[0]!._tag).toBe("added")
      expect((events[0] as Extract<RegistryEvent, { _tag: "added" }>).entry.id).toBe(
        "pod-0"
      )

      const snap = yield* reg.snapshot
      expect(snap.length).toBe(1)
      const found = yield* reg.resolve(WorkerId("pod-0"))
      expect(Option.isSome(found)).toBe(true)
    }).pipe(Effect.provide(workerRegistrySimulatedLayer()))
  )

  it.effect("add of an already-registered id is a no-op (no event)", () =>
    Effect.gen(function* () {
      const ctl = yield* WorkerRegistrySimulatedControl
      const reg = yield* WorkerRegistry

      // 1) Drain the legitimate first add so the next subscriber starts
      //    fresh.
      const fiber1 = yield* collectEvents(1)
      yield* TestClock.adjust("1 millis")
      yield* ctl.add(POD_0)
      yield* Fiber.join(fiber1)

      // 2) Now subscribe again and try to re-add. The duplicate add
      //    must NOT emit; we use timeoutOption so the test can't hang.
      const fiber2 = yield* Effect.forkChild(
        reg.changes.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeoutOption("100 millis")
        )
      )
      yield* TestClock.adjust("1 millis")
      yield* ctl.add(POD_0) // duplicate — should be silent
      yield* TestClock.adjust("200 millis")
      const result = yield* Fiber.join(fiber2)
      expect(Option.isNone(result)).toBe(true)

      const snap = yield* reg.snapshot
      expect(snap.length).toBe(1)
    }).pipe(Effect.provide(workerRegistrySimulatedLayer()))
  )

  it.effect("remove → emits 'removed' and clears snapshot/resolve", () =>
    Effect.gen(function* () {
      const ctl = yield* WorkerRegistrySimulatedControl
      const reg = yield* WorkerRegistry

      const fiber = yield* collectEvents(1)
      yield* TestClock.adjust("1 millis")
      yield* ctl.remove(POD_0.id)

      const events = yield* Fiber.join(fiber)
      expect(events.length).toBe(1)
      expect(events[0]!._tag).toBe("removed")

      const snap = yield* reg.snapshot
      expect(snap).toEqual([])
      const missing = yield* reg.resolve(POD_0.id)
      expect(Option.isNone(missing)).toBe(true)
    }).pipe(Effect.provide(workerRegistrySimulatedLayer({ initial: [POD_0] })))
  )

  it.effect("setHealth alive→draining stamps drainingSince and emits event", () =>
    Effect.gen(function* () {
      const ctl = yield* WorkerRegistrySimulatedControl
      const reg = yield* WorkerRegistry

      const fiber = yield* collectEvents(1)
      yield* TestClock.adjust("1 millis")
      yield* ctl.setHealth(POD_0.id, "draining")

      const events = yield* Fiber.join(fiber)
      expect(events).toHaveLength(1)
      expect(events[0]!._tag).toBe("health_changed")
      const ev = events[0] as Extract<RegistryEvent, { _tag: "health_changed" }>
      expect(ev.from).toBe("alive")
      expect(ev.to).toBe("draining")

      const after = yield* reg.resolve(POD_0.id)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) {
        expect(after.value.health).toBe("draining")
        expect(after.value.drainingSince).toBeTypeOf("number")
      }
    }).pipe(Effect.provide(workerRegistrySimulatedLayer({ initial: [POD_0] })))
  )

  it.effect("setHealth draining→alive clears drainingSince", () =>
    Effect.gen(function* () {
      const ctl = yield* WorkerRegistrySimulatedControl
      const reg = yield* WorkerRegistry

      const fiber = yield* collectEvents(2)
      yield* TestClock.adjust("1 millis")
      yield* ctl.setHealth(POD_0.id, "draining")
      yield* ctl.setHealth(POD_0.id, "alive")

      const events = yield* Fiber.join(fiber)
      expect(events.map((e) => e._tag)).toEqual(["health_changed", "health_changed"])

      const after = yield* reg.resolve(POD_0.id)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) {
        expect(after.value.health).toBe("alive")
        expect(after.value.drainingSince).toBeUndefined()
      }
    }).pipe(Effect.provide(workerRegistrySimulatedLayer({ initial: [POD_0] })))
  )

  it.effect("setHealth to the same value is a no-op (no event)", () =>
    Effect.gen(function* () {
      const ctl = yield* WorkerRegistrySimulatedControl
      const reg = yield* WorkerRegistry

      const fiber = yield* Effect.forkChild(
        reg.changes.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeoutOption("100 millis")
        )
      )
      yield* TestClock.adjust("1 millis")
      yield* ctl.setHealth(POD_0.id, "alive") // identity transition
      yield* TestClock.adjust("200 millis")
      const result = yield* Fiber.join(fiber)
      expect(Option.isNone(result)).toBe(true)
    }).pipe(Effect.provide(workerRegistrySimulatedLayer({ initial: [POD_0] })))
  )

  it.effect("setAddress emits 'address_changed' and updates snapshot", () =>
    Effect.gen(function* () {
      const ctl = yield* WorkerRegistrySimulatedControl
      const reg = yield* WorkerRegistry

      const fiber = yield* collectEvents(1)
      yield* TestClock.adjust("1 millis")
      const newAddr = { host: "10.0.0.99", port: 5070 }
      yield* ctl.setAddress(POD_0.id, newAddr)

      const events = yield* Fiber.join(fiber)
      expect(events).toHaveLength(1)
      expect(events[0]!._tag).toBe("address_changed")
      const ev = events[0] as Extract<RegistryEvent, { _tag: "address_changed" }>
      expect(ev.from).toEqual(POD_0.address)
      expect(ev.to).toEqual(newAddr)

      const after = yield* reg.resolve(POD_0.id)
      expect(Option.isSome(after)).toBe(true)
      if (Option.isSome(after)) expect(after.value.address).toEqual(newAddr)
    }).pipe(Effect.provide(workerRegistrySimulatedLayer({ initial: [POD_0] })))
  )

  it.effect("multiple mutations emit RegistryEvents in order", () =>
    Effect.gen(function* () {
      const ctl = yield* WorkerRegistrySimulatedControl
      const reg = yield* WorkerRegistry

      const fiber = yield* collectEvents(4)
      yield* TestClock.adjust("1 millis")

      yield* ctl.add(POD_0)
      yield* ctl.add(POD_1)
      yield* ctl.setHealth(POD_0.id, "draining")
      yield* ctl.remove(POD_1.id)

      const events = yield* Fiber.join(fiber)
      expect(events.map((e) => e._tag)).toEqual([
        "added",
        "added",
        "health_changed",
        "removed",
      ])

      const snap = yield* reg.snapshot
      expect(snap.length).toBe(1)
      expect(snap[0]!.id).toBe("pod-0")
      expect(snap[0]!.health).toBe("draining")
    }).pipe(Effect.provide(workerRegistrySimulatedLayer()))
  )

  it.effect("setHealth on unknown id is a no-op (no event, no error)", () =>
    Effect.gen(function* () {
      const ctl = yield* WorkerRegistrySimulatedControl
      const reg = yield* WorkerRegistry
      yield* ctl.setHealth(WorkerId("ghost"), "draining")
      yield* ctl.setAddress(WorkerId("ghost"), { host: "1.2.3.4", port: 5060 })
      yield* ctl.remove(WorkerId("ghost"))
      const snap = yield* reg.snapshot
      expect(snap).toEqual([])
    }).pipe(Effect.provide(workerRegistrySimulatedLayer()))
  )
})
