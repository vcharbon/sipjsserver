/**
 * MetricsRegistry — central holder for live metric snapshot references.
 *
 * Each subsystem (UdpTransport, OverloadController, Dispatcher) writes its
 * own plain-object metrics into the registry on layer init. The StatusServer
 * reads from the registry when serving /status and /metrics. This avoids
 * making StatusServer directly depend on every subsystem and keeps fields
 * optional for processes that don't run all subsystems (e.g. cluster main
 * only has Dispatcher metrics; workers only have OverloadController).
 */

import { Layer, ServiceMap } from "effect"
import type { UdpTransportMetrics } from "../sip/UdpTransport.js"
import type { OverloadControllerMetrics } from "../b2bua/OverloadController.js"
import type { MainToWorkerMessage, WorkerMetricsSnapshot } from "../cluster/IpcProtocol.js"

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
