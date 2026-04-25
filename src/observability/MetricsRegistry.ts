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

export interface MetricsRegistryState {
  udp: UdpTransportMetrics | undefined
  overload: OverloadControllerMetrics | undefined
  dispatcher: DispatcherMetrics | undefined
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
    workers: [],
    broadcastToWorkers: undefined,
    adapterErrors: {
      transient: { newCall: 0, callFailure: 0, callRefer: 0 },
      permanent: { newCall: 0, callFailure: 0, callRefer: 0 },
    },
  }))
}
