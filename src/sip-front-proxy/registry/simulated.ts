/**
 * Simulated `WorkerRegistry` — D3, test-controllable impl.
 *
 * Tests drive registry membership and per-worker health by holding a
 * second service tag (`WorkerRegistrySimulatedControl`) alongside the
 * `WorkerRegistry` they're testing against. Every control mutation
 * publishes a tagged `RegistryEvent` through a `PubSub` so the
 * `WorkerRegistry.changes` stream observed by routing-side code sees
 * the same delta sequence the test provoked.
 *
 * Layer: `simulatedLayer({ initial? })` returns a single Layer that
 * provides BOTH `WorkerRegistry` and `WorkerRegistrySimulatedControl`,
 * so test fixtures don't have to redo the wiring to grab the control
 * handle. Per-test usage:
 *
 *   const layer = simulatedLayer()
 *   it.effect("…", () => Effect.gen(function* () {
 *     const ctl = yield* WorkerRegistrySimulatedControl
 *     const reg = yield* WorkerRegistry
 *     yield* ctl.add({ id: WorkerId("pod-0"), address, health: "alive" })
 *     // …assert on reg.snapshot / reg.resolve / reg.changes…
 *   }).pipe(Effect.provide(layer)))
 *
 * D4 invariant: `snapshot` and `resolve` only do `Ref.get`; control
 * mutations and PubSub publishing live in the (separate) control API,
 * which tests are free to drive sequentially.
 */

import {
  Clock,
  Effect,
  HashMap,
  Layer,
  Option,
  PubSub,
  Ref,
  ServiceMap,
  Stream,
} from "effect"
import type { SocketAddr } from "../RoutingStrategy.js"
import {
  type RegistryEvent,
  type WorkerEntry,
  type WorkerHealth,
  type WorkerId,
  WorkerRegistry,
  type WorkerRegistryApi,
} from "./WorkerRegistry.js"

// ---------------------------------------------------------------------------
// Control service surface
// ---------------------------------------------------------------------------

export interface WorkerRegistrySimulatedControlApi {
  /** Add a new worker. No-op (and no event) if `id` is already registered. */
  readonly add: (entry: WorkerEntry) => Effect.Effect<void>
  /** Remove a worker. No-op (and no event) if `id` is not registered. */
  readonly remove: (id: WorkerId) => Effect.Effect<void>
  /** Set a worker's health. No-op if the value is unchanged. */
  readonly setHealth: (id: WorkerId, health: WorkerHealth) => Effect.Effect<void>
  /** Replace a worker's address. No-op if the value is unchanged. */
  readonly setAddress: (id: WorkerId, address: SocketAddr) => Effect.Effect<void>
}

export class WorkerRegistrySimulatedControl extends ServiceMap.Service<
  WorkerRegistrySimulatedControl,
  WorkerRegistrySimulatedControlApi
>()("@sipjsserver/sip-front-proxy/WorkerRegistrySimulatedControl") {}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const sameAddress = (a: SocketAddr, b: SocketAddr): boolean =>
  a.host === b.host && a.port === b.port

/**
 * Update an entry's health, stamping `drainingSince` on the alive→draining
 * edge and clearing it on every other transition. PR3b uses the timestamp
 * to gate the in-dialog grace window.
 */
const transitionHealth = (
  entry: WorkerEntry,
  to: WorkerHealth,
  nowMs: number
): WorkerEntry => {
  if (to === "draining") {
    return { ...entry, health: to, drainingSince: nowMs }
  }
  // Drop drainingSince on transitions out of draining. We rebuild the
  // object literal explicitly (rather than `delete`-ing) to keep it as a
  // plain immutable record.
  const { drainingSince: _omit, ...rest } = entry
  return { ...rest, health: to }
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export interface SimulatedLayerOpts {
  /** Initial worker set; defaults to empty. */
  readonly initial?: ReadonlyArray<WorkerEntry>
  /**
   * Bound for the internal `PubSub<RegistryEvent>`. Tests rarely produce
   * more than a handful of events per scenario, but the unbounded variant
   * would let a runaway test fill memory; 256 is plenty.
   */
  readonly eventBufferCapacity?: number
}

/**
 * Build a single Layer providing both `WorkerRegistry` (the read surface
 * routing-side code uses) and `WorkerRegistrySimulatedControl` (the
 * write surface tests use).
 */
export const simulatedLayer = (
  opts: SimulatedLayerOpts = {}
): Layer.Layer<WorkerRegistry | WorkerRegistrySimulatedControl> => {
  const initial = opts.initial ?? []
  const eventBufferCapacity = opts.eventBufferCapacity ?? 256

  return Layer.effectServices(
    Effect.gen(function* () {
      const stateRef = yield* Ref.make(
        HashMap.fromIterable(initial.map((e) => [e.id, e] as const))
      )
      const events = yield* PubSub.bounded<RegistryEvent>(eventBufferCapacity)

      // ── Read surface (D4: pure Ref.get / HashMap reads) ───────────────
      const registry: WorkerRegistryApi = {
        snapshot: Ref.get(stateRef).pipe(
          Effect.map((map) => Array.from(HashMap.values(map)))
        ),
        resolve: (id) =>
          Ref.get(stateRef).pipe(Effect.map((map) => HashMap.get(map, id))),
        lookupByAddress: (addr) =>
          Ref.get(stateRef).pipe(
            Effect.map((map) => {
              for (const entry of HashMap.values(map)) {
                if (
                  entry.address.host === addr.host &&
                  entry.address.port === addr.port
                ) {
                  return Option.some(entry)
                }
              }
              return Option.none<WorkerEntry>()
            })
          ),
        changes: Stream.fromPubSub(events),
      }

      // ── Control surface (free to suspend; only used by tests) ─────────
      const control: WorkerRegistrySimulatedControlApi = {
        add: (entry) =>
          Effect.gen(function* () {
            const map = yield* Ref.get(stateRef)
            if (HashMap.has(map, entry.id)) return
            yield* Ref.set(stateRef, HashMap.set(map, entry.id, entry))
            yield* PubSub.publish(events, { _tag: "added", entry })
          }),
        remove: (id) =>
          Effect.gen(function* () {
            const map = yield* Ref.get(stateRef)
            if (!HashMap.has(map, id)) return
            yield* Ref.set(stateRef, HashMap.remove(map, id))
            yield* PubSub.publish(events, { _tag: "removed", id })
          }),
        setHealth: (id, health) =>
          Effect.gen(function* () {
            const map = yield* Ref.get(stateRef)
            const current = HashMap.get(map, id)
            if (current._tag === "None") return
            if (current.value.health === health) return
            const from = current.value.health
            const nowMs = yield* Clock.currentTimeMillis
            const next = transitionHealth(current.value, health, nowMs)
            yield* Ref.set(stateRef, HashMap.set(map, id, next))
            yield* PubSub.publish(events, {
              _tag: "health_changed",
              id,
              from,
              to: health,
            })
          }),
        setAddress: (id, address) =>
          Effect.gen(function* () {
            const map = yield* Ref.get(stateRef)
            const current = HashMap.get(map, id)
            if (current._tag === "None") return
            if (sameAddress(current.value.address, address)) return
            const from = current.value.address
            const next: WorkerEntry = { ...current.value, address }
            yield* Ref.set(stateRef, HashMap.set(map, id, next))
            yield* PubSub.publish(events, {
              _tag: "address_changed",
              id,
              from,
              to: address,
            })
          }),
      }

      return ServiceMap.empty().pipe(
        ServiceMap.add(WorkerRegistry, registry),
        ServiceMap.add(WorkerRegistrySimulatedControl, control)
      )
    })
  )
}
