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
  type DataFrame,
  type NoopFrame,
  type PullFrame,
} from "./ReplicationProtocol.js"
import { KvBackend, type KvBackendApi } from "../storage/KvBackend.js"
import { mpUnpack, stripStampedPrefix } from "../call/CallCodec.js"
import { callIndexKeysFromUnknown } from "../call/CallModel.js"
import {
  PartitionedRelayStorage,
  type PartitionedRelayStorageApi,
  type ScanEntry,
} from "../cache/PartitionedRelayStorage.js"
import {
  buildChannelStream,
  encodeFramesToBytes,
  type BootstrapTickState,
  type ReplogTickState,
  type Watermark,
} from "./ChannelStream.js"

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
// Replog stream builder — long-lived `/replog` endpoint.
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
  readonly initialSince: Watermark
  readonly chunkSize: number
  readonly noopIntervalMs: number
}

/**
 * Construct the long-lived NDJSON stream for one /replog connection.
 *
 * State machine (see `ReplogTickState`):
 *   - **Pulling**: pull one batch via the channel's lex-ordered bucket
 *     walk. Emit one Data frame per entry; on a partial batch append a
 *     Noop at `head` and transition to Idle. On a full batch stay in
 *     Pulling with the advanced cursor.
 *   - **Idle**: sleep `noopIntervalMs`, then transition back to Pulling
 *     with the same cursor. The Noop emitted at the prior Pulling tick
 *     has already flushed downstream before the sleep begins — paginate
 *     hands the chunk off before re-entering the step.
 *
 * Encoding to NDJSON bytes runs in `encodeFramesToBytes` downstream so
 * the loop body deals only in typed `PullFrame` values.
 */
export const buildPullStream = (
  args: BuildPullStreamArgs
): Stream.Stream<Uint8Array> => {
  const step = (
    state: ReplogTickState
  ): Effect.Effect<
    readonly [ReadonlyArray<PullFrame>, Option.Option<ReplogTickState>]
  > => {
    if (state._tag === "Idle") {
      return Effect.as(
        Effect.sleep(Duration.millis(args.noopIntervalMs)),
        [
          [],
          Option.some<ReplogTickState>({ _tag: "Pulling", cursor: state.cursor }),
        ] as const
      )
    }
    return Effect.gen(function* () {
      const batch = yield* args.channel
        .pullBatch(state.cursor, args.chunkSize)
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
      const nextCursor: Watermark =
        batch.entries.length > 0
          ? (() => {
              const last = batch.entries[batch.entries.length - 1]!
              return { gen: last.entryGen, counter: last.score }
            })()
          : state.cursor
      // Infinite stream — always Some. The HTTP request scope bounds
      // the stream's life; client disconnect closes the scope and
      // interrupts the in-flight pull (including the idle sleep).
      const next: ReplogTickState = partial
        ? { _tag: "Idle", cursor: nextCursor }
        : { _tag: "Pulling", cursor: nextCursor }
      return [frames, Option.some(next)] as const
    })
  }

  const initial: ReplogTickState = {
    _tag: "Pulling",
    cursor: args.initialSince,
  }
  return encodeFramesToBytes(buildChannelStream(initial, step))
}

// ---------------------------------------------------------------------------
// Bootstrap stream — one-shot scan of `bak:{caller}:*`, emitted as
// `Data{op:"create",partition:"pri"}` frames followed by one terminal
// `Noop`. Same NDJSON wire format as `/replog`; data-frame gen/counter
// are sentinel `0`/`0` since bootstrap is outside the channel watermark
// space (the client bypasses the watermark gate on this endpoint), and
// the terminal Noop carries the channel head watermark recorded before
// the scan started — the receiver seeds its puller from that.
//
// Three-phase paginate (see `BootstrapTickState`):
//   FetchingHead → Scanning → EmitTerminalNoop → None
//
// Scanning collects the whole partition in one tick via
// `Stream.runCollect`. That bounds memory by partition size, which is
// already the same order-of-magnitude as the HTTP response we are
// streaming. If partitions ever grow large enough to make this a
// concern, the path forward is to expose the Redis SCAN cursor on
// `PartitionedRelayStorage.scanCalls` and step it inside paginate.
// ---------------------------------------------------------------------------

const buildBootstrapStream = (
  storage: PartitionedRelayStorageApi,
  channel: ChannelIndexApi,
  caller: string
): Stream.Stream<Uint8Array> => {
  const step = (
    state: BootstrapTickState
  ): Effect.Effect<
    readonly [ReadonlyArray<PullFrame>, Option.Option<BootstrapTickState>]
  > => {
    switch (state._tag) {
      case "FetchingHead":
        return Effect.gen(function* () {
          // Snapshot head BEFORE scan. Channel writes that race the
          // scan window land at `(head.gen, head.counter+N)` — the
          // puller picks them up via the seeded watermark;
          // applyReplicaUpdate is idempotent so any double-applies are
          // no-ops.
          const headBatch = yield* channel
            .pullBatch({ gen: 0, counter: 0 }, 0)
            .pipe(Effect.orDie)
          const head: Watermark = {
            gen: headBatch.head.gen,
            counter: headBatch.head.counter,
          }
          return [
            [],
            Option.some<BootstrapTickState>({ _tag: "Scanning", head }),
          ] as const
        })
      case "Scanning":
        return Effect.gen(function* () {
          const frames = yield* storage
            .scanCalls("bak", caller)
            .pipe(Stream.orDie, Stream.map(toBootstrapDataFrame), Stream.runCollect)
          return [
            frames,
            Option.some<BootstrapTickState>({
              _tag: "EmitTerminalNoop",
              head: state.head,
            }),
          ] as const
        })
      case "EmitTerminalNoop": {
        const noop: NoopFrame = {
          _tag: "Noop",
          gen: state.head.gen,
          counter: state.head.counter,
          latency_ms: 0,
        }
        return Effect.succeed([[noop], Option.none()] as const)
      }
    }
  }
  const initial: BootstrapTickState = { _tag: "FetchingHead" }
  return encodeFramesToBytes(buildChannelStream(initial, step))
}

const toBootstrapDataFrame = (entry: ScanEntry): DataFrame => {
  // Decode the body once on the bootstrap source to populate the wire
  // envelope's callGen + indexes. Commit 4 lifts these to a sidecar
  // read so this decode disappears.
  let decoded: unknown = null
  if (entry.body !== null) {
    try {
      if (entry.body.length > 0 && entry.body[0] === 0x7b) {
        decoded = JSON.parse(entry.body.toString("utf8"))
      } else {
        decoded = mpUnpack(stripStampedPrefix(entry.body))
      }
    } catch {
      decoded = null
    }
  }
  const decodedTopGen =
    decoded !== null &&
    typeof decoded === "object" &&
    typeof (decoded as { _topology?: { gen?: unknown } })._topology === "object"
      ? (decoded as { _topology?: { gen?: unknown } })._topology?.gen
      : undefined
  const callGen =
    typeof decodedTopGen === "number" && Number.isFinite(decodedTopGen)
      ? Math.max(0, decodedTopGen)
      : 0
  const indexes = callIndexKeysFromUnknown(decoded)
  return {
    _tag: "Data",
    gen: 0,
    counter: 0,
    op: "create",
    partition: "pri",
    callRef: entry.callRef,
    body: entry.body,
    body_ttl_remaining_sec: entry.ttlSec,
    latency_ms: 0,
    callGen,
    indexes,
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
