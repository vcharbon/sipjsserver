/**
 * SimulatedK8sCluster smoke tests — slice 3 of the k8s-reliability
 * rework. Verifies the cluster facade materialises against the
 * `k8sFakeStackLayer` composition, advances workers from `unknown` to
 * `alive` through HealthProbe, runs the multi-phase kill pipeline,
 * and exposes per-peer snapshot reads. The end-to-end failover
 * scenario (alice → proxy → worker A killed → BYE routed to B) is a
 * follow-up slice that needs DSL extensions and a new SUT entry in
 * `simulated-backend.ts`; this file just locks in the building blocks.
 */

import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Fiber as EffectFiber } from "effect"
import { TestClock } from "effect/testing"
import {
  k8sFakeStackLayer,
  k8sWorkerId,
  K8S_PROXY_ADDR,
} from "./k8sFakeStack.js"
import { SimulatedK8sCluster } from "../../src/test-harness/internal/SimulatedK8sCluster.js"
import { testAppConfigDefaults } from "../../src/test-harness/config-defaults.js"
import {
  HandlerRegistry,
  type EventHandler,
} from "../../src/sip/SipRouter.js"
import { WorkerRegistry } from "../../src/sip-front-proxy/index.js"

// Minimal handler registry — the kill / snapshot machinery doesn't
// process SIP messages; it just needs the routers to bootstrap.
const NOOP_HANDLER: EventHandler = () => Effect.void
const noopHandlers: HandlerRegistry = {
  sip: NOOP_HANDLER,
  cancelled: NOOP_HANDLER,
  timer: NOOP_HANDLER,
  timeout: NOOP_HANDLER,
  internalEvent: NOOP_HANDLER,
}

const baseConfig = testAppConfigDefaults({
  sipLocalIp: K8S_PROXY_ADDR.host,
  sipLocalPort: K8S_PROXY_ADDR.port,
})

const stackLayer = k8sFakeStackLayer({
  config: baseConfig,
  handlers: noopHandlers,
  workerCount: 2,
})

describe("SimulatedK8sCluster (slice 3)", () => {
  it.effect("materialises and exposes both workers via the cluster facade", () =>
    Effect.gen(function* () {
      const cluster = yield* SimulatedK8sCluster
      expect(cluster.workers.length).toBe(2)
      expect(cluster.workers.map((w) => w.id as unknown as string)).toEqual([
        "b2b-1",
        "b2b-2",
      ])
      expect(cluster.workerOf(k8sWorkerId(1)).address.host).toBe("10.20.0.1")
      expect(cluster.workerOf(k8sWorkerId(2)).address.host).toBe("10.20.0.2")
    }).pipe(Effect.provide(stackLayer))
  )

  it.effect("registry is auto-stamped with firstSeenAtMs (LB fresh-pod guard activated)", () =>
    Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const snap = yield* reg.snapshot
      expect(snap.length).toBe(2)
      // autoStampFirstSeenAtMs is on, so every initial worker has a
      // stamp from t=0 (TestClock starts at 0).
      for (const w of snap) {
        expect(w.firstSeenAtMs).toBeDefined()
      }
    }).pipe(Effect.provide(stackLayer))
  )

  it.effect("kill runs the four-phase pipeline and records events", () =>
    Effect.gen(function* () {
      const cluster = yield* SimulatedK8sCluster
      const reg = yield* WorkerRegistry

      // Drain any pre-existing events (none expected, but defensive).
      yield* cluster.drainKillEvents

      // Non-zero timing gaps insert `Effect.sleep` calls that block
      // under TestClock — fork the kill, then drive virtual time
      // forward enough to cover every gap before joining.
      const fiber = yield* Effect.forkScoped(
        cluster.kill(k8sWorkerId(1), {
          drainHoldMs: 100,
          disconnectGapMs: 50,
          fabricKillDelayMs: 25,
        })
      )
      yield* TestClock.adjust("200 millis")
      yield* EffectFiber.join(fiber)

      const events = yield* cluster.drainKillEvents
      // drain → disconnect → registry → fabric (4 phases when drainHoldMs > 0)
      expect(events.map((e) => e.phase)).toEqual([
        "drain",
        "disconnect",
        "registry",
        "fabric",
      ])
      // Every event names the killed worker.
      for (const e of events) {
        expect(e.workerId as unknown as string).toBe("b2b-1")
      }
      // Phase timestamps are monotonically non-decreasing under
      // TestClock — non-zero gaps interleave Clock advances.
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.atMs).toBeGreaterThanOrEqual(events[i - 1]!.atMs)
      }

      // Registry now reports the killed worker as dead.
      const opt = yield* reg.resolve(k8sWorkerId(1))
      expect(opt._tag).toBe("Some")
      if (opt._tag === "Some") {
        expect(opt.value.health).toBe("dead")
      }

      // Peer fabric snapshot: killed worker is "dead", survivor is
      // still routable.
      const killed = yield* cluster.snapshotPeer(k8sWorkerId(1))
      const alive = yield* cluster.snapshotPeer(k8sWorkerId(2))
      expect(killed.health).toBe("dead")
      expect(alive.health).toBe("alive")
    }).pipe(Effect.provide(stackLayer))
  )

  it.effect("kill with all-zero timing collapses to drain-skip + immediate transitions", () =>
    Effect.gen(function* () {
      const cluster = yield* SimulatedK8sCluster
      yield* cluster.drainKillEvents
      yield* cluster.kill(k8sWorkerId(2)) // no timing → drainHold skipped
      const events = yield* cluster.drainKillEvents
      // No drain phase recorded.
      expect(events.map((e) => e.phase)).toEqual([
        "disconnect",
        "registry",
        "fabric",
      ])
    }).pipe(Effect.provide(stackLayer))
  )

  it.effect("disconnect / reconnect flip the network gate without touching registry", () =>
    Effect.gen(function* () {
      const cluster = yield* SimulatedK8sCluster
      const reg = yield* WorkerRegistry

      const beforeOpt = yield* reg.resolve(k8sWorkerId(1))
      const beforeHealth =
        beforeOpt._tag === "Some" ? beforeOpt.value.health : "unknown"

      yield* cluster.disconnect(k8sWorkerId(1))
      yield* cluster.reconnect(k8sWorkerId(1))

      const afterOpt = yield* reg.resolve(k8sWorkerId(1))
      const afterHealth =
        afterOpt._tag === "Some" ? afterOpt.value.health : "unknown"
      expect(afterHealth).toBe(beforeHealth)
    }).pipe(Effect.provide(stackLayer))
  )

  it.effect("expectReplicatedTo dies with a useful message when key is missing", () =>
    Effect.gen(function* () {
      const cluster = yield* SimulatedK8sCluster
      const exit = yield* Effect.exit(
        cluster.expectReplicatedTo(k8sWorkerId(2), {
          callRef: "missing-call-ref",
          primary: k8sWorkerId(1),
        })
      )
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(stackLayer))
  )
})

