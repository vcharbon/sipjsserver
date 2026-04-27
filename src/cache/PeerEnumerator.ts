/**
 * PeerEnumerator — discovers the cluster's currently-Ready peer set.
 *
 * Slice 6 of the HA-resilience plan. Different concern from
 * `PeerEndpointResolver` (slice 3): the resolver maps a single ordinal
 * to a URL; this service answers "which peers should I be talking to
 * RIGHT NOW?" The two are designed to compose — `ReclaimRunner` calls
 * `enumerator.currentPeers` to get the live set, then resolves each
 * ordinal to a URL via `PeerEndpointResolver` (or, in tests, dispatches
 * through `PeerCachePort` whose backing layer already knows how to
 * route by ordinal).
 *
 * Three layer constructors:
 *
 *   - `headlessStatefulSet(cfg)` — production. A scoped background
 *     fiber polls `dns.promises.resolveSrv` against the headless
 *     StatefulSet's `_{portName}._tcp.{serviceName}.{namespace}.{suffix}`
 *     SRV record every `refreshIntervalMs` (default 10s). Each SRV
 *     target's first DNS label is the pod ordinal (e.g.
 *     `b2bua-worker-2.b2bua-headless.default.svc.cluster.local` →
 *     ordinal `b2bua-worker-2`). Empty results / `ENOTFOUND` reset the
 *     cached set; `ESERVFAIL`/timeout keeps the prior snapshot and
 *     logs a warning (treat the cluster as last-known-good when DNS
 *     is transiently flaky). Self is filtered out if `self` is
 *     supplied.
 *
 *   - `staticSet(peers)` — fixed list. Used by unit tests of slice-6
 *     primitives that want to drive currentPeers explicitly.
 *
 *   - `fromFabric(fabric, self)` — derives the live set from a
 *     `PeerFabric.simulatedBuilt` handle. A peer's fabric `health` of
 *     `"alive"` or `"draining"` counts as ready; `"dead"` or
 *     `"rebooting"` does NOT. This makes `step.fabric.kill("pod-3")`
 *     in the scenario DSL drop pod-3 from enumeration immediately —
 *     the natural choice for slice-6 fabric-driven tests.
 *
 * Default state: empty set on construction. Production layer's first
 * DNS poll runs at fiber start; tests that need a non-empty initial
 * snapshot use `staticSet` or `fromFabric`.
 */

import { Data, Effect, Layer, MutableRef, Result, ServiceMap } from "effect"
import { WorkerOrdinal } from "./PeerCachePort.js"
import type { PeerFabricApi, PeerFabricControlApi } from "./PeerFabric.js"

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export interface PeerEnumeratorApi {
  /**
   * Currently-known set of ready peer ordinals (excluding self if the
   * underlying layer was given a `self` to filter on). Reads a cached
   * snapshot — never blocks on DNS. The snapshot is refreshed by the
   * layer's own background fiber (production) or recomputed eagerly
   * (test layers).
   */
  readonly currentPeers: Effect.Effect<ReadonlyArray<WorkerOrdinal>>
}

class DnsLookupError extends Data.TaggedError("PeerEnumeratorDnsLookupError")<{
  readonly code: string | undefined
  readonly message: string
}> {}

export class PeerEnumerator extends ServiceMap.Service<
  PeerEnumerator,
  PeerEnumeratorApi
>()("@sipjsserver/cache/PeerEnumerator") {
  /**
   * Production: DNS-driven SRV polling. Uses the layer's own scope so
   * the background fiber stops on Layer teardown.
   *
   * The actual `dns.promises.resolveSrv` call is wrapped in
   * `Effect.tryPromise` and runs off the fiber's main loop. We don't
   * try to parse the trailing port — `PeerEndpointResolver` already
   * encodes that into the URL it builds for each ordinal.
   */
  static readonly headlessStatefulSet = (cfg: {
    readonly serviceName: string
    readonly namespace: string
    readonly portName: string
    readonly clusterSuffix?: string
    readonly refreshIntervalMs?: number
    readonly self?: WorkerOrdinal
  }): Layer.Layer<PeerEnumerator> => {
    const refreshMs = cfg.refreshIntervalMs ?? 10_000
    const suffix = cfg.clusterSuffix ?? "svc.cluster.local"
    const srvName = `_${cfg.portName}._tcp.${cfg.serviceName}.${cfg.namespace}.${suffix}`
    return Layer.effect(PeerEnumerator)(
      Effect.gen(function* () {
        const ref = MutableRef.make<ReadonlyArray<WorkerOrdinal>>([])

        const tick = Effect.gen(function* () {
          const result = yield* Effect.result(
            Effect.tryPromise({
              try: async () => {
                // Lazy import keeps `node:dns` out of bundles that
                // don't ship the production layer.
                const dns = await import("node:dns/promises")
                return dns.resolveSrv(srvName)
              },
              catch: (err) => {
                const e = err as { code?: string; message?: string }
                return new DnsLookupError({
                  code: e.code,
                  message: e.message ?? String(err),
                })
              },
            })
          )
          if (Result.isFailure(result)) {
            const err = result.failure
            if (err.code === "ENOTFOUND" || err.code === "NXDOMAIN") {
              MutableRef.set(ref, [])
            } else {
              yield* Effect.logWarning(
                `PeerEnumerator: DNS lookup failed for ${srvName}: ${err.message} — keeping prior snapshot`
              )
            }
            return
          }
          const records = result.success
          const ordinals: Array<WorkerOrdinal> = []
          for (const r of records) {
            const firstLabel = r.name.split(".")[0]
            if (firstLabel === undefined || firstLabel.length === 0) continue
            const ord = WorkerOrdinal(firstLabel)
            if (cfg.self !== undefined && ord === cfg.self) continue
            ordinals.push(ord)
          }
          // Sort + dedupe to keep snapshots stable across retries.
          const dedup = Array.from(new Set(ordinals)).sort()
          MutableRef.set(ref, dedup)
        })

        // First poll inline so `currentPeers` is non-empty by the time
        // the layer hands control back to its consumer (provided DNS
        // is reachable). Wrapped in `ignore` so a startup DNS failure
        // doesn't crash the layer build — the warning above documents
        // it and the next tick will retry.
        yield* tick.pipe(Effect.ignore)
        // Background refresh — scoped so the fiber dies with the layer.
        // Effect.sleep (not Effect.delay) so TestClock can drive it.
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep(`${refreshMs} millis`)
              yield* tick
            })
          )
        )
        return {
          currentPeers: Effect.sync(() => MutableRef.get(ref)),
        }
      })
    )
  }

  /**
   * Fixed list — used by unit tests that drive currentPeers
   * explicitly. The list is captured at layer-build time; mutating
   * the input array afterwards has no effect.
   */
  static readonly staticSet = (
    peers: ReadonlyArray<WorkerOrdinal>
  ): Layer.Layer<PeerEnumerator> => {
    const snapshot = Array.from(peers)
    return Layer.succeed(PeerEnumerator, {
      currentPeers: Effect.sync(() => snapshot),
    })
  }

  /**
   * Backed by a `PeerFabric` handle. Reads the live health of every
   * peer through `PeerFabricControl.snapshotPeer` and filters down to
   * ordinals whose health is `alive` or `draining`. `dead` and
   * `rebooting` peers are excluded — a rebooting pod is K8s-not-Ready
   * (its readiness probe answers 503 while ReclaimRunner runs), and a
   * dead pod has no DNS endpoint.
   *
   * Convenient when a scenario has already built a fabric via
   * `PeerFabric.simulatedBuilt`: pass `fabric` and (optionally) `self`
   * to filter the local worker out of its own enumeration.
   */
  static readonly fromFabric = (
    handle: { readonly fabric: PeerFabricApi; readonly control: PeerFabricControlApi },
    self?: WorkerOrdinal
  ): Layer.Layer<PeerEnumerator> =>
    Layer.succeed(PeerEnumerator, {
      currentPeers: Effect.gen(function* () {
        const out: Array<WorkerOrdinal> = []
        for (const ord of handle.fabric.peers) {
          if (self !== undefined && ord === self) continue
          const snap = yield* handle.control.snapshotPeer(ord)
          if (snap.health === "alive" || snap.health === "draining") {
            out.push(ord)
          }
        }
        return out
      }),
    })
}
