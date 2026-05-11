/**
 * ReplLogServer — long-lived NDJSON `/replog` endpoint.
 *
 * Per-peer-pull request:
 *   GET /replog?caller={peerId}&gen={uint}&counter={uint}&chunk_size={uint}
 *
 * Server-side emission loop (per design doc Wire Protocol §):
 *   while connection_open:
 *     batch = channelIndex.pullBatch({ gen: req.gen, counter: req.counter }, chunk_size)
 *     for e in batch.entries:
 *       emit data_frame(e) — gen comes from e.entryGen, ttl-remaining from e
 *     if batch.entries.length == chunk_size: continue immediately
 *     else: emit noop({ gen: serverGen, counter: batch.head.counter }); sleep 100ms
 *
 * The loop runs forever — there is no max-open. Pullers manage reconnect
 * on transport failure; correctness does not depend on connection
 * lifetime. Frames are emitted in strictly ascending lex `(gen, counter)`
 * order across per-`(channel, entryGen)` buckets; the underlying storage
 * primitive walks buckets in lex order.
 *
 * Per Story 7d there is no `sinceGen != serverGen` special case — every
 * entry carries its own `entryGen` (mirrors at `0`, originating at the
 * writer's incarnation gen), and lex compare on `(entry.gen, entry.counter)`
 * naturally handles cross-incarnation watermarks.
 */

import {
  Clock,
  Duration,
  Effect,
  Layer,
  Option,
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
  type DataFrame,
  type NoopFrame,
  type PullFrame,
} from "./ReplicationProtocol.js"
import { KvBackend, type KvBackendApi } from "../storage/KvBackend.js"
import {
  PartitionedRelayStorage,
  type PartitionedRelayStorageApi,
  type ScanEntry,
} from "../cache/PartitionedRelayStorage.js"

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

  /**
   * Build the NDJSON byte stream for one `/bootstrap` request. Same
   * wire format as `/replog` (PullFrame Data + final Noop), but reads
   * directly from `PartitionedRelayStorage.scanCalls("bak", caller)`
   * — every emitted frame is a `Data{op:"create",partition:"pri"}`
   * synthesized from a scan entry. Stream is finite: ends after the
   * scan exhausts plus one terminal Noop.
   */
  readonly bootstrapStream: (args: {
    readonly caller: string
  }) => Stream.Stream<Uint8Array>
}

export class ReplLogServer extends ServiceMap.Service<
  ReplLogServer,
  ReplLogServerApi
>()("@sipjsserver/replication/ReplLogServer") {
  static readonly layer = (
    config: ReplLogServerConfig
  ): Layer.Layer<ReplLogServer, never, KvBackend | PartitionedRelayStorage> =>
    Layer.effect(
      ReplLogServer,
      Effect.gen(function* () {
        const kv = yield* KvBackend
        const storage = yield* PartitionedRelayStorage
        return makeServer(kv, storage, config)
      })
    )

  /** Synchronous factory for tests that wire a custom `KvBackend` instance. */
  static readonly makeUnsafe = (
    kv: KvBackendApi,
    storage: PartitionedRelayStorageApi,
    config: ReplLogServerConfig
  ): ReplLogServerApi => makeServer(kv, storage, config)
}

const makeServer = (
  kv: KvBackendApi,
  storage: PartitionedRelayStorageApi,
  config: ReplLogServerConfig
): ReplLogServerApi => {
  const noopMs = config.noopIntervalMs ?? REPLLOG_DEFAULT_NOOP_INTERVAL_MS

  const stream: ReplLogServerApi["stream"] = ({
    caller,
    sinceGen,
    sinceCounter,
    chunkSize,
  }) => {
    const channelIndex: ChannelIndexApi = ChannelIndex.make(
      { self: config.self, peer: caller, gen: config.gen },
      kv
    )

    return buildPullStream({
      channel: channelIndex,
      serverGen: config.gen,
      initialSince: { gen: sinceGen, counter: sinceCounter },
      chunkSize,
      noopIntervalMs: noopMs,
    })
  }

  const bootstrapStream: ReplLogServerApi["bootstrapStream"] = ({ caller }) => {
    // Channel from server (self) → caller — the channel the caller's
    // puller will resume pulling after bootstrap. Recording the head
    // here, before scan, ensures the terminal Noop carries a watermark
    // the puller can seed without re-fetching the partition.
    const channelIndex: ChannelIndexApi = ChannelIndex.make(
      { self: config.self, peer: caller, gen: config.gen },
      kv
    )
    return buildBootstrapStream(storage, channelIndex, caller)
  }

  return { stream, bootstrapStream }
}

// ---------------------------------------------------------------------------
// Stream builder — one batch-iteration per inner Effect; repeats forever
// ---------------------------------------------------------------------------

interface BuildPullStreamArgs {
  readonly channel: ChannelIndexApi
  /**
   * The server's incarnation gen — stamped on Noop frames as the
   * heartbeat marker. Per Story 7d, Data frames carry per-entry
   * `entryGen` instead (read from `PulledEntry`); the server's gen
   * here is purely for noop heartbeats.
   */
  readonly serverGen: number
  readonly initialSince: { readonly gen: number; readonly counter: number }
  readonly chunkSize: number
  readonly noopIntervalMs: number
}

/**
 * Tick state threaded through `Stream.paginate`. Kept inside paginate's
 * closure so the stream's pull is a single Suspend node — no recursive
 * `Stream.concat` chain that would grow per-tick for the lifetime of
 * the (long-lived) HTTP request.
 */
interface TickState {
  readonly since: { readonly gen: number; readonly counter: number }
  readonly sleepFirst: boolean
}

/**
 * Construct the long-lived NDJSON stream for one /replog connection.
 *
 * Order of operations within a tick (executed by paginate's loop body):
 *   1. (optional) sleep `noopIntervalMs` if the previous tick's batch was
 *      partial. We sleep at the START of the next tick — never at the
 *      end of the current one — so the noop frame the previous tick
 *      emitted is flushed downstream before we block.
 *   2. Pull a batch from the channel via lex-ordered bucket walk.
 *   3. Emit one Data frame per entry — `gen` and `body_ttl_remaining_sec`
 *      come from the entry itself (per Story 7d).
 *   4. If the batch was partial, emit a Noop frame at `head` (the
 *      channel's lex-greatest tuple) and mark `partial=true` so the
 *      next tick begins with a sleep.
 *   5. Advance the cursor to the LAST entry's `(entryGen, score)` —
 *      this is the strict lex-greater anchor for the next pull.
 *
 * Encoding to NDJSON bytes is pushed to a downstream `Stream.map` stage
 * so the loop body deals only in typed `PullFrame` values.
 */
export const buildPullStream = (
  args: BuildPullStreamArgs
): Stream.Stream<Uint8Array> =>
  Stream.paginate<TickState, PullFrame>(
    { since: args.initialSince, sleepFirst: false },
    (state) =>
      Effect.gen(function* () {
        if (state.sleepFirst) {
          yield* Effect.sleep(Duration.millis(args.noopIntervalMs))
        }
        const batch = yield* args.channel
          .pullBatch(state.since, args.chunkSize)
          .pipe(Effect.orDie)
        const nowMs = yield* Clock.currentTimeMillis

        const frames: Array<PullFrame> = []
        for (const entry of batch.entries) {
          const data = buildDataFrame(entry, nowMs)
          if (data !== null) frames.push(data)
        }
        const partial = batch.entries.length < args.chunkSize
        if (partial) {
          // Noop carries the actual head tuple `(head.gen, head.counter)`,
          // not `(serverGen, head.counter)`. With per-`(channel, entryGen)`
          // buckets (Story 7d), `head.gen` may differ from `serverGen` —
          // e.g. a channel with gen=0 mirror entries but an empty
          // gen=`serverGen` originating bucket has `head.gen=0`. Stamping
          // `serverGen` with `head.counter` from a different bucket
          // fabricates a tuple that no entry occupies; the puller
          // advances watermark to it and then filters out future
          // originating writes whose counter is ≤ that value.
          const noop: NoopFrame = {
            _tag: "Noop",
            gen: batch.head.gen,
            counter: batch.head.counter,
            latency_ms: 0,
          }
          frames.push(noop)
        }
        const nextSince =
          batch.entries.length > 0
            ? (() => {
                const last = batch.entries[batch.entries.length - 1]!
                return { gen: last.entryGen, counter: last.score }
              })()
            : state.since
        // Infinite stream — always Some. The HTTP request scope bounds
        // the stream's life; client disconnect closes the scope and
        // interrupts the in-flight pull (including the idle sleep).
        const nextState: TickState = {
          since: nextSince,
          sleepFirst: partial,
        }
        return [frames, Option.some(nextState)] as const
      })
  ).pipe(Stream.map((frame) => textEncoder.encode(encodeFrame(frame))))

const textEncoder = new TextEncoder()

// ---------------------------------------------------------------------------
// Bootstrap stream — one-shot scan of `bak:{caller}:*`, emitted as
// `Data{op:"create",partition:"pri"}` frames followed by one terminal
// `Noop`. Same NDJSON wire format as `/replog`; gen/counter are sentinel
// `0`/`0` since bootstrap is outside the channel watermark space (the
// client bypasses the watermark gate on this endpoint).
// ---------------------------------------------------------------------------

const buildBootstrapStream = (
  storage: PartitionedRelayStorageApi,
  channel: ChannelIndexApi,
  caller: string
): Stream.Stream<Uint8Array> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Snapshot head BEFORE scan. Channel writes that race the scan
      // window land at `(head.gen, head.counter+N)` — the puller picks
      // them up via the seeded watermark; applyReplicaUpdate is
      // idempotent so any double-applies are no-ops.
      const headBatch = yield* channel.pullBatch({ gen: 0, counter: 0 }, 0).pipe(
        Effect.orDie
      )
      const dataFrames = storage.scanCalls("bak", caller).pipe(
        Stream.orDie,
        Stream.map(encodeBootstrapEntry)
      )
      const terminalNoop: NoopFrame = {
        _tag: "Noop",
        gen: headBatch.head.gen,
        counter: headBatch.head.counter,
        latency_ms: 0,
      }
      return Stream.concat(
        dataFrames,
        Stream.succeed(textEncoder.encode(encodeFrame(terminalNoop)))
      )
    })
  )

const encodeBootstrapEntry = (entry: ScanEntry): Uint8Array => {
  const frame: DataFrame = {
    _tag: "Data",
    gen: 0,
    counter: 0,
    op: "create",
    partition: "pri",
    callRef: entry.callRef,
    body: safeParseJsonValue(entry.json),
    body_ttl_remaining_sec: entry.ttlSec,
    latency_ms: 0,
  }
  return textEncoder.encode(encodeFrame(frame))
}

const safeParseJsonValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

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

    // ── GET /bootstrap?caller={self} ────────────────────────────────────
    // Peer-scan-bootstrap: stream every entry in this server's
    // `bak:{caller}:*` partition as NDJSON DataFrames, then a terminal
    // Noop, then close. The receiver applies into its local
    // `pri:{caller}:*` partition. See
    // docs/plan/echo-removal-grill-me-smooth-parasol.md §1.
    yield* router.add(
      "GET",
      "/bootstrap",
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
        const body = server.bootstrapStream({ caller })
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
