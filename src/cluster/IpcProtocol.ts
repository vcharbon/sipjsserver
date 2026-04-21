/**
 * IPC message protocol between the main (dispatcher) process and worker
 * child processes.
 *
 * Messages are exchanged via Node.js child_process IPC (`process.send` /
 * `process.on("message")`) with `serialization: "advanced"` so Buffers
 * travel as-is without a base64 round-trip.
 */

// ---------------------------------------------------------------------------
// Main → Worker messages
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

export type MainToWorkerMessage = IpcInboundPacket | IpcShutdown | IpcForceGc | IpcHeapSnapshot | IpcCpuProfile

// ---------------------------------------------------------------------------
// Worker → Main messages
// ---------------------------------------------------------------------------

/** Outbound UDP packet from worker to be sent by the main process. */
export interface IpcOutboundPacket {
  readonly type: "send"
  readonly raw: Buffer
  readonly address: string
  readonly port: number
}

/** Worker is ready to receive traffic. */
export interface IpcReady {
  readonly type: "ready"
}

/** Worker has finished draining and flushing (graceful shutdown complete). */
export interface IpcDrained {
  readonly type: "drained"
}

/** Periodic metrics snapshot from worker → dispatcher. */
export interface IpcMetrics {
  readonly type: "metrics"
  readonly data: WorkerMetricsSnapshot
}

/**
 * Snapshot of all worker-internal metrics. Sent periodically to the dispatcher
 * so it can expose per-worker and aggregate stats on /metrics and /status.
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

export type WorkerToMainMessage = IpcOutboundPacket | IpcReady | IpcDrained | IpcMetrics
