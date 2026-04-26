/**
 * topologies — D10 of the SIP Front Proxy plan.
 *
 * `topologyTest(name, body)` runs the same scenario body twice, once
 * per topology:
 *
 *   - `'direct'`   — Alice (UAC) speaks straight to Bob (UAS). No
 *                    proxy. Used as the behavioural baseline.
 *   - `'withProxy'` — Alice → Proxy(LoadBalancer) → Bob (a single
 *                    worker). Asserts the proxy is **transparent**: the
 *                    same observable call flow happens, modulo Via /
 *                    Record-Route headers the proxy adds.
 *
 * Both runs go through `runProxyScenario` so per-scenario `.txt` /
 * `.html` reports land under `test-results/sip-front-proxy/transparency/`,
 * named `<scenario>--direct.{txt,html}` and `<scenario>--with-proxy.{txt,html}`.
 *
 * The body receives a `Topology` object exposing:
 *
 *   - `topology.kind`      — `'direct'` | `'withProxy'`, useful for
 *                            assertions that legitimately differ
 *                            (e.g. extra Via/Record-Route in withProxy).
 *   - `topology.target`    — the address Alice's UAC should send INVITEs to
 *                            (the UAS address in `direct`, the proxy
 *                            address in `withProxy`).
 *   - `topology.bindUac`   — bind a recorded UAC endpoint at a fixed
 *                            address.
 *   - `topology.bindUas`   — bind a recorded UAS endpoint at a fixed
 *                            address. In `withProxy` topology this
 *                            address must coincide with the registered
 *                            worker's address (the helper picks one
 *                            address per UAS so callers don't have to
 *                            think about it — see `defaults` arg).
 *   - `topology.pump`      — advance the simulated clock enough for one
 *                            round-trip leg (`pump(cycles?)`).
 *   - `topology.proxyAddr` — `withProxy` only: the proxy's bind address,
 *                            so tests can build `Route: <proxy>` headers.
 *
 * The fixture deliberately keeps the UAC byte-building in the test body —
 * transparency tests want to assert on parsed shape after both
 * topologies, so they own the message construction.
 *
 * In the `withProxy` topology the LoadBalancer registers exactly one
 * worker at `defaults.workerAddr`. Tests that need a multi-worker
 * draining scenario use `proxyFakeStack` directly (see
 * `tests/sip-front-proxy/transparency/draining.test.ts`).
 */

import { Effect, Layer, type Scope } from "effect"
import { describe, it } from "@effect/vitest"
import {
  proxyFakeStack,
  type ProxyFakeStack,
} from "./proxy-fakeStack.js"
import {
  ProxyCore,
  type SocketAddr,
  WorkerId,
} from "../../src/sip-front-proxy/index.js"
import { SignalingNetwork, type UdpEndpoint } from "../../src/sip/SignalingNetwork.js"
import {
  bindNamedEndpoint,
  ProxyParticipants,
  runProxyScenario,
} from "../sip-front-proxy/_report/runner.js"
import { pumpAll } from "./pumpAll.js"
import { PumpableClock, PumpableClockLayer } from "./PumpableClock.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TopologyKind = "direct" | "withProxy"

export interface Topology {
  readonly kind: TopologyKind
  /**
   * The address Alice's UAC should send INVITEs to.
   *   - `direct`    → UAS address (default `defaults.uasAddr`)
   *   - `withProxy` → proxy address (default `defaults.proxyAddr`)
   */
  readonly target: SocketAddr
  /** Proxy bind address. Only meaningful in `withProxy`. */
  readonly proxyAddr: SocketAddr | undefined
  /**
   * Bind a recorded UAC endpoint at `addr`. The endpoint name appears
   * in trace reports.
   */
  readonly bindUac: (
    name: string,
    addr: SocketAddr,
    queueMax?: number
  ) => Effect.Effect<UdpEndpoint, never, SignalingNetwork | ProxyParticipants | Scope.Scope>
  /**
   * Bind a recorded UAS endpoint at `addr`. In `direct` topology the
   * test owns the address. In `withProxy` topology the address MUST
   * match the worker's registered address (the default uses
   * `defaults.workerAddr`).
   */
  readonly bindUas: (
    name: string,
    addr: SocketAddr,
    queueMax?: number
  ) => Effect.Effect<UdpEndpoint, never, SignalingNetwork | ProxyParticipants | Scope.Scope>
  /**
   * Drive the simulated clock and network forward until both are quiescent
   * (no pending sleeps, no in-flight transit). The legacy `cycles` param
   * is preserved for caller compatibility but is now a no-op — `pumpAll`
   * advances exactly to the next deadline regardless of how many round-trips
   * the scenario requires.
   */
  readonly pump: (cycles?: number) => Effect.Effect<void, never, PumpableClock | SignalingNetwork>
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export interface TopologyDefaults {
  /** Where Alice binds (UAC). */
  readonly aliceAddr: SocketAddr
  /** Where Bob binds (UAS).  */
  readonly bobAddr: SocketAddr
  /**
   * Where the proxy binds in `withProxy` topology. In `direct` topology
   * this address is unused; the field stays in the defaults so suites
   * can share one constants module.
   */
  readonly proxyAddr: SocketAddr
  /** Transit delay (ms) for the simulated network. Default: 5. */
  readonly transitDelayMs?: number
  /**
   * Worker id to register in `withProxy`. Defaults to `WorkerId("w-0")`.
   * Tests that want to verify the cookie carries a specific worker id
   * (rare for transparency cases) can override.
   */
  readonly workerId?: WorkerId
}

const DEFAULT_TRANSIT_MS = 5

// ---------------------------------------------------------------------------
// Pump helpers
// ---------------------------------------------------------------------------

// `transitMs` is unused by pumpAll (which queries the next pending deadline
// directly via PumpableClock) but kept in the signature so the existing
// makePump call sites don't need refactoring. `cycles` is similarly preserved
// as a no-op — pumpAll drains to quiescence on a single call.
const makePump = (_transitMs: number) =>
  (_cycles = 1): Effect.Effect<void, never, PumpableClock | SignalingNetwork> =>
    Effect.asVoid(pumpAll())

// ---------------------------------------------------------------------------
// Direct topology
// ---------------------------------------------------------------------------

interface DirectTopologyArgs {
  readonly defaults: TopologyDefaults
}

const directLayer = (transitMs: number) =>
  SignalingNetwork.simulated({ transitDelayMs: transitMs }).pipe(
    Layer.provideMerge(PumpableClockLayer),
  )

const directBody = (
  defaults: TopologyDefaults,
  body: (t: Topology) => Effect.Effect<void, unknown, ProxyParticipants | SignalingNetwork | Scope.Scope>
) => {
  const transitMs = defaults.transitDelayMs ?? DEFAULT_TRANSIT_MS
  const pump = makePump(transitMs)
  const topology: Topology = {
    kind: "direct",
    target: defaults.bobAddr,
    proxyAddr: undefined,
    bindUac: (name, addr, queueMax = 64) => bindNamedEndpoint(name, addr, queueMax),
    bindUas: (name, addr, queueMax = 64) => bindNamedEndpoint(name, addr, queueMax),
    pump,
  }
  return body(topology)
}

// ---------------------------------------------------------------------------
// withProxy topology
// ---------------------------------------------------------------------------

const withProxyBody = (
  defaults: TopologyDefaults,
  fx: ProxyFakeStack,
  workerId: WorkerId,
  body: (t: Topology) => Effect.Effect<void, unknown, ProxyParticipants | SignalingNetwork | Scope.Scope>
) => {
  const transitMs = defaults.transitDelayMs ?? DEFAULT_TRANSIT_MS
  const pump = makePump(transitMs)
  const topology: Topology = {
    kind: "withProxy",
    target: defaults.proxyAddr,
    proxyAddr: defaults.proxyAddr,
    bindUac: (name, addr, queueMax = 64) =>
      bindNamedEndpoint(name, addr, queueMax),
    // For withProxy the UAS sits at the registered worker's address.
    // We accept whatever address the test passes (callers normally
    // pass `defaults.bobAddr === workerAddr` per the suite's fixture
    // constants); the simulated fabric only cares about ip:port match.
    bindUas: (name, addr, queueMax = 64) => {
      void workerId
      void fx
      return bindNamedEndpoint(name, addr, queueMax)
    },
    pump,
  }
  return body(topology)
}

// ---------------------------------------------------------------------------
// Public test helper
// ---------------------------------------------------------------------------

export interface TopologyTestOpts {
  /** Per-suite addressing defaults (Alice/Bob/proxy). */
  readonly defaults: TopologyDefaults
  /**
   * Optional human-readable scenario description carried into both
   * report files. Reasonable default: the test name.
   */
  readonly description?: string
  /**
   * Optionally restrict to a single topology. Defaults to running both.
   * Useful for the dedicated draining/health-probe tests that only make
   * sense `withProxy`.
   */
  readonly only?: TopologyKind
}

/**
 * Run `body` once per topology under a `describe` block. Each run
 * dumps `.txt` + `.html` reports under the `transparency/` folder.
 *
 * The body receives a `Topology` argument and must return an Effect.
 * The body's outer environment is `ProxyParticipants | SignalingNetwork |
 * Scope.Scope` — provided by the wrapper. Bodies that need extra
 * services should use `Effect.provide` inside their own composition.
 */
export const topologyTest = (
  name: string,
  opts: TopologyTestOpts,
  body: (t: Topology) => Effect.Effect<void, unknown, ProxyParticipants | SignalingNetwork | Scope.Scope>
): void => {
  const transitMs = opts.defaults.transitDelayMs ?? DEFAULT_TRANSIT_MS
  const description = opts.description ?? name

  describe(`transparency: ${name}`, () => {
    if (opts.only === undefined || opts.only === "direct") {
      const layer = directLayer(transitMs)
      it.effect(`[direct] ${name}`, () =>
        runProxyScenario(
          {
            name: `${name}--direct`,
            description: `${description}\nTopology: direct (no proxy).`,
            outputDir: TRANSPARENCY_OUTPUT_DIR,
          },
          directBody(opts.defaults, body)
        ).pipe(Effect.provide(layer))
      )
    }
    if (opts.only === undefined || opts.only === "withProxy") {
      const workerId = opts.defaults.workerId ?? WorkerId("w-0")
      const fx = proxyFakeStack({
        proxyAddr: opts.defaults.proxyAddr,
        transitDelayMs: transitMs,
        workers: [
          { id: workerId, address: opts.defaults.bobAddr, health: "alive" },
        ],
      })
      it.effect(`[withProxy] ${name}`, () =>
        runProxyScenario(
          {
            name: `${name}--with-proxy`,
            description: `${description}\nTopology: Alice → Proxy → Worker(=Bob).`,
            outputDir: TRANSPARENCY_OUTPUT_DIR,
          },
          // Touch ProxyCore inside the body wrapper so the layer
          // actually starts the proxy fiber. Without this touch the
          // simulated fabric would route Alice's packets to the proxy
          // address but the proxy wouldn't be bound.
          Effect.gen(function* () {
            yield* ProxyCore // forces layer build
            yield* withProxyBody(opts.defaults, fx, workerId, body)
          })
        ).pipe(Effect.provide(fx.layer))
      )
    }
  })
}

/** Directory where transparency reports land (per topology + scenario). */
export const TRANSPARENCY_OUTPUT_DIR = "test-results/sip-front-proxy/transparency"

// Re-export so tests have a single import path.
export { proxyFakeStack } from "./proxy-fakeStack.js"
