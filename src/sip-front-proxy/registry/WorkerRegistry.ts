/**
 * WorkerRegistry — D3 of the SIP Front Proxy plan.
 *
 * Tracks the set of B2BUA workers the proxy can route to. Three concrete
 * impls land across the plan:
 *
 *   - `kubernetesStatefulSet` (PR5, production) — driven by a K8s `Pod` watch.
 *   - `static` (this PR, dev/local) — env-driven, no dynamic updates.
 *   - `simulated` (this PR, tests) — explicit add/remove/setHealth controls
 *     so unit tests can drive registry events deterministically.
 *
 * D4 invariant — the routing path is non-blocking. `snapshot` and `resolve`
 * MUST only do `Ref.get` (and pure HashMap reads). They MUST NOT call
 * `Effect.sleep`, perform I/O, or otherwise suspend on anything other than
 * the unconditional Ref read. Background fibers (K8s watch, HealthProbe)
 * own all suspending work; they update an in-memory `SubscriptionRef` and
 * the routing path snapshots it lock-free.
 *
 * `changes` is a Stream backed by `SubscriptionRef.changes`-style fan-out:
 * each registry mutation emits one tagged `RegistryEvent` so consumers can
 * react incrementally rather than diffing snapshots.
 */

import type { Brand, Effect, Option, Stream } from "effect"
import { ServiceMap } from "effect"
import type { SocketAddr } from "../RoutingStrategy.js"

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

/**
 * Worker identity. In production this is the K8s Pod name (StatefulSet pods
 * have stable, ordered names like `b2bua-worker-0`). In tests / static
 * mode it's any non-empty string the operator chose. Branded so the proxy
 * can't accidentally pass a host or call-id where a worker id is expected.
 */
export type WorkerId = string & Brand.Brand<"@sipjsserver/sip-front-proxy/WorkerId">

/** Construct a `WorkerId` from a raw string. No runtime validation here —
 * the registry impls are responsible for rejecting empty / malformed ids
 * at the layer-build boundary. */
export const WorkerId = (raw: string): WorkerId => raw as WorkerId

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Health classification for a worker, per D5 (draining model).
 *
 * `unknown` is the initial state for a freshly-admitted worker that the
 * proxy has not yet exchanged an OPTIONS round-trip with. It is **distinct
 * from `dead`**: dead means we previously confirmed the worker is gone,
 * unknown means we haven't yet confirmed anything. Routing-side filters
 * MUST treat unknown as not-routable for new dialogs (same as dead). The
 * distinction is preserved so future hysteresis on `dead → alive` recovery
 * (e.g. require N consecutive 200 OKs before re-admitting) does not also
 * penalize cold-start workers.
 */
export type WorkerHealth = "unknown" | "alive" | "draining" | "dead"

export interface WorkerEntry {
  readonly id: WorkerId
  readonly address: SocketAddr
  readonly health: WorkerHealth
  /**
   * Epoch milliseconds when the worker first transitioned into `draining`.
   * Used by `LoadBalancerStrategy` (PR3b) to decide whether the in-dialog
   * grace window has elapsed. `undefined` for `alive`/`dead`.
   *
   * We deliberately use a plain number rather than an effect `DateTime`/
   * `Instant` to match existing project convention (epoch ms everywhere —
   * see `CancelBranchLru.Entry.expiresAtMs`).
   */
  readonly drainingSince?: number
}

/**
 * Tagged delta the registry emits whenever its observable state changes.
 * Consumers (HealthProbe, metrics) match on `_tag` and update their own
 * derived state.
 */
export type RegistryEvent =
  | { readonly _tag: "added"; readonly entry: WorkerEntry }
  | { readonly _tag: "removed"; readonly id: WorkerId }
  | {
      readonly _tag: "health_changed"
      readonly id: WorkerId
      readonly from: WorkerHealth
      readonly to: WorkerHealth
    }
  | {
      readonly _tag: "address_changed"
      readonly id: WorkerId
      readonly from: SocketAddr
      readonly to: SocketAddr
    }

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface WorkerRegistryApi {
  /**
   * Snapshot the current worker set. Strictly non-suspending: implemented
   * as a single `Ref.get` (or `SubscriptionRef.get`) per the D4 invariant.
   * Safe to call from the routing hot path; safe to `Effect.runSync` in
   * tests.
   */
  readonly snapshot: Effect.Effect<ReadonlyArray<WorkerEntry>>
  /**
   * Resolve a worker by id. Strictly non-suspending: a `Ref.get` followed
   * by a HashMap lookup. Returns `Option.none` if the id is not registered
   * (or has been removed).
   */
  readonly resolve: (id: WorkerId) => Effect.Effect<Option.Option<WorkerEntry>>
  /**
   * Reverse lookup: find the worker bound at `(host, port)`. Strictly
   * non-suspending; safe on the hot path. Used by the proxy when it
   * receives a packet from a worker (the source address identifies which
   * worker is initiating an outbound call) so it can stamp the matching
   * stickiness cookie on the B-leg Record-Route. Returns `Option.none`
   * if the address doesn't match any registered worker — which happens
   * for any non-worker source (Alice, Bob, an external SBC).
   */
  readonly lookupByAddress: (addr: SocketAddr) => Effect.Effect<Option.Option<WorkerEntry>>
  /**
   * Hot stream of registry deltas. Each subscriber sees events from the
   * point of subscription onwards (no backfill — subscribers that need
   * the current set should `snapshot` first, then process `changes`).
   */
  readonly changes: Stream.Stream<RegistryEvent>
}

export class WorkerRegistry extends ServiceMap.Service<WorkerRegistry, WorkerRegistryApi>()(
  "@sipjsserver/sip-front-proxy/WorkerRegistry"
) {}
