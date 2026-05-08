/**
 * Chaos primitives for the endurance harness.
 *
 * Three classes of disruption are supported:
 *
 *   1. Pod kill — graceful (`kubectl delete --grace-period=0 --force`)
 *      or abrupt (`kubectl exec -- kill -9 1`). Reuses semantics from
 *      tests/k8s/fixtures/podKill.ts.
 *
 *   2. Kind node shutdown — `docker stop <kind-node-container>` for a
 *      bounded outage, then `docker start`. The kubelet re-attaches
 *      bound pods on return; pods are NOT deleted (per plan).
 *
 *   3. Shared limiter Redis kill — separate path because the limiter
 *      Redis is a single-replica Deployment with its own labels.
 *
 * Each operation returns a `ChaosOutcome` describing exactly what
 * happened, the time at which the kill was issued (`tFire`), and the
 * time the system recovered (`tRecovered`). The orchestrator's
 * `chaos-timeline.ndjson` is built from these.
 */

import { Data, Effect } from "effect"
import { exec } from "../fixtures/exec.js"
import { execInPod, listPods, type PodInfo } from "../fixtures/kubectl.js"
import { killPod, type KillMode } from "../fixtures/podKill.js"

export class ChaosOpsError extends Data.TaggedError("ChaosOpsError")<{
  readonly op: string
  readonly target: string
  readonly reason: string
}> {
  override get message(): string {
    return `chaos op '${this.op}' on '${this.target}' failed: ${this.reason}`
  }
}

export type ChaosEventType =
  | "worker-pod-graceful"
  | "worker-pod-kill9"
  | "proxy-pod-graceful"
  | "proxy-pod-kill9"
  | "limiter-redis-graceful"
  | "limiter-redis-kill9"
  | "node-shutdown-app"
  | "node-shutdown-edge"
  | "proxy-cutoff-vrrp"

// Chaos catalog rule: only events whose proper handling has zero or
// near-zero traffic impact. `proxy-cutoff-vrrp` qualifies — with
// nopreempt + strict-ARP the original master keeps the VIP, peer just
// sees a silent partner. `proxy-cutoff-ingress` (blackhole UDP/5060 on
// the active node) and `proxy-cutoff-workers` (blackhole egress to the
// pod CIDR) were considered but rejected: ingress has no realistic prod
// analog and no clean handling path; workers depends on a working
// chk_proxy script to cede the VIP, which the current keepalived
// sidecar doesn't run cleanly. Re-introduce only when both have a
// detection path with sub-second failover.
export type ProxyCutoffKind = "vrrp"

export interface ChaosOutcome {
  readonly type: ChaosEventType
  readonly target: string
  readonly tFire: Date
  readonly tRecovered: Date
  /** Replicas ready before the event fired. */
  readonly readyBefore: number
  /** Replicas ready after recovery completed. */
  readonly readyAfter: number
}

export const PROXY_LABEL = "app.kubernetes.io/name=sip-front-proxy"
export const WORKER_LABEL = "app.kubernetes.io/name=b2bua-worker"
export const LIMITER_REDIS_LABEL = "app.kubernetes.io/name=redis"

export const PROXY_DEPLOYMENT = "sip-front-proxy"
export const WORKER_STATEFULSET = "b2bua-worker"
export const LIMITER_REDIS_DEPLOYMENT = "redis"

const PROXY_REPLICAS = 2
const WORKER_REPLICAS = 2
const LIMITER_REDIS_REPLICAS = 1

/** Maximum seconds to wait for replica count to return to expected. */
const RECOVERY_TIMEOUT_SEC = 120

/** Bounded outage duration for node shutdowns. */
const NODE_OUTAGE_SEC = 60

/** Bounded outage duration for proxy network cutoffs. */
const PROXY_CUTOFF_SEC = 30

export interface KillPodEventOpts {
  readonly namespace: string
  readonly type:
    | "worker-pod-graceful"
    | "worker-pod-kill9"
    | "proxy-pod-graceful"
    | "proxy-pod-kill9"
    | "limiter-redis-graceful"
    | "limiter-redis-kill9"
}

/**
 * Pick a random kill target satisfying the "leave at least one ready"
 * constraint, then execute the kill. Returns ChaosOutcome with the
 * recovery wait already complete.
 */
export const killPodEvent = (
  opts: KillPodEventOpts,
  rand: () => number,
): Effect.Effect<ChaosOutcome, ChaosOpsError> =>
  Effect.gen(function* () {
    const { label, mode, replicas, deploymentLike, kind } = decodePodEvent(opts.type)
    const pods = yield* listPods(opts.namespace, label)
    const ready = pods.filter((p) => p.ready)
    if (ready.length === 0) {
      return yield* new ChaosOpsError({
        op: opts.type,
        target: label,
        reason: `no ready pods (need ≥1 to leave one alive after kill)`,
      })
    }
    if (ready.length < 2 && replicas >= 2) {
      return yield* new ChaosOpsError({
        op: opts.type,
        target: label,
        reason: `only ${ready.length} ready pod(s); killing would leave zero (need ≥2 to be safe)`,
      })
    }
    // Random pick (deterministic via injected `rand`).
    const idx = Math.floor(rand() * ready.length)
    const targetSpec = ready[idx]
    if (targetSpec === undefined) {
      return yield* new ChaosOpsError({
        op: opts.type,
        target: label,
        reason: `random pick failed (idx=${idx}, len=${ready.length})`,
      })
    }
    const target: PodInfo = targetSpec

    const tFire = yield* killPod(opts.namespace, target.name, mode).pipe(
      Effect.mapError(
        (e) =>
          new ChaosOpsError({
            op: opts.type,
            target: target.name,
            reason: `killPod failed: ${e.message}`,
          }),
      ),
    )
    yield* Effect.logInfo(
      `chaos[${opts.type}] killed ${target.name} (${kind}); waiting for ${deploymentLike} recovery`,
    )
    const tRecovered = yield* waitReplicasReady(
      opts.namespace,
      label,
      replicas,
      RECOVERY_TIMEOUT_SEC,
    ).pipe(
      Effect.mapError(
        (msg) =>
          new ChaosOpsError({
            op: opts.type,
            target: target.name,
            reason: msg,
          }),
      ),
    )
    return {
      type: opts.type,
      target: target.name,
      tFire,
      tRecovered,
      readyBefore: ready.length,
      readyAfter: replicas,
    }
  })

/**
 * Pick a kind worker node by tier, stop its docker container for
 * `NODE_OUTAGE_SEC`, then start it again. Wait for kubelet to re-Ready
 * the node. Returns the outcome with the chosen node name.
 *
 * The cluster is named `sip-e2e` (cluster.ts CLUSTER_NAME); kind names
 * its node containers `<cluster>-control-plane`, `<cluster>-worker`,
 * `<cluster>-worker2`, etc. We resolve which docker name corresponds to
 * which `tier` label by querying kubectl.
 */
export const nodeShutdownEvent = (
  opts: { readonly namespace: string; readonly tier: "app" | "edge" },
  rand: () => number,
): Effect.Effect<ChaosOutcome, ChaosOpsError> =>
  Effect.gen(function* () {
    const type: ChaosEventType =
      opts.tier === "app" ? "node-shutdown-app" : "node-shutdown-edge"
    const candidates = yield* listNodesByTier(opts.tier).pipe(
      Effect.mapError(
        (msg) =>
          new ChaosOpsError({
            op: type,
            target: `tier=${opts.tier}`,
            reason: msg,
          }),
      ),
    )
    if (candidates.length === 0) {
      return yield* new ChaosOpsError({
        op: type,
        target: `tier=${opts.tier}`,
        reason: `no nodes found for tier`,
      })
    }
    // Constraint: don't shut down a node if it would leave its tier with
    // zero ready nodes.
    if (candidates.length < 2) {
      return yield* new ChaosOpsError({
        op: type,
        target: `tier=${opts.tier}`,
        reason: `only ${candidates.length} node(s) of tier '${opts.tier}'; need ≥2 to safely shut one down`,
      })
    }
    const idx = Math.floor(rand() * candidates.length)
    const chosen = candidates[idx]
    if (chosen === undefined) {
      return yield* new ChaosOpsError({
        op: type,
        target: `tier=${opts.tier}`,
        reason: `random pick failed (idx=${idx}, len=${candidates.length})`,
      })
    }

    // Match labels for the relevant deployment to count ready replicas
    // before/after.
    const witness =
      opts.tier === "app"
        ? { label: WORKER_LABEL, expected: WORKER_REPLICAS }
        : { label: PROXY_LABEL, expected: PROXY_REPLICAS }
    const podsBefore = yield* listPods(opts.namespace, witness.label)
    const readyBefore = podsBefore.filter((p) => p.ready).length

    const tFire = new Date()
    yield* Effect.logInfo(
      `chaos[${type}] docker stop ${chosen} (${opts.tier} node) for ${NODE_OUTAGE_SEC}s`,
    )
    yield* exec("docker", ["stop", chosen], { timeoutMs: 60_000 }).pipe(
      Effect.mapError(
        (e) =>
          new ChaosOpsError({
            op: type,
            target: chosen,
            reason: `docker stop failed: ${e.stderr.trim() || e.stdout.trim()}`,
          }),
      ),
    )
    yield* Effect.sleep(`${NODE_OUTAGE_SEC} seconds`)
    yield* Effect.logInfo(`chaos[${type}] docker start ${chosen}`)
    yield* exec("docker", ["start", chosen], { timeoutMs: 60_000 }).pipe(
      Effect.mapError(
        (e) =>
          new ChaosOpsError({
            op: type,
            target: chosen,
            reason: `docker start failed: ${e.stderr.trim() || e.stdout.trim()}`,
          }),
      ),
    )
    // Wait for the node to go Ready again, then for replicas to settle.
    yield* waitNodeReady(chosen, RECOVERY_TIMEOUT_SEC).pipe(
      Effect.mapError(
        (msg) =>
          new ChaosOpsError({ op: type, target: chosen, reason: msg }),
      ),
    )
    const tRecovered = yield* waitReplicasReady(
      opts.namespace,
      witness.label,
      witness.expected,
      RECOVERY_TIMEOUT_SEC,
    ).pipe(
      Effect.mapError(
        (msg) =>
          new ChaosOpsError({ op: type, target: chosen, reason: msg }),
      ),
    )
    return {
      type,
      target: chosen,
      tFire,
      tRecovered,
      readyBefore,
      readyAfter: witness.expected,
    }
  })

/**
 * Pick a random ready proxy pod, identify its kind node container,
 * install an iptables rule that drops VRRP advertisements (proto 112)
 * for `PROXY_CUTOFF_SEC`, then remove it. Tests split-brain handling:
 * with `nopreempt` set, the original master keeps the VIP and peer just
 * sees a silent partner — no client-side impact. See docs/lb-proxy-ha.md.
 */
export const proxyCutoffEvent = (
  opts: {
    readonly namespace: string
    readonly kind: ProxyCutoffKind
  },
  rand: () => number,
): Effect.Effect<ChaosOutcome, ChaosOpsError> =>
  Effect.gen(function* () {
    const type: ChaosEventType = "proxy-cutoff-vrrp"
    void opts.kind

    const pods = yield* listPods(opts.namespace, PROXY_LABEL)
    const ready = pods.filter((p) => p.ready)
    if (ready.length < 2) {
      return yield* new ChaosOpsError({
        op: type,
        target: PROXY_LABEL,
        reason: `only ${ready.length} ready proxy pod(s); need ≥2 to safely cutoff one`,
      })
    }
    const idx = Math.floor(rand() * ready.length)
    const target = ready[idx]
    if (target === undefined) {
      return yield* new ChaosOpsError({
        op: type,
        target: PROXY_LABEL,
        reason: `random pick failed (idx=${idx}, len=${ready.length})`,
      })
    }
    if (target.node === "") {
      return yield* new ChaosOpsError({
        op: type,
        target: target.name,
        reason: `pod has no .spec.nodeName — cannot resolve kind container`,
      })
    }
    const node = target.node
    const rule = iptablesRuleFor(opts.kind)

    const tFire = new Date()
    yield* Effect.logInfo(
      `chaos[${type}] iptables -A ${rule} on kind node ${node} (proxy ${target.name}) for ${PROXY_CUTOFF_SEC}s`,
    )
    yield* exec("docker", ["exec", node, "iptables", "-A", ...rule.split(" ")], {
      timeoutMs: 10_000,
    }).pipe(
      Effect.mapError(
        (e) =>
          new ChaosOpsError({
            op: type,
            target: node,
            reason: `iptables -A failed: ${e.stderr.trim() || e.stdout.trim()}`,
          }),
      ),
    )

    yield* Effect.sleep(`${PROXY_CUTOFF_SEC} seconds`)

    yield* Effect.logInfo(`chaos[${type}] iptables -D ${rule} on ${node}`)
    // Best-effort restore; if the rule was already removed (e.g., kind
    // container restart) we still want the run to continue.
    yield* exec("docker", ["exec", node, "iptables", "-D", ...rule.split(" ")], {
      timeoutMs: 10_000,
    }).pipe(
      Effect.matchEffect({
        onSuccess: () => Effect.void,
        onFailure: (e) =>
          Effect.logWarning(
            `chaos[${type}] iptables -D non-fatal failure on ${node}: ${e.stderr.trim() || e.stdout.trim()}`,
          ),
      }),
    )

    // Recovery is "rule removed"; we don't wait for application-level
    // re-convergence (the analyzer measures that from sipp results).
    const tRecovered = new Date()
    return {
      type,
      target: target.name,
      tFire,
      tRecovered,
      readyBefore: ready.length,
      readyAfter: ready.length,
    }
  })

const iptablesRuleFor = (_kind: ProxyCutoffKind): string => {
  // Drop INPUT for IP proto 112 (VRRP). The peer's advertisements stop
  // arriving on this node; with nopreempt set in keepalived.conf the
  // peer keeps mastering and this node sees a silent partner.
  return `INPUT -p 112 -j DROP`
}

interface PodEventDecoded {
  readonly label: string
  readonly mode: KillMode
  readonly replicas: number
  readonly deploymentLike: string
  readonly kind: "worker" | "proxy" | "limiter-redis"
}

const decodePodEvent = (type: KillPodEventOpts["type"]): PodEventDecoded => {
  switch (type) {
    case "worker-pod-graceful":
      return {
        label: WORKER_LABEL,
        mode: "delete-grace0",
        replicas: WORKER_REPLICAS,
        deploymentLike: WORKER_STATEFULSET,
        kind: "worker",
      }
    case "worker-pod-kill9":
      return {
        label: WORKER_LABEL,
        mode: "exec-kill-9",
        replicas: WORKER_REPLICAS,
        deploymentLike: WORKER_STATEFULSET,
        kind: "worker",
      }
    case "proxy-pod-graceful":
      return {
        label: PROXY_LABEL,
        mode: "delete-grace0",
        replicas: PROXY_REPLICAS,
        deploymentLike: PROXY_DEPLOYMENT,
        kind: "proxy",
      }
    case "proxy-pod-kill9":
      return {
        label: PROXY_LABEL,
        mode: "exec-kill-9",
        replicas: PROXY_REPLICAS,
        deploymentLike: PROXY_DEPLOYMENT,
        kind: "proxy",
      }
    case "limiter-redis-graceful":
      return {
        label: LIMITER_REDIS_LABEL,
        mode: "delete-grace0",
        replicas: LIMITER_REDIS_REPLICAS,
        deploymentLike: LIMITER_REDIS_DEPLOYMENT,
        kind: "limiter-redis",
      }
    case "limiter-redis-kill9":
      return {
        label: LIMITER_REDIS_LABEL,
        mode: "exec-kill-9",
        replicas: LIMITER_REDIS_REPLICAS,
        deploymentLike: LIMITER_REDIS_DEPLOYMENT,
        kind: "limiter-redis",
      }
  }
}

/**
 * Poll the workload's pod list until the desired number of pods are
 * Ready. Returns the wall-clock Date at which the condition first held.
 */
const waitReplicasReady = (
  namespace: string,
  label: string,
  expected: number,
  timeoutSec: number,
): Effect.Effect<Date, string> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutSec * 1000
    while (Date.now() < deadline) {
      const pods = yield* listPods(namespace, label)
      const ready = pods.filter((p) => p.ready).length
      if (ready >= expected) return new Date()
      yield* Effect.sleep("1 second")
    }
    return yield* Effect.fail(
      `replicas not ready within ${timeoutSec}s (label=${label}, want=${expected})`,
    )
  })

const waitNodeReady = (
  nodeName: string,
  timeoutSec: number,
): Effect.Effect<void, string> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutSec * 1000
    while (Date.now() < deadline) {
      const result = yield* exec(
        "kubectl",
        [
          "get",
          "node",
          nodeName,
          "-o",
          "jsonpath={range .status.conditions[?(@.type==\"Ready\")]}{.status}{end}",
        ],
        { timeoutMs: 10_000 },
      ).pipe(
        Effect.matchEffect({
          onSuccess: (r) => Effect.succeed(r.stdout.trim()),
          onFailure: () => Effect.succeed(""),
        }),
      )
      if (result === "True") return
      yield* Effect.sleep("1 second")
    }
    return yield* Effect.fail(`node ${nodeName} not Ready within ${timeoutSec}s`)
  })

/**
 * List kind worker docker container names for a given tier label
 * (`app` or `edge`). Returns the docker container names, which equal
 * the kubernetes node names in kind.
 */
const listNodesByTier = (tier: string): Effect.Effect<ReadonlyArray<string>, string> =>
  Effect.gen(function* () {
    const result = yield* exec(
      "kubectl",
      [
        "get",
        "nodes",
        "-l",
        `tier=${tier}`,
        "-o",
        "jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}",
      ],
      { timeoutMs: 10_000 },
    ).pipe(
      Effect.matchEffect({
        onSuccess: (r) => Effect.succeed(r.stdout),
        onFailure: (e) => Effect.fail(`kubectl get nodes failed: ${e.message}`),
      }),
    )
    return result
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  })

/**
 * Read the limiter Redis sidecar's window keys and return the current
 * in-flight count for a given limiter id. Used by the recorder to poll
 * limiter probe convergence on a 10s cadence.
 *
 * Sums all `limiter:<id>:*` keys; mirrors CallLimiter's verification
 * algorithm (sum the last LIMITER_ACTIVE_WINDOWS windows).
 */
export const readLimiterInflight = (
  namespace: string,
  limiterId: string,
): Effect.Effect<number, ChaosOpsError> =>
  Effect.gen(function* () {
    // Find a limiter Redis pod. Single-replica Deployment.
    const pods = yield* listPods(namespace, LIMITER_REDIS_LABEL)
    const ready = pods.find((p) => p.ready)
    if (ready === undefined) {
      // Limiter Redis may be transiently down during chaos; report 0
      // rather than failing the whole poll.
      return 0
    }
    // Production keys are prefixed by `redisKeyPrefix` (default "sipas")
    // — see `src/config/AppConfig.ts` and `src/redis/RedisClient.ts`.
    // The pattern is `<prefix>:limiter:<id>:<windowTimestamp>`.
    const result = yield* execInPod(namespace, ready.name, "redis", [
      "sh",
      "-c",
      `redis-cli --scan --pattern 'sipas:limiter:${limiterId}:*' | xargs -r redis-cli mget | awk '{s+=$1} END {print s+0}'`,
    ]).pipe(
      Effect.matchEffect({
        onSuccess: (r) => Effect.succeed(r.stdout.trim()),
        onFailure: () => Effect.succeed("0"),
      }),
    )
    const n = parseInt(result, 10)
    return Number.isFinite(n) ? n : 0
  })
