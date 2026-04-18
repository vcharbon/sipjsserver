/**
 * WorkerConfig — per-worker configuration provided by the dispatcher.
 *
 * The workerIndex and totalWorkers are set via environment variables
 * by the dispatcher when spawning child processes.
 */

import { Layer, ServiceMap } from "effect"

export interface WorkerConfigData {
  readonly workerIndex: number
  readonly totalWorkers: number
}

export class WorkerConfig extends ServiceMap.Service<
  WorkerConfig,
  WorkerConfigData
>()("@sipjsserver/WorkerConfig") {
  static readonly layer = Layer.sync(WorkerConfig, () => ({
    workerIndex: parseInt(process.env.WORKER_INDEX ?? "0", 10),
    totalWorkers: parseInt(process.env.TOTAL_WORKERS ?? "1", 10)
  }))
}
