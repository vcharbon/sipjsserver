/**
 * MetricsRegistry — central holder for live metric snapshot references.
 *
 * Each subsystem (UdpTransport, OverloadController) writes its own
 * plain-object metrics into the registry on layer init. The StatusServer
 * reads from the registry when serving /status and /metrics. This avoids
 * making StatusServer directly depend on every subsystem and keeps fields
 * optional for processes that don't run all subsystems.
 *
 * PR6 — the cluster module (`src/cluster/`) is retired. The IPC protocol
 * types that used to live in `src/cluster/IpcProtocol.ts` are inlined
 * here so the legacy multi-process worker plumbing (still referenced by
 * `StatusServer` via `workers` / `broadcastToWorkers`) keeps compiling
 * during the cutover. Both fields are dead code once all callers move
 * to the SIP front proxy + StatefulSet topology and can be removed in
 * a follow-up PR.
 */

import { Layer, ServiceMap } from "effect"
import type { UdpTransportMetrics } from "../sip/UdpTransport.js"
import type { OverloadControllerMetrics } from "../b2bua/OverloadController.js"
import type { TransactionLayerMetrics } from "../sip/TransactionLayer.js"

// ---------------------------------------------------------------------------
// Legacy cluster IPC types (inlined from the retired `src/cluster/IpcProtocol.ts`).
// Kept here so existing StatusServer / per-worker plumbing typechecks while the
// cluster mode is fully removed. Treat as deprecated — new code should use the
// SIP front proxy's metrics surface.
// ---------------------------------------------------------------------------

/** Raw UDP packet forwarded from the main process to a worker. */
export interface IpcInboundPacket {
  readonly type: "packet"
  readonly raw: Buffer
  readonly address: string
  readonly port: number
}

/** Shutdown signal from main to worker. */
export interface IpcShutdown {
  readonly type: "shutdown"
}

/** Trigger globalThis.gc() in the worker (requires --expose-gc). */
export interface IpcForceGc {
  readonly type: "force-gc"
}

/** Trigger v8.writeHeapSnapshot() in the worker. */
export interface IpcHeapSnapshot {
  readonly type: "heap-snapshot"
  readonly dir: string
}

/** Trigger V8 CPU profiling in the worker for a given duration. */
export interface IpcCpuProfile {
  readonly type: "cpu-profile"
  readonly dir: string
  readonly durationMs: number
}

export type MainToWorkerMessage =
  | IpcInboundPacket
  | IpcShutdown
  | IpcForceGc
  | IpcHeapSnapshot
  | IpcCpuProfile

/**
 * Snapshot of all worker-internal metrics. In the now-retired cluster
 * mode this was sent periodically from each worker; the front-proxy
 * topology replaces it with per-pod Prometheus scraping.
 */
export interface WorkerMetricsSnapshot {
  /** Active calls (gauge). */
  readonly callsConcurrent: number
  /** Total calls created since worker start (counter). */
  readonly callsTotal: number
  /** Active SIP transactions (gauge). */
  readonly transactionsActive: number
  /** Total SIP messages processed (counter). */
  readonly messagesProcessed: number
  /** Overload controller stats. */
  readonly overload: {
    readonly admitTotal: number
    readonly rejectBucketEmpty: number
    readonly rejectShedder: number
    readonly shedProbability: number
    readonly tokenBucketLevel: number
    readonly tokenBucketRatio: number
    readonly loopLagMsP95: number
    readonly routingApiP95MsNewCall: number
    readonly routingApiP95MsInDialog: number
    readonly fractionLoopLag: number
    readonly fractionActiveCalls: number
    readonly fractionInDialogQueue: number
    readonly fractionRoutingLatency: number
  }
  /** Cumulative CPU time from process.cpuUsage() (microseconds). */
  readonly cpuUsage: {
    readonly user: number
    readonly system: number
  }
  /** Process memory usage (from process.memoryUsage()). */
  readonly memory: {
    readonly rss: number
    readonly heapTotal: number
    readonly heapUsed: number
    readonly external: number
    readonly arrayBuffers: number
  }
  /** Sizes of key in-memory maps for leak detection. */
  readonly mapSizes: {
    readonly txnMap: number
    readonly callsMap: number
    readonly sipIndex: number
    readonly semaphores: number
    readonly fibersMap: number
  }
  /** GC pressure metrics. */
  readonly gc: {
    readonly totalCount: number
    readonly totalPauseMs: number
    readonly maxPauseMs: number
    readonly windowCount: number
    readonly windowPauseMs: number
    readonly lastPauseTimestamp: number
    readonly lastPauseDurationMs: number
    readonly lastPauseKind: string
  }
}

export interface DispatcherMetrics {
  queueDepth: { emergency: number; inDialog: number; normalNewCall: number }
  queueDrops: { emergency: number; inDialog: number; normalNewCall: number }
  dispatcher503Sent: number
  workerKills: number
  /** Total UDP packets dispatched to workers (counter). */
  dispatchedTotal: number
  /** Packets dropped because no Call-ID could be extracted (counter). */
  droppedNoCallIdTotal: number
}

/**
 * CallDecisionEngine adapter error counters, split by tier.
 *
 *   - transient — infra hiccup (timeout / network / http-5xx). WARN tier,
 *     the stack synthesizes a 503/terminate/sipfrag as appropriate.
 *   - permanent — adapter contract violation (http-4xx / schema / semantic /
 *     defect). ERROR tier.
 *
 * Keyed by (tier, method). `adapter` dimension is a single string (today
 * "http-reference") — we don't split the counter per adapter since only
 * one runs at a time.
 */
export interface AdapterErrorMetrics {
  transient: { newCall: number; callFailure: number; callRefer: number }
  permanent: { newCall: number; callFailure: number; callRefer: number }
}

/**
 * Buckets exposed by `b2bua_worker_terminating_calls{age_bucket}`. Age
 * is measured from the moment the call entered `terminating` (derived
 * from the safety-net `terminating_timeout` timer's fireAt minus its
 * 64-s window, falling back to `createdAt` for crash-recovered calls
 * that lack the timer entry). The `gte300s` bucket should always read
 * zero — non-zero is the canary for the stuck-`terminating` defect
 * class hardened in
 * docs/plan/endurance-stuck-terminating-and-overload-hardening.md.
 */
export interface TerminatingCallsByBucket {
  readonly lt10s: number
  readonly lt60s: number
  readonly lt300s: number
  readonly gte300s: number
}

/**
 * Optional CallState-side metrics surface. CallState assigns a getter
 * here at layer init so the Prometheus renderer (and any future
 * /debug/memory caller) reads instantaneous bucket counts without
 * round-tripping through Effect.
 *
 * `concurrentCallsCount` is the source of truth for the
 * `b2bua_active_dialogs` gauge: the size of the in-memory `callsMap`
 * (every call this worker currently owns or is acting as backup for).
 */
export interface CallStateMetrics {
  readonly terminatingByBucket: () => TerminatingCallsByBucket
  readonly concurrentCallsCount: () => number
}

/**
 * Optional TimerService surface — exposes the live count of running
 * timer fibers. Surfaced as `b2bua_worker_active_timers`.
 *
 * `handlerTimeoutTotal` counts every timer body that exceeded its
 * `timerHandlerTimeoutMs` budget. Sustained non-zero indicates a hung
 * rule chain or an outbound effect (HTTP, Redis) that does not respect
 * its own timeout. Surfaced as `b2bua_worker_timer_handler_timeouts_total`.
 */
export interface TimerServiceMetrics {
  readonly activeCount: () => number
  readonly handlerTimeoutTotal: () => number
}

/**
 * Optional SipRouter consumer surface — counters for the per-event
 * safety wrap added on top of the inbound `Stream.runForEach`. Both
 * counters should stay at zero in healthy systems.
 *
 * - `eventHandlerTimeoutTotal` — `withCall` did not return inside
 *   `eventHandlerTimeoutMs`. The first such hit identifies the event
 *   class (sip:METHOD / timer:type / internal-event topic) that hung.
 * - `forcePurgeTotal` — the safety-net `terminating_timeout` timer
 *   fired and its handler errored or hung; SipRouter ran the in-memory
 *   force-purge to remove the call without waiting for the orphan
 *   sweep.
 */
export interface SipRouterMetrics {
  readonly eventHandlerTimeoutTotal: () => number
  readonly forcePurgeTotal: () => number
  /**
   * `b2bua_stale_response_dropped_total{method, status}` — incoming
   * SIP responses that resolved to an unknown call (vanished or
   * never-existed). RFC 3261 §17.1.1.2 says these MUST be silently
   * dropped, which the SipRouter does today; this counter only
   * surfaces visibility. Sustained non-zero on a particular method
   * (typically OPTIONS keepalive) indicates the call lifecycle is
   * teardown-racing with in-flight transactions — the symptom that
   * motivated the tombstone redesign in
   * docs/plan/lets-plan-a-proper-crystalline-emerson.md.
   */
  readonly staleResponseDroppedTotal: () => Record<string, number>
  /**
   * `b2bua_zombie_timeout_total` — Timer B/F (RFC 3261 §17.1) fired on a
   * client transaction whose owning call has already been deleted.
   * Should be unreachable after TransactionLayer.cancelTxnsForCall is
   * wired into every call-eviction path; non-zero indicates an eviction
   * path that bypassed the cancel and is alert-worthy.
   */
  readonly zombieTimeoutTotal: () => number
}

/**
 * Peer-scan-bootstrap counters. Populated by the bootstrap orchestrator
 * during worker boot, surfaced for the Prometheus scrape so operators
 * can correlate pod-restart counts with bootstrap success rate. See
 * docs/plan/echo-removal-grill-me-smooth-parasol.md §5.
 *
 * `outcome` is one of `"ok"`, `"timeout"`, `"error"` — populated as the
 * per-peer attempts conclude.
 */
export interface ReplicationBootstrapMetrics {
  readonly startedTotal: () => number
  readonly completedTotal: () => Record<string, number>
  readonly entriesImportedTotal: () => Record<string, number>
  readonly durationMs: () => Record<string, ReadonlyArray<number>>
}

/**
 * Worker-readiness transition metric. Recorded exactly once per
 * worker incarnation when the ReadinessController flips `Ready=true`.
 * Consumers correlate `readyInMs` with bootstrap-duration / restored-call
 * counts to spot regressions in cold-boot time. The `reason` slot is
 * `all_caught_up` (every alive peer reached `everCaughtUp` before T_max)
 * or `t_max_timeout` (the controller flipped Ready by ceiling, with a
 * WARN log naming the un-caught peers — see ReadinessController.ts).
 */
export interface WorkerReadinessMetrics {
  readonly readyInMs: () => number | undefined
  readonly readyReason: () => "all_caught_up" | "t_max_timeout" | undefined
}

/**
 * Optional OTel pipeline surface — populated by the BSP wrapper
 * introduced in Slice 5. Holds queue-depth and drop counters that
 * the upstream `BatchSpanProcessor` does not expose publicly.
 */
export interface OtelPipelineMetrics {
  readonly bspQueueDepth: () => number
  readonly bspQueueCapacity: number
  readonly bspDroppedTotal: () => number
  readonly tracerDisabledTotal: () => Record<string, number>
}

/**
 * Periodic Redis SCAN-derived call-key counts. Refreshed on a
 * background fiber so the SIP hot path never pays a SCAN.
 *
 *   - `nominalCount` is the number of `pri:{self}:call:*` keys the
 *     worker currently owns as primary.
 *   - `backupCountsByPrimary` is `{ [primary]: count }` for every
 *     `bak:{primary}:call:*` partition this worker is holding on
 *     behalf of another pod.
 *   - `lastScanTimestampMs` is the wall-clock at which the snapshot
 *     was last refreshed (0 if no scan has completed yet) — operators
 *     can subtract it from `now` to see how stale the gauge is.
 */
export interface RedisCallKeyCountMetrics {
  readonly nominalCount: () => number
  readonly backupCountsByPrimary: () => Record<string, number>
  readonly lastScanTimestampMs: () => number
}

/** BufferedCdrLayer counters (Phase 3 — non-blocking CDR write). */
export interface CdrBufferMetrics {
  readonly submitDroppedTotal: () => number
  readonly queueDepth: () => number
  readonly queueCapacity: number
}

/** BufferedTerminateWriter counters (Phase 4 — terminate-path Redis I/O). */
export interface StorageBufferMetrics {
  readonly fallthroughTotal: () => number
  readonly fallthroughErrorTotal: () => number
  readonly queueDepth: () => number
  readonly queueCapacity: number
  readonly drainerCount: number
}

/**
 * CallLimiter result counters. Bumped on every `checkAndIncrement` outcome
 * so operators can distinguish "limiter saturating naturally" (rejected) from
 * "limiter Redis fell over" (redis_error / timeout). See plan
 * docs/plan/to-review-and-properly-swift-moler.md — these counters are the
 * primary in-cluster verification signal for the limiter-Redis cascade fix.
 */
export interface CallLimiterMetrics {
  /** Successful INCR — call admitted under cap. */
  readonly allowedTotal: () => number
  /** Cap-hit — call rejected; not a backend error. */
  readonly rejectedTotal: () => number
  /** ioredis surfaced a RedisError within commandTimeout (fail-open admission). */
  readonly redisErrorTotal: () => number
  /** Outer Effect-level safety net fired (fail-open admission). */
  readonly timeoutTotal: () => number
}

/** PerCallDispatcher gauges + counters (ADR-0004). */
export interface DispatchMetrics {
  /** Current number of per-call queues, by partition label ("primary" or "backup"). */
  readonly queueCounts: () => { primary: number; backup: number }
  /** Cumulative queues created since boot, by reason. */
  readonly creationsTotal: () => { boot: number; lazy: number; failover: number }
  /** Cumulative queues removed since boot, by reason. */
  readonly removalsTotal: () => { terminate: number; reaper: number }
  /** Lazy-creation attempts refused because the per-call queue cap was reached. */
  readonly capDropsTotal: () => number
  /** Events dropped at offer time because a per-call queue was full. */
  readonly queueDropsTotal: () => number
  /** Handlers currently in flight, by partition. */
  readonly inFlight: () => { primary: number; backup: number }
  /** Times the global concurrency cap blocked a worker from running. */
  readonly saturationTotal: () => number
  /** Configured global concurrency cap. */
  readonly concurrencyCap: number
  /** Configured per-call queue cap. */
  readonly queueCap: number
}

export interface MetricsRegistryState {
  udp: UdpTransportMetrics | undefined
  overload: OverloadControllerMetrics | undefined
  dispatcher: DispatcherMetrics | undefined
  /** Inbound TransactionLayer event queue + drop counters (Slice 2). */
  transactionLayer: TransactionLayerMetrics | undefined
  /** Live count of timer fibers (Slice 4 — TimerService.activeCountSync). */
  timers: TimerServiceMetrics | undefined
  /** Live `terminating`-state bucket counts (Slice 4 canary for stuck calls). */
  callState: CallStateMetrics | undefined
  /** SipRouter consumer-loop safety counters (Slice 1.4/event-timeout). */
  sipRouter: SipRouterMetrics | undefined
  /** Peer-scan-bootstrap success / failure / duration counters. */
  replicationBootstrap: ReplicationBootstrapMetrics | undefined
  /** Worker-readiness transition (ms from boot to Ready, with reason). */
  workerReadiness: WorkerReadinessMetrics | undefined
  /** OTel BSP queue depth / drop counters (Slice 5). */
  otelPipeline: OtelPipelineMetrics | undefined
  /** BufferedCdrLayer queue depth + drop counters (Phase 3). */
  cdrBuffer: CdrBufferMetrics | undefined
  /** BufferedTerminateWriter queue depth + fallthrough counters (Phase 4). */
  storageBuffer: StorageBufferMetrics | undefined
  /** PerCallDispatcher gauges + counters (ADR-0004). */
  dispatch: DispatchMetrics | undefined
  /** CallLimiter per-result counters (allowed / rejected / redis_error / timeout). */
  callLimiter: CallLimiterMetrics | undefined
  /** Periodic-SCAN-derived nominal/backup call-key counts. */
  redisCallKeyCounts: RedisCallKeyCountMetrics | undefined
  /** Per-worker metrics snapshots, indexed by worker index. */
  workers: WorkerMetricsSnapshot[]
  /** Broadcast an IPC message to all workers (set by Dispatcher in cluster mode). */
  broadcastToWorkers: ((msg: MainToWorkerMessage) => void) | undefined
  /** CallDecisionEngine adapter error counters (dual-tier). */
  adapterErrors: AdapterErrorMetrics
}

export class MetricsRegistry extends ServiceMap.Service<MetricsRegistry, MetricsRegistryState>()(
  "@sipjsserver/MetricsRegistry"
) {
  static readonly layer: Layer.Layer<MetricsRegistry> = Layer.sync(MetricsRegistry, () => ({
    udp: undefined,
    overload: undefined,
    dispatcher: undefined,
    transactionLayer: undefined,
    timers: undefined,
    callState: undefined,
    sipRouter: undefined,
    replicationBootstrap: undefined,
    workerReadiness: undefined,
    otelPipeline: undefined,
    cdrBuffer: undefined,
    storageBuffer: undefined,
    dispatch: undefined,
    callLimiter: undefined,
    redisCallKeyCounts: undefined,
    workers: [],
    broadcastToWorkers: undefined,
    adapterErrors: {
      transient: { newCall: 0, callFailure: 0, callRefer: 0 },
      permanent: { newCall: 0, callFailure: 0, callRefer: 0 },
    },
  }))
}
