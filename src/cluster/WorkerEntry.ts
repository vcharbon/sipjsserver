/**
 * WorkerEntry — child process entry point for cluster mode.
 *
 * Each worker runs the full SIP processing stack (Parser, TransactionLayer,
 * SipRouter, handlers, CallState, TimerService, etc.) with IPC-backed
 * transport instead of a real UDP socket.
 *
 * On startup, the worker:
 * 1. Loads owned calls from Redis (by workerIndex)
 * 2. Restores timers from serialized entries
 * 3. Signals "ready" to the dispatcher
 * 4. Starts consuming the TransactionEvent stream
 */

import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, LogLevel, References } from "effect"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { SipRouter } from "../sip/SipRouter.js"
import { TransactionLayer } from "../sip/TransactionLayer.js"
import { AppConfig } from "../config/AppConfig.js"
import { CallState } from "../call/CallState.js"
import { CallStateCache } from "../call/CallStateCache.js"
import { CallLimiter } from "../call/CallLimiter.js"
import { TimerService } from "../call/TimerService.js"
import { CdrWriter } from "../cdr/CdrWriter.js"
import { RedisClient } from "../redis/RedisClient.js"
import { CallControlClient } from "../http/CallControlClient.js"
import { TracingService } from "../tracing/TracingService.js"
import { FetchHttpClient } from "effect/unstable/http"
import { handlers, B2buaCoreLayer } from "../b2bua/B2buaCore.js"
import { IpcTransportLayer } from "./IpcTransport.js"
import { OverloadController } from "../b2bua/OverloadController.js"
import { MetricsRegistry } from "../observability/MetricsRegistry.js"
import { WorkerConfig } from "./WorkerConfig.js"
import { writeHeapSnapshot } from "node:v8"
import { join as pathJoin } from "node:path"
import { writeFileSync } from "node:fs"
import type { WorkerToMainMessage, WorkerMetricsSnapshot, MainToWorkerMessage } from "./IpcProtocol.js"

// ---------------------------------------------------------------------------
// Environment-specific layers (IPC transport instead of UDP)
// ---------------------------------------------------------------------------

const AppConfigLayer = AppConfig.layer
const WorkerConfigLayer = WorkerConfig.layer
const MetricsRegistryLayer = MetricsRegistry.layer

const RedisLayer = RedisClient.layer.pipe(
  Layer.provide(AppConfigLayer)
)

const CallLimiterLayer = CallLimiter.layer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(RedisLayer)
)

const CallStateCacheLayer = CallStateCache.redisLayer.pipe(
  Layer.provide(RedisLayer)
)

const CdrLayer = CdrWriter.layer.pipe(
  Layer.provide(AppConfigLayer)
)

const OverloadControllerLayer = OverloadController.layer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(MetricsRegistryLayer)
)

const CallControlLayer = CallControlClient.layer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(OverloadControllerLayer)
)

const TracingLayer = TracingService.layer.pipe(
  Layer.provide(AppConfigLayer)
)

const OtelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const workerCfg = yield* WorkerConfig
    return NodeSdk.layer(() => ({
      resource: {
        serviceName: "sip-b2bua",
        serviceVersion: "0.1.0",
        "worker.index": workerCfg.workerIndex
      },
      spanProcessor: new BatchSpanProcessor(
        new OTLPTraceExporter({ url: config.otelTracesUrl })
      ),
      tracerConfig: {
        spanLimits: { attributeValueLengthLimit: config.otelMaxAttributeValueLength }
      }
    }))
  })
).pipe(Layer.provide(AppConfigLayer), Layer.provide(WorkerConfigLayer))

// ---------------------------------------------------------------------------
// Composed B2BUA layer (core + environment deps)
// ---------------------------------------------------------------------------

const SipLayer = B2buaCoreLayer.pipe(
  Layer.provide(AppConfigLayer),
  Layer.provide(IpcTransportLayer),
  Layer.provide(OverloadControllerLayer),
  Layer.provide(CallStateCacheLayer),
  Layer.provide(CallLimiterLayer),
  Layer.provide(CallControlLayer),
  Layer.provide(TracingLayer),
  Layer.provide(CdrLayer),
)

// ---------------------------------------------------------------------------
// Worker main
// ---------------------------------------------------------------------------

const workerMain = Effect.gen(function* () {
  const workerCfg = yield* WorkerConfig
  const workerIdx = workerCfg.workerIndex

  process.title = `sipb2bua-worker-${workerIdx}`

  // Swallow IPC EPIPE errors during shutdown (dispatcher closes channel before workers exit)
  process.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" || err.code === "ERR_IPC_CHANNEL_CLOSED") return
    console.error(`[worker-${workerIdx}] Unhandled process error:`, err)
  })

  yield* Effect.logInfo(`Worker ${workerIdx} starting`)

  // Load owned calls from Redis (crash recovery)
  const callState = yield* CallState
  const timers = yield* TimerService
  const ownedCalls = yield* callState.loadOwnedCalls(workerIdx).pipe(
    Effect.catchTag("RedisError", (e) => {
      return Effect.logError(`Failed to load owned calls from Redis: ${e.reason}`).pipe(
        Effect.as([] as ReadonlyArray<import("../call/CallModel.js").Call>)
      )
    })
  )

  // Restore timers for recovered calls
  const router = yield* SipRouter
  for (const call of ownedCalls) {
    if (call.timers.length > 0) {
      yield* timers.restoreFromEntries(call.callRef, call.timers, (callRef, timerType, legId) =>
        // Timer fires are processed via the router's withCall wrapper.
        // For now, log and let the next SIP message for the call handle state.
        Effect.logInfo(`Restored timer fired: ${timerType} for call ${callRef} leg=${legId ?? "call-level"}`)
      )
      yield* Effect.logDebug(`Restored ${call.timers.length} timers for call ${call.callRef}`)
    }
  }

  // Access services for metrics reporting
  const txnLayer = yield* TransactionLayer
  const overloadCtrl = yield* OverloadController

  // Signal ready to dispatcher
  const readyMsg: WorkerToMainMessage = { type: "ready" }
  if (process.send) {
    process.send(readyMsg)
  }

  // ── Periodic metrics reporting to dispatcher ────────────────────
  // Uses raw setInterval (not Effect.sleep) so TestClock doesn't block it.
  const metricsInterval = setInterval(() => {
    if (!process.send || !process.connected) return
    const stats = callState.statsSync()
    const ol = overloadCtrl.metrics
    const gc = ol.gc
    const memUsage = process.memoryUsage()
    const cpuUsg = process.cpuUsage()
    const snapshot: WorkerMetricsSnapshot = {
      callsConcurrent: stats.concurrent,
      callsTotal: stats.total,
      transactionsActive: txnLayer.metrics.activeTransactions(),
      messagesProcessed: txnLayer.metrics.messagesProcessed,
      cpuUsage: {
        user: cpuUsg.user,
        system: cpuUsg.system,
      },
      memory: {
        rss: memUsage.rss,
        heapTotal: memUsage.heapTotal,
        heapUsed: memUsage.heapUsed,
        external: memUsage.external,
        arrayBuffers: memUsage.arrayBuffers,
      },
      mapSizes: {
        txnMap: txnLayer.metrics.activeTransactions(),
        callsMap: stats.concurrent,
        sipIndex: stats.sipIndexSize,
        semaphores: stats.semaphoresSize,
        fibersMap: timers.activeCountSync(),
      },
      overload: {
        admitTotal: ol.admitTotal,
        rejectBucketEmpty: ol.rejectTotal.bucket_empty,
        rejectShedder: ol.rejectTotal.shedder,
        shedProbability: ol.shedProbability,
        tokenBucketLevel: ol.tokenBucketLevel,
        tokenBucketRatio: ol.tokenBucketRatio,
        loopLagMsP95: ol.loopLagMsP95,
        routingApiP95MsNewCall: ol.routingApiP95Ms.new_call,
        routingApiP95MsInDialog: ol.routingApiP95Ms.in_dialog,
        fractionLoopLag: ol.fractionLoopLag,
        fractionActiveCalls: ol.fractionActiveCalls,
        fractionInDialogQueue: ol.fractionInDialogQueue,
        fractionRoutingLatency: ol.fractionRoutingLatency,
      },
      gc: {
        totalCount: gc.totalCount,
        totalPauseMs: gc.totalPauseMs,
        maxPauseMs: gc.maxPauseMs,
        windowCount: gc.windowCount,
        windowPauseMs: gc.windowPauseMs,
        lastPauseTimestamp: gc.lastPauseTimestamp,
        lastPauseDurationMs: gc.lastPauseDurationMs,
        lastPauseKind: gc.lastPauseKind,
      },
    }
    // Reset window counters after snapshot so next report covers only the
    // interval since last report (typically 1s).
    gc.windowCount = 0
    gc.windowPauseMs = 0
    gc.maxPauseMs = 0
    const msg: WorkerToMainMessage = { type: "metrics", data: snapshot }
    try { process.send(msg) } catch { /* channel closed during shutdown */ }
  }, 1000)
  metricsInterval.unref()

  // ── Debug IPC handlers (force-gc, heap-snapshot) ────────────────
  process.on("message", (msg: MainToWorkerMessage) => {
    if (msg.type === "force-gc") {
      if (typeof globalThis.gc === "function") {
        globalThis.gc()
        console.log(`[worker-${workerIdx}] Manual GC triggered via IPC`)
      }
    } else if (msg.type === "heap-snapshot") {
      try {
        const file = writeHeapSnapshot(
          pathJoin(msg.dir, `heap-worker-${workerIdx}-${Date.now()}.heapsnapshot`)
        )
        console.log(`[worker-${workerIdx}] Heap snapshot written: ${file}`)
      } catch (err) {
        console.error(`[worker-${workerIdx}] Failed to write heap snapshot:`, err)
      }
    } else if (msg.type === "cpu-profile") {
      const { dir, durationMs } = msg
      ;(async () => {
        try {
          const { Session } = await import("node:inspector/promises")
          const session = new Session()
          session.connect()
          await session.post("Profiler.enable")
          await session.post("Profiler.start")
          console.log(`[worker-${workerIdx}] CPU profiling started (${durationMs}ms)`)
          await new Promise<void>(r => setTimeout(r, durationMs))
          const { profile } = await session.post("Profiler.stop")
          await session.post("Profiler.disable")
          session.disconnect()
          const file = pathJoin(dir, `cpu-worker-${workerIdx}-${Date.now()}.cpuprofile`)
          writeFileSync(file, JSON.stringify(profile))
          console.log(`[worker-${workerIdx}] CPU profile written: ${file}`)
        } catch (err) {
          console.error(`[worker-${workerIdx}] CPU profile failed:`, err)
        }
      })()
    }
  })

  // Handle graceful shutdown signal
  yield* Effect.forkDetach(
    Effect.callback<void>((resume) => {
      const onMsg = (msg: MainToWorkerMessage) => {
        if (msg.type === "shutdown") {
          process.removeListener("message", onMsg)
          resume(Effect.void)
        }
      }
      process.on("message", onMsg)
    }).pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          yield* Effect.logInfo(`Worker ${workerIdx} received shutdown — flushing all calls`)
          yield* callState.flushAllCalls().pipe(
            Effect.catchTag("RedisError", (e) =>
              Effect.logError(`Failed to flush calls on shutdown: ${e.reason}`)
            )
          )
          const drainedMsg: WorkerToMainMessage = { type: "drained" }
          if (process.send) {
            process.send(drainedMsg)
          }
          yield* Effect.logInfo(`Worker ${workerIdx} drained — exiting`)
          process.exit(0)
        })
      )
    )
  )

  yield* Effect.logInfo(`Worker ${workerIdx} ready — consuming events`)

  // Run SipRouter — blocks forever consuming TransactionEvent stream
  return yield* router.start(handlers)
}).pipe(
  Effect.provide(
    SipLayer.pipe(
      Layer.provideMerge(Layer.mergeAll(
        AppConfigLayer, WorkerConfigLayer, OverloadControllerLayer
      )),
      Layer.provideMerge(OtelLayer),
      Layer.provide(RedisLayer)
    )
  )
)

// ---------------------------------------------------------------------------
// Log level from env
// ---------------------------------------------------------------------------

const validLogLevels = new Set(["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"])

const logLevelFromEnv = (): LogLevel.LogLevel => {
  const raw = process.env.EFFECT_LOG_LEVEL ?? "Info"
  const normalised = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
  return validLogLevels.has(normalised) ? (normalised as LogLevel.LogLevel) : "Info"
}

NodeRuntime.runMain(
  workerMain.pipe(Effect.provideService(References.MinimumLogLevel, logLevelFromEnv()))
)
