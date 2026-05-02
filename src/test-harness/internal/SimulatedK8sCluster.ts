/**
 * SimulatedK8sCluster — slice 3.1 façade that bundles every test-side
 * lever needed to simulate K8s pod lifecycle and partition events
 * deterministically under TestClock.
 *
 * Owns nothing of its own: it composes the existing primitives —
 *   - `WorkerRegistrySimulatedControl` (registry membership + health)
 *   - `WorkerConnectivity` (per-worker network gate flips)
 *   - `PeerFabricControl` (per-peer storage health + snapshots)
 *   - `MetricsRegistry` (counter snapshots for routing assertions)
 *
 * — into a single service surface so failover scenarios can read like
 * the plan's pseudocode (`s.cluster.kill("b2b-1")`, etc.) without
 * threading four service tags through every step. Workers are
 * pre-allocated by the surrounding `k8sFakeStackLayer` (slice 3.2);
 * this MVP does not support dynamic addWorker — the per-worker scope
 * lifecycle plumbing that demands lands in a follow-up.
 *
 * Invariants:
 *   - `kill` is multi-phase by default: network disconnect → registry
 *     setHealth("dead") → PeerFabricControl.killWorker. Each phase
 *     emits an event into `phaseEvents` so `expectKillPhase` can
 *     assert the timeline. The defaults (immediate / 0ms gaps) are
 *     enough for the first failover test; tunable gaps land later.
 *   - `respawn` reverses kill: PeerFabricControl.rebootWorker (clears
 *     storage), registry.add (with a fresh `firstSeenAtMs` via the
 *     auto-stamp opt-in), connectivity.reconnect.
 *   - Snapshot reads are pure — `expectReplicatedTo` /
 *     `expectCallStateOn` consult `PeerFabricControl.snapshotPeer`
 *     and never mutate.
 */

import {
  Clock,
  Data,
  Effect,
  Exit,
  Layer,
  Metric,
  Scope,
  ServiceMap,
} from "effect"
import {
  PeerFabricControl,
  type PeerSnapshot,
} from "../../cache/PeerFabric.js"
import { WorkerOrdinal } from "../../cache/PeerCachePort.js"
import { CallState } from "../../call/CallState.js"
import { TimerService } from "../../call/TimerService.js"
import {
  WorkerId,
  WorkerRegistrySimulatedControl,
  type SocketAddr,
} from "../../sip-front-proxy/index.js"
import { WorkerConnectivity } from "./WorkerConnectivity.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-phase timing knobs for the kill pipeline. Defaults are zero
 * gaps (kill-9 semantics). Non-zero gaps interleave virtual-time
 * sleeps via the surrounding `Clock`, letting the test reproduce
 * conntrack-stale windows or graceful-drain holds without real
 * wall-clock latency.
 */
export interface KillTiming {
  /** ms the worker spends in registry health="draining" before disconnect. 0 = skip. */
  readonly drainHoldMs?: number
  /** ms between phase-1 disconnect and phase-3 registry-remove (health=dead). */
  readonly disconnectGapMs?: number
  /** ms between registry-remove and phase-4 PeerFabricControl.killWorker. */
  readonly fabricKillDelayMs?: number
}

export type KillPhase = "drain" | "disconnect" | "registry" | "fabric"

/**
 * Per-call knobs for `cluster.respawn`. Defaults model §11.2 of
 * `docs/replication/call-cache-backup.md` (full pod replace, sidecar
 * wiped). Set `preserveStorage: true` to model §11.1 (process restart
 * with sidecar persisting).
 */
export interface RespawnOptions {
  /**
   * When true, skip the `PeerFabric.rebootWorker` storage wipe and use
   * `softRebootWorker` instead — the rebuilt worker comes up in front
   * of its previous sidecar contents (`pri:{self}:` keys intact). Used
   * by tests that exercise the timer-rehydration boot path.
   */
  readonly preserveStorage?: boolean
}

export interface KillEvent {
  readonly workerId: WorkerId
  readonly phase: KillPhase
  readonly atMs: number
}

export interface ClusterWorker {
  readonly id: WorkerId
  readonly ordinal: WorkerOrdinal
  readonly address: SocketAddr
}

/** Routing-decision kinds tracked by `sip_routing_decision_total{kind}`. */
export type RoutingDecisionKind =
  | "select_new"
  | "decode_forward"
  | "decode_forward_backup"
  | "decode_reject"
  | "decode_unknown"
  | "cancel_lookup_hit"
  | "cancel_lookup_miss"

/**
 * Point-in-time snapshot of the routing-decision counters. Tests use a
 * baseline snapshot + a post-action snapshot to assert deltas without
 * coupling to absolute counter values.
 */
export interface RoutingMetricsSnapshot {
  /** Total `sip_routing_decision_total{kind}` aggregated across all strategies. */
  readonly decisionTotalsByKind: ReadonlyMap<RoutingDecisionKind, number>
  /** Total `sipfp_decode_forward_promoted_total{from}` aggregated across all reasons. */
  readonly promotedTotal: number
}

export interface SimulatedK8sClusterApi {
  /** Static handle on every worker pre-allocated by the layer. */
  readonly workers: ReadonlyArray<ClusterWorker>

  /** Lookup by id; throws if unknown (programmer error in tests). */
  readonly workerOf: (id: WorkerId) => ClusterWorker

  // -- Lifecycle primitives ------------------------------------------------
  readonly kill: (id: WorkerId, timing?: KillTiming) => Effect.Effect<void>
  /**
   * Bring a worker back after a `kill`. Pre-condition: the worker is
   * currently in the dead/closed-scope state. Steps performed:
   *   1. PeerFabric.rebootWorker — fresh storage handle.
   *   2. WorkerConnectivity.reconnect — gate flag flipped on.
   *   3. Registry remove + add (auto-stamps a fresh `firstSeenAtMs`).
   *   4. Open a new worker scope (forked from the SUT scope) and run
   *      the per-worker `buildWorker` closure against it. The closure
   *      stands up the UdpTransport binding, ReplPuller pull loops,
   *      runs ReadyGate (peer-log drain), and forks SipRouter ingest.
   *
   * Stub when the cluster wasn't built with worker-lifecycle support;
   * see `SimulatedK8sClusterLayerWithLifecycleOpts`.
   */
  readonly respawn: (
    id: WorkerId,
    opts?: RespawnOptions
  ) => Effect.Effect<void>
  readonly disconnect: (id: WorkerId) => Effect.Effect<void>
  readonly reconnect: (id: WorkerId) => Effect.Effect<void>
  readonly partition: (opts: {
    readonly from: WorkerId
    readonly to: WorkerId
    readonly direction: "from-to" | "to-from" | "both"
  }) => Effect.Effect<void>
  readonly heal: (a: WorkerId, b: WorkerId) => Effect.Effect<void>

  // -- Observation ---------------------------------------------------------
  /** Drain (and clear) every recorded kill phase event so far. */
  readonly drainKillEvents: Effect.Effect<ReadonlyArray<KillEvent>>
  readonly snapshotPeer: (id: WorkerId) => Effect.Effect<PeerSnapshot>
  /**
   * Aggregate the proxy's routing-decision counters into a structured
   * snapshot. The test interpreter holds a per-scenario baseline and
   * computes deltas across `expectRoutedTo` calls.
   */
  readonly snapshotRoutingMetrics: Effect.Effect<RoutingMetricsSnapshot>

  // -- Convenience assertions ---------------------------------------------
  /**
   * Assert the call's bak partition entry exists on `id`. The partition
   * key is `bak:{primary}:call:{callRef}` — `primary` is decoded from the
   * callRef's first segment (slice 4 Option C). Returns the raw JSON
   * string on success.
   */
  readonly expectReplicatedTo: (
    id: WorkerId,
    opts: { readonly callRef: string; readonly primary: WorkerId }
  ) => Effect.Effect<string>

  /**
   * Assert the call lives in the named partition on `id`. `partition`
   * narrows expected role; `present: false` asserts absence.
   */
  readonly expectCallStateOn: (
    id: WorkerId,
    opts: {
      readonly callRef: string
      readonly partition: "pri" | "bak"
      readonly owner: WorkerId
      readonly present?: boolean
    }
  ) => Effect.Effect<void>

  /**
   * Iterate every still-live worker (handles whose scope hasn't been
   * closed by `kill`) and collect leak reports for any worker whose
   * `CallState`/`TimerService` is not clean. Returns an empty array on
   * a healthy teardown. Consumed by the harness's `verifyCleanState`
   * sweep when `sut === "k8sFailover"`.
   */
  readonly verifyCleanStateOnAllWorkers: () => Effect.Effect<
    ReadonlyArray<string>
  >
}

export class SimulatedK8sCluster extends ServiceMap.Service<
  SimulatedK8sCluster,
  SimulatedK8sClusterApi
>()("@sipjsserver/test-support/SimulatedK8sCluster") {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class K8sClusterAssertionError extends Data.TaggedError(
  "K8sClusterAssertionError"
)<{
  readonly message: string
}> {}

// ---------------------------------------------------------------------------
// Worker lifecycle handle (slice 4b-ii)
// ---------------------------------------------------------------------------

/**
 * Per-worker lifecycle handle managed by the cluster service. Each
 * worker owns a child scope forked from the SUT scope; closing it
 * tears down the worker's UdpTransport binding, ReplPuller pull
 * loops, ReadyGate fiber, and SipRouter ingest atomically. `respawn`
 * closes the current scope and rebuilds against a fresh one.
 */
export interface WorkerRuntimeHandle {
  readonly id: WorkerId
  scope: Scope.Closeable
  /** Re-runs the `buildWorker` closure against `scope`. */
  readonly rebuild: (scope: Scope.Closeable) => Effect.Effect<void>
  /**
   * Per-worker `CallState` instance (mutated on respawn so cluster-wide
   * sweeps always see the live worker's stats). Exposed so the
   * end-of-scenario clean-state assertion can iterate every worker
   * — sipproxyHA / b2bonly only ever expose a single instance, k8sFailover
   * needs to inspect both workers in the cluster.
   */
  callState: CallState["Service"]
  /** Per-worker `TimerService` instance (mutated on respawn). */
  timers: TimerService["Service"]
}

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

export interface SimulatedK8sClusterLayerOpts {
  readonly workers: ReadonlyArray<ClusterWorker>
  /**
   * Optional worker-lifecycle wiring. When supplied:
   *   - `kill` appends a phase 5 that closes the worker's scope.
   *   - `respawn` rebuilds the worker against a fresh child scope.
   *
   * Without it, `respawn` dies on call (matches the "stub" behaviour
   * shipped in slice 3b before per-worker scopes were wired).
   */
  readonly lifecycle?: WorkerLifecycle
}

/**
 * Worker-lifecycle wiring passed by `k8sFakeStackLayer`. The cluster
 * service holds a reference to these handles (mutated in place: the
 * `scope` field is replaced on respawn) so it can close + rebuild a
 * worker without consulting other layers.
 */
export interface WorkerLifecycle {
  /** Mutable map: WorkerId → live runtime handle. */
  readonly handles: Map<string, WorkerRuntimeHandle>
  /** Ambient scope that owns each worker's child scope. */
  readonly sutScope: Scope.Scope
  /** Re-add the worker to the registry post-respawn. */
  readonly registryAdd: (id: WorkerId) => Effect.Effect<void>
  /**
   * Reset side-state owned by the surrounding stack on respawn (e.g.
   * the per-peer ReplLog whose backing store was swapped out by
   * PeerFabric.rebootWorker). Run BEFORE rebuilding the worker.
   */
  readonly onRebootSideEffects: (id: WorkerId) => Effect.Effect<void>
}

/**
 * Build the cluster service against the pre-allocated worker set. The
 * surrounding `k8sFakeStackLayer` is responsible for actually
 * materialising those workers (each B2BUA's UdpTransport binding,
 * router fiber, storage layer) — this layer just wires the control
 * plane that mutates / observes them.
 */
export const SimulatedK8sClusterLayer = (
  opts: SimulatedK8sClusterLayerOpts
): Layer.Layer<
  SimulatedK8sCluster,
  never,
  WorkerRegistrySimulatedControl | WorkerConnectivity | PeerFabricControl
> =>
  Layer.effect(
    SimulatedK8sCluster,
    Effect.gen(function* () {
      const registry = yield* WorkerRegistrySimulatedControl
      const connectivity = yield* WorkerConnectivity
      const fabric = yield* PeerFabricControl
      const lifecycle = opts.lifecycle
      // Plain array — `Queue.takeAll` in Effect v4 blocks on an empty
      // queue, which deadlocks `drainKillEvents` calls used as
      // pre-checks. The cluster runs single-fiber under tests, so a
      // mutable array is the simplest correct surface.
      const phaseEvents: KillEvent[] = []

      const byId = new Map<string, ClusterWorker>(
        opts.workers.map((w) => [w.id as unknown as string, w])
      )

      const workerOf: SimulatedK8sClusterApi["workerOf"] = (id) => {
        const w = byId.get(id as unknown as string)
        if (w === undefined) {
          throw new Error(`SimulatedK8sCluster: unknown worker "${id}"`)
        }
        return w
      }

      const recordPhase = (workerId: WorkerId, phase: KillPhase) =>
        Effect.gen(function* () {
          const atMs = yield* Clock.currentTimeMillis
          phaseEvents.push({ workerId, phase, atMs })
        })

      const sleepIfPositive = (ms: number | undefined) =>
        ms !== undefined && ms > 0 ? Effect.sleep(`${ms} millis`) : Effect.void

      const kill: SimulatedK8sClusterApi["kill"] = (id, timing) =>
        Effect.gen(function* () {
          const w = workerOf(id)
          const t = timing ?? {}
          // Phase 0: optional graceful-drain hold.
          if (t.drainHoldMs !== undefined && t.drainHoldMs > 0) {
            yield* registry.setHealth(id, "draining")
            yield* recordPhase(id, "drain")
            yield* sleepIfPositive(t.drainHoldMs)
          }
          // Phase 1: network disconnect.
          yield* connectivity.disconnect(id as unknown as string)
          yield* recordPhase(id, "disconnect")
          yield* sleepIfPositive(t.disconnectGapMs)
          // Phase 2: registry health → dead.
          yield* registry.setHealth(id, "dead")
          yield* recordPhase(id, "registry")
          yield* sleepIfPositive(t.fabricKillDelayMs)
          // Phase 3: peer-fabric storage marked dead. Storage retained
          // for inspection — backups serve from `bak:{primary}` on
          // their own sidecars regardless.
          yield* fabric.killWorker(w.ordinal)
          yield* recordPhase(id, "fabric")
          // Phase 4 (only with lifecycle wiring): close the worker's
          // scope so its UdpTransport binding, ReplPuller pull loops,
          // and SipRouter ingest fiber are interrupted cleanly. Until
          // a respawn lands, the worker is fully gone from the SUT.
          if (lifecycle !== undefined) {
            const handle = lifecycle.handles.get(id as unknown as string)
            if (handle !== undefined) {
              yield* Scope.close(handle.scope, Exit.void)
            }
          }
        })

      const respawn: SimulatedK8sClusterApi["respawn"] = (id, opts) =>
        Effect.gen(function* () {
          if (lifecycle === undefined) {
            return yield* Effect.die(
              new K8sClusterAssertionError({
                message:
                  `respawn(${id as unknown as string}): cluster was built without ` +
                  `worker-lifecycle wiring — pass opts.lifecycle in SimulatedK8sClusterLayer.`,
              })
            )
          }
          const w = workerOf(id)
          // 1. Bring the sidecar back. Default mimics ephemeral
          //    sidecar Redis (full wipe — §11.2). With
          //    preserveStorage:true the previous keys are kept (§11.1
          //    process restart with sidecar persisting).
          if (opts?.preserveStorage === true) {
            yield* fabric.softRebootWorker(w.ordinal)
          } else {
            yield* fabric.rebootWorker(w.ordinal)
          }
          // 2. Network gate flipped back on.
          yield* connectivity.reconnect(id as unknown as string)
          // 3. Registry: re-add (kill set health=dead but kept the
          //    entry; remove + add resets `firstSeenAtMs` via the
          //    layer's autoStamp opt-in).
          yield* registry.remove(id)
          yield* lifecycle.registryAdd(id)
          // 4. Surrounding-stack-side reset (e.g. rebuild this peer's
          //    ReplLog so other workers see writes against the new
          //    storage handle).
          yield* lifecycle.onRebootSideEffects(id)
          // 5. Open a fresh child scope and run the worker's
          //    `rebuild` closure against it. The closure stands up
          //    UdpTransport, ReplPuller, ReadyGate (drains peers),
          //    then forks SipRouter ingest.
          const newScope = yield* Scope.fork(lifecycle.sutScope, "sequential")
          const handle = lifecycle.handles.get(id as unknown as string)
          if (handle === undefined) {
            return yield* Effect.die(
              new K8sClusterAssertionError({
                message: `respawn(${id as unknown as string}): no runtime handle in lifecycle map`,
              })
            )
          }
          yield* handle.rebuild(newScope)
          handle.scope = newScope
        })

      const disconnect: SimulatedK8sClusterApi["disconnect"] = (id) =>
        connectivity.disconnect(id as unknown as string)

      const reconnect: SimulatedK8sClusterApi["reconnect"] = (id) =>
        connectivity.reconnect(id as unknown as string)

      const partition: SimulatedK8sClusterApi["partition"] = ({
        from,
        to,
        direction,
      }) =>
        connectivity.partition({
          from: from as unknown as string,
          to: to as unknown as string,
          direction,
        })

      const heal: SimulatedK8sClusterApi["heal"] = (a, b) =>
        connectivity.heal(a as unknown as string, b as unknown as string)

      const drainKillEvents: SimulatedK8sClusterApi["drainKillEvents"] =
        Effect.sync(() => {
          const out = phaseEvents.slice()
          phaseEvents.length = 0
          return out
        })

      const snapshotPeer: SimulatedK8sClusterApi["snapshotPeer"] = (id) =>
        fabric.snapshotPeer(workerOf(id).ordinal)

      const snapshotRoutingMetrics: SimulatedK8sClusterApi["snapshotRoutingMetrics"] =
        Effect.gen(function* () {
          const snaps = yield* Metric.snapshot
          const decisionTotalsByKind = new Map<RoutingDecisionKind, number>()
          let promotedTotal = 0
          for (const s of snaps) {
            if (s.id === "sip_routing_decision_total" && s.type === "Counter") {
              const kind = s.attributes?.kind as RoutingDecisionKind | undefined
              if (kind === undefined) continue
              const count = Number(s.state.count)
              decisionTotalsByKind.set(
                kind,
                (decisionTotalsByKind.get(kind) ?? 0) + count
              )
            } else if (
              s.id === "sipfp_decode_forward_promoted_total" &&
              s.type === "Counter"
            ) {
              promotedTotal += Number(s.state.count)
            }
          }
          return { decisionTotalsByKind, promotedTotal }
        })

      const partitionKey = (
        role: "pri" | "bak",
        owner: WorkerId,
        callRef: string
      ): string => `${role}:${owner as unknown as string}:call:${callRef}`

      const expectReplicatedTo: SimulatedK8sClusterApi["expectReplicatedTo"] = (
        id,
        { callRef, primary }
      ) =>
        Effect.gen(function* () {
          const snap = yield* fabric.snapshotPeer(workerOf(id).ordinal)
          const key = partitionKey("bak", primary, callRef)
          const found = snap.entries.find((e) => e.key === key)
          if (found === undefined) {
            const known = snap.entries.map((e) => e.key).join(", ")
            return yield* Effect.die(
              new K8sClusterAssertionError({
                message: `expectReplicatedTo: peer ${id} missing key "${key}". Present: [${known}]`,
              })
            )
          }
          return found.value
        })

      const expectCallStateOn: SimulatedK8sClusterApi["expectCallStateOn"] = (
        id,
        { callRef, partition: role, owner, present = true }
      ) =>
        Effect.gen(function* () {
          const snap = yield* fabric.snapshotPeer(workerOf(id).ordinal)
          const key = partitionKey(role, owner, callRef)
          const found = snap.entries.some((e) => e.key === key)
          if (present && !found) {
            const known = snap.entries.map((e) => e.key).join(", ")
            return yield* Effect.die(
              new K8sClusterAssertionError({
                message: `expectCallStateOn: peer ${id} missing key "${key}". Present: [${known}]`,
              })
            )
          }
          if (!present && found) {
            return yield* Effect.die(
              new K8sClusterAssertionError({
                message: `expectCallStateOn: peer ${id} unexpectedly has key "${key}".`,
              })
            )
          }
        })

      const verifyCleanStateOnAllWorkers: SimulatedK8sClusterApi["verifyCleanStateOnAllWorkers"] =
        () =>
          Effect.gen(function* () {
            const errors: string[] = []
            if (lifecycle === undefined) return errors
            for (const [idStr, handle] of lifecycle.handles) {
              const active = handle.timers.activeCountSync()
              if (active > 0) {
                errors.push(
                  `TimerService leak on worker ${idStr}: ${active} timer(s) still active. ` +
                    `All timers should be cancelled during call cleanup.`
                )
              }
              const { concurrent, total } = yield* handle.callState.stats()
              if (concurrent > 0) {
                errors.push(
                  `CallState leak on worker ${idStr}: ${concurrent} call(s) still in memory ` +
                    `(total created: ${total}). All calls should be removed after ` +
                    `scenario completion — the "terminating" state should have resolved.`
                )
              }
            }
            return errors
          })

      return {
        workers: opts.workers,
        workerOf,
        kill,
        respawn,
        disconnect,
        reconnect,
        partition,
        heal,
        drainKillEvents,
        snapshotPeer,
        snapshotRoutingMetrics,
        expectReplicatedTo,
        expectCallStateOn,
        verifyCleanStateOnAllWorkers,
      }
    })
  )

// ---------------------------------------------------------------------------
// Helpers re-exported for tests
// ---------------------------------------------------------------------------

export const makeClusterWorker = (
  id: WorkerId,
  address: SocketAddr
): ClusterWorker => ({
  id,
  ordinal: WorkerOrdinal(id as unknown as string),
  address,
})

// Suppress unused-import warning when the file evolves; keep for future use.
export type { Scope }
