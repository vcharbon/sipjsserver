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
 */
export interface CallStateMetrics {
  readonly terminatingByBucket: () => TerminatingCallsByBucket
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
  /** OTel BSP queue depth / drop counters (Slice 5). */
  otelPipeline: OtelPipelineMetrics | undefined
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
    otelPipeline: undefined,
    workers: [],
    broadcastToWorkers: undefined,
    adapterErrors: {
      transient: { newCall: 0, callFailure: 0, callRefer: 0 },
      permanent: { newCall: 0, callFailure: 0, callRefer: 0 },
    },
  }))
}
