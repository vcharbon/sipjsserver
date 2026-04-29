/**
 * ReplMetrics — Prometheus signal aggregator for the replication path.
 *
 * Exposes counters/gauges derived from the production-wired primitives
 * (`WriteNotifier`, `EpochCounter`). Per-peer pull-side metrics
 * (replpos lag, drained-frames-total, ReadyGate unreconciled count)
 * are deliberately NOT here: they require the boot-time client wiring
 * (`ReplPuller` redis layer + HTTP-backed `ReplogClient` + `ReadyGate`
 * at boot) which has not landed in production yet — see
 * `docs/todos/DATA-REPLICATION-LAYER-REFACTOR-SURPRISES.md` P1.
 *
 * What's wired today:
 *   - `b2bua_repl_writer_epoch{owner}` — gauge. Current local epoch
 *     for this worker's writer (read once at layer init from
 *     `EpochCounter.current`; never changes within a process).
 *   - `b2bua_repl_writes_total{peer}` — counter. Number of
 *     peer-bearing writes published on `WriteNotifier` since process
 *     start, partitioned by peer ordinal.
 *   - `b2bua_repl_writes_seq_max{peer}` — gauge. Highest `seq`
 *     observed for this peer in any published notification (a
 *     monotonic stamp matching the local `propagate_seq:{peer}`
 *     counter).
 *
 * Implementation: a scoped fiber subscribes to `WriteNotifier` and
 * accumulates per-peer counters in a `MutableHashMap`. Sliding-PubSub
 * backpressure means a slow subscriber would drop events — but
 * `MutableRef.update` is a few-nanosecond op, so the metrics fiber is
 * effectively never the slow consumer.
 */

import {
  Effect,
  Layer,
  MutableHashMap,
  Option,
  ServiceMap,
  Stream,
} from "effect"
import { EpochCounter } from "./EpochCounter.js"
import { WriteNotifier } from "./WriteNotifier.js"

// ---------------------------------------------------------------------------
// State shape (consumed by StatusServer.renderPrometheus)
// ---------------------------------------------------------------------------

export interface ReplMetricsPeerState {
  readonly writesTotal: number
  readonly seqMax: number
}

export interface ReplMetricsSnapshot {
  readonly owner: string
  readonly writerEpoch: number
  readonly perPeer: ReadonlyArray<readonly [string, ReplMetricsPeerState]>
}

export interface ReplMetricsApi {
  readonly snapshot: Effect.Effect<ReplMetricsSnapshot>
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
    EpochCounter | WriteNotifier
  > = Layer.effect(
    ReplMetrics,
    Effect.gen(function* () {
      const counter = yield* EpochCounter
      const notifier = yield* WriteNotifier

      const writerEpoch = yield* counter.current.pipe(
        Effect.catchTag("EpochCounterError", (err) =>
          Effect.logWarning(
            `ReplMetrics: EpochCounter unavailable at init (${err.reason}); reporting 0`
          ).pipe(Effect.as(0))
        )
      )

      const perPeer = MutableHashMap.empty<string, ReplMetricsPeerState>()

      const ingest = notifier.subscribe.pipe(
        Stream.runForEach((n) =>
          Effect.sync(() => {
            const opt = MutableHashMap.get(perPeer, n.peer)
            if (Option.isNone(opt)) {
              MutableHashMap.set(perPeer, n.peer, {
                writesTotal: 1,
                seqMax: n.seq,
              })
              return
            }
            const prev = opt.value
            MutableHashMap.set(perPeer, n.peer, {
              writesTotal: prev.writesTotal + 1,
              seqMax: n.seq > prev.seqMax ? n.seq : prev.seqMax,
            })
          })
        )
      )

      yield* Effect.forkScoped(ingest)

      return {
        snapshot: Effect.sync(() => ({
          owner: counter.owner,
          writerEpoch,
          perPeer: Array.from(perPeer),
        })),
      }
    })
  )
}
