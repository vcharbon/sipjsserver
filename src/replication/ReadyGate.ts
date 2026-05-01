/**
 * ReadyGate — boot-time handshake that drains every reachable peer's
 * `propagate:{self}` stream up to its `head_at_open` watermark, then
 * flips `WorkerReadiness.markReady(true)`.
 *
 * Slice 5 deliverable. Spec §8 of
 * docs/replication/call-cache-backup.md.
 *
 * Single-owner invariant (spec §0): when a peer was holding `bak:{self}:`
 * copies of this worker's primary calls and serving requests against
 * them while this worker was down, those updates flow back through
 * the *same* `propagate:{self}` stream as a reverse-direction entry.
 * The drain therefore picks up both directions:
 *
 *   - Forward direction (peer is primary, this worker holds the
 *     backup) — entry applied to `bak:{peer}:call:{ref}` locally.
 *     Existing behaviour.
 *   - Reverse direction (this worker is the primary, the peer was
 *     serving a request as backup while this worker was down) —
 *     entry applied to `pri:{self}:call:{ref}` locally so this
 *     worker resumes serving its own primary calls with the latest
 *     state the peer wrote. The k8s-reliability rework (slice 2.5)
 *     adds the direction tag to the wire format and the
 *     direction-aware apply path; the existing `ReclaimRunner` flow
 *     (src/cache/ReclaimRunner.ts) covers the same recovery via
 *     scan as a safety net for entries that fell out of the
 *     propagate window.
 *
 * The drain never writes into a peer's `pri:` — that would violate
 * the §0 single-owner invariant. Forward entries land in this
 * worker's `bak:{peer}:`; reverse entries land in this worker's own
 * `pri:{self}:`. Neither modifies any other worker's state.
 *
 * Lifecycle (per spec §8.1):
 *   1. Bump epoch (handled by EpochCounter at its own layer creation).
 *   2. Enumerate peers via PeerEnumerator.
 *   3. For each peer, open `/replog` (drainOnly mode) and apply every
 *      entry via ReplPuller until caught_up. Mark peer `synced`.
 *   4. Hard ceiling 30 s wall-clock — peers not synced go into
 *      `unreconciled[]`. The metric `sipjsserver_ready_gate_unreconciled_count`
 *      rises; calls whose `_topology.bak === unreconciled-peer` will
 *      481 fall-through (matches D14 contract).
 *   5. Flip WorkerReadiness.markReady(true).
 *
 * Transport-agnostic: the gate consumes a `ReplogClient` service that
 * given a peer ordinal returns a `Stream<Uint8Array>` (NDJSON). Tests
 * wire a direct ReplLog stream; production wires FetchHttpClient.
 */

import {
  Data,
  Duration,
  Effect,
  Layer,
  Result,
  ServiceMap,
  Stream,
} from "effect"
import {
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http"
import {
  PeerEndpointResolver,
} from "../cache/PeerEndpointResolver.js"
import { WorkerOrdinal } from "../cache/PeerCachePort.js"
import { PeerEnumerator } from "../cache/PeerEnumerator.js"
import { WorkerReadiness } from "../cache/WorkerReadiness.js"
import { ReplPuller } from "./ReplPuller.js"

// ---------------------------------------------------------------------------
// ReplogClient — pluggable transport to a peer's /replog endpoint
// ---------------------------------------------------------------------------

export interface ReplogClientApi {
  /**
   * Open a `/replog` long-poll stream against `peer`. The returned
   * Stream emits NDJSON byte chunks. Caller (ReadyGate) feeds it to
   * ReplPuller.applyStream which decodes, applies, and persists
   * replpos.
   *
   * The `drainOnly` query semantic is the gate's responsibility — it
   * passes the appropriate query string to the underlying transport
   * (in production: `?drainOnly=1`; in tests: invokes
   * `replLog.stream(..., { drainOnly: true })`).
   */
  readonly streamFromPeer: (
    peer: string,
    sinceSeq: number,
    opts?: { readonly drainOnly?: boolean }
  ) => Stream.Stream<Uint8Array, never>
}

export class ReplogClient extends ServiceMap.Service<
  ReplogClient,
  ReplogClientApi
>()("@sipjsserver/replication/ReplogClient") {
  /**
   * Production: HTTP-backed transport. Resolves the peer to a base URL
   * via `PeerEndpointResolver`, opens
   * `GET <peerBase>/replog?caller=<self>&since=<lastSeq>[&drainOnly=1]`
   * through the ambient `HttpClient` (typically `FetchHttpClient.layer`),
   * and exposes the response body as a `Stream<Uint8Array>`.
   *
   * Transport / DNS / status errors are absorbed: the stream ends
   * gracefully (caller observes "no more frames" rather than a typed
   * error). Production wires a forked-fiber retry loop above this layer
   * so a closed stream simply triggers reconnect with backoff.
   *
   * `self` is the local worker's ordinal — the `caller` query param the
   * peer's `/replog` endpoint records as the calling worker's identity.
   */
  static readonly fetchHttpLayer = (cfg: {
    readonly self: string
  }): Layer.Layer<ReplogClient, never, HttpClient.HttpClient | PeerEndpointResolver> =>
    Layer.effect(
      ReplogClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const resolver = yield* PeerEndpointResolver

        const buildUrl = (
          peer: string,
          sinceSeq: number,
          drainOnly: boolean
        ): Effect.Effect<string, never> =>
          Effect.gen(function* () {
            const resolved = yield* Effect.result(
              resolver.resolve(WorkerOrdinal(peer))
            )
            if (Result.isFailure(resolved)) {
              yield* Effect.logWarning(
                `ReplogClient: resolve(${peer}) failed (${resolved.failure.reason}) — yielding empty stream`
              )
              return ""
            }
            const base = resolved.success
            const drainQs = drainOnly ? "&drainOnly=1" : ""
            return `${base}/replog?caller=${encodeURIComponent(
              cfg.self
            )}&since=${sinceSeq}${drainQs}`
          })

        const streamFromPeer = (
          peer: string,
          sinceSeq: number,
          opts?: { readonly drainOnly?: boolean }
        ): Stream.Stream<Uint8Array, never> => {
          const drainOnly = opts?.drainOnly === true
          // The whole pipeline is wrapped in an Effect that resolves
          // the URL, builds the request, and unwraps a Stream from
          // the streamed response body. Any HTTP error converts to an
          // empty stream + warning log so the consumer (ReplPuller)
          // observes a clean end-of-stream and the steady-state retry
          // loop reconnects after backoff.
          return Stream.unwrap(
            Effect.gen(function* () {
              const url = yield* buildUrl(peer, sinceSeq, drainOnly)
              if (url.length === 0) return Stream.empty
              const req = HttpClientRequest.get(url)
              const respResult = yield* Effect.result(client.execute(req))
              if (Result.isFailure(respResult)) {
                yield* Effect.logWarning(
                  `ReplogClient: execute(${peer}) failed — ${respResult.failure.message}`
                )
                return Stream.empty
              }
              const resp = respResult.success
              if (resp.status < 200 || resp.status >= 300) {
                yield* Effect.logWarning(
                  `ReplogClient: peer ${peer} returned status=${resp.status}`
                )
                return Stream.empty
              }
              // resp.stream returns Stream<Uint8Array, HttpClientError>
              // — collapse the error channel so the public surface is
              // `Stream<Uint8Array, never>` (ReplPuller's contract).
              return resp.stream.pipe(
                Stream.catchCause((cause) =>
                  Stream.unwrap(
                    Effect.logWarning(
                      `ReplogClient: stream from ${peer} aborted — ${cause}`
                    ).pipe(Effect.as(Stream.empty))
                  )
                )
              )
            })
          )
        }

        return { streamFromPeer }
      })
    )
}

// ---------------------------------------------------------------------------
// ReadyGate types
// ---------------------------------------------------------------------------

export class ReadyGateError extends Data.TaggedError("ReadyGateError")<{
  readonly reason: string
}> {}

export interface ReadyGateResult {
  readonly synced: ReadonlyArray<string>
  readonly unreconciled: ReadonlyArray<string>
  readonly durationMs: number
}

export interface ReadyGateConfig {
  /** Hard ceiling on the boot handshake. Default 30s (spec §8.3). */
  readonly maxDuration?: Duration.Input
}

export interface ReadyGateApi {
  /**
   * Run the boot handshake. Blocks until either every peer is synced
   * or `maxDuration` elapses, then flips `WorkerReadiness.markReady(true)`
   * and returns the {synced, unreconciled, durationMs} summary.
   */
  readonly run: Effect.Effect<ReadyGateResult, ReadyGateError>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ReadyGate extends ServiceMap.Service<ReadyGate, ReadyGateApi>()(
  "@sipjsserver/replication/ReadyGate"
) {
  /**
   * Memory-layer factory for tests. Production code uses the same
   * shape but wires an HTTP-backed ReplogClient.
   */
  static readonly layer = (
    config?: ReadyGateConfig
  ): Layer.Layer<
    ReadyGate,
    never,
    PeerEnumerator | WorkerReadiness | ReplPuller | ReplogClient
  > =>
    Layer.effect(
      ReadyGate,
      Effect.gen(function* () {
        const enumerator = yield* PeerEnumerator
        const readiness = yield* WorkerReadiness
        const puller = yield* ReplPuller
        const client = yield* ReplogClient

        const maxDuration = Duration.fromInputUnsafe(
          config?.maxDuration ?? "30 seconds"
        )

        const drainOnePeer = (
          peer: string
        ): Effect.Effect<{
          readonly peer: string
          readonly synced: boolean
        }> =>
          Effect.gen(function* () {
            const pos = yield* puller.readPos(peer)
            const upstream = client.streamFromPeer(peer, pos.lastSeq, {
              drainOnly: true,
            })
            const result = yield* puller.applyStream(peer, upstream).pipe(
              // ReplPuller errors don't poison the gate — log and treat
              // the peer as unreconciled. Both error tags carry a
              // `reason` we surface to logs.
              Effect.catchTags({
                ReplPullerError: (err) =>
                  Effect.logWarning(
                    `ReadyGate: drain of peer ${peer} failed (ReplPullerError: ${err.reason})`
                  ).pipe(
                    Effect.as({
                      framesApplied: 0,
                      caughtUpAtSeq: null,
                    } as const)
                  ),
                AtomicWriterError: (err) =>
                  Effect.logWarning(
                    `ReadyGate: drain of peer ${peer} failed (AtomicWriterError: ${err.reason})`
                  ).pipe(
                    Effect.as({
                      framesApplied: 0,
                      caughtUpAtSeq: null,
                    } as const)
                  ),
              })
            )
            return {
              peer,
              synced: result.caughtUpAtSeq !== null,
            }
          })

        const run: Effect.Effect<ReadyGateResult, ReadyGateError> =
          Effect.gen(function* () {
            const startNs = yield* Effect.sync(() => Date.now())
            const peers = yield* enumerator.currentPeers

            // Race the parallel drain against the maxDuration ceiling.
            // Whichever wins decides what `synced` includes; peers not
            // yet drained at timeout are recorded as unreconciled.
            const drainAll = Effect.all(
              peers.map((p) => drainOnePeer(p)),
              { concurrency: "unbounded" }
            )
            const outcomes = yield* drainAll.pipe(
              Effect.timeout(maxDuration),
              Effect.catchTag("TimeoutError", () =>
                Effect.succeed(
                  // On timeout we don't know per-peer status reliably;
                  // mark every peer unreconciled. Background drains
                  // would still complete, but the gate has elapsed.
                  peers.map((p) => ({ peer: p, synced: false }))
                )
              )
            )
            const synced = outcomes
              .filter((o) => o.synced)
              .map((o) => o.peer)
            const unreconciled = outcomes
              .filter((o) => !o.synced)
              .map((o) => o.peer)
            const durationMs = Date.now() - startNs

            yield* readiness.markReady(true)
            yield* Effect.logInfo(
              `ReadyGate: ready (synced=${synced.length} unreconciled=${unreconciled.length} durationMs=${durationMs})`
            )

            return { synced, unreconciled, durationMs }
          })

        return { run }
      })
    )
}
