/**
 * PR5 — `WorkerRegistry.kubernetesStatefulSet` (K8s pod-watch impl).
 *
 * Coverage:
 *   - ADDED with status.podIP + Ready=True → `add` event with health=alive.
 *   - MODIFIED setting deletionTimestamp → `health_changed` to `draining`,
 *     `drainingSince` populated.
 *   - MODIFIED dropping Ready=True → `health_changed` to `dead` (we'd
 *     previously seen it alive, so the most-conservative fallback is dead).
 *   - DELETED → `removed`.
 *   - Probe-side `setHealth` overlays K8s view; most-restrictive wins.
 *   - Watch reconnect: when `onClose` fires with an error, the loop sleeps
 *     for the backoff and reconnects (TestClock-driven).
 *
 * We do NOT spin up a real K8s cluster — the registry takes a `WatchClient`
 * abstraction and the test passes a fake that exposes `pump(phase, pod)`
 * and `crash(err)` controls.
 */

import { describe, expect, it } from "@effect/vitest"
import type { V1Pod } from "@kubernetes/client-node"
import { Effect, Fiber, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  WorkerId,
  WorkerRegistry,
  WorkerRegistryControl,
  type RegistryEvent,
  type WorkerEntry,
} from "../../../src/sip-front-proxy/index.js"
import {
  kubernetesStatefulSetLayer,
  mostRestrictiveHealth,
  type WatchClient,
} from "../../../src/sip-front-proxy/registry/kubernetes.js"

// ---------------------------------------------------------------------------
// Fake WatchClient
// ---------------------------------------------------------------------------

interface ActiveWatch {
  readonly onEvent: (phase: string, pod: V1Pod) => void
  readonly onClose: (err: unknown) => void
  aborted: boolean
}

const makeFakeWatchClient = () => {
  const active: ActiveWatch[] = []
  const startCounts = { count: 0 }

  const client: WatchClient = {
    start: ({ onEvent, onClose }) => {
      startCounts.count++
      const w: ActiveWatch = { onEvent, onClose, aborted: false }
      active.push(w)
      return Promise.resolve(() => {
        w.aborted = true
      })
    },
  }

  const pump = (phase: string, pod: V1Pod) => {
    for (const w of active) if (!w.aborted) w.onEvent(phase, pod)
  }
  const crash = (err: unknown) => {
    for (const w of active) {
      if (!w.aborted) {
        w.aborted = true
        w.onClose(err)
      }
    }
  }
  const closeClean = () => {
    for (const w of active) {
      if (!w.aborted) {
        w.aborted = true
        w.onClose(null)
      }
    }
  }
  return { client, pump, crash, closeClean, startCounts }
}

// ---------------------------------------------------------------------------
// Pod fixtures
// ---------------------------------------------------------------------------

const podAlive = (name: string, ip: string): V1Pod =>
  ({
    metadata: { name },
    status: {
      podIP: ip,
      conditions: [{ type: "Ready", status: "True" }],
    },
  }) as unknown as V1Pod

const podDraining = (name: string, ip: string): V1Pod =>
  ({
    metadata: { name, deletionTimestamp: new Date() },
    status: {
      podIP: ip,
      conditions: [{ type: "Ready", status: "True" }],
    },
  }) as unknown as V1Pod

const podNotReady = (name: string, ip: string): V1Pod =>
  ({
    metadata: { name },
    status: {
      podIP: ip,
      conditions: [{ type: "Ready", status: "False" }],
    },
  }) as unknown as V1Pod

const layerWith = (client: WatchClient) =>
  kubernetesStatefulSetLayer(
    {
      namespace: "test",
      statefulSetName: "b2bua-worker",
      podPort: 5060,
      reconnectInitialMs: 100,
      reconnectMaxMs: 200,
    },
    client
  )

/**
 * Subscribe to the registry's `changes` stream from a forked fiber. The
 * underlying PubSub only emits to subscribers present at publish time —
 * just like the simulated registry test, we yield a TestClock tick after
 * forking so the subscription is live before the first `pump`.
 */
const collectEvents = (n: number) =>
  Effect.gen(function* () {
    const reg = yield* WorkerRegistry
    return yield* Effect.forkChild(
      reg.changes.pipe(Stream.take(n), Stream.runCollect)
    )
  })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sip-front-proxy/registry/kubernetes", () => {
  it.effect("most-restrictive health resolves correctly", () =>
    Effect.gen(function* () {
      expect(mostRestrictiveHealth("alive", "alive")).toBe("alive")
      expect(mostRestrictiveHealth("alive", "draining")).toBe("draining")
      expect(mostRestrictiveHealth("draining", "alive")).toBe("draining")
      expect(mostRestrictiveHealth("draining", "dead")).toBe("dead")
      expect(mostRestrictiveHealth("dead", "alive")).toBe("dead")
    })
  )

  it.effect("ADDED with Ready=True + podIP → 'added' event, unknown until probe", () => {
    const fake = makeFakeWatchClient()
    return Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const fiber = yield* collectEvents(1)
      yield* TestClock.adjust("1 millis")
      // Wait until the watch fiber has called `start` (the callback-based
      // Effect resolves the promise on the next microtask). Yielding a
      // tick is enough.
      yield* TestClock.adjust("10 millis")

      fake.pump("ADDED", podAlive("pod-0", "10.0.0.10"))

      const events = yield* Fiber.join(fiber)
      expect(events.length).toBe(1)
      expect(events[0]!._tag).toBe("added")
      const ev = events[0] as Extract<RegistryEvent, { _tag: "added" }>
      expect(ev.entry.id).toBe("pod-0")
      expect(ev.entry.address).toEqual({ host: "10.0.0.10", port: 5060 })
      // Composed health is `unknown`: K8s ready=True but probe has not
      // yet observed an OPTIONS round-trip. HealthProbe transitions
      // unknown → alive on first 200 OK.
      expect(ev.entry.health).toBe("unknown")

      const snap = yield* reg.snapshot
      expect(snap).toHaveLength(1)
      expect(snap[0]!.health).toBe("unknown")
    }).pipe(Effect.provide(layerWith(fake.client)))
  })

  it.effect("MODIFIED with deletionTimestamp → draining + drainingSince", () => {
    const fake = makeFakeWatchClient()
    return Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      yield* TestClock.adjust("10 millis")

      // First add the pod
      const addFiber = yield* collectEvents(1)
      yield* TestClock.adjust("1 millis")
      fake.pump("ADDED", podAlive("pod-0", "10.0.0.10"))
      yield* Fiber.join(addFiber)

      // Now flip into draining
      const drainFiber = yield* collectEvents(1)
      yield* TestClock.adjust("1 millis")
      fake.pump("MODIFIED", podDraining("pod-0", "10.0.0.10"))
      const events = yield* Fiber.join(drainFiber)

      expect(events).toHaveLength(1)
      expect(events[0]!._tag).toBe("health_changed")
      const ev = events[0] as Extract<RegistryEvent, { _tag: "health_changed" }>
      // Initial admission composes to `unknown` (K8s alive + probe
      // unknown). The deletionTimestamp transition pushes K8s to
      // draining; mostRestrictiveHealth(draining, unknown) → draining.
      expect(ev.from).toBe("unknown")
      expect(ev.to).toBe("draining")

      const e = yield* reg.resolve(WorkerId("pod-0"))
      expect(Option.isSome(e)).toBe(true)
      if (Option.isSome(e)) {
        expect(e.value.health).toBe("draining")
        expect(e.value.drainingSince).toBeTypeOf("number")
      }
    }).pipe(Effect.provide(layerWith(fake.client)))
  })

  it.effect("MODIFIED dropping Ready=True → dead (was previously alive)", () => {
    const fake = makeFakeWatchClient()
    return Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      yield* TestClock.adjust("10 millis")

      const addFiber = yield* collectEvents(1)
      yield* TestClock.adjust("1 millis")
      fake.pump("ADDED", podAlive("pod-0", "10.0.0.10"))
      yield* Fiber.join(addFiber)

      const flipFiber = yield* collectEvents(1)
      yield* TestClock.adjust("1 millis")
      fake.pump("MODIFIED", podNotReady("pod-0", "10.0.0.10"))
      const events = yield* Fiber.join(flipFiber)

      expect(events).toHaveLength(1)
      const ev = events[0] as Extract<RegistryEvent, { _tag: "health_changed" }>
      // Composed pre-transition health was `unknown` (K8s side alive,
      // probe still unknown). After Ready drops, K8s side flips to
      // dead because `prevK8sHealth === "alive"` (interpretPod tracks
      // the K8s side independently of probe state).
      expect(ev.from).toBe("unknown")
      expect(ev.to).toBe("dead")

      const e = yield* reg.resolve(WorkerId("pod-0"))
      if (Option.isSome(e)) expect(e.value.health).toBe("dead")
    }).pipe(Effect.provide(layerWith(fake.client)))
  })

  it.effect("DELETED → 'removed' event, snapshot drops the entry", () => {
    const fake = makeFakeWatchClient()
    return Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      yield* TestClock.adjust("10 millis")

      const addFiber = yield* collectEvents(1)
      yield* TestClock.adjust("1 millis")
      fake.pump("ADDED", podAlive("pod-0", "10.0.0.10"))
      yield* Fiber.join(addFiber)

      const remFiber = yield* collectEvents(1)
      yield* TestClock.adjust("1 millis")
      fake.pump("DELETED", podAlive("pod-0", "10.0.0.10"))
      const events = yield* Fiber.join(remFiber)

      expect(events).toHaveLength(1)
      expect(events[0]!._tag).toBe("removed")

      const snap = yield* reg.snapshot
      expect(snap).toEqual([] as ReadonlyArray<WorkerEntry>)
    }).pipe(Effect.provide(layerWith(fake.client)))
  })

  it.effect(
    "probe-side setHealth → composes with K8s view (most-restrictive wins)",
    () => {
      const fake = makeFakeWatchClient()
      return Effect.gen(function* () {
        const reg = yield* WorkerRegistry
        const ctl = yield* WorkerRegistryControl
        yield* TestClock.adjust("10 millis")

        const addFiber = yield* collectEvents(1)
        yield* TestClock.adjust("1 millis")
        fake.pump("ADDED", podAlive("pod-0", "10.0.0.10"))
        yield* Fiber.join(addFiber)

        // K8s view: alive. Probe says: dead. Resolved: dead.
        const f1 = yield* collectEvents(1)
        yield* TestClock.adjust("1 millis")
        yield* ctl.setHealth(WorkerId("pod-0"), "dead")
        const ev1 = yield* Fiber.join(f1)
        expect((ev1[0] as Extract<RegistryEvent, { _tag: "health_changed" }>).to).toBe(
          "dead"
        )
        const r1 = yield* reg.resolve(WorkerId("pod-0"))
        if (Option.isSome(r1)) expect(r1.value.health).toBe("dead")

        // Now K8s flips draining via deletionTimestamp; probe still says
        // dead → resolved stays dead (no event because resolved didn't
        // change), but the K8s side is now `draining`.
        fake.pump("MODIFIED", podDraining("pod-0", "10.0.0.10"))
        yield* TestClock.adjust("5 millis")
        const r2 = yield* reg.resolve(WorkerId("pod-0"))
        if (Option.isSome(r2)) expect(r2.value.health).toBe("dead")

        // Probe relaxes back to alive; resolved drops to draining (the K8s
        // side's deletionTimestamp dominates).
        const f2 = yield* collectEvents(1)
        yield* TestClock.adjust("1 millis")
        yield* ctl.setHealth(WorkerId("pod-0"), "alive")
        const ev2 = yield* Fiber.join(f2)
        const ev2x = ev2[0] as Extract<RegistryEvent, { _tag: "health_changed" }>
        expect(ev2x.from).toBe("dead")
        expect(ev2x.to).toBe("draining")
      }).pipe(Effect.provide(layerWith(fake.client)))
    }
  )

  it.effect(
    "watch reconnects after onClose(err) with backoff",
    () => {
      const fake = makeFakeWatchClient()
      return Effect.gen(function* () {
        yield* TestClock.adjust("10 millis")

        // First start completed.
        const startsBefore = fake.startCounts.count
        expect(startsBefore).toBeGreaterThanOrEqual(1)

        // Crash the active watch.
        fake.crash(new Error("api-server gone"))

        // Loop sleeps reconnectInitialMs (100). Bump past it.
        yield* TestClock.adjust("150 millis")
        // The reconnect promise resolves on a microtask; one more tick
        // is plenty for the second `start` call to register.
        yield* TestClock.adjust("10 millis")
        expect(fake.startCounts.count).toBeGreaterThan(startsBefore)
      }).pipe(Effect.provide(layerWith(fake.client)))
    }
  )

  it.effect("ADDED before podIP populated is deferred until later MODIFIED", () => {
    const fake = makeFakeWatchClient()
    return Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      yield* TestClock.adjust("10 millis")

      // Pod scheduled but no IP yet.
      const noIp: V1Pod = {
        metadata: { name: "pod-0" },
        status: { conditions: [{ type: "Ready", status: "False" }] },
      } as unknown as V1Pod
      fake.pump("ADDED", noIp)
      yield* TestClock.adjust("5 millis")
      const snap1 = yield* reg.snapshot
      expect(snap1).toEqual([])

      // Now IP arrives + Ready.
      const addFiber = yield* collectEvents(1)
      yield* TestClock.adjust("1 millis")
      fake.pump("MODIFIED", podAlive("pod-0", "10.0.0.10"))
      const events = yield* Fiber.join(addFiber)
      expect(events[0]!._tag).toBe("added")
    }).pipe(Effect.provide(layerWith(fake.client)))
  })
})
