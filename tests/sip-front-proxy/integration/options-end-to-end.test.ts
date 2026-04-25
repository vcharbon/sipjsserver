/**
 * End-to-end integration: real `HealthProbe.optionsKeepalive` →
 * shared `SignalingNetwork.simulated` → real B2BUA worker
 * (`fakeStackLayer` with real `SipRouter` + real `DrainingState`).
 *
 * This is the contract test that closes the gap between
 * `tests/b2bua/draining-options.test.ts` (B2BUA OPTIONS handler with
 * hand-crafted UAC) and `tests/sip-front-proxy/transparency/health-probe.test.ts`
 * (proxy probe with hand-crafted worker replies). Here both halves are
 * the production code — only the network fabric is virtualised.
 *
 * Sequence:
 *   1. Start the B2BUA router. Probe runs at INTERVAL_MS = 1s, three
 *      threshold misses to call `dead`. Worker default state = serving.
 *   2. Probe ticks → B2BUA short-circuit replies 200 → registry stays alive.
 *   3. Flip B2BUA `DrainingState.markDraining`.
 *   4. Next probe tick → 503 + Retry-After: 0 → registry → draining.
 *   5. Interrupt the B2BUA router fiber so OPTIONS go unanswered.
 *      `THRESHOLD` consecutive misses → registry → dead.
 *
 * Why this matters: it's the only test in the suite that proves the
 * OPTIONS request the probe constructs is parseable by the real
 * `customParser` + `SipRouter` chain in the worker, and that the
 * response the worker generates round-trips through the real
 * `customParser` in the probe's inbound drain.
 */

import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { handlers } from "../../../src/b2bua/B2buaCore.js"
import { DrainingState } from "../../../src/b2bua/DrainingState.js"
import { SipRouter } from "../../../src/sip/SipRouter.js"
import {
  HealthProbe,
  optionsKeepaliveLayer,
} from "../../../src/sip-front-proxy/health/HealthProbe.js"
import {
  simulatedAdapterLayer,
  WorkerRegistryControl,
} from "../../../src/sip-front-proxy/health/WorkerRegistryControl.js"
import {
  WorkerId,
  WorkerRegistry,
  workerRegistrySimulatedLayer,
  type WorkerHealth,
} from "../../../src/sip-front-proxy/index.js"
import { fakeStackLayer } from "../../support/fakeStack.js"
import { testAppConfigDefaults } from "../../support/testAppConfigDefaults.js"

// ── Constants ──────────────────────────────────────────────────────────
const SIP_PORT = 15060                // B2BUA bind
const PROBE_BIND = { ip: "127.0.0.1", port: 25070 }
const WORKER_ADDR = { host: "127.0.0.1", port: SIP_PORT }
const W = WorkerId("w-real-b2bua")
const TRANSIT_MS = 1                  // tight so each tick stays cheap
const INTERVAL_MS = 1_000
const TIMEOUT_MS = 200
const THRESHOLD = 3

// ── Layer composition ──────────────────────────────────────────────────
//
// Goal: ONE `SignalingNetwork.simulated` shared by the B2BUA's
// `UdpTransport` (binds at SIP_PORT) and the `HealthProbe`'s outbound
// endpoint (binds at PROBE_BIND.port). `fakeStackLayer` exposes its
// internal SignalingNetwork outward, so feeding it into
// `optionsKeepaliveLayer` via `Layer.provideMerge` reuses the same
// instance — avoiding the two-network bug noted in `fakeStack.ts`.
const config = testAppConfigDefaults({ sipLocalPort: SIP_PORT })

const buildLayer = () => {
  const B2bua = fakeStackLayer({ config, transitDelayMs: TRANSIT_MS })
  const Registry = workerRegistrySimulatedLayer({
    initial: [{ id: W, address: WORKER_ADDR, health: "alive" }],
  })
  // Adapter requires WorkerRegistrySimulatedControl from Registry
  const Control = simulatedAdapterLayer.pipe(Layer.provideMerge(Registry))
  // Probe requires SignalingNetwork (B2bua) + WorkerRegistry + Control
  const ProbeDeps = Layer.mergeAll(B2bua, Control)
  const Probe = optionsKeepaliveLayer({
    bindHost: PROBE_BIND.ip,
    bindPort: PROBE_BIND.port,
    intervalMs: INTERVAL_MS,
    timeoutMs: TIMEOUT_MS,
    threshold: THRESHOLD,
  }).pipe(Layer.provideMerge(ProbeDeps))
  return Probe
}

const health = (
  registry: WorkerRegistry["Service"]
): Effect.Effect<WorkerHealth | undefined> =>
  registry
    .resolve(W)
    .pipe(Effect.map((opt) => (Option.isNone(opt) ? undefined : opt.value.health)))

/**
 * Drive one full probe tick through TestClock. The probe's loop shape is:
 *   sleep(intervalMs) → if(enabled) fanOut → sleep(timeoutMs) → reap
 *
 * Yielding repeatedly between adjusts gives the B2BUA's forked fibers
 * (UdpTransport ingress + SipRouter event loop + the probe's inbound
 * stream) chances to pick up scheduled work.
 */
const oneTick = Effect.gen(function* () {
  // Step the idle wait. Probe is now mid-tick: OPTIONS in flight.
  yield* TestClock.adjust(Duration.millis(INTERVAL_MS + 1))
  // Pump enough to let: probe send → simulated transit → B2BUA receive
  // → SipRouter dispatch → OPTIONS short-circuit → worker send →
  // simulated transit → probe inbound drain → registry update.
  for (let i = 0; i < 10; i++) {
    yield* Effect.yieldNow
    yield* TestClock.adjust(Duration.millis(TRANSIT_MS + 1))
    yield* Effect.yieldNow
  }
  // Then cross the timeoutMs window so the reaper wakes for any
  // outstanding probe (only matters when the worker dropped the OPTIONS).
  yield* TestClock.adjust(Duration.millis(TIMEOUT_MS + 1))
  for (let i = 0; i < 4; i++) {
    yield* Effect.yieldNow
  }
})

describe("integration: HealthProbe ↔ real B2BUA OPTIONS handler", () => {
  it.effect(
    "alive (200) → draining (503) → dead (silence past threshold)",
    () =>
      Effect.gen(function* () {
        const router = yield* SipRouter
        const draining = yield* DrainingState
        const probe = yield* HealthProbe
        const registry = yield* WorkerRegistry
        const control = yield* WorkerRegistryControl
        void control // hold ref so the layer can't drop it

        // Bring up the B2BUA event loop.
        const routerFiber = yield* Effect.forkChild(router.start(handlers))
        // Enable the probe loop.
        yield* probe.start

        // ── 1. Two ticks with B2BUA in 'serving' → registry stays alive ──
        yield* oneTick
        yield* oneTick
        const aliveAfter = yield* health(registry)
        expect(aliveAfter).toBe("alive")

        // ── 2. Flip B2BUA to draining → next tick reports 503 → registry draining ──
        yield* draining.markDraining
        yield* oneTick
        const drainingAfter = yield* health(registry)
        expect(drainingAfter).toBe("draining")

        // ── 3. Kill the B2BUA → OPTIONS go unanswered → THRESHOLD misses → dead ──
        // Reset health to `alive` so the timeout path is what flips it,
        // not the 503 sticking around.
        yield* control.setHealth(W, "alive")
        yield* Fiber.interrupt(routerFiber)

        // After router interruption, the B2BUA's bound endpoint queue still
        // exists (the layer scope holds the bind), but no consumer pulls
        // from it — OPTIONS arrive and rot. Each tick increments
        // consecutiveMisses; once it crosses THRESHOLD the probe demotes.
        for (let tick = 0; tick < THRESHOLD; tick++) {
          yield* oneTick
        }
        const deadAfter = yield* health(registry)
        expect(deadAfter).toBe("dead")
      }).pipe(Effect.provide(buildLayer()))
  )
})
