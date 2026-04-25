/**
 * WorkerRegistryControl — write surface used by `HealthProbe` to flip
 * health annotations on the registry.
 *
 * Why a second tag rather than widening `WorkerRegistry`: the read
 * surface is on the routing hot path and must stay strictly
 * non-suspending (D4). Health writes happen on background fibers and
 * may suspend (e.g. publishing onto a PubSub). Splitting the tags lets
 * read consumers depend on a tighter surface that the type-checker
 * forbids them from mutating.
 *
 * Three concrete impls across the plan:
 *
 *   - `simulatedAdapter` (this file) — wraps the existing
 *     `WorkerRegistrySimulatedControl` so tests get a single interface
 *     for both probe modes (`optionsKeepalive` and `manual`).
 *   - `noopLayer` (this file) — production stub for PR4 when no live
 *     write source is wired yet. PR5 replaces this with the K8s watcher.
 *   - `kubernetesStatefulSet` (PR5) — driven by the K8s pod watch.
 *
 * The interface is deliberately minimal: just `setHealth`. PR5 may
 * extend it with `setAddress` for pod-IP rotation; for PR4 the probe
 * never mutates addresses.
 */

import { Effect, Layer, ServiceMap } from "effect"
import {
  WorkerRegistrySimulatedControl,
  type WorkerRegistrySimulatedControlApi,
} from "../registry/simulated.js"
import type { WorkerHealth, WorkerId } from "../registry/WorkerRegistry.js"

export interface WorkerRegistryControlApi {
  /**
   * Annotate a worker's health. No-op when the worker is not
   * registered or when the value is unchanged. Suspending is allowed —
   * the routing path never calls this.
   */
  readonly setHealth: (id: WorkerId, health: WorkerHealth) => Effect.Effect<void>
}

export class WorkerRegistryControl extends ServiceMap.Service<
  WorkerRegistryControl,
  WorkerRegistryControlApi
>()("@sipjsserver/sip-front-proxy/WorkerRegistryControl") {}

/**
 * Adapter that satisfies `WorkerRegistryControl` by delegating to the
 * existing simulated control surface. Tests build the simulated
 * registry as before, then layer this on top so probes (and the
 * draining fallback logic in `LoadBalancerStrategy`) don't need to
 * import simulated internals.
 */
export const simulatedAdapterLayer: Layer.Layer<
  WorkerRegistryControl,
  never,
  WorkerRegistrySimulatedControl
> = Layer.effect(
  WorkerRegistryControl,
  Effect.gen(function* () {
    const sim: WorkerRegistrySimulatedControlApi = yield* WorkerRegistrySimulatedControl
    return {
      setHealth: (id, health) => sim.setHealth(id, health),
    }
  })
)

/**
 * Production no-op control for PR4 — accepts every write and discards
 * it. Used until PR5 wires the K8s watcher. The probe still works
 * (it logs the would-be transitions), but the registry only reflects
 * the static seed.
 *
 * Logged at debug so a misconfigured production deploy is visible
 * without spamming a noisy log line per probe cycle.
 */
export const noopLayer: Layer.Layer<WorkerRegistryControl> = Layer.succeed(
  WorkerRegistryControl,
  {
    setHealth: (id, health) =>
      Effect.logDebug(
        `WorkerRegistryControl[noop]: ignoring setHealth(${id}, ${health})`
      ),
  }
)
