/**
 * proxyB2bFakeStack — the SUT layer for the `proxy+b2b` matrix arm of
 * the fake-clock e2e harness. Wires a real `ProxyCore` in front of one
 * real `B2buaCoreLayer` worker, both bound on the same
 * `SignalingNetwork.simulated`. Reuses `b2buaWorkerStackLayer` and
 * `proxyStackLayer` from `networkLeaves.ts` — same building blocks as
 * `fakeStackLayer` and `proxyFakeStack`, just composed differently so a
 * single packet can flow alice→proxy→worker→bob (and back) without ever
 * leaving the shared in-memory fabric.
 *
 * ## Topology
 *
 *   alice ──UDP──► proxy(127.0.0.1:15060) ──UDP──► worker(127.0.0.1:15061) ──UDP──► bob
 *
 * - `INGRESS_ADDR` is the address scenarios send their initial INVITE
 *   to. It's the proxy's listen port, but it matches the port
 *   `fakeStackLayer` exposes by default (15060), so scenarios that
 *   hardcode `sip:…@127.0.0.1:15060` work unchanged on both SUTs.
 * - `WORKER_ADDR` is where the B2BUA worker listens. It's deliberately
 *   different from the proxy address; the worker's `sipLocalPort`
 *   matches.
 *
 * ## What's NOT here yet (Slice B)
 *
 * In Slice A the worker still sends its B-leg INVITEs directly to Bob,
 * exactly like `fakeStackLayer`. Slice B introduces
 * `AppConfig.b2bOutboundProxy` and the matching worker logic so the
 * B-leg also traverses the proxy — at which point a Bob-initiated BYE
 * also routes back through the proxy via the cookie-decode path.
 */

import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import type { AppConfigData } from "../../src/config/AppConfig.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import {
  type SocketAddr,
  WorkerId,
} from "../../src/sip-front-proxy/index.js"
import { b2buaWorkerStackLayer, proxyStackLayer } from "./networkLeaves.js"
import { PumpableClockLayer } from "./PumpableClock.js"

/** Default simulated transit delay — same as `fakeStack`'s. */
export const DEFAULT_TRANSIT_DELAY_MS = 15

/**
 * Pinned address scenarios send their initial INVITE to. Matches the
 * b2bonly default so basicCall and friends don't have to know which
 * SUT they're running against.
 */
export const INGRESS_ADDR: SocketAddr = { host: "127.0.0.1", port: 15060 }

/**
 * Pinned worker bind. `sipLocalPort` in the worker's `AppConfigData`
 * matches; UDP packets the proxy forwards land here.
 */
export const WORKER_ADDR: SocketAddr = { host: "10.0.0.1", port: 15061 }

/** Stable WorkerId for the single registered worker. */
export const WORKER_ID = WorkerId("test-worker-1")

export interface ProxyB2bFakeStackOpts {
  readonly config: AppConfigData
  readonly transitDelayMs?: number
}

/**
 * Build the `proxy+b2b` SUT layer.
 *
 * Returned layer exposes every service from both the proxy stack and
 * the worker stack — `ProxyCore`, `SipRouter`, `CallState`,
 * `SignalingNetwork`, etc. — all sharing one `SignalingNetwork`. The
 * worker is registered with the proxy's `WorkerRegistry` at construction
 * time; the proxy's `LoadBalancerStrategyLive` selects it via HRW for
 * any inbound dialog (with one worker, the only possible outcome).
 */
export function proxyB2bFakeStackLayer(opts: ProxyB2bFakeStackOpts) {
  // Force the worker's sipLocalPort to match WORKER_ADDR so legStackIdentity
  // stamps the right Via/Contact addresses; ingress is the proxy's port.
  // Set `b2bOutboundProxy` so B-leg dialog-creating outbound traffic
  // also traverses the proxy (Bob's responses + in-dialog requests come
  // back through the proxy via the stickiness cookie — symmetric with
  // the A-leg path).
  const workerConfig: AppConfigData = {
    ...opts.config,
    sipLocalIp: WORKER_ADDR.host,
    sipLocalPort: WORKER_ADDR.port,
    b2bOutboundProxy: { host: INGRESS_ADDR.host, port: INGRESS_ADDR.port },
  }

  const NetworkLayer = SignalingNetwork.simulated({
    transitDelayMs: opts.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS,
  })

  const WorkerStack = b2buaWorkerStackLayer({ config: workerConfig })
  const ProxyStack = proxyStackLayer({
    proxyAddr: INGRESS_ADDR,
    workers: [{ id: WORKER_ID, address: WORKER_ADDR, health: "alive" }],
  })

  return Layer.mergeAll(WorkerStack, ProxyStack).pipe(
    Layer.provideMerge(NetworkLayer),
    Layer.provideMerge(PumpableClockLayer),
  )
}

/**
 * Pump the simulated fabric: yield once, advance virtual time enough for
 * one transit, yield again, advance again. Three transits cover the
 * worst case for proxy+b2b (alice→proxy + proxy→worker + worker→bob in
 * the same scheduler step).
 */
export const pumpFor = (transitDelayMs: number, cycles = 1) =>
  Effect.gen(function* () {
    for (let i = 0; i < cycles; i++) {
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${transitDelayMs + 1} millis`)
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${transitDelayMs + 1} millis`)
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${transitDelayMs + 1} millis`)
      yield* Effect.yieldNow
    }
  })
