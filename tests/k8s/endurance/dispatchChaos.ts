/**
 * Shared chaos-event dispatcher. The random-schedule SOAK loop in
 * `run-endurance.ts` and the iteration sub-command in `run-chaos.ts`
 * both go through this single entry point so they can never diverge.
 *
 * Implementation note: kept in its own file (no top-level side effects)
 * so importing it does NOT trigger the orchestrator's main() runner.
 */

import { Effect } from "effect"
import {
  killPodEvent,
  networkChaosEvent,
  nodeShutdownEvent,
  proxyCutoffEvent,
  PROXY_LABEL,
  WORKER_LABEL,
  type ChaosEventType,
  type ChaosOutcome,
  type NetworkChaosPeerSet,
} from "./chaosOps.js"
import { nonEmergencyBurstEvent } from "./sippJobs.js"

export interface DispatchOpts {
  readonly namespace: string
  readonly artifactDir: string
  /**
   * Pre-kill /debug/heap-snapshot capture for graceful worker kills.
   * Pass undefined when the sub-command fires a worker-pod-graceful
   * outside the orchestrator's recorder context.
   */
  readonly captureForensicsBeforeKill?: (
    namespace: string,
    podName: string,
  ) => Effect.Effect<void, never>
}

export const dispatchChaos = (
  type: ChaosEventType,
  rand: () => number,
  opts: DispatchOpts,
): Effect.Effect<ChaosOutcome, { readonly message: string }> => {
  const { namespace, artifactDir } = opts
  switch (type) {
    case "node-shutdown-app":
      return nodeShutdownEvent({ namespace, tier: "app" }, rand)
    case "node-shutdown-edge":
      return nodeShutdownEvent({ namespace, tier: "edge" }, rand)
    case "proxy-cutoff-vrrp":
      return proxyCutoffEvent({ namespace, kind: "vrrp" }, rand)
    case "worker-pod-graceful":
    case "worker-pod-kill9":
    case "proxy-pod-graceful":
    case "proxy-pod-kill9":
    case "limiter-redis-graceful":
    case "limiter-redis-kill9":
      return killPodEvent(
        {
          namespace,
          type,
          ...(opts.captureForensicsBeforeKill !== undefined && {
            captureForensicsBeforeKill: opts.captureForensicsBeforeKill,
          }),
        },
        rand,
      )
    case "worker-cut-from-proxy-hard":
      return networkChaosEvent(
        {
          namespace,
          type,
          targetLabel: WORKER_LABEL,
          peerSets: ["proxy"],
          intensity: { kind: "hard" },
        },
        rand,
      )
    case "worker-cut-from-peers-hard":
      return networkChaosEvent(
        {
          namespace,
          type,
          targetLabel: WORKER_LABEL,
          peerSets: ["peers"],
          intensity: { kind: "hard" },
        },
        rand,
      )
    case "worker-cut-from-limiter-redis-hard":
      return networkChaosEvent(
        {
          namespace,
          type,
          targetLabel: WORKER_LABEL,
          peerSets: ["limiter-redis"],
          intensity: { kind: "hard" },
        },
        rand,
      )
    case "worker-isolate-all-hard":
      return networkChaosEvent(
        {
          namespace,
          type,
          targetLabel: WORKER_LABEL,
          peerSets: [
            "proxy",
            "peers",
            "limiter-redis",
          ] as ReadonlyArray<NetworkChaosPeerSet>,
          intensity: { kind: "hard" },
        },
        rand,
      )
    case "worker-cut-from-proxy-loss30":
      return networkChaosEvent(
        {
          namespace,
          type,
          targetLabel: WORKER_LABEL,
          peerSets: ["proxy"],
          intensity: { kind: "loss", probability: 0.3 },
        },
        rand,
      )
    case "proxy-full-isolate":
      return networkChaosEvent(
        {
          namespace,
          type,
          targetLabel: PROXY_LABEL,
          peerSets: ["all"],
          intensity: { kind: "hard" },
        },
        rand,
      )
    case "non-emergency-burst":
      return nonEmergencyBurstEvent({
        namespace,
        runId: artifactDir.split("/").pop() ?? artifactDir,
        artifactDir,
      })
  }
}
