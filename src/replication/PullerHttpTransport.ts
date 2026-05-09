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

// Re-exports to keep import sites stable.
export { PeerEndpointResolver }
