/**
 * Kubernetes `WorkerRegistry` — D3 / D5 / D8 / PR5.
 *
 * Watches Pods in a namespace (filtered by a label selector) using the
 * `@kubernetes/client-node` `Watch` API and maintains a live `WorkerEntry`
 * map for the SIP front proxy to route against.
 *
 * Pod-state mapping (D5):
 *
 *   - `metadata.deletionTimestamp != null` → `draining`. **K8s deletion-
 *     timestamp accelerant**: shaves up to one OPTIONS interval off
 *     drain-detection because the proxy learns about the impending
 *     termination immediately, before the worker's own `DrainingState`
 *     SIGTERM handler has flipped its OPTIONS reply.
 *   - `Ready` condition `True` → `alive`.
 *   - Otherwise → not-ready: keep the previous health value, or `dead`
 *     if it was `alive` and just dropped below ready (matches
 *     conservatives like the kubelet's own readiness logic).
 *
 * Health composition (D5 — most-restrictive wins):
 *
 *   K8s drives the K8s-side health from the watch. The proxy's
 *   `HealthProbe` independently flips a **probe-side** health value via
 *   `WorkerRegistryControl.setHealth`. We expose ONE `WorkerEntry.health`
 *   to consumers, computed as the most restrictive of the two:
 *
 *     dead > draining > alive
 *
 *   so a worker observed alive by K8s but timed out by the probe is
 *   `dead`; one observed alive by the probe but with deletion-timestamp
 *   set in K8s is `draining`. Per-id state is kept in `pairs: Map<id,
 *   { k8s, probe }>`; the resolution is recomputed on every flip.
 *
 * D4 invariant: `snapshot` and `resolve` are pure `Ref.get` (+ HashMap
 * read). All watch I/O, parsing, and Ref writes happen inside the
 * background watch fiber — failures there are logged + retried and never
 * propagate onto the routing path.
 *
 * D8: pod-IP rotation is modelled here. A pod that gets a new
 * `status.podIP` (rare under StatefulSet but possible after eviction)
 * emits an `address_changed` event; the worker id (= pod name) stays
 * stable.
 *
 * Watch reconnect: K8s watches are long-lived HTTP responses; the API
 * server closes them periodically (or after restart). On any error or
 * "watch ended" signal we log + sleep with exponential backoff
 * (200 ms → 5 s) + reconnect. Failures NEVER surface to callers.
 *
 * Testing seam: `WatchClient` is an injectable interface mirroring the
 * surface of `@kubernetes/client-node`'s `Watch.watch`. Production
 * builds wire `kubernetesWatchClient(kc)`; unit tests pass a
 * test double that drives the `(phase, apiObj)` callback directly.
 */

import { Watch, type V1Pod } from "@kubernetes/client-node"
import {
  Cause,
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
import { WorkerRegistryControl } from "../health/WorkerRegistryControl.js"
import {
  type RegistryEvent,
  type WorkerEntry,
  type WorkerHealth,
  WorkerId,
  WorkerRegistry,
  type WorkerRegistryApi,
} from "./WorkerRegistry.js"

// ---------------------------------------------------------------------------
// WatchClient — testing seam
// ---------------------------------------------------------------------------

/**
 * Minimal interface the registry uses against the K8s API. Mirrors
 * `@kubernetes/client-node`'s `Watch.watch` shape so tests can replace
 * it without standing up a real cluster.
 *
 * `start` resolves to a function the caller invokes to abort the watch
 * (mirrors the AbortController returned by the SDK). The `onEvent`
 * callback is invoked with phases `ADDED` / `MODIFIED` / `DELETED` (and
 * occasionally `ERROR` — handled in our reconnect loop). `onClose` is
 * invoked when the underlying response ends, with `null` for clean
 * close or an Error for failure.
 */
export interface WatchClient {
  readonly start: (params: {
    readonly path: string
    readonly query: Record<string, string | number | boolean | undefined>
    readonly onEvent: (phase: string, pod: V1Pod) => void
    readonly onClose: (err: unknown) => void
  }) => Promise<() => void>
}

/**
 * Build a production `WatchClient` backed by `@kubernetes/client-node`.
 * Caller provides a configured `KubeConfig`. The function only needs
 * a `Watch` instance, but accepting the higher-level config keeps the
 * import surface symmetric with the rest of the SDK.
 */
export const kubernetesWatchClient = (
  watch: Watch
): WatchClient => ({
  start: ({ path, query, onEvent, onClose }) =>
    watch
      .watch(
        path,
        query,
        (phase, apiObj) => onEvent(phase, apiObj as V1Pod),
        (err) => onClose(err)
      )
      .then((controller) => () => controller.abort()),
})

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface KubernetesStatefulSetOpts {
  /** Namespace to watch. Required — the proxy never watches across namespaces. */
  readonly namespace: string
  /**
   * Logical StatefulSet name. Used for log context and as the default
   * value of the `app.kubernetes.io/name` label selector.
   */
  readonly statefulSetName: string
  /** SIP UDP port the worker listens on inside the pod. */
  readonly podPort: number
  /**
   * Override the pod label selector. Defaults to
   * `app.kubernetes.io/name=<statefulSetName>`. Operators that already
   * brand their pods differently can pass their own selector here.
   */
  readonly labelSelector?: string
  /**
   * Initial reconnect delay (ms). Exponential backoff doubles up to
   * `reconnectMaxMs`. Default: 200ms.
   */
  readonly reconnectInitialMs?: number
  /** Max reconnect delay (ms). Default: 5000ms. */
  readonly reconnectMaxMs?: number
  /**
   * Bound for the internal `PubSub<RegistryEvent>`. A registry watching
   * a busy StatefulSet can briefly produce O(N) events on reconnect;
   * 256 is plenty for typical N≤32 deployments.
   */
  readonly eventBufferCapacity?: number
}

const DEFAULT_RECONNECT_INITIAL_MS = 200
const DEFAULT_RECONNECT_MAX_MS = 5_000
const DEFAULT_EVENT_BUFFER = 256

// ---------------------------------------------------------------------------
// Health composition (most-restrictive wins) — D5
// ---------------------------------------------------------------------------

const RANK: Record<WorkerHealth, number> = {
  alive: 0,
  unknown: 1,
  draining: 2,
  dead: 3,
}

/**
 * `dead > draining > unknown > alive`. Returns the more-restrictive of
 * the two. `unknown` ranks above `alive` so `(k8s=alive, probe=unknown)`
 * composes to `unknown` — a worker the K8s pod-watch admits as Ready
 * but whose OPTIONS round-trip we haven't yet observed is not routable.
 * `draining`/`dead` rank above `unknown` because both signals are
 * authoritative regardless of probe state.
 */
export const mostRestrictiveHealth = (
  a: WorkerHealth,
  b: WorkerHealth
): WorkerHealth => (RANK[a] >= RANK[b] ? a : b)

interface HealthPair {
  readonly k8s: WorkerHealth
  readonly probe: WorkerHealth
}

const resolvePair = (pair: HealthPair): WorkerHealth =>
  mostRestrictiveHealth(pair.k8s, pair.probe)

// ---------------------------------------------------------------------------
// Pod → derived K8s health
// ---------------------------------------------------------------------------

/**
 * Translate a `V1Pod` into a K8s-side health value plus its (optional)
 * derived address. Returns `null` for pods we can't represent yet
 * (no name, no IP) — those are skipped until a later MODIFIED event
 * fills in the missing fields.
 */
const interpretPod = (
  pod: V1Pod,
  podPort: number,
  prevK8sHealth: WorkerHealth | undefined
): {
  readonly id: WorkerId
  readonly address: SocketAddr | undefined
  readonly k8sHealth: WorkerHealth
} | null => {
  const name = pod.metadata?.name
  if (typeof name !== "string" || name.length === 0) return null
  const id = WorkerId(name)
  const podIP = pod.status?.podIP
  const address: SocketAddr | undefined =
    typeof podIP === "string" && podIP.length > 0
      ? { host: podIP, port: podPort }
      : undefined

  // Deletion-timestamp accelerant beats every other read — D5.
  if (pod.metadata?.deletionTimestamp != null) {
    return { id, address, k8sHealth: "draining" }
  }

  const ready = pod.status?.conditions?.find((c) => c.type === "Ready")
  if (ready?.status === "True") {
    return { id, address, k8sHealth: "alive" }
  }

  // Not ready (and not draining). If we'd previously seen this pod alive
  // and it's now dropped, mark it dead — matches the kubelet's "stopped
  // serving" semantics. Otherwise keep the previous value so a
  // freshly-scheduled pod that's still booting doesn't flap to dead the
  // moment we observe it.
  if (prevK8sHealth === "alive") return { id, address, k8sHealth: "dead" }
  return { id, address, k8sHealth: prevK8sHealth ?? "dead" }
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * Build a Layer providing both `WorkerRegistry` and
 * `WorkerRegistryControl` from a K8s pod watch. The control surface
 * lets `HealthProbe` overlay probe-derived health on top of the K8s
 * view; the read surface composes the two via most-restrictive-wins.
 *
 * `watchClient` is the testing seam — production wires
 * `kubernetesWatchClient(...)`, tests pass a fake.
 */
export const kubernetesStatefulSetLayer = (
  opts: KubernetesStatefulSetOpts,
  watchClient: WatchClient
): Layer.Layer<WorkerRegistry | WorkerRegistryControl> => {
  const reconnectInitialMs = opts.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS
  const reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
  const eventBufferCapacity = opts.eventBufferCapacity ?? DEFAULT_EVENT_BUFFER
  const labelSelector =
    opts.labelSelector ?? `app.kubernetes.io/name=${opts.statefulSetName}`
  const path = `/api/v1/namespaces/${opts.namespace}/pods`

  return Layer.effectServices(
    Effect.gen(function* () {
      const stateRef = yield* Ref.make(HashMap.empty<WorkerId, WorkerEntry>())
      const pairsRef = yield* Ref.make(HashMap.empty<WorkerId, HealthPair>())
      const events = yield* PubSub.bounded<RegistryEvent>(eventBufferCapacity)

      // ── Mutation helpers (run inside the watch fiber) ─────────────────

      /**
       * Merge a derived K8s observation into state. Handles add / update
       * / address-rotation / health-change. Probe-side values stay
       * untouched — only `pair.k8s` is overwritten.
       */
      const applyPodObservation = (pod: V1Pod): Effect.Effect<void> =>
        Effect.gen(function* () {
          const pairs = yield* Ref.get(pairsRef)
          const map = yield* Ref.get(stateRef)
          const prevPair = HashMap.get(pairs, WorkerId(pod.metadata?.name ?? ""))
          const interp = interpretPod(
            pod,
            opts.podPort,
            prevPair._tag === "Some" ? prevPair.value.k8s : undefined
          )
          if (interp === null) return
          const { id, address, k8sHealth } = interp

          const prevEntry = HashMap.get(map, id)
          if (prevEntry._tag === "None") {
            // Need an address to register a new worker — without an IP
            // we can't route to it. Wait for a later MODIFIED event.
            if (address === undefined) return
            // Probe side defaults to `unknown` — the worker is not
            // routable until HealthProbe observes a 200 OK to OPTIONS
            // and flips this to `alive`. See `WorkerHealth` doc comment.
            const newPair: HealthPair = { k8s: k8sHealth, probe: "unknown" }
            const resolved = resolvePair(newPair)
            const drainingSince =
              resolved === "draining" ? yield* Clock.currentTimeMillis : undefined
            const entry: WorkerEntry =
              drainingSince === undefined
                ? { id, address, health: resolved }
                : { id, address, health: resolved, drainingSince }
            yield* Ref.set(pairsRef, HashMap.set(pairs, id, newPair))
            yield* Ref.set(stateRef, HashMap.set(map, id, entry))
            yield* PubSub.publish(events, { _tag: "added", entry })
            return
          }

          // Existing worker — diff address + composed health.
          const oldEntry = prevEntry.value
          // Defensive fallback when the pair-side state is missing
          // (should not happen if `applyPodObservation` is the only
          // mutator). `probe: "unknown"` matches the new-admission
          // default so the worker stays not-routable until the probe
          // confirms it.
          const oldPair: HealthPair = prevPair._tag === "Some"
            ? prevPair.value
            : { k8s: "alive", probe: "unknown" }
          const newPair: HealthPair = { k8s: k8sHealth, probe: oldPair.probe }
          const resolvedOld = oldEntry.health
          const resolvedNew = resolvePair(newPair)

          let nextEntry: WorkerEntry = oldEntry

          // Address rotation (D8). Only meaningful when we have one.
          if (
            address !== undefined &&
            (address.host !== oldEntry.address.host ||
              address.port !== oldEntry.address.port)
          ) {
            yield* PubSub.publish(events, {
              _tag: "address_changed",
              id,
              from: oldEntry.address,
              to: address,
            })
            nextEntry = { ...nextEntry, address }
          }

          // Health change.
          if (resolvedNew !== resolvedOld) {
            const nowMs = yield* Clock.currentTimeMillis
            if (resolvedNew === "draining") {
              nextEntry = {
                id: nextEntry.id,
                address: nextEntry.address,
                health: "draining",
                drainingSince:
                  oldEntry.drainingSince ?? nowMs,
              }
            } else {
              nextEntry = {
                id: nextEntry.id,
                address: nextEntry.address,
                health: resolvedNew,
              }
            }
            yield* PubSub.publish(events, {
              _tag: "health_changed",
              id,
              from: resolvedOld,
              to: resolvedNew,
            })
          }

          // Persist if anything changed.
          if (nextEntry !== oldEntry) {
            yield* Ref.set(stateRef, HashMap.set(map, id, nextEntry))
          }
          yield* Ref.set(pairsRef, HashMap.set(pairs, id, newPair))
        })

      const removeById = (id: WorkerId): Effect.Effect<void> =>
        Effect.gen(function* () {
          const map = yield* Ref.get(stateRef)
          if (!HashMap.has(map, id)) return
          yield* Ref.set(stateRef, HashMap.remove(map, id))
          const pairs = yield* Ref.get(pairsRef)
          yield* Ref.set(pairsRef, HashMap.remove(pairs, id))
          yield* PubSub.publish(events, { _tag: "removed", id })
        })

      const handlePhase = (
        phase: string,
        pod: V1Pod
      ): Effect.Effect<void> => {
        switch (phase) {
          case "ADDED":
          case "MODIFIED":
            return applyPodObservation(pod)
          case "DELETED": {
            const name = pod.metadata?.name
            if (typeof name !== "string" || name.length === 0)
              return Effect.void
            return removeById(WorkerId(name))
          }
          default:
            // ERROR or unrecognised phase — log + let the reconnect loop
            // handle it via onClose. Don't throw onto the routing path.
            return Effect.logDebug(
              `kubernetes registry: ignoring watch phase "${phase}" for pod ${pod.metadata?.name ?? "<unknown>"}`
            )
        }
      }

      // ── Watch loop with reconnect/backoff ─────────────────────────────

      // Capture the parent layer's services so the per-event effects
      // we runFork from outside-of-Effect callbacks (the K8s watch's
      // node-style listeners) inherit the same Logger/Clock/etc.
      const parentServices = yield* Effect.services<never>()

      const runWatchOnce: Effect.Effect<void> = Effect.callback<void>(
        (resume) => {
          let abort: (() => void) | undefined
          let resolved = false
          const finish = (err: unknown) => {
            if (resolved) return
            resolved = true
            if (err === undefined || err === null) {
              resume(Effect.void)
            } else {
              resume(
                Effect.logWarning(
                  `kubernetes registry: watch closed with error: ${String(err)}`
                )
              )
            }
          }
          watchClient
            .start({
              path,
              query: { labelSelector, watch: true },
              onEvent: (phase, pod) => {
                // Run the per-event effect on the parent runtime so it
                // inherits the same services (Logger, etc.). Errors are
                // captured here so they NEVER reach the routing path.
                Effect.runForkWith(parentServices)(
                  handlePhase(phase, pod).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        `kubernetes registry: handlePhase failed`,
                        cause
                      )
                    )
                  )
                )
              },
              onClose: (err) => finish(err),
            })
            .then((stop) => {
              abort = stop
            })
            .catch((err) => finish(err))
          // Cleanup on interruption.
          return Effect.sync(() => {
            if (abort !== undefined) abort()
          })
        }
      )

      const watchLoop: Effect.Effect<void> = Effect.gen(function* () {
        let delay = reconnectInitialMs
        // Effect.forever loops until interruption (layer scope close).
        return yield* Effect.forever(
          Effect.gen(function* () {
            yield* runWatchOnce.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `kubernetes registry: watch fiber failure (will retry)`,
                  cause
                )
              )
            )
            yield* Effect.logDebug(
              `kubernetes registry: watch ended; reconnecting in ${delay}ms`
            )
            yield* Effect.sleep(`${delay} millis`)
            delay = Math.min(delay * 2, reconnectMaxMs)
          })
        )
      })

      yield* Effect.forkScoped(
        watchLoop.pipe(
          Effect.catchCause((cause) =>
            // Defensive: Effect.forever should never complete normally,
            // but if anything escapes, swallow it — D4.
            Effect.logError(
              `kubernetes registry: watch loop terminated unexpectedly: ${Cause.pretty(cause)}`
            )
          )
        )
      )

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

      // ── Probe-side write surface (D5 most-restrictive) ────────────────
      const setHealth = (
        id: WorkerId,
        probeHealth: WorkerHealth
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const map = yield* Ref.get(stateRef)
          const cur = HashMap.get(map, id)
          if (cur._tag === "None") return
          const pairs = yield* Ref.get(pairsRef)
          const oldPair = HashMap.get(pairs, id)
          const k8sHealth: WorkerHealth =
            oldPair._tag === "Some" ? oldPair.value.k8s : "alive"
          if (oldPair._tag === "Some" && oldPair.value.probe === probeHealth) {
            return
          }
          const newPair: HealthPair = { k8s: k8sHealth, probe: probeHealth }
          yield* Ref.set(pairsRef, HashMap.set(pairs, id, newPair))
          const oldEntry = cur.value
          const resolvedOld = oldEntry.health
          const resolvedNew = resolvePair(newPair)
          if (resolvedNew === resolvedOld) return
          const nowMs = yield* Clock.currentTimeMillis
          const nextEntry: WorkerEntry =
            resolvedNew === "draining"
              ? {
                  id: oldEntry.id,
                  address: oldEntry.address,
                  health: "draining",
                  drainingSince: oldEntry.drainingSince ?? nowMs,
                }
              : {
                  id: oldEntry.id,
                  address: oldEntry.address,
                  health: resolvedNew,
                }
          yield* Ref.set(stateRef, HashMap.set(map, id, nextEntry))
          yield* PubSub.publish(events, {
            _tag: "health_changed",
            id,
            from: resolvedOld,
            to: resolvedNew,
          })
        })

      const control = { setHealth }

      return ServiceMap.empty().pipe(
        ServiceMap.add(WorkerRegistry, registry),
        ServiceMap.add(WorkerRegistryControl, control)
      )
    })
  )
}
