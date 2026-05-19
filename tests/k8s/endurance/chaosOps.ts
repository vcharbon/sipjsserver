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
  // `worker-pod-graceful` invokes `kubectl delete --grace-period=20` so
  // SIGTERM actually drives the two-tier drain protocol (ADR-0008).
  | "worker-pod-graceful"
  // `worker-pod-api-delete-force` invokes `kubectl delete --grace-period=0
  // --force` — fast API-side removal that skips kubelet graceful protocol.
  // Models a node-lost-style failure routed through the control plane.
  // (This is the renamed legacy `worker-pod-graceful`, which was misnamed
  // because `--grace-period=0 --force` is the opposite of graceful.)
  | "worker-pod-api-delete-force"
  | "worker-pod-kill9"
  | "proxy-pod-graceful"
  | "proxy-pod-kill9"
  | "limiter-redis-graceful"
  | "limiter-redis-kill9"
  | "node-shutdown-app"
  | "node-shutdown-edge"
  | "proxy-cutoff-vrrp"
  // Network-chaos catalog (2026-05-15): admitted under the new "any
  // impact modelled by ExpectedImpact" rule. See docs/k8s-endurance.md
  // §"Expected-impact mechanism" + ADR-0002 amendment.
  | "worker-cut-from-proxy-hard"
  | "worker-cut-from-peers-hard"
  | "worker-cut-from-limiter-redis-hard"
  | "worker-isolate-all-hard"
  | "worker-cut-from-proxy-loss30"
  | "proxy-full-isolate"
  | "non-emergency-burst"

/** All ChaosEventType values as an array; single source of truth. */
export const ALL_CHAOS_EVENT_TYPES: ReadonlyArray<ChaosEventType> = [
  "worker-pod-graceful",
  "worker-pod-api-delete-force",
  "worker-pod-kill9",
  "proxy-pod-graceful",
  "proxy-pod-kill9",
  "limiter-redis-graceful",
  "limiter-redis-kill9",
  "node-shutdown-app",
  "node-shutdown-edge",
  "proxy-cutoff-vrrp",
  "worker-cut-from-proxy-hard",
  "worker-cut-from-peers-hard",
  "worker-cut-from-limiter-redis-hard",
  "worker-isolate-all-hard",
  "worker-cut-from-proxy-loss30",
  "proxy-full-isolate",
  "non-emergency-burst",
]

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
  /**
   * Proof-of-effect from `verifyChaosTookEffect`. Optional because the
   * primitive may not have wired one yet (legacy path); analyser treats
   * a missing `verify` as unverified, not noop.
   */
  readonly verify?: VerifyOutcome
}

/**
 * Outcome of a `verifyChaosTookEffect` run. `ok: true` means the
 * primitive demonstrably mutated cluster state (iptables counter went
 * up, worker logged a Redis error, sipp success rate plummeted, …).
 * `ok: false` means the orchestrator fired the primitive but no
 * SUT-observable effect was detected — chaos[N] NOOP_DETECTED.
 */
export type VerifyOutcome =
  | { readonly ok: true; readonly observed: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Wrap a verify Effect so every chaos primitive emits a uniform
 * `chaos[verify]` log line — analysts grep this prefix to inspect
 * every fired event's proof-of-effect across an entire run.
 */
export const verifyChaosTookEffect = (
  eventType: ChaosEventType,
  verifyRun: Effect.Effect<VerifyOutcome>,
): Effect.Effect<VerifyOutcome> =>
  Effect.gen(function* () {
    const outcome = yield* verifyRun
    if (outcome.ok) {
      yield* Effect.logInfo(
        `chaos[verify] PASSED  — ${eventType}: ${outcome.observed}`,
      )
    } else {
      yield* Effect.logWarning(
        `chaos[verify] FAILED  — ${eventType}: ${outcome.reason}`,
      )
    }
    return outcome
  })

/**
 * Trivial verify for primitives whose post-condition (pod gone +
 * re-created, node back Ready, …) is already proven by the
 * orchestrator's existing wait. Emits the uniform `chaos[verify]` line
 * with `ok: true` and the supplied observation string.
 */
export const trivialVerifyOk = (observed: string): VerifyOutcome => ({
  ok: true,
  observed,
})

/**
 * Sum FORWARD-chain packet counts across `nodes`, filtered by the
 * `endurance-net-chaos` comment marker the network primitive stamps on
 * its rules. Sleeps `midDelayMs` first so we read counters *during*
 * the cut, then compares against the install-time baseline (always 0
 * for fresh rules).
 *
 * Returns `ok: true` if any packets matched anywhere, `ok: false` if
 * the rule installed but matched zero traffic (wrong chain / wrong
 * direction / wrong pod-IP / kube-svc CIDR routing bypassed it).
 */
export const verifyIptablesDropCounter = (
  nodes: ReadonlyArray<string>,
  midDelayMs: number,
): Effect.Effect<VerifyOutcome> =>
  Effect.gen(function* () {
    yield* Effect.sleep(`${midDelayMs} millis`)
    let totalPkts = 0
    const perNode: Array<string> = []
    for (const node of nodes) {
      const r = yield* exec(
        "docker",
        ["exec", node, "iptables", "-L", "FORWARD", "-nvx"],
        { timeoutMs: 10_000 },
      ).pipe(
        Effect.matchEffect({
          onSuccess: (out) => Effect.succeed(out.stdout),
          onFailure: () => Effect.succeed(""),
        }),
      )
      let nodePkts = 0
      for (const rawLine of r.split("\n")) {
        if (!rawLine.includes("endurance-net-chaos")) continue
        const parts = rawLine.trim().split(/\s+/)
        const pkts = parseInt(parts[0] ?? "0", 10)
        if (Number.isFinite(pkts)) nodePkts += pkts
      }
      totalPkts += nodePkts
      perNode.push(`${node}=${nodePkts}`)
    }
    const secs = (midDelayMs / 1000).toFixed(1)
    if (totalPkts > 0) {
      return {
        ok: true,
        observed: `pkts dropped=${totalPkts} after ${secs}s (${perNode.join(", ")})`,
      }
    }
    return {
      ok: false,
      reason: `pkts dropped=0 across ${nodes.length} node(s) after ${secs}s — rule didn't match traffic (wrong chain / direction / pod-IP / kube-svc CIDR)`,
    }
  })

/**
 * Tail the target pod's container log starting `lookbackSec` before
 * `now`, scan for `pattern`, return the first matching line. Used by
 * SUT-side verifications: a hard cut is real only if the worker's
 * Redis client / replication puller actually noticed.
 */
export const verifyPodLogPattern = (
  namespace: string,
  podName: string,
  container: string,
  pattern: RegExp,
  midDelayMs: number,
): Effect.Effect<VerifyOutcome> =>
  Effect.gen(function* () {
    yield* Effect.sleep(`${midDelayMs} millis`)
    const sinceSec = Math.ceil(midDelayMs / 1000) + 2
    const r = yield* exec(
      "kubectl",
      ["-n", namespace, "logs", podName, "-c", container, `--since=${sinceSec}s`],
      { timeoutMs: 15_000 },
    ).pipe(
      Effect.matchEffect({
        onSuccess: (out) => Effect.succeed(out.stdout),
        onFailure: (e) => Effect.succeed(`<<logs read failed: ${e.message}>>`),
      }),
    )
    for (const rawLine of r.split("\n")) {
      if (pattern.test(rawLine)) {
        const trimmed = rawLine.trim().slice(0, 240)
        return {
          ok: true,
          observed: `${podName} emitted: ${trimmed}`,
        }
      }
    }
    return {
      ok: false,
      reason: `no /${pattern.source}/ in ${podName} (${container}) log within ${(midDelayMs / 1000).toFixed(1)}s of cut`,
    }
  })

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

/** Bounded outage duration for worker network-isolation cuts. */
export const NETWORK_CUT_DURATION_SEC = 30

/** Burst event duration (sipp ad-hoc Job runtime). */
export const BURST_DURATION_SEC = 60
/** Burst CAPS — non-emergency INVITEs sent against the proxy VIP. */
export const BURST_CAPS = 200

export interface KillPodEventOpts {
  readonly namespace: string
  readonly type:
    | "worker-pod-graceful"
    | "worker-pod-api-delete-force"
    | "worker-pod-kill9"
    | "proxy-pod-graceful"
    | "proxy-pod-kill9"
    | "limiter-redis-graceful"
    | "limiter-redis-kill9"
  /**
   * When set, the chaos op POSTs `/debug/heap-snapshot` and
   * `/debug/cpu-profile?wait=1` to the target pod (worker only — proxy
   * and limiter Redis pods don't expose `/debug`) and waits for both
   * files to be `kubectl cp`-d into the artifact dir before issuing
   * the kill. Skipped silently for non-worker targets and for the
   * `kill9` variant on workers (the SIGKILL'd process can't serve a
   * snapshot anyway). Best-effort: any failure inside the capture path
   * is logged and the kill proceeds.
   */
  readonly captureForensicsBeforeKill?: (
    namespace: string,
    podName: string,
  ) => Effect.Effect<void, never>
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

    // Pre-kill forensics capture: only meaningful for worker pods
    // (where the StatusServer with /debug routes runs) and only
    // useful for the graceful path (kill9 takes the process out
    // before it can serve the snapshot).
    if (
      opts.captureForensicsBeforeKill !== undefined &&
      (opts.type === "worker-pod-graceful" || opts.type === "worker-pod-api-delete-force")
    ) {
      yield* Effect.logInfo(
        `chaos[${opts.type}] capturing pre-kill forensics on ${target.name}`,
      )
      yield* opts.captureForensicsBeforeKill(opts.namespace, target.name)
    }

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
    // The kill + replicas-ready wait already proved the primitive's
    // effect (pod gone, then re-created). Emit the uniform log line so
    // analysts see one chaos[verify] per event, including pod kills.
    const verify = yield* verifyChaosTookEffect(
      opts.type,
      Effect.succeed<VerifyOutcome>(
        trivialVerifyOk(
          `pod ${target.name} killed (${kind}/${mode}), ${replicas} replica(s) Ready`,
        ),
      ),
    )
    return {
      type: opts.type,
      target: target.name,
      tFire,
      tRecovered,
      readyBefore: ready.length,
      readyAfter: replicas,
      verify,
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
    const verify = yield* verifyChaosTookEffect(
      type,
      Effect.succeed<VerifyOutcome>(
        trivialVerifyOk(
          `node ${chosen} stopped + started, ${witness.expected} ${opts.tier}-tier replicas re-Ready`,
        ),
      ),
    )
    return {
      type,
      target: chosen,
      tFire,
      tRecovered,
      readyBefore,
      readyAfter: witness.expected,
      verify,
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
    const verify = yield* verifyChaosTookEffect(
      type,
      Effect.succeed<VerifyOutcome>(
        trivialVerifyOk(
          `iptables ${rule} installed+removed on ${node} for ${PROXY_CUTOFF_SEC}s (VRRP block)`,
        ),
      ),
    )
    return {
      type,
      target: target.name,
      tFire,
      tRecovered,
      readyBefore: ready.length,
      readyAfter: ready.length,
      verify,
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
        mode: "delete-grace20",
        replicas: WORKER_REPLICAS,
        deploymentLike: WORKER_STATEFULSET,
        kind: "worker",
      }
    case "worker-pod-api-delete-force":
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

/* ------------------------------------------------------------------ */
/* Network-chaos primitive (iptables FORWARD rules on every kind node) */
/* ------------------------------------------------------------------ */

/**
 * Which peer class(es) to isolate the target pod from.
 *
 * For a worker target:
 *   - "proxy" — both proxy pods
 *   - "peers" — every OTHER worker pod (the replication peer set)
 *   - "limiter-redis" — the shared limiter Redis pod
 *   - "all" — everything else in the cluster (drops all FORWARD for
 *     the target pod's IP, regardless of remote peer)
 *
 * For a proxy target only "all" is meaningful — partial-loss /
 * asymmetric cuts on the proxy do not model anything real (VRRP either
 * holds the VIP or it doesn't).
 */
export type NetworkChaosPeerSet =
  | "proxy"
  | "peers"
  | "limiter-redis"
  | "all"

export type NetworkChaosIntensity =
  | { readonly kind: "hard" }
  /** Drop a fraction of packets via iptables `-m statistic`. 0..1. */
  | { readonly kind: "loss"; readonly probability: number }

export interface NetworkChaosOpts {
  readonly namespace: string
  readonly type: ChaosEventType
  /** Pod label selector for the target — WORKER_LABEL or PROXY_LABEL. */
  readonly targetLabel: string
  readonly peerSets: ReadonlyArray<NetworkChaosPeerSet>
  readonly intensity: NetworkChaosIntensity
  readonly durationSec?: number
  /**
   * Optional verify hook. Called after rules are installed but before
   * the cut sleeps out. The verify Effect should sleep its own
   * `midDelayMs`, read an OS- or SUT-level signal, and return a
   * `VerifyOutcome` proving (or disproving) that the cut actually
   * mutated state. See `verifyIptablesDropCounter`,
   * `verifyPodLogPattern`.
   */
  readonly buildVerify?: (ctx: {
    readonly target: PodInfo
    readonly peerIps: ReadonlyArray<string>
    readonly nodes: ReadonlyArray<string>
  }) => Effect.Effect<VerifyOutcome>
}

/**
 * Fire a network-isolation chaos event: install iptables FORWARD rules
 * on every kind node that drop traffic between the target pod and the
 * resolved peer-set IPs, sleep `durationSec`, then remove them.
 *
 * The "hard" intensity uses a plain `-j DROP`. The "loss" intensity
 * adds `-m statistic --mode random --probability <p>` so only a
 * fraction of packets are dropped; the connection appears alive but
 * UDP retransmits pile up. iptables removes the need for tc qdisc
 * machinery in v1.
 *
 * Rule cleanup is best-effort: if the orchestrator dies between fire
 * and recover, the leftover rules can be torn down manually with
 * `iptables -D INPUT/FORWARD -m comment --comment 'endurance-net-chaos'`.
 */
export const networkChaosEvent = (
  opts: NetworkChaosOpts,
  rand: () => number,
): Effect.Effect<ChaosOutcome, ChaosOpsError> =>
  Effect.gen(function* () {
    const durationSec = opts.durationSec ?? NETWORK_CUT_DURATION_SEC
    const targets = yield* listPods(opts.namespace, opts.targetLabel)
    const readyTargets = targets.filter((p) => p.ready && p.ip !== "")
    if (readyTargets.length < 2) {
      return yield* new ChaosOpsError({
        op: opts.type,
        target: opts.targetLabel,
        reason: `only ${readyTargets.length} ready target pod(s); need ≥2 (one survives the cut)`,
      })
    }
    const idx = Math.floor(rand() * readyTargets.length)
    const target = readyTargets[idx]
    if (target === undefined) {
      return yield* new ChaosOpsError({
        op: opts.type,
        target: opts.targetLabel,
        reason: `random pick failed (idx=${idx}, len=${readyTargets.length})`,
      })
    }

    const peerIps = yield* resolvePeerIps(opts.namespace, opts.peerSets, target.name)

    const nodes = yield* listAllKindNodes().pipe(
      Effect.mapError(
        (msg) =>
          new ChaosOpsError({ op: opts.type, target: target.name, reason: msg }),
      ),
    )
    if (nodes.length === 0) {
      return yield* new ChaosOpsError({
        op: opts.type,
        target: target.name,
        reason: "no kind nodes resolved",
      })
    }

    const rules = buildIptablesRules(target.ip, peerIps, opts.intensity)
    if (rules.length === 0) {
      return yield* new ChaosOpsError({
        op: opts.type,
        target: target.name,
        reason: `peer-set resolved to zero peer IPs (peerSets=${opts.peerSets.join(",")})`,
      })
    }

    const tFire = new Date()
    yield* Effect.logInfo(
      `chaos[${opts.type}] target=${target.name} (ip=${target.ip}) peers=${peerIps.length} nodes=${nodes.length} rules=${rules.length} dur=${durationSec}s`,
    )
    // Install on every node — same-node traffic may go via the kindnet
    // bridge (subject to FORWARD when bridge-nf is on), cross-node
    // traffic transits the docker bridge and is forwarded by the host;
    // installing everywhere covers both paths without resolving which
    // node each peer lives on.
    yield* installRules(nodes, rules, "-I").pipe(
      Effect.mapError(
        (msg) =>
          new ChaosOpsError({ op: opts.type, target: target.name, reason: msg }),
      ),
    )

    // Recovery branch always runs, even on interruption, so the rules
    // don't survive an orchestrator crash.
    const cleanup = installRules(nodes, rules, "-D").pipe(
      Effect.matchEffect({
        onSuccess: () => Effect.void,
        onFailure: (msg) =>
          Effect.logWarning(`chaos[${opts.type}] cleanup failed (best-effort): ${msg}`),
      }),
    )

    const verifyOutcome: VerifyOutcome | undefined = yield* Effect.gen(
      function* () {
        if (opts.buildVerify === undefined) {
          yield* Effect.sleep(`${durationSec} seconds`)
          return undefined
        }
        const tVerifyStart = Date.now()
        const o = yield* verifyChaosTookEffect(
          opts.type,
          opts.buildVerify({ target, peerIps, nodes }),
        )
        const elapsedMs = Date.now() - tVerifyStart
        const remainingMs = durationSec * 1000 - elapsedMs
        if (remainingMs > 0) {
          yield* Effect.sleep(`${remainingMs} millis`)
        }
        return o
      },
    ).pipe(Effect.ensuring(cleanup))

    const tRecovered = new Date()
    return {
      type: opts.type,
      target: target.name,
      tFire,
      tRecovered,
      readyBefore: readyTargets.length,
      readyAfter: readyTargets.length,
      ...(verifyOutcome !== undefined && { verify: verifyOutcome }),
    }
  })

const resolvePeerIps = (
  namespace: string,
  peerSets: ReadonlyArray<NetworkChaosPeerSet>,
  targetPodName: string,
): Effect.Effect<ReadonlyArray<string>, ChaosOpsError> =>
  Effect.gen(function* () {
    const out: Array<string> = []
    for (const set of peerSets) {
      if (set === "all") {
        // "all" means "drop every FORWARD packet for this pod's IP" —
        // implemented by passing an empty peer-IP list (see
        // buildIptablesRules).
        return []
      }
      const label =
        set === "proxy"
          ? PROXY_LABEL
          : set === "limiter-redis"
            ? LIMITER_REDIS_LABEL
            : WORKER_LABEL
      const pods = yield* listPods(namespace, label)
      for (const p of pods) {
        if (p.ip === "") continue
        // "peers" excludes the target worker itself.
        if (set === "peers" && p.name === targetPodName) continue
        out.push(p.ip)
      }
    }
    return out
  })

/**
 * Build the iptables rule fragments (everything after the chain).
 * Each fragment is symmetric (target↔peer) and tagged with a comment
 * so we can audit / cleanup leftovers.
 *
 * Empty `peerIps` ⇒ "isolate the pod entirely" — install a wildcard
 * drop on FORWARD for that source AND destination.
 */
const buildIptablesRules = (
  targetIp: string,
  peerIps: ReadonlyArray<string>,
  intensity: NetworkChaosIntensity,
): ReadonlyArray<ReadonlyArray<string>> => {
  const statMatch =
    intensity.kind === "loss"
      ? ["-m", "statistic", "--mode", "random", "--probability", intensity.probability.toFixed(3)]
      : []
  const comment = ["-m", "comment", "--comment", "endurance-net-chaos"]
  const rules: Array<ReadonlyArray<string>> = []
  if (peerIps.length === 0) {
    // "all": catch every FORWARD packet for the pod IP in both
    // directions.
    rules.push(["FORWARD", "-s", targetIp, ...statMatch, ...comment, "-j", "DROP"])
    rules.push(["FORWARD", "-d", targetIp, ...statMatch, ...comment, "-j", "DROP"])
    return rules
  }
  for (const peer of peerIps) {
    rules.push([
      "FORWARD",
      "-s",
      targetIp,
      "-d",
      peer,
      ...statMatch,
      ...comment,
      "-j",
      "DROP",
    ])
    rules.push([
      "FORWARD",
      "-s",
      peer,
      "-d",
      targetIp,
      ...statMatch,
      ...comment,
      "-j",
      "DROP",
    ])
  }
  return rules
}

const installRules = (
  nodes: ReadonlyArray<string>,
  rules: ReadonlyArray<ReadonlyArray<string>>,
  action: "-I" | "-D",
): Effect.Effect<void, string> =>
  Effect.gen(function* () {
    for (const node of nodes) {
      for (const rule of rules) {
        // rule[0] is the chain name (e.g. "FORWARD"). Insert at
        // position 1 so we run before kube-proxy's
        // `KUBE-FORWARD ... ACCEPT ctstate RELATED,ESTABLISHED`
        // short-circuit. Otherwise UDP/TCP flows already in conntrack
        // (which is every flow after the first packet) bypass our DROP.
        // For -D iptables matches the rule body regardless of position.
        const chain = rule[0]!
        const tail = rule.slice(1)
        const args =
          action === "-I"
            ? ["exec", node, "iptables", "-I", chain, "1", ...tail]
            : ["exec", node, "iptables", "-D", chain, ...tail]
        yield* exec("docker", args, { timeoutMs: 10_000 }).pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.void,
            onFailure: (e) =>
              action === "-D"
                ? Effect.logDebug(
                    `iptables -D on ${node} non-fatal: ${e.stderr.trim() || e.stdout.trim()}`,
                  )
                : Effect.fail(
                    `iptables ${action} on ${node} failed: ${e.stderr.trim() || e.stdout.trim()}`,
                  ),
          }),
        )
      }
    }
  })

const listAllKindNodes = (): Effect.Effect<ReadonlyArray<string>, string> =>
  Effect.gen(function* () {
    const result = yield* exec(
      "kubectl",
      [
        "get",
        "nodes",
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
