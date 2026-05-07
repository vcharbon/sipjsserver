/**
 * ReplMetrics — Prometheus signal aggregator for the replication path.
 *
 * Exposes counters/gauges derived from the production-wired primitives
 * (`WriteNotifier`, `EpochCounter`, `AtomicWriter`). Slice A
 * (replication observability) extends the surface with four signals:
 *
 *   - `b2bua_repl_writer_epoch{owner}` — gauge.
 *   - `b2bua_repl_writes_total{peer}` — counter.
 *   - `b2bua_repl_writes_seq_max{peer}` — gauge.
 *   - `b2bua_repl_lag_seq{peer}` — gauge. `latestSeenSeq − lastAppliedSeq`
 *     reported by the consumer-side ReplPuller (slice A).
 *   - `b2bua_repl_queue_depth{peer}` — gauge. ZCARD of `propagate:{peer}`
 *     sampled from AtomicWriter (slice A).
 *   - `b2bua_repl_frame_lag_ms` — histogram. End-to-end propagation lag
 *     in millis, recorded by the consumer per applied entry that
 *     carried the optional `tx_ms` wire field (slice A).
 *
 * A forked sampler fiber polls `lag` and `queueDepth` every 200 ms and
 * emits min/max/mean over each 1-second window to structured logs. The
 * Prometheus rendering reads the most-recent instant gauge from the
 * snapshot.
 */

import {
  Duration,
  Effect,
  Layer,
  MutableHashMap,
  Option,
  Schedule,
  ServiceMap,
  Stream,
} from "effect"
import { AtomicWriter } from "./AtomicWriter.js"
import { EpochCounter } from "./EpochCounter.js"
import { WriteNotifier } from "./WriteNotifier.js"

// ---------------------------------------------------------------------------
// Histogram primitive
// ---------------------------------------------------------------------------

/**
 * Slice A — replication frame-lag bucket boundaries (ms). Open-ended on
 * the right via the implicit `+Inf` bucket the renderer adds.
 */
export const HISTOGRAM_BUCKETS_MS: ReadonlyArray<number> = [
  1, 5, 10, 50, 100, 500, 1000, 5000,
]

export interface HistogramSnapshot {
  readonly buckets: ReadonlyArray<number>
  readonly counts: ReadonlyArray<number>
  readonly sum: number
  readonly count: number
}

interface HistogramState {
  readonly buckets: ReadonlyArray<number>
  readonly counts: number[]
  sum: number
  count: number
}

const newHistogram = (
  buckets: ReadonlyArray<number> = HISTOGRAM_BUCKETS_MS
): HistogramState => ({
  buckets,
  counts: new Array<number>(buckets.length + 1).fill(0),
  sum: 0,
  count: 0,
})

const observeHistogram = (h: HistogramState, value: number): void => {
  let i = 0
  while (i < h.buckets.length && value > h.buckets[i]!) i++
  h.counts[i] = (h.counts[i] ?? 0) + 1
  h.sum += value
  h.count++
}

const snapshotHistogram = (h: HistogramState): HistogramSnapshot => ({
  buckets: h.buckets,
  counts: h.counts.slice(),
  sum: h.sum,
  count: h.count,
})

// ---------------------------------------------------------------------------
// State shape (consumed by StatusServer.renderPrometheus)
// ---------------------------------------------------------------------------

export interface ReplMetricsPeerState {
  readonly writesTotal: number
  readonly seqMax: number
  /** Last value of `latestSeenSeq − lastAppliedSeq` recorded for this peer. */
  readonly lagSeq: number
  /** Last queue-depth value sampled for this peer. */
  readonly queueDepth: number
  readonly frameLag: HistogramSnapshot
}

export interface ReplMetricsSnapshot {
  readonly owner: string
  readonly writerEpoch: number
  readonly perPeer: ReadonlyArray<readonly [string, ReplMetricsPeerState]>
}

export interface ReplMetricsApi {
  readonly snapshot: Effect.Effect<ReplMetricsSnapshot>
  /**
   * Slice A. ReplPuller publishes the highest seq seen on the wire for
   * peer (BEFORE the idempotency skip) so the lag-seq gauge reflects
   * "frames witnessed but not yet applied".
   */
  readonly recordSeen: (peer: string, seq: number) => Effect.Effect<void>
  /** Slice A. ReplPuller publishes lastAppliedSeq after each successful apply. */
  readonly recordApplied: (peer: string, seq: number) => Effect.Effect<void>
  /** Slice A. Record an end-to-end frame-lag observation in milliseconds. */
  readonly recordFrameLag: (peer: string, ms: number) => Effect.Effect<void>
}

// ---------------------------------------------------------------------------
// Internal mutable per-peer cell
// ---------------------------------------------------------------------------

interface PeerCell {
  writesTotal: number
  seqMax: number
  latestSeenSeq: number
  lastAppliedSeq: number
  lagSeq: number
  queueDepth: number
  /** Ring buffer of the last 5 lag samples (for 1s aggregation logging). */
  lagSamples: number[]
  /** Ring buffer of the last 5 queue-depth samples. */
  queueSamples: number[]
  frameLag: HistogramState
}

const newCell = (): PeerCell => ({
  writesTotal: 0,
  seqMax: 0,
  latestSeenSeq: 0,
  lastAppliedSeq: 0,
  lagSeq: 0,
  queueDepth: 0,
  lagSamples: [],
  queueSamples: [],
  frameLag: newHistogram(),
})

const cellOf = (
  perPeer: MutableHashMap.MutableHashMap<string, PeerCell>,
  peer: string
): PeerCell => {
  const opt = MutableHashMap.get(perPeer, peer)
  if (Option.isSome(opt)) return opt.value
  const cell = newCell()
  MutableHashMap.set(perPeer, peer, cell)
  return cell
}

interface SampleStats {
  readonly min: number
  readonly max: number
  readonly mean: number
  readonly n: number
}

const summarize = (samples: ReadonlyArray<number>): SampleStats => {
  if (samples.length === 0) return { min: 0, max: 0, mean: 0, n: 0 }
  let min = samples[0]!
  let max = samples[0]!
  let sum = 0
  for (const v of samples) {
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  return { min, max, mean: sum / samples.length, n: samples.length }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ReplMetrics extends ServiceMap.Service<ReplMetrics, ReplMetricsApi>()(
  "@sipjsserver/replication/ReplMetrics"
) {
  static readonly layer: Layer.Layer<
    ReplMetrics,
    never,
    EpochCounter | WriteNotifier | AtomicWriter
  > = Layer.effect(
    ReplMetrics,
    Effect.gen(function* () {
      const counter = yield* EpochCounter
      const notifier = yield* WriteNotifier
      const writer = yield* AtomicWriter

      const writerEpoch = yield* counter.current.pipe(
        Effect.catchTag("EpochCounterError", (err) =>
          Effect.logWarning(
            `ReplMetrics: EpochCounter unavailable at init (${err.reason}); reporting 0`
          ).pipe(Effect.as(0))
        )
      )

      const perPeer = MutableHashMap.empty<string, PeerCell>()

      // Subscribe to writer-side notifications: bumps writes counters
      // AND seeds peer cells so the sampler fiber knows which peers to
      // probe (we only care about peers we've written to).
      const ingest = notifier.subscribe.pipe(
        Stream.runForEach((n) =>
          Effect.sync(() => {
            const cell = cellOf(perPeer, n.peer)
            cell.writesTotal += 1
            if (n.seq > cell.seqMax) cell.seqMax = n.seq
          })
        )
      )

      yield* Effect.forkScoped(ingest)

      // Sampler fiber: every 200ms, probe queue depth + recompute lag
      // for every known peer; aggregate over 5 samples (1s) into
      // structured logs and update the instant gauges.
      const sampleOnce = Effect.gen(function* () {
        const peers: string[] = []
        for (const [peer] of perPeer) peers.push(peer)
        for (const peer of peers) {
          const cell = cellOf(perPeer, peer)
          const lag = Math.max(0, cell.latestSeenSeq - cell.lastAppliedSeq)
          cell.lagSeq = lag
          cell.lagSamples.push(lag)
          const depth = yield* writer.queueDepth(peer).pipe(
            Effect.catchTag("AtomicWriterError", (err) =>
              Effect.logDebug(
                `ReplMetrics: queueDepth(${peer}) failed (${err.reason}); reporting last-known`
              ).pipe(Effect.as(cell.queueDepth))
            )
          )
          cell.queueDepth = depth
          cell.queueSamples.push(depth)
          if (cell.lagSamples.length >= 5 || cell.queueSamples.length >= 5) {
            const lagStats = summarize(cell.lagSamples)
            const queueStats = summarize(cell.queueSamples)
            cell.lagSamples = []
            cell.queueSamples = []
            yield* Effect.logInfo("repl: sampler-window", {
              peer,
              lag_seq_min: lagStats.min,
              lag_seq_max: lagStats.max,
              lag_seq_mean: lagStats.mean,
              queue_depth_min: queueStats.min,
              queue_depth_max: queueStats.max,
              queue_depth_mean: queueStats.mean,
              n: lagStats.n,
            })
          }
        }
      })

      yield* Effect.forkScoped(
        Effect.repeat(sampleOnce, Schedule.spaced(Duration.millis(200)))
      )

      const recordSeen = (peer: string, seq: number): Effect.Effect<void> =>
        Effect.sync(() => {
          const cell = cellOf(perPeer, peer)
          if (seq > cell.latestSeenSeq) cell.latestSeenSeq = seq
        })

      const recordApplied = (peer: string, seq: number): Effect.Effect<void> =>
        Effect.sync(() => {
          const cell = cellOf(perPeer, peer)
          if (seq > cell.lastAppliedSeq) cell.lastAppliedSeq = seq
        })

      const recordFrameLag = (
        peer: string,
        ms: number
      ): Effect.Effect<void> =>
        Effect.sync(() => {
          if (!Number.isFinite(ms) || ms < 0) return
          const cell = cellOf(perPeer, peer)
          observeHistogram(cell.frameLag, ms)
        })

      const snapshot: Effect.Effect<ReplMetricsSnapshot> = Effect.sync(() => {
        const out: Array<readonly [string, ReplMetricsPeerState]> = []
        for (const [peer, cell] of perPeer) {
          out.push([
            peer,
            {
              writesTotal: cell.writesTotal,
              seqMax: cell.seqMax,
              lagSeq: cell.lagSeq,
              queueDepth: cell.queueDepth,
              frameLag: snapshotHistogram(cell.frameLag),
            },
          ])
        }
        return {
          owner: counter.owner,
          writerEpoch,
          perPeer: out,
        }
      })

      return { snapshot, recordSeen, recordApplied, recordFrameLag }
    })
  )

  /**
   * Slice A. No-op metrics service for tests/fixtures that don't exercise
   * the replication observability path. Methods are no-ops; the snapshot
   * always reports an empty per-peer table.
   */
  static readonly noopLayer: Layer.Layer<ReplMetrics> = Layer.succeed(
    ReplMetrics,
    {
      snapshot: Effect.succeed({
        owner: "noop",
        writerEpoch: 0,
        perPeer: [],
      }),
      recordSeen: () => Effect.void,
      recordApplied: () => Effect.void,
      recordFrameLag: () => Effect.void,
    }
  )
}
