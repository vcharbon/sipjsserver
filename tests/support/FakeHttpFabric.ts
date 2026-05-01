/**
 * FakeHttpFabric — in-memory `HttpClient` ↔ `HttpRouter` fabric for
 * fake-clock tests. Slice 1.2 of the failover-harness plan
 * (docs/plan/management-of-k8s-reliability-compiled-dijkstra.md).
 *
 * Production replication uses Effect's `effect/unstable/http` Tags —
 *   - `HttpClient.HttpClient` (consumed by ReadyGate, PeerCacheClient)
 *   - `HttpRouter.HttpRouter` (consumed by addReplLogRoutes,
 *     addPeerRelayRoutes)
 *
 * Both sides are pluggable. This module satisfies the same Tags with
 * an in-process registry: `register(host, port, router)` puts a router
 * into a `host:port` map, and the fake client looks up the router by
 * URL host:port and round-trips the request through it. ReplPuller's
 * NDJSON long-poll, ReadyGate's drain, and PeerCacheClient's PUT/POST
 * all run unchanged under TestClock, since they live entirely above the
 * transport.
 *
 * Behaviour:
 *   - URL parse fails             → `HttpClientError(InvalidUrlError)`
 *   - No router for host:port     → `HttpClientError(TransportError)`
 *     (mirrors a connection-refused / DNS-fail in production)
 *   - Route handler defect/error  → `HttpClientError(TransportError)`
 *   - Connectivity-gate denies    → `HttpClientError(TransportError)`
 *     (slice 1.3 — read from the fiber's `ConnectivityGate` Reference;
 *     covers worker disconnect / partition rules wired by
 *     `tests/support/WorkerConnectivity.ts`)
 *   - Otherwise                   → server response wrapped via
 *     `HttpServerResponse.toClientResponse(...)` so streaming bodies
 *     pipe straight through `response.stream`.
 *
 * Scope handling: each `execute` call creates a fresh `Closeable` scope
 * for the route handler. The scope is intentionally not closed by the
 * fake client — streaming responses (e.g. ReplLog long-poll) need it to
 * outlive `execute()`. The fabric tracks every per-request scope and
 * closes them when the fabric's layer scope closes (i.e. test cleanup).
 *
 * Caller identity: `FakeHttpClientLayer` builds an anonymous client
 * (gate sees `src = undefined` → only the dst-side flags + partitions
 * involving an unknown sender are evaluated; in practice this means
 * "no-op for the from→to partition rules"). For multi-worker scenarios
 * pass the caller's address via `fakeHttpClientLayerForSelf({ip,port})`
 * so the gate can resolve the caller's workerId and honor full
 * src/dst partition rules.
 */

import {
  Effect,
  Exit,
  Layer,
  MutableHashMap,
  Scope,
  ServiceMap,
} from "effect"
import * as Fiber from "effect/Fiber"
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { ConnectivityGate } from "../../src/sip/ConnectivityGate.js"

// URL.hostname lowercases, so we normalise on register/lookup to keep
// the registry case-insensitive in line with HTTP host semantics.
const routeKey = (host: string, port: number): string =>
  `${host.toLowerCase()}:${port}`

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

export interface FakeHttpFabricApi {
  /**
   * Register `router` under `host:port`. Returns an Effect that
   * requires a `Scope` — closing that scope auto-deregisters the
   * route. Wired this way so each worker's HttpRouter can be registered
   * in the worker's lifecycle scope (per slice-3 Q2: kill closes the
   * worker scope, which auto-removes its routes).
   *
   * Re-registering the same `host:port` overrides the previous router;
   * this matches "respawning a worker on the same address" semantics.
   */
  readonly register: (
    host: string,
    port: number,
    router: HttpRouter.HttpRouter,
  ) => Effect.Effect<void, never, Scope.Scope>

  /**
   * Look up a router by host:port. Exposed so callers can verify
   * registration / use the fabric outside the fake `HttpClient` (e.g.
   * direct stream comparison tests).
   */
  readonly lookup: (
    host: string,
    port: number,
  ) => Effect.Effect<HttpRouter.HttpRouter | undefined>

  /**
   * Internal — used by `FakeHttpClientLayer`. Look up the router for
   * `request`'s URL and round-trip the request through it. Failures
   * (no route registered, handler error, connectivity-gate denial)
   * surface as `HttpClientError`. Not part of the public test surface;
   * tests should obtain an `HttpClient.HttpClient` via
   * `FakeHttpClientLayer` (or `fakeHttpClientLayerForSelf`) and call
   * `client.execute(request)`.
   *
   * `selfAddress`, when supplied, is passed to the connectivity gate
   * as the packet's `src` so the gate can resolve the caller's
   * workerId and honor partition rules in both directions. Anonymous
   * callers (`undefined`) skip the from-side check; the gate may still
   * deny the request via the dst-side `inbound` flag.
   */
  readonly executeRequest: (
    request: HttpClientRequest.HttpClientRequest,
    url: URL,
    selfAddress: { readonly ip: string; readonly port: number } | undefined,
  ) => Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError
  >
}

export class FakeHttpFabric extends ServiceMap.Service<
  FakeHttpFabric,
  FakeHttpFabricApi
>()("@sipjsserver/test-support/FakeHttpFabric") {}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

const transportError = (
  request: HttpClientRequest.HttpClientRequest,
  description: string,
): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description }),
  })

const portFromUrl = (url: URL): number => {
  if (url.port !== "") return Number(url.port)
  if (url.protocol === "https:") return 443
  return 80
}

export const FakeHttpFabricLayer: Layer.Layer<FakeHttpFabric> = Layer.effect(
  FakeHttpFabric,
  Effect.gen(function* () {
    const routes = MutableHashMap.empty<string, HttpRouter.HttpRouter>()

    // Each `executeRequest` call leaks a fresh scope so streamed
    // response bodies (ReplLog long-poll, NDJSON heartbeats, etc.)
    // outlive the call. The fabric closes any leaked scopes when its
    // own layer scope closes — i.e. at test teardown.
    const requestScopes = new Set<Scope.Closeable>()
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        requestScopes,
        (s) => Scope.close(s, Exit.void).pipe(Effect.ignore),
        { discard: true, concurrency: "unbounded" },
      ),
    )

    const register: FakeHttpFabricApi["register"] = (host, port, router) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          MutableHashMap.set(routes, routeKey(host, port), router)
        }),
        () =>
          Effect.sync(() => {
            MutableHashMap.remove(routes, routeKey(host, port))
          }),
      )

    const lookup: FakeHttpFabricApi["lookup"] = (host, port) =>
      Effect.sync(() => {
        const opt = MutableHashMap.get(routes, routeKey(host, port))
        return opt._tag === "Some" ? opt.value : undefined
      })

    const executeRequest: FakeHttpFabricApi["executeRequest"] = (
      request,
      url,
      selfAddress,
    ) => {
      const host = url.hostname
      const port = portFromUrl(url)

      // Connectivity-gate check (slice 1.3). Mirrors
      // `SignalingNetwork.simulated`'s deliver-time check, surfaced as
      // a `TransportError` since that is what HTTP callers expect on a
      // partitioned link (FetchHttpClient maps connection refused /
      // network unreachable to TransportError too).
      const fiber = Fiber.getCurrent()
      const gate =
        fiber !== undefined
          ? fiber.getRef(ConnectivityGate)
          : ConnectivityGate.defaultValue()
      // Use a sentinel src when no selfAddress is given so the gate's
      // `lookup(src)` returns `undefined` → `canDeliver` allows the
      // request unless the dst-side flags say otherwise.
      const src = selfAddress ?? { ip: "0.0.0.0", port: 0 }
      const dst = { ip: host, port }
      if (!gate.canDeliver(src, dst)) {
        return Effect.fail(
          transportError(request, `connectivity gate denied ${host}:${port}`),
        )
      }

      const opt = MutableHashMap.get(routes, routeKey(host, port))
      if (opt._tag === "None") {
        return Effect.fail(
          transportError(request, `no fake route for ${host}:${port}`),
        )
      }
      const router = opt.value
      return Effect.gen(function* () {
        const scope = Scope.makeUnsafe()
        requestScopes.add(scope)
        const serverRequest = HttpServerRequest.fromClientRequest(request)
        const handlerResult = yield* Effect.result(
          router
            .asHttpEffect()
            .pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                serverRequest,
              ),
              Effect.provideService(Scope.Scope, scope),
            ),
        )
        if (handlerResult._tag === "Failure") {
          requestScopes.delete(scope)
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
          return yield* Effect.fail(
            transportError(
              request,
              `route handler failed: ${String(handlerResult.failure)}`,
            ),
          )
        }
        const serverResp = handlerResult.success
        return HttpServerResponse.toClientResponse(serverResp, { request })
      })
    }

    return { register, lookup, executeRequest }
  }),
)

// ---------------------------------------------------------------------------
// Fake HttpClient
// ---------------------------------------------------------------------------

/**
 * `HttpClient` layer backed by the fake fabric — anonymous caller
 * (gate sees `src = undefined`, only dst-side flags evaluated).
 * Suitable for single-worker tests; multi-worker tests should prefer
 * `fakeHttpClientLayerForSelf` so partition rules in both directions
 * apply.
 */
export const FakeHttpClientLayer: Layer.Layer<
  HttpClient.HttpClient,
  never,
  FakeHttpFabric
> = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const fabric = yield* FakeHttpFabric
    return HttpClient.make((request, url) =>
      fabric.executeRequest(request, url, undefined),
    )
  }),
)

/**
 * Build an `HttpClient` layer whose `execute` reports `selfAddress` as
 * the packet's source to the connectivity gate. Use one per worker in
 * multi-worker fake-stacks so that gate rules of the form "from worker
 * A to worker B" apply when A is the caller.
 */
export const fakeHttpClientLayerForSelf = (selfAddress: {
  readonly ip: string
  readonly port: number
}): Layer.Layer<HttpClient.HttpClient, never, FakeHttpFabric> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const fabric = yield* FakeHttpFabric
      return HttpClient.make((request, url) =>
        fabric.executeRequest(request, url, selfAddress),
      )
    }),
  )
