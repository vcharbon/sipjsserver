/**
 * Production wiring for the puller's transport — HTTP GET against the
 * peer's `/replog` NDJSON endpoint, body streamed as `Uint8Array`
 * chunks via `HttpClientResponse.stream`.
 *
 * Extracted from `main.ts` so tests can exercise the SAME code path
 * the production worker uses (mounted in front of `FakeHttpFabric` for
 * fake-clock variants, in front of `FetchHttpClient.layer` against a
 * real listener for the live integration variant). The fake-stack at
 * `tests/support/k8sFakeStack.ts` keeps its own direct `buildPullStream`
 * shortcut for speed; this module is the bridge that catches
 * production-only regressions like the Slice 8 stub that drove the
 * 481 storm in `endurance-2026-05-09t16-15-02-748z`.
 *
 * Server-side bounded cost: `chunkSize` caps a single Lua
 * `CHANNEL_PULL_BATCH_LUA` to that many ZRANGEBYSCORE+GET pairs and
 * the server emits a `Noop` per drained batch, so even a long-stale
 * puller reconnect cannot lock the source's Redis past one chunk's
 * worth of work. Default 1000 is a few-ms script under in-memory
 * Redis; tune down per deployment if Redis CPU pressure is observed.
 */

import { Effect, Stream } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import {
  PullerTransportError,
  type OpenStreamArgs,
} from "./PullerFiber.js"
import {
  PeerEndpointResolver,
  type PeerEndpointResolverApi,
} from "../cache/PeerEndpointResolver.js"
import { WorkerOrdinal } from "../cache/PeerCachePort.js"
import { streamNdjsonLines } from "./NdjsonStream.js"
import type {
  DataFrame,
  ProtocolError,
} from "./ReplicationProtocol.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MakePullerOpenStreamConfig {
  /** This worker's ordinal — used as the `caller` query param. */
  readonly self: string
  /** The source peer the puller is fetching from. */
  readonly source: string
  /** Resolved at factory build time (one HttpClient per Replication scope). */
  readonly client: HttpClient.HttpClient
  /** Resolves `source` → base URL (`http://…:port`, no trailing slash). */
  readonly resolver: PeerEndpointResolverApi
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the `openStream` callback the production `runPullerFiber`
 * consumes. Mirrors `PullerFiberConfig.openStream`: takes the puller's
 * current watermark, returns a long-lived NDJSON byte stream.
 *
 * Logging (WARN level — these events are rare and load-bearing for
 * failover diagnostics):
 *   - "puller(P): opening /replog stream …" — every reconnect attempt.
 *   - "puller(P): stream error — …" — every transport / server error.
 * The fiber-level reconnect / backoff logic lives in `runPullerFiber`;
 * this module is intentionally stateless across reconnects.
 */
export const makePullerOpenStream = (
  config: MakePullerOpenStreamConfig
): ((args: OpenStreamArgs) => Stream.Stream<Uint8Array, PullerTransportError>) =>
  (args) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const baseUrl = yield* config.resolver
          .resolve(WorkerOrdinal(config.source))
          .pipe(
            Effect.mapError(
              (e) =>
                new PullerTransportError({
                  reason: `resolve(${config.source}): ${e.reason}${
                    e.detail !== undefined ? ` (${e.detail})` : ""
                  }`,
                })
            )
          )
        yield* Effect.logWarning(
          `puller(${config.source}): opening /replog stream gen=${args.sinceGen} counter=${args.sinceCounter} chunk=${args.chunkSize} url=${baseUrl}`
        )
        const request = HttpClientRequest.get(`${baseUrl}/replog`).pipe(
          HttpClientRequest.setUrlParams({
            caller: config.self,
            gen: String(args.sinceGen),
            counter: String(args.sinceCounter),
            chunk_size: String(args.chunkSize),
          })
        )
        return HttpClientResponse.stream(config.client.execute(request)).pipe(
          Stream.mapError(
            (err) =>
              new PullerTransportError({
                reason: `puller(${config.source}) ${err.reason._tag}: ${err.message}`,
              })
          ),
          Stream.tapError((err) =>
            Effect.logWarning(
              `puller(${config.source}): stream error — ${err.reason}`
            )
          )
        )
      })
    )

// ---------------------------------------------------------------------------
// Bootstrap stream — one-shot GET /bootstrap?caller={self}
// ---------------------------------------------------------------------------

export interface MakeBootstrapStreamConfig {
  /** This worker's ordinal — the bootstrap consumer's identity. */
  readonly self: string
  /** The source peer hosting our `bak:{self}:*` partition. */
  readonly source: string
  readonly client: HttpClient.HttpClient
  readonly resolver: PeerEndpointResolverApi
}

/**
 * Bootstrap event yielded by `makeBootstrapStream`. `Entry` carries
 * one synthesized `Data{op:"create",partition:"pri"}` frame; `Head`
 * carries the channel watermark the server recorded just before its
 * scan started — the receiver seeds the puller from this so it
 * resumes pulling deltas without re-walking the partition.
 */
export type BootstrapEvent =
  | { readonly _tag: "Entry"; readonly frame: DataFrame }
  | {
      readonly _tag: "Head"
      readonly head: { readonly gen: number; readonly counter: number }
    }

/**
 * Open a one-shot bootstrap stream from `source`'s `/bootstrap` endpoint.
 * Yields one `Entry` per scanned call followed by exactly one terminal
 * `Head` event carrying the channel watermark recorded server-side.
 *
 * Errors (HTTP fetch failures, NDJSON parse failures) surface as
 * `PullerTransportError | ProtocolError` so the caller can attach
 * retry / timeout policy.
 */
export const makeBootstrapStream = (
  config: MakeBootstrapStreamConfig
): Stream.Stream<BootstrapEvent, PullerTransportError | ProtocolError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const baseUrl = yield* config.resolver
        .resolve(WorkerOrdinal(config.source))
        .pipe(
          Effect.mapError(
            (e) =>
              new PullerTransportError({
                reason: `resolve(${config.source}): ${e.reason}${
                  e.detail !== undefined ? ` (${e.detail})` : ""
                }`,
              })
          )
        )
      yield* Effect.logWarning(
        `bootstrap(${config.source}): opening /bootstrap stream caller=${config.self} url=${baseUrl}`
      )
      const request = HttpClientRequest.get(`${baseUrl}/bootstrap`).pipe(
        HttpClientRequest.setUrlParams({ caller: config.self })
      )
      const bytes = HttpClientResponse.stream(config.client.execute(request)).pipe(
        Stream.mapError(
          (err) =>
            new PullerTransportError({
              reason: `bootstrap(${config.source}) ${err.reason._tag}: ${err.message}`,
            })
        ),
        Stream.tapError((err) =>
          Effect.logWarning(
            `bootstrap(${config.source}): stream error — ${err.reason}`
          )
        )
      )
      return streamNdjsonLines(bytes).pipe(
        Stream.map((frame): BootstrapEvent =>
          frame._tag === "Data"
            ? { _tag: "Entry", frame }
            : { _tag: "Head", head: { gen: frame.gen, counter: frame.counter } }
        )
      )
    })
  )

// Re-exports to keep import sites stable.
export { PeerEndpointResolver }
