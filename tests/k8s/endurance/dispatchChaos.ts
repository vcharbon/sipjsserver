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
  verifyIptablesDropCounter,
  WORKER_LABEL,
  type ChaosEventType,
  type ChaosOutcome,
  type NetworkChaosOpts,
  type NetworkChaosPeerSet,
} from "./chaosOps.js"
import { nonEmergencyBurstEvent } from "./sippJobs.js"

/**
 * Mid-cut counter read after this many ms. Hard cuts saturate the
 * iptables FORWARD-chain rule within a few hundred ms at 30 CAPS, but
 * keep some slack for slow scheduler quanta.
 */
const HARD_CUT_VERIFY_MID_MS = 5_000
/**
 * Loss cuts sample only ~30% of matched packets — give the counter
 * more wall time to climb past zero.
 */
const LOSS_CUT_VERIFY_MID_MS = 10_000

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
    case "worker-pod-api-delete-force":
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
    case "worker-cut-from-proxy-hard": {
      const cutOpts: NetworkChaosOpts = {
        namespace,
        type,
        targetLabel: WORKER_LABEL,
        peerSets: ["proxy"],
        intensity: { kind: "hard" },
        buildVerify: ({ nodes }) =>
          verifyIptablesDropCounter(nodes, HARD_CUT_VERIFY_MID_MS),
      }
      return networkChaosEvent(cutOpts, rand)
    }
    case "worker-cut-from-peers-hard": {
      const cutOpts: NetworkChaosOpts = {
        namespace,
        type,
        targetLabel: WORKER_LABEL,
        peerSets: ["peers"],
        intensity: { kind: "hard" },
        // The replication puller (b2bua-worker-0 ↔ b2bua-worker-1)
        // exchanges /replog SSE traffic continuously. Iptables counter
        // is the direct OS-level proof. SUT-side puller-reconnect log
        // is harder to scope without false negatives (the puller may
        // be mid-reconnect when we sample), so we lead with iptables.
        buildVerify: ({ nodes }) =>
          verifyIptablesDropCounter(nodes, HARD_CUT_VERIFY_MID_MS),
      }
      return networkChaosEvent(cutOpts, rand)
    }
    case "worker-cut-from-limiter-redis-hard": {
      const cutOpts: NetworkChaosOpts = {
        namespace,
        type,
        targetLabel: WORKER_LABEL,
        peerSets: ["limiter-redis"],
        intensity: { kind: "hard" },
        // iptables counter is the only reliable proof here. The worker
        // does NOT emit `Redis (limiter): error` within 5s of a packet
        // cut: ioredis fires `error` events on TCP close, but a packet
        // drop just stalls the existing TCP socket — the worker observes
        // hung consult calls (Event handler timed out after 10s) rather
        // than a Redis error event.
        buildVerify: ({ nodes }) =>
          verifyIptablesDropCounter(nodes, HARD_CUT_VERIFY_MID_MS),
      }
      return networkChaosEvent(cutOpts, rand)
    }
    case "worker-isolate-all-hard": {
      const cutOpts: NetworkChaosOpts = {
        namespace,
        type,
        targetLabel: WORKER_LABEL,
        peerSets: [
          "proxy",
          "peers",
          "limiter-redis",
        ] as ReadonlyArray<NetworkChaosPeerSet>,
        intensity: { kind: "hard" },
        buildVerify: ({ nodes }) =>
          verifyIptablesDropCounter(nodes, HARD_CUT_VERIFY_MID_MS),
      }
      return networkChaosEvent(cutOpts, rand)
    }
    case "worker-cut-from-proxy-loss30": {
      const cutOpts: NetworkChaosOpts = {
        namespace,
        type,
        targetLabel: WORKER_LABEL,
        peerSets: ["proxy"],
        intensity: { kind: "loss", probability: 0.3 },
        buildVerify: ({ nodes }) =>
          verifyIptablesDropCounter(nodes, LOSS_CUT_VERIFY_MID_MS),
      }
      return networkChaosEvent(cutOpts, rand)
    }
    case "proxy-full-isolate": {
      const cutOpts: NetworkChaosOpts = {
        namespace,
        type,
        targetLabel: PROXY_LABEL,
        peerSets: ["all"],
        intensity: { kind: "hard" },
        buildVerify: ({ nodes }) =>
          verifyIptablesDropCounter(nodes, HARD_CUT_VERIFY_MID_MS),
      }
      return networkChaosEvent(cutOpts, rand)
    }
    case "non-emergency-burst":
      return nonEmergencyBurstEvent({
        namespace,
        runId: artifactDir.split("/").pop() ?? artifactDir,
        artifactDir,
      })
  }
}
