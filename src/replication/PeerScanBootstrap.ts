/**
 * Peer-scan-bootstrap orchestrator (echo-removal slice §3).
 *
 * On worker boot, fan out one per-peer bootstrap effect against the
 * peers alive in the K8s enumeration snapshot. Each per-peer effect:
 *
 *   1. Opens a `/bootstrap` stream against the source peer.
 *   2. Applies each `Entry` event into local `pri:{self}:call:{callRef}`
 *      via the atomic `kv.applyReplicaUpdate` primitive — same shape
 *      `makeReplicationApply` uses for steady-state apply.
 *   3. Captures the terminal `Head` event and calls `seedWatermark`
 *      so the puller resumes from that head instead of `(0,0)`.
 *
 * Transport, retry and timeout policies live here; the wire format
 * is owned by `ReplLogServer.bootstrapStream` / `makeBootstrapStream`.
 *
 * Failure modes:
 *   - One peer fails transport-class (HTTP 5xx, parse, network drop):
 *     retry once after `perPeerRetryDelayMs`. If the retry also fails,
 *     that peer's outcome is `"error"` and the worker proceeds.
 *   - Overall wall-time exceeds `overallTimeoutMs`: every still-running
 *     per-peer attempt is interrupted; those peers' outcomes are
 *     `"timeout"`.
 *
 * In neither case does the bootstrap phase fail the worker boot — the
 * puller's normal delta pull eventually reconciles whatever bootstrap
 * could not import (subject to the trade-off that quiet calls remain
 * unreachable until the peer originates a write that re-mentions them).
 *
 * Design ref: docs/plan/echo-removal-grill-me-smooth-parasol.md §3.
 */

import {
  Clock,
  Effect,
  MutableRef,
  Option,
  Result,
  Stream,
} from "effect"
import type { HttpClient } from "effect/unstable/http"
import { callIndexKeysFromUnknown } from "../call/CallModel.js"
import { mpUnpack, stripStampedPrefix } from "../call/CallCodec.js"

/**
 * Decode a body Buffer (legacy JSON or msgpack via first-byte dispatch).
 * Decode failure returns `null` so the bootstrap apply path treats the
 * entry as un-indexable — better than crashing the bootstrap loop.
 */
const safeDecodeBody = (buf: Buffer): unknown => {
  try {
    if (buf.length > 0 && buf[0] === 0x7b) {
      return JSON.parse(buf.toString("utf8"))
    }
    return mpUnpack(stripStampedPrefix(buf))
  } catch {
    return null
  }
}
import type { PeerEndpointResolverApi } from "../cache/PeerEndpointResolver.js"
import type { WorkerOrdinal } from "../cache/PeerCachePort.js"
import type { KvBackendApi } from "../storage/KvBackend.js"
import {
  makeBootstrapStream,
  type BootstrapEvent,
} from "./PullerHttpTransport.js"
import type { DataFrame, ProtocolError } from "./ReplicationProtocol.js"
import { PullerTransportError } from "./PullerFiber.js"
import type { ReplicationBootstrapMetrics } from "../observability/MetricsRegistry.js"
import { ChannelIndex } from "./ChannelIndex.js"
import type {
  PartitionedRelayStorageApi,
  ScanEntry,
} from "../cache/PartitionedRelayStorage.js"

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type BootstrapOutcome = "ok" | "timeout" | "error"

export interface BootstrapResult {
  readonly peer: WorkerOrdinal
  readonly outcome: BootstrapOutcome
  readonly entriesImported: number
  readonly head: { readonly gen: number; readonly counter: number } | null
  readonly durationMs: number
  readonly error: string | null
}

export interface BootstrapMetricsHooks {
  readonly recordStarted: () => void
  readonly recordCompleted: (peer: string, outcome: BootstrapOutcome) => void
  readonly recordEntriesImported: (peer: string, count: number) => void
  readonly recordDurationMs: (peer: string, ms: number) => void
}

export interface RunPeerScanBootstrapConfig {
  readonly self: string
  readonly peers: ReadonlyArray<WorkerOrdinal>
  readonly kv: KvBackendApi
  /**
   * Production transport — required UNLESS `streamFactory` is set.
   * Wires `makeBootstrapStream` against the peer's `/bootstrap` route
   * via the resolved base URL.
   */
  readonly httpClient?: HttpClient.HttpClient
  readonly resolver?: PeerEndpointResolverApi
  /**
   * Plant the post-bootstrap watermark for `peer`. Called inside the
   * per-peer effect when the terminal `Head` event arrives — wired in
   * production to `supervisor.seedWatermark`.
   */
  readonly seedWatermark: (args: {
    readonly peer: WorkerOrdinal
    readonly watermark: { readonly gen: number; readonly counter: number }
  }) => Effect.Effect<void>
  readonly overallTimeoutMs: number
  readonly perPeerRetryDelayMs: number
  /**
   * Optional bootstrap-stream factory override — production wires this
   * to `makeBootstrapStream` (the HTTP-backed transport). Tests can
   * inject a direct in-process stream (no HTTP) that reads the peer's
   * `KvBackend` straight.
   */
  readonly streamFactory?: (
    peer: WorkerOrdinal
  ) => Stream.Stream<BootstrapEvent, PullerTransportError | ProtocolError>
  readonly metrics?: BootstrapMetricsHooks
  /**
   * Fallback body TTL when an entry's `body_ttl_remaining_sec` is 0
   * (peer's bak entry on the verge of expiry). Default 30s — entries
   * about to expire still get a short grace window so an in-flight
   * BYE doesn't 481 immediately. Set lower (e.g. 5s) under heavy
   * traffic to bound stale state.
   */
  readonly fallbackBodyTtlSec?: number
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const DEFAULT_FALLBACK_TTL_SEC = 30

export const runPeerScanBootstrap = (
  config: RunPeerScanBootstrapConfig
): Effect.Effect<ReadonlyArray<BootstrapResult>> =>
  Effect.gen(function* () {
    config.metrics?.recordStarted()
    if (config.peers.length === 0) {
      return [] as ReadonlyArray<BootstrapResult>
    }

    const startMs = yield* Clock.currentTimeMillis
    const deadlineMs = startMs + config.overallTimeoutMs
    const streamFactory: (
      peer: WorkerOrdinal
    ) => Stream.Stream<BootstrapEvent, PullerTransportError | ProtocolError> =
      config.streamFactory ??
      ((peer: WorkerOrdinal) => {
        if (config.httpClient === undefined || config.resolver === undefined) {
          return Stream.fail(
            new PullerTransportError({
              reason: "bootstrap: no streamFactory and no httpClient/resolver",
            })
          )
        }
        return makeBootstrapStream({
          self: config.self,
          source: peer as unknown as string,
          client: config.httpClient,
          resolver: config.resolver,
        })
      })
    const fallbackTtl = config.fallbackBodyTtlSec ?? DEFAULT_FALLBACK_TTL_SEC

    const perPeer = (peer: WorkerOrdinal): Effect.Effect<BootstrapResult> =>
      runPerPeerWithDeadline({
        peer,
        self: config.self,
        kv: config.kv,
        streamFactory,
        seedWatermark: config.seedWatermark,
        deadlineMs,
        retryDelayMs: config.perPeerRetryDelayMs,
        fallbackBodyTtlSec: fallbackTtl,
      })

    const results = yield* Effect.all(config.peers.map(perPeer), {
      concurrency: "unbounded",
    })

    if (config.metrics !== undefined) {
      for (const r of results) {
        const peerLabel = r.peer as unknown as string
        config.metrics.recordCompleted(peerLabel, r.outcome)
        if (r.entriesImported > 0) {
          config.metrics.recordEntriesImported(peerLabel, r.entriesImported)
        }
        config.metrics.recordDurationMs(peerLabel, r.durationMs)
      }
    }

    return results
  })

// ---------------------------------------------------------------------------
// Per-peer machinery
// ---------------------------------------------------------------------------

interface PerPeerContext {
  readonly peer: WorkerOrdinal
  readonly self: string
  readonly kv: KvBackendApi
  readonly streamFactory: (
    peer: WorkerOrdinal
  ) => Stream.Stream<BootstrapEvent, PullerTransportError | ProtocolError>
  readonly seedWatermark: (args: {
    readonly peer: WorkerOrdinal
    readonly watermark: { readonly gen: number; readonly counter: number }
  }) => Effect.Effect<void>
  readonly deadlineMs: number
  readonly retryDelayMs: number
  readonly fallbackBodyTtlSec: number
}

interface PerPeerState {
  entriesImported: number
  head: { gen: number; counter: number } | null
  startMs: number
}

const runPerPeerWithDeadline = (
  ctx: PerPeerContext
): Effect.Effect<BootstrapResult> =>
  Effect.gen(function* () {
    const startMs = yield* Clock.currentTimeMillis
    const stateRef = MutableRef.make<PerPeerState>({
      entriesImported: 0,
      head: null,
      startMs,
    })

    const buildResult = (
      outcome: BootstrapOutcome,
      error: string | null,
      endMs: number
    ): BootstrapResult => {
      const s = MutableRef.get(stateRef)
      return {
        peer: ctx.peer,
        outcome,
        entriesImported: s.entriesImported,
        head: s.head,
        durationMs: endMs - startMs,
        error,
      }
    }

    const remaining = Math.max(0, ctx.deadlineMs - startMs)
    if (remaining <= 0) {
      return buildResult(
        "timeout",
        "deadline exceeded before start",
        startMs
      )
    }

    // Attempt 1 — wrap stream consumption in `Effect.result` so the
    // stream's typed error surfaces as a Result.failure; wrap again
    // in `Effect.timeoutOption` so an unresponsive peer yields None
    // (timeout) rather than blocking past the budget.
    const attempt1Outer = yield* Effect.timeoutOption(
      Effect.result(runOneAttempt(ctx, stateRef)),
      `${remaining} millis`
    )
    const nowAfterFirst = yield* Clock.currentTimeMillis

    if (Option.isNone(attempt1Outer)) {
      return buildResult("timeout", "deadline exceeded on attempt", nowAfterFirst)
    }
    const attempt1 = attempt1Outer.value
    if (Result.isSuccess(attempt1)) {
      return buildResult("ok", null, nowAfterFirst)
    }

    // First attempt errored — retry once if remaining budget covers
    // the backoff + a fresh attempt window.
    yield* Effect.logWarning(
      `bootstrap(${ctx.peer}): attempt 1 failed (${attempt1.failure.reason}), retrying after ${ctx.retryDelayMs}ms`
    )
    const remainAfterFirst = Math.max(0, ctx.deadlineMs - nowAfterFirst)
    if (remainAfterFirst <= ctx.retryDelayMs) {
      return buildResult(
        "timeout",
        "deadline exceeded before retry",
        nowAfterFirst
      )
    }
    yield* Effect.sleep(`${ctx.retryDelayMs} millis`)
    const nowAfterSleep = yield* Clock.currentTimeMillis
    const remainAfterSleep = Math.max(0, ctx.deadlineMs - nowAfterSleep)
    if (remainAfterSleep <= 0) {
      return buildResult(
        "timeout",
        "deadline exceeded after retry backoff",
        nowAfterSleep
      )
    }
    const attempt2Outer = yield* Effect.timeoutOption(
      Effect.result(runOneAttempt(ctx, stateRef)),
      `${remainAfterSleep} millis`
    )
    const nowAfterSecond = yield* Clock.currentTimeMillis
    if (Option.isNone(attempt2Outer)) {
      return buildResult("timeout", "deadline exceeded on retry", nowAfterSecond)
    }
    const attempt2 = attempt2Outer.value
    if (Result.isSuccess(attempt2)) {
      return buildResult("ok", null, nowAfterSecond)
    }
    return buildResult("error", attempt2.failure.reason, nowAfterSecond)
  })

const runOneAttempt = (
  ctx: PerPeerContext,
  stateRef: MutableRef.MutableRef<PerPeerState>
): Effect.Effect<void, PullerTransportError | ProtocolError> =>
  ctx.streamFactory(ctx.peer).pipe(
    Stream.runForEach((event) => onEvent(ctx, stateRef, event))
  )

const onEvent = (
  ctx: PerPeerContext,
  stateRef: MutableRef.MutableRef<PerPeerState>,
  event: BootstrapEvent
): Effect.Effect<void, PullerTransportError | ProtocolError> => {
  if (event._tag === "Entry") {
    return applyBootstrapEntry(ctx, event.frame).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const cur = MutableRef.get(stateRef)
          MutableRef.set(stateRef, {
            ...cur,
            entriesImported: cur.entriesImported + 1,
          })
        })
      ),
      Effect.catchTag("KvError", (err) =>
        Effect.logWarning(
          `bootstrap(${ctx.peer}): apply failed for callRef=${event.frame.callRef}: ${err.reason}`
        )
      )
    )
  }
  // Head event — capture and seed.
  return Effect.sync(() => {
    const cur = MutableRef.get(stateRef)
    MutableRef.set(stateRef, { ...cur, head: event.head })
  }).pipe(
    Effect.andThen(
      ctx.seedWatermark({ peer: ctx.peer, watermark: event.head })
    )
  )
}

// ---------------------------------------------------------------------------
// Direct in-process bootstrap stream — used by fake stacks (k8s, b2b
// proxy) that share peer KvBackends in-memory and want to skip the
// HTTP fabric round-trip. Mirrors the server-side `buildBootstrapStream`
// + client-side `makeBootstrapStream` flow into a single Stream.
// ---------------------------------------------------------------------------

export interface MakeDirectBootstrapStreamConfig {
  readonly self: string
  /** The source peer's ordinal — `bak:{self}:*` lives in their storage. */
  readonly source: string
  /** The peer's incarnation gen — `propagate:{source}->{self}` is keyed by it. */
  readonly sourceGen: number
  readonly peerKv: import("../storage/KvBackend.js").KvBackendApi
  readonly peerStorage: PartitionedRelayStorageApi
}

/**
 * Build a direct in-process `BootstrapEvent` stream — Entry per scan
 * entry followed by exactly one terminal Head carrying the peer's
 * recorded outgoing-channel head. Used by fake stacks. Production
 * uses `makeBootstrapStream` (HTTP-backed) instead.
 */
export const makeDirectBootstrapStream = (
  config: MakeDirectBootstrapStreamConfig
): Stream.Stream<BootstrapEvent, PullerTransportError | ProtocolError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const channel = ChannelIndex.make(
        { self: config.source, peer: config.self, gen: config.sourceGen },
        config.peerKv
      )
      const headBatch = yield* channel.pullBatch({ gen: 0, counter: 0 }, 0).pipe(
        Effect.mapError(
          (e) =>
            new PullerTransportError({
              reason: `bootstrap(${config.source}) head pull: ${e.reason}`,
            })
        )
      )
      const entries = config.peerStorage.scanCalls("bak", config.self).pipe(
        Stream.mapError(
          (e) =>
            new PullerTransportError({
              reason: `bootstrap(${config.source}) scanCalls: ${e.reason}`,
            })
        ),
        Stream.map((entry): BootstrapEvent => ({
          _tag: "Entry",
          frame: scanEntryToDataFrame(entry),
        }))
      )
      const headEvent: BootstrapEvent = {
        _tag: "Head",
        head: { gen: headBatch.head.gen, counter: headBatch.head.counter },
      }
      return Stream.concat(entries, Stream.succeed(headEvent))
    })
  )

const scanEntryToDataFrame = (entry: ScanEntry): DataFrame => {
  // Decode the body once on the scan source to populate the wire
  // envelope's callGen + indexes. Commit 4 sources both from a
  // sidecar instead so this decode disappears entirely.
  const decoded = entry.body !== null ? safeDecodeBody(entry.body) : null
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
// Bootstrap metrics state — allocates counter maps + the
// `ReplicationBootstrapMetrics` snapshot surface that
// `MetricsRegistry.replicationBootstrap` exposes. Hooks side is wired
// into the orchestrator via `metrics`; reader side is wired into the
// Prometheus scrape via `MetricsRegistry`.
// ---------------------------------------------------------------------------

export const makeBootstrapMetricsState = (): {
  readonly hooks: BootstrapMetricsHooks
  readonly registry: ReplicationBootstrapMetrics
} => {
  let started = 0
  const completed = new Map<string, number>()
  const imported = new Map<string, number>()
  const durations = new Map<string, Array<number>>()

  const inc = (m: Map<string, number>, key: string, delta = 1): void => {
    m.set(key, (m.get(key) ?? 0) + delta)
  }
  const push = (m: Map<string, Array<number>>, key: string, v: number): void => {
    const arr = m.get(key)
    if (arr === undefined) m.set(key, [v])
    else arr.push(v)
  }
  const snapshotNum = (m: Map<string, number>): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const [k, v] of m) out[k] = v
    return out
  }
  const snapshotArr = (
    m: Map<string, Array<number>>
  ): Record<string, ReadonlyArray<number>> => {
    const out: Record<string, ReadonlyArray<number>> = {}
    for (const [k, v] of m) out[k] = v
    return out
  }

  const hooks: BootstrapMetricsHooks = {
    recordStarted: () => {
      started += 1
    },
    recordCompleted: (peer, outcome) => {
      inc(completed, `${peer}|${outcome}`)
    },
    recordEntriesImported: (peer, count) => {
      inc(imported, peer, count)
    },
    recordDurationMs: (peer, ms) => {
      push(durations, peer, ms)
    },
  }

  const registry: ReplicationBootstrapMetrics = {
    startedTotal: () => started,
    completedTotal: () => snapshotNum(completed),
    entriesImportedTotal: () => snapshotNum(imported),
    durationMs: () => snapshotArr(durations),
  }

  return { hooks, registry }
}

const applyBootstrapEntry = (
  ctx: PerPeerContext,
  frame: DataFrame
): Effect.Effect<void, import("../storage/KvBackend.js").KvError> => {
  if (frame.body === null) return Effect.void
  const bodyTtlSec =
    frame.body_ttl_remaining_sec > 0
      ? frame.body_ttl_remaining_sec
      : ctx.fallbackBodyTtlSec
  const bodyKey = `pri:${ctx.self}:call:${frame.callRef}`
  // Unpack once for index derivation; the raw msgpack bytes
  // (`frame.body`) are what we persist locally so the bootstrapped
  // copy is bit-for-bit identical to the source peer's body.
  const decoded = safeDecodeBody(frame.body)
  const derivedIndexes = callIndexKeysFromUnknown(decoded)
  // Extract callGen from the decoded body to populate the sidecar;
  // commit 4 will let the frame carry it directly.
  const decodedTopologyGen =
    decoded !== null &&
    typeof decoded === "object" &&
    decoded !== null &&
    typeof (decoded as { _topology?: { gen?: unknown } })._topology === "object"
      ? (decoded as { _topology?: { gen?: unknown } })._topology?.gen
      : undefined
  const callGen =
    typeof decodedTopologyGen === "number" && Number.isFinite(decodedTopologyGen)
      ? Math.max(0, decodedTopologyGen)
      : 0
  return ctx.kv.applyReplicaUpdate({
    bodyKey,
    bodyValue: frame.body,
    bodyTtlSec,
    callGen,
    indexes: derivedIndexes.map((k) => ({
      key: `idx:${k}`,
      value: frame.callRef,
      ttlSec: bodyTtlSec,
    })),
  })
}
