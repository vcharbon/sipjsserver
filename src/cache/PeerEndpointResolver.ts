/**
 * PeerEndpointResolver — maps a `WorkerOrdinal` to the URL of that
 * peer's relay endpoint.
 *
 * Slice 3. Production wires from the headless StatefulSet DNS
 * pattern (`{ordinal}.{svc}.{ns}.svc.cluster.local:{port}`). Tests
 * inject a static map.
 *
 * Splitting this out keeps `PeerCacheClient` test-friendly: tests
 * don't need DNS or K8s — they pass a `Layer` with explicit
 * `WorkerOrdinal → URL` mappings.
 */

import { Data, Effect, Layer, ServiceMap } from "effect"
import type { WorkerOrdinal } from "./PeerCachePort.js"

export class PeerEndpointResolveError extends Data.TaggedError(
  "PeerEndpointResolveError"
)<{
  readonly peer: WorkerOrdinal
  readonly reason: "unknown_peer" | "dns_failed"
  readonly detail?: string
}> {}

export interface PeerEndpointResolverApi {
  /** Resolve a peer ordinal to the base URL of its relay (no trailing slash). */
  readonly resolve: (
    peer: WorkerOrdinal
  ) => Effect.Effect<string, PeerEndpointResolveError>
}

export class PeerEndpointResolver extends ServiceMap.Service<
  PeerEndpointResolver,
  PeerEndpointResolverApi
>()("@sipjsserver/cache/PeerEndpointResolver") {
  /**
   * DNS-style resolver: builds
   * `http://{ordinal}.{serviceName}.{namespace}.svc.cluster.local:{port}`.
   * Node's HTTP client handles the actual DNS lookup at connect-time
   * — we don't pre-resolve here. Failure surfaces as a connection
   * error from the client side.
   */
  static readonly headlessStatefulSet = (cfg: {
    readonly serviceName: string
    readonly namespace: string
    readonly relayPort: number
    /** Optional cluster-DNS suffix; defaults to `svc.cluster.local`. */
    readonly clusterSuffix?: string
  }): Layer.Layer<PeerEndpointResolver> =>
    Layer.succeed(PeerEndpointResolver, {
      resolve: (peer) =>
        Effect.succeed(
          `http://${peer}.${cfg.serviceName}.${cfg.namespace}.${
            cfg.clusterSuffix ?? "svc.cluster.local"
          }:${cfg.relayPort}`
        ),
    })

  /**
   * Static-map resolver — used by tests to point peers at
   * arbitrary URLs (e.g. `http://127.0.0.1:5xxxx`).
   */
  static readonly staticMap = (
    map: ReadonlyMap<WorkerOrdinal, string>
  ): Layer.Layer<PeerEndpointResolver> =>
    Layer.succeed(PeerEndpointResolver, {
      resolve: (peer) => {
        const url = map.get(peer)
        if (url === undefined) {
          return Effect.fail(
            new PeerEndpointResolveError({ peer, reason: "unknown_peer" })
          )
        }
        return Effect.succeed(url)
      },
    })
}
