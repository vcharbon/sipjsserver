/**
 * ReplLogServer — long-lived NDJSON `/replog` endpoint.
 *
 * Per-peer-pull request:
 *   GET /replog?caller={peerId}&gen={uint}&counter={uint}&chunk_size={uint}
 *
 * Server-side emission loop (per design doc Wire Protocol §):
 *   while connection_open:
 *     entries = channelIndex.pullBatch(watermark, chunk_size)
 *     for e in entries: emit data_frame(e); watermark = e.score
 *     if entries.length == chunk_size: continue immediately
 *     else: emit noop(headCounter); sleep 100ms
 *
 * The loop runs forever — there is no max-open. Pullers manage reconnect
 * on transport failure; correctness does not depend on connection
 * lifetime. Frames are emitted in strictly ascending `(gen, counter)`
 * order; `gen` is constant for the server's lifetime.
 *
 * If the requesting `gen` is older than the server's current `gen`, the
 * effective `sinceScore` resets to 0 — the puller is from a prior
 * incarnation and needs a full bootstrap of the new gen's data. No
 * special "gen_mismatch" frame is emitted; the natural `(gen, counter)`
 * ordering on subsequent frames carries them past the puller's
 * (now stale) watermark.
 */

import {
  Clock,
  Duration,
  Effect,
  Layer,
  ServiceMap,
  Stream,
} from "effect"
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import {
  ChannelIndex,
  type ChannelIndexApi,
} from "./ChannelIndex.js"
import {
  buildDataFrame,
  encodeFrame,
  type NoopFrame,
} from "./ReplicationProtocol.js"
import { KvBackend, type KvBackendApi } from "../storage/KvBackend.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default chunk_size when the puller omits it. */
export const REPLLOG_DEFAULT_CHUNK_SIZE = 1000

/** Sleep between Redis pulls when the channel is empty. */
export const REPLLOG_DEFAULT_NOOP_INTERVAL_MS = 100

export interface ReplLogServerConfig {
  /** This worker's identity — used to construct ChannelIndex bindings. */
  readonly self: string
  /** This worker's incarnation gen (from EpochCounter; constant for process). */
  readonly gen: number
  /** Override the default 100ms idle-sleep (mostly for tests). */
  readonly noopIntervalMs?: number
}

// ---------------------------------------------------------------------------
// Service surface — the per-request stream builder
// ---------------------------------------------------------------------------

export interface ReplLogServerApi {
  /**
   * Build the NDJSON byte stream for one `/replog` request. The caller
   * (HTTP route handler) wraps the returned `Stream` into an HTTP
   * response and lets it run until the client disconnects.
   */
  readonly stream: (args: {
    readonly caller: string
    readonly sinceGen: number
    readonly sinceCounter: number
    readonly chunkSize: number
  }) => Stream.Stream<Uint8Array>
}

export class ReplLogServer extends ServiceMap.Service<
  ReplLogServer,
  ReplLogServerApi
>()("@sipjsserver/replication/ReplLogServer") {
  static readonly layer = (
    config: ReplLogServerConfig
  ): Layer.Layer<ReplLogServer, never, KvBackend> =>
    Layer.effect(
      ReplLogServer,
      Effect.gen(function* () {
        const kv = yield* KvBackend
        return makeServer(kv, config)
      })
    )

  /** Synchronous factory for tests that wire a custom `KvBackend` instance. */
  static readonly makeUnsafe = (
    kv: KvBackendApi,
    config: ReplLogServerConfig
  ): ReplLogServerApi => makeServer(kv, config)
}

const makeServer = (
  kv: KvBackendApi,
  config: ReplLogServerConfig
): ReplLogServerApi => {
  const noopMs = config.noopIntervalMs ?? REPLLOG_DEFAULT_NOOP_INTERVAL_MS

  const stream: ReplLogServerApi["stream"] = ({
    caller,
    sinceGen,
    sinceCounter,
    chunkSize,
  }) => {
    // If the puller's gen is from a prior incarnation, treat the
    // request as cold-start — the new gen's frames will sort above
    // anything the puller previously stored.
    const effectiveSinceCounter =
      sinceGen === config.gen ? sinceCounter : 0

    const channelIndex: ChannelIndexApi = ChannelIndex.make(
      { self: config.self, peer: caller, gen: config.gen },
      kv
    )

    return buildPullStream({
      channel: channelIndex,
      gen: config.gen,
      initialSince: effectiveSinceCounter,
      chunkSize,
      noopIntervalMs: noopMs,
    })
  }

  return { stream }
}

// ---------------------------------------------------------------------------
// Stream builder — one batch-iteration per inner Effect; repeats forever
// ---------------------------------------------------------------------------

interface BuildPullStreamArgs {
  readonly channel: ChannelIndexApi
  readonly gen: number
  readonly initialSince: number
  readonly chunkSize: number
  readonly noopIntervalMs: number
}

/**
 * Construct the long-lived NDJSON stream for one /replog connection.
 * Internal helper exposed for the unit tests in
 * `tests/replication/server-emission-loop.test.ts`.
 */
export const buildPullStream = (
  args: BuildPullStreamArgs
): Stream.Stream<Uint8Array> => recurseTick(args, args.initialSince, false)

/**
 * One iteration of the server-emission loop, lazily continued via
 * `Stream.concat` so that `Stream.take(N)` (and real client disconnects)
 * interrupt before the next tick's idle sleep is entered.
 *
 * Order of operations within a tick:
 *   1. (optional) sleep `noopIntervalMs` if the previous tick's batch was
 *      partial. We sleep at the START of the next tick — never at the
 *      end of the current one — so the noop frame the previous tick
 *      emitted is flushed downstream before we block.
 *   2. Pull a batch from the channel.
 *   3. Emit one Data frame per entry.
 *   4. If the batch was partial, emit a Noop frame at `headCounter` and
 *      mark `partial=true` so the next tick begins with a sleep.
 */
const recurseTick = (
  args: BuildPullStreamArgs,
  since: number,
  sleepFirst: boolean
): Stream.Stream<Uint8Array> =>
  Stream.unwrap(
    Effect.gen(function* () {
      if (sleepFirst) {
        yield* Effect.sleep(Duration.millis(args.noopIntervalMs))
      }
      const batch = yield* args.channel
        .pullBatch(since, args.chunkSize)
        .pipe(Effect.orDie)
      const nowMs = yield* Clock.currentTimeMillis
      const frames: Array<Uint8Array> = []
      for (const entry of batch.entries) {
        const data = buildDataFrame(entry, args.gen, nowMs)
        if (data === null) continue
        frames.push(textEncoder.encode(encodeFrame(data)))
      }
      const partial = batch.entries.length < args.chunkSize
      if (partial) {
        const noop: NoopFrame = {
          _tag: "Noop",
          gen: args.gen,
          counter: batch.headCounter,
          latency_ms: 0,
        }
        frames.push(textEncoder.encode(encodeFrame(noop)))
      }
      const nextSince =
        batch.entries.length > 0
          ? batch.entries[batch.entries.length - 1]!.score
          : since
      return Stream.concat(
        Stream.fromIterable(frames),
        recurseTick(args, nextSince, partial)
      )
    })
  )

const textEncoder = new TextEncoder()

// ---------------------------------------------------------------------------
// HTTP route registration
// ---------------------------------------------------------------------------

/**
 * Register the `/replog` route on the provided router. The route reads
 * the `caller`, `gen`, `counter`, `chunk_size` URL params, builds the
 * pull stream via `ReplLogServer`, and returns it as an NDJSON HTTP
 * response. The connection stays open until the client disconnects or
 * the server fiber is interrupted.
 */
export const addReplLogRoutes = (
  router: HttpRouter.HttpRouter
): Effect.Effect<void, never, ReplLogServer> =>
  Effect.gen(function* () {
    const server = yield* ReplLogServer
    yield* router.add(
      "GET",
      "/replog",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(req.url, "http://localhost")
        const caller = url.searchParams.get("caller")
        if (caller === null || caller.length === 0) {
          return HttpServerResponse.jsonUnsafe(
            { error: "missing required query param: caller" },
            { status: 400 }
          )
        }
        const sinceGen = paramAsNonNegativeInt(url, "gen", 0)
        const sinceCounter = paramAsNonNegativeInt(url, "counter", 0)
        const chunkSize = paramAsNonNegativeInt(
          url,
          "chunk_size",
          REPLLOG_DEFAULT_CHUNK_SIZE
        )
        if (sinceGen === null || sinceCounter === null || chunkSize === null) {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid gen/counter/chunk_size param" },
            { status: 400 }
          )
        }
        if (chunkSize < 1) {
          return HttpServerResponse.jsonUnsafe(
            { error: "chunk_size must be >= 1" },
            { status: 400 }
          )
        }
        const body = server.stream({
          caller,
          sinceGen,
          sinceCounter,
          chunkSize,
        })
        return HttpServerResponse.stream(body, {
          contentType: "application/x-ndjson",
          headers: { "cache-control": "no-store" },
        })
      })
    )
  })

const paramAsNonNegativeInt = (
  url: URL,
  name: string,
  defaultValue: number
): number | null => {
  const raw = url.searchParams.get(name)
  if (raw === null) return defaultValue
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null
  return n
}
