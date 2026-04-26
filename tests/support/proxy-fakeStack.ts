/**
 * proxy-fakeStack — canonical fixture for the PR3b load-balancer test suite.
 *
 * Wires `SignalingNetwork.simulated` + `ProxyCore` + `LoadBalancerStrategyLive`
 * + `WorkerRegistry.simulated` + `HmacKeyProvider.static` + `CancelBranchLru`
 * over a single in-memory UDP fabric. The same Effect runtime hosts the
 * proxy and any number of simulated workers + UAC/UAS endpoints, all under
 * `it.effect` + TestClock — no real sockets, no Redis, no wall clock.
 *
 *   const fx = proxyFakeStack({
 *     proxyAddr: { host: "10.0.0.1", port: 5060 },
 *     workers: [
 *       { id: WorkerId("w-0"), address: { host: "10.0.1.0", port: 5060 } },
 *       { id: WorkerId("w-1"), address: { host: "10.0.1.1", port: 5060 } },
 *     ],
 *   })
 *
 *   it.effect("…", () => Effect.gen(function* () {
 *     const proxy = yield* ProxyCore
 *     const alice = yield* fx.bindUac({ host: "10.0.0.2", port: 5060 })
 *     const w0    = yield* fx.bindUasFor(WorkerId("w-0"))
 *     // …drive UDP packets via alice.send / w0.poll…
 *   }).pipe(Effect.provide(fx.layer)))
 *
 * What's deliberately not wrapped: the SIP-byte construction. Tests build
 * INVITEs / ACKs / BYEs by hand and assert on parsed shape. PR4's
 * topology-parameterized fixture will layer a higher-level scenario DSL on
 * top of this when the transparency suite needs it.
 *
 * Test-side controls — exposed off the returned `ProxyFakeStack`:
 *   - `addSimulatedWorker(id, addr)` — register a new worker; if a UAS
 *     endpoint was previously bound for that id it is NOT auto-rebound,
 *     since the simulated fabric routes by ip:port (the address is what
 *     matters; the worker id is metadata used by the strategy cookie).
 *   - `removeSimulatedWorker(id)` — unregister the worker from the
 *     registry. Any bound UAS endpoint at the worker's address remains
 *     bound (callers can still poll it for the post-removal residue, e.g.
 *     CANCELs that beat the stickiness reshard).
 *   - `setWorkerHealth(id, health)` — flip health.
 *   - `bindUac(addr)` / `bindUasFor(id)` — bind raw UDP endpoints for the
 *     test to drive.
 */

import { Data, Effect, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import {
  CancelBranchLru,
  HmacKeyProvider,
  type HmacKey,
  LoadBalancerConfig,
  type LoadBalancerConfigData,
  ProxyCore,
  type SocketAddr,
  type WorkerEntry,
  type WorkerHealth,
  type WorkerId,
  WorkerRegistrySimulatedControl,
} from "../../src/sip-front-proxy/index.js"
import { SignalingNetwork, type UdpEndpoint } from "../../src/sip/SignalingNetwork.js"
import {
  bindNamedEndpoint,
  ProxyParticipants,
} from "../sip-front-proxy/_report/runner.js"
import { proxyStackLayer } from "./networkLeaves.js"
import { PumpableClock, PumpableClockLayer } from "./PumpableClock.js"

/** Default simulated transit delay — same as the proxy-only fake stack. */
export const DEFAULT_TRANSIT_DELAY_MS = 5

export interface ProxyFakeStackOpts {
  /** ip:port the proxy binds (and advertises) on. */
  readonly proxyAddr: SocketAddr
  /** Initial worker set. Defaults to empty (use `addSimulatedWorker`). */
  readonly workers?: ReadonlyArray<WorkerEntry>
  /** Override the test HMAC key (rotation tests want explicit control). */
  readonly hmacKey?: HmacKey
  /** Optional previous HMAC key to test rotation overlap. */
  readonly hmacPreviousKey?: HmacKey
  /** Override transit delay (default: 5 ms virtual). */
  readonly transitDelayMs?: number
  /** Override CancelBranchLru TTL (default: 32 s). */
  readonly cancelLruTtlMs?: number
  /** Override CancelBranchLru sweep interval (default: 16 s). */
  readonly cancelLruSweepIntervalMs?: number
  /** Override proxy bind queueMax (default: 1024). */
  readonly proxyQueueMax?: number
  /** Override the LoadBalancer config (cookie name, drain grace). */
  readonly loadBalancer?: LoadBalancerConfigData
}

/**
 * Test-side helper that bundles the layer with mutator helpers. The layer
 * is what tests pass to `Effect.provide`; the helpers are services that
 * the test pulls out of the runtime via `yield*`. We fold both into one
 * value so tests don't have to remember which is which.
 */
export interface ProxyFakeStack {
  readonly layer: Layer.Layer<
    | ProxyCore
    | SignalingNetwork
    | CancelBranchLru
    | HmacKeyProvider
    | LoadBalancerConfig
    | WorkerRegistrySimulatedControl
    | PumpableClock
  >
  readonly proxyAddr: SocketAddr
  readonly transitDelayMs: number
  /** Ordered worker addresses keyed by id, for tests that want to verify
   *  the simulated routing target without re-querying the registry. */
  readonly workerAddress: (id: WorkerId) => SocketAddr | undefined

  // ── Mutators (wrapped so tests don't have to thread the control svc) ──
  readonly addSimulatedWorker: (
    id: WorkerId,
    addr: SocketAddr,
    health?: WorkerHealth
  ) => Effect.Effect<void, never, WorkerRegistrySimulatedControl>
  readonly removeSimulatedWorker: (
    id: WorkerId
  ) => Effect.Effect<void, never, WorkerRegistrySimulatedControl>
  readonly setWorkerHealth: (
    id: WorkerId,
    health: WorkerHealth
  ) => Effect.Effect<void, never, WorkerRegistrySimulatedControl>

  // ── Endpoint factories ────────────────────────────────────────────────
  readonly bindUac: (
    addr: SocketAddr,
    queueMax?: number
  ) => Effect.Effect<UdpEndpoint, never, SignalingNetwork | Scope.Scope>
  /**
   * Bind a raw UDP endpoint at the address advertised by `id` so simulated
   * traffic the proxy forwards to that worker arrives in this endpoint's
   * queue. Fails with `UnknownWorkerForBind` if the id was never registered.
   */
  readonly bindUasFor: (
    id: WorkerId,
    queueMax?: number
  ) => Effect.Effect<UdpEndpoint, UnknownWorkerForBind, SignalingNetwork | Scope.Scope>

  /**
   * Recording variant of {@link bindUac}: routes traffic through the
   * `ProxyParticipants` so the test runner can dump per-scenario reports.
   * The `name` is the participant label that appears in the reports
   * (e.g. `"alice"`).
   */
  readonly bindNamedUac: (
    name: string,
    addr: SocketAddr,
    queueMax?: number
  ) => Effect.Effect<UdpEndpoint, never, SignalingNetwork | ProxyParticipants | Scope.Scope>
  /**
   * Recording variant of {@link bindUasFor}: routes traffic through the
   * `ProxyParticipants` so the test runner can dump per-scenario reports.
   * `name` is the participant label (e.g. `"w-0"`).
   */
  readonly bindNamedUasFor: (
    name: string,
    id: WorkerId,
    queueMax?: number
  ) => Effect.Effect<
    UdpEndpoint,
    UnknownWorkerForBind,
    SignalingNetwork | ProxyParticipants | Scope.Scope
  >
}

/** Internal — bind requested for a worker that was never registered. */
export class UnknownWorkerForBind extends Data.TaggedError("UnknownWorkerForBind")<{
  readonly id: string
}> {}

/**
 * Build the canonical proxy + load-balancer fake stack. Call once per
 * test-suite scope; pass the returned `layer` to `Effect.provide` and use
 * the helpers off the same value.
 */
export function proxyFakeStack(opts: ProxyFakeStackOpts): ProxyFakeStack {
  const transitDelayMs = opts.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS
  const initialWorkers = opts.workers ?? []
  const workerAddresses = new Map<string, SocketAddr>()
  for (const w of initialWorkers) workerAddresses.set(w.id, w.address)

  const NetworkLayer = SignalingNetwork.simulated({ transitDelayMs })
  const ProxyStack = proxyStackLayer({
    proxyAddr: opts.proxyAddr,
    workers: initialWorkers,
    ...(opts.hmacKey !== undefined ? { hmacKey: opts.hmacKey } : {}),
    ...(opts.hmacPreviousKey !== undefined ? { hmacPreviousKey: opts.hmacPreviousKey } : {}),
    ...(opts.cancelLruTtlMs !== undefined ? { cancelLruTtlMs: opts.cancelLruTtlMs } : {}),
    ...(opts.cancelLruSweepIntervalMs !== undefined
      ? { cancelLruSweepIntervalMs: opts.cancelLruSweepIntervalMs }
      : {}),
    ...(opts.proxyQueueMax !== undefined ? { proxyQueueMax: opts.proxyQueueMax } : {}),
    ...(opts.loadBalancer !== undefined ? { loadBalancer: opts.loadBalancer } : {}),
  })
  const layer = ProxyStack.pipe(
    Layer.provideMerge(NetworkLayer),
    Layer.provideMerge(PumpableClockLayer),
  )

  // ── Mutators ────────────────────────────────────────────────────────────
  const addSimulatedWorker = (
    id: WorkerId,
    addr: SocketAddr,
    health: WorkerHealth = "alive"
  ) =>
    Effect.gen(function* () {
      const ctl = yield* WorkerRegistrySimulatedControl
      yield* ctl.add({ id, address: addr, health })
      workerAddresses.set(id, addr)
    })
  const removeSimulatedWorker = (id: WorkerId) =>
    Effect.gen(function* () {
      const ctl = yield* WorkerRegistrySimulatedControl
      yield* ctl.remove(id)
      // Keep workerAddresses around so a test that re-binds at the same
      // address still gets the right SocketAddr from `workerAddress`.
    })
  const setWorkerHealth = (id: WorkerId, health: WorkerHealth) =>
    Effect.gen(function* () {
      const ctl = yield* WorkerRegistrySimulatedControl
      yield* ctl.setHealth(id, health)
    })

  // ── Endpoints ───────────────────────────────────────────────────────────
  const bindUac = (addr: SocketAddr, queueMax = 64) =>
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      return yield* net
        .bindUdp({ ip: addr.host, port: addr.port, queueMax })
        .pipe(Effect.orDie)
    })
  const bindUasFor = (id: WorkerId, queueMax = 64) =>
    Effect.gen(function* () {
      const addr = workerAddresses.get(id)
      if (addr === undefined) return yield* new UnknownWorkerForBind({ id })
      const net = yield* SignalingNetwork
      return yield* net
        .bindUdp({ ip: addr.host, port: addr.port, queueMax })
        .pipe(Effect.orDie)
    })

  // Named variants — register `(host, port) → label` so the report
  // renders participant names instead of raw addresses. Recording
  // happens at the SignalingNetwork level (drainTrace), not here.
  const bindNamedUac = (name: string, addr: SocketAddr, queueMax = 64) =>
    bindNamedEndpoint(name, addr, queueMax)
  const bindNamedUasFor = (name: string, id: WorkerId, queueMax = 64) =>
    Effect.gen(function* () {
      const addr = workerAddresses.get(id)
      if (addr === undefined) return yield* new UnknownWorkerForBind({ id })
      return yield* bindNamedEndpoint(name, addr, queueMax)
    })

  return {
    layer,
    proxyAddr: opts.proxyAddr,
    transitDelayMs,
    workerAddress: (id) => workerAddresses.get(id),
    addSimulatedWorker,
    removeSimulatedWorker,
    setWorkerHealth,
    bindUac,
    bindUasFor,
    bindNamedUac,
    bindNamedUasFor,
  }
}

/**
 * Pump the simulated fabric: yield once, advance virtual time enough for
 * one transit, yield again, advance again. Two transits cover the worst
 * case (Alice→Proxy + Proxy→Bob in the same scheduler step).
 *
 * Identical pattern to `tests/sip-front-proxy/transit-only/*` — exposed
 * here so load-balancer tests don't have to copy-paste it.
 */
export const pumpFor = (transitDelayMs: number, cycles = 1) =>
  Effect.gen(function* () {
    for (let i = 0; i < cycles; i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${transitDelayMs + 1} millis`)
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${transitDelayMs + 1} millis`)
      yield* Effect.yieldNow
    }
  })
