/**
 * HTTP server exposing B2BUA runtime stats and call control API.
 */

import { NodeHttpServer } from "@effect/platform-node"
import { Clock, Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { writeHeapSnapshot } from "node:v8"
import { CallState } from "../call/CallState.js"
import { AppConfig } from "../config/AppConfig.js"
import { addCallControlRoutes } from "../decision/adapters/http-reference/MockServer.js"
import { MetricsRegistry, type MetricsRegistryState } from "../observability/MetricsRegistry.js"


/** Start a V8 CPU profile in the current process, write to dir after durationMs. */
function profileProcess(dir: string, durationMs: number, label: string): void {
  ;(async () => {
    try {
      const { Session } = await import("node:inspector/promises")
      const session = new Session()
      session.connect()
      await session.post("Profiler.enable")
      await session.post("Profiler.start")
      await new Promise<void>(r => setTimeout(r, durationMs))
      const { profile } = await session.post("Profiler.stop")
      await session.post("Profiler.disable")
      session.disconnect()
      const file = `${dir}/cpu-${label}-${process.pid}-${Date.now()}.cpuprofile`
      writeFileSync(file, JSON.stringify(profile))
      console.log(`[${label}] CPU profile written: ${file}`)
    } catch (err) {
      console.error(`[${label}] CPU profile failed:`, err)
    }
  })()
}

function buildStatusBlocks(registry: MetricsRegistryState) {
  const overload = {
    udp: registry.udp
      ? {
          queue_depth: registry.udp.queueDepth,
          queue_max: registry.udp.queueMax,
          drops_total: {
            tier1_brake: registry.udp.dropsTier1Brake,
            tail_drop: registry.udp.dropsTailDrop,
          },
          tier1_503_sent_total: registry.udp.tier1RejectSent,
        }
      : null,
    dispatcher: registry.dispatcher
      ? {
          packets_dispatched_total: registry.dispatcher.dispatchedTotal,
          dropped_no_callid_total: registry.dispatcher.droppedNoCallIdTotal,
          queue_depth: registry.dispatcher.queueDepth,
          queue_drops_total: registry.dispatcher.queueDrops,
          dispatcher_503_sent_total: registry.dispatcher.dispatcher503Sent,
          kill_total: registry.dispatcher.workerKills,
        }
      : null,
    tier3: registry.overload
      ? {
          admit_total: registry.overload.admitTotal,
          reject_total: registry.overload.rejectTotal,
          shed_probability: registry.overload.shedProbability,
          token_bucket_level: registry.overload.tokenBucketLevel,
          loop_lag_ms_p95: registry.overload.loopLagMsP95,
          routing_api_p95_ms: registry.overload.routingApiP95Ms,
        }
      : null,
  }

  const workers = registry.workers
    .map((w, i) =>
      w === undefined
        ? { worker: i, status: "no_data" as const }
        : {
            worker: i,
            status: "ok" as const,
            calls_concurrent: w.callsConcurrent,
            calls_total: w.callsTotal,
            transactions_active: w.transactionsActive,
            messages_processed: w.messagesProcessed,
            overload: {
              admit_total: w.overload.admitTotal,
              reject_total: { bucket_empty: w.overload.rejectBucketEmpty, shedder: w.overload.rejectShedder },
              shed_probability: w.overload.shedProbability,
              token_bucket_level: w.overload.tokenBucketLevel,
              loop_lag_ms_p95: w.overload.loopLagMsP95,
              routing_api_p95_ms: { new_call: w.overload.routingApiP95MsNewCall, in_dialog: w.overload.routingApiP95MsInDialog },
            },
          }
    )

  return { overload, workers }
}

function renderPrometheus(reg: MetricsRegistryState): string {
  const lines: string[] = []

  /** Emit a single metric line with optional labels. */
  const m = (name: string, value: number, labels?: Record<string, string>) => {
    const labelStr = labels
      ? "{" + Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",") + "}"
      : ""
    lines.push(`${name}${labelStr} ${value}`)
  }

  /** Emit # HELP and # TYPE header for a metric family. */
  const header = (name: string, type: "counter" | "gauge", help: string) => {
    lines.push(`# HELP ${name} ${help}`)
    lines.push(`# TYPE ${name} ${type}`)
  }

  // ── Dispatcher metrics ────────────────────────────────────────────
  if (reg.dispatcher) {
    header("b2bua_dispatcher_packets_total", "counter", "Total UDP packets dispatched to workers.")
    m("b2bua_dispatcher_packets_total", reg.dispatcher.dispatchedTotal)

    header("b2bua_dispatcher_dropped_no_callid_total", "counter", "Packets dropped because no Call-ID could be extracted.")
    m("b2bua_dispatcher_dropped_no_callid_total", reg.dispatcher.droppedNoCallIdTotal)

    header("b2bua_dispatcher_503_sent_total", "counter", "Stateless 503 responses sent by the dispatcher.")
    m("b2bua_dispatcher_503_sent_total", reg.dispatcher.dispatcher503Sent)

    header("b2bua_dispatcher_worker_kill_total", "counter", "Workers killed due to stuck inDialog-full queues.")
    m("b2bua_dispatcher_worker_kill_total", reg.dispatcher.workerKills)

    header("b2bua_dispatcher_queue_depth", "gauge", "Current per-class dispatcher queue depth across all workers.")
    m("b2bua_dispatcher_queue_depth", reg.dispatcher.queueDepth.emergency, { class: "emergency" })
    m("b2bua_dispatcher_queue_depth", reg.dispatcher.queueDepth.inDialog, { class: "in_dialog" })
    m("b2bua_dispatcher_queue_depth", reg.dispatcher.queueDepth.normalNewCall, { class: "new_call" })

    header("b2bua_dispatcher_queue_drops_total", "counter", "Packets dropped from dispatcher per-worker queues.")
    m("b2bua_dispatcher_queue_drops_total", reg.dispatcher.queueDrops.emergency, { class: "emergency" })
    m("b2bua_dispatcher_queue_drops_total", reg.dispatcher.queueDrops.inDialog, { class: "in_dialog" })
    m("b2bua_dispatcher_queue_drops_total", reg.dispatcher.queueDrops.normalNewCall, { class: "new_call" })
  }

  // ── UDP transport metrics (standalone mode) ───────────────────────
  if (reg.udp) {
    header("b2bua_udp_queue_depth", "gauge", "Current UDP receive queue depth.")
    m("b2bua_udp_queue_depth", reg.udp.queueDepth)

    header("b2bua_udp_queue_max", "gauge", "Maximum UDP receive queue capacity.")
    m("b2bua_udp_queue_max", reg.udp.queueMax)

    header("b2bua_udp_drops_total", "counter", "UDP packets dropped at the transport layer.")
    m("b2bua_udp_drops_total", reg.udp.dropsTier1Brake, { reason: "tier1_brake" })
    m("b2bua_udp_drops_total", reg.udp.dropsTailDrop, { reason: "tail_drop" })

    header("b2bua_udp_tier1_503_sent_total", "counter", "Stateless 503 responses sent by the UDP tier-1 brake.")
    m("b2bua_udp_tier1_503_sent_total", reg.udp.tier1RejectSent)
  }

  // ── Standalone overload controller metrics ────────────────────────
  if (reg.overload) {
    header("b2bua_overload_admit_total", "counter", "Calls admitted by the overload controller.")
    m("b2bua_overload_admit_total", reg.overload.admitTotal)

    header("b2bua_overload_reject_total", "counter", "Calls rejected by the overload controller.")
    m("b2bua_overload_reject_total", reg.overload.rejectTotal.bucket_empty, { reason: "bucket_empty" })
    m("b2bua_overload_reject_total", reg.overload.rejectTotal.shedder, { reason: "shedder" })

    header("b2bua_overload_shed_probability", "gauge", "Current adaptive shedding probability (0.0-1.0).")
    m("b2bua_overload_shed_probability", reg.overload.shedProbability)

    header("b2bua_overload_token_bucket_level", "gauge", "Current token bucket fill level.")
    m("b2bua_overload_token_bucket_level", reg.overload.tokenBucketLevel)

    header("b2bua_overload_token_bucket_ratio", "gauge", "Token bucket fill ratio (0.0-1.0).")
    m("b2bua_overload_token_bucket_ratio", reg.overload.tokenBucketRatio)

    header("b2bua_loop_lag_ms_p95", "gauge", "Event loop lag p95 estimate in milliseconds.")
    m("b2bua_loop_lag_ms_p95", reg.overload.loopLagMsP95)

    header("b2bua_routing_api_latency_p95_ms", "gauge", "Routing API latency p95 in milliseconds.")
    m("b2bua_routing_api_latency_p95_ms", reg.overload.routingApiP95Ms.new_call, { stage: "new_call" })
    m("b2bua_routing_api_latency_p95_ms", reg.overload.routingApiP95Ms.in_dialog, { stage: "in_dialog" })

    header("b2bua_overload_fraction", "gauge", "Per-signal shedding fraction (0.0-1.0).")
    m("b2bua_overload_fraction", reg.overload.fractionLoopLag, { signal: "loop_lag" })
    m("b2bua_overload_fraction", reg.overload.fractionActiveCalls, { signal: "active_calls" })
    m("b2bua_overload_fraction", reg.overload.fractionInDialogQueue, { signal: "in_dialog_queue" })
    m("b2bua_overload_fraction", reg.overload.fractionRoutingLatency, { signal: "routing_latency" })

    // GC pressure metrics (standalone mode)
    header("b2bua_gc_pauses_total", "counter", "Total GC pauses since process start.")
    m("b2bua_gc_pauses_total", reg.overload.gc.totalCount)

    header("b2bua_gc_pause_seconds_total", "counter", "Total GC pause time in seconds since process start.")
    m("b2bua_gc_pause_seconds_total", reg.overload.gc.totalPauseMs / 1000)

    header("b2bua_gc_pause_max_seconds", "gauge", "Max GC pause in seconds within the last reporting window.")
    m("b2bua_gc_pause_max_seconds", reg.overload.gc.maxPauseMs / 1000)

    header("b2bua_gc_window_pauses", "gauge", "GC pauses within the last reporting window.")
    m("b2bua_gc_window_pauses", reg.overload.gc.windowCount)

    header("b2bua_gc_window_pause_seconds", "gauge", "Total GC pause time in seconds within the last reporting window.")
    m("b2bua_gc_window_pause_seconds", reg.overload.gc.windowPauseMs / 1000)

    header("b2bua_gc_last_pause_timestamp_seconds", "gauge", "Unix timestamp of the most recent GC pause.")
    m("b2bua_gc_last_pause_timestamp_seconds", reg.overload.gc.lastPauseTimestamp / 1000)

    header("b2bua_gc_last_pause_duration_seconds", "gauge", "Duration of the most recent GC pause in seconds.")
    m("b2bua_gc_last_pause_duration_seconds", reg.overload.gc.lastPauseDurationMs / 1000)
  }

  // ── Per-worker metrics ────────────────────────────────────────────
  if (reg.workers.length > 0 && reg.workers.some((w) => w !== undefined)) {
    header("b2bua_worker_calls_concurrent", "gauge", "Current concurrent active calls per worker.")
    header("b2bua_worker_calls_total", "counter", "Total calls created since worker start.")
    header("b2bua_worker_transactions_active", "gauge", "Current active SIP transactions per worker.")
    header("b2bua_worker_messages_processed_total", "counter", "Total SIP messages processed per worker.")
    header("b2bua_worker_overload_admit_total", "counter", "Calls admitted by worker overload controller.")
    header("b2bua_worker_overload_reject_total", "counter", "Calls rejected by worker overload controller.")
    header("b2bua_worker_overload_shed_probability", "gauge", "Worker adaptive shedding probability (0.0-1.0).")
    header("b2bua_worker_overload_token_bucket_level", "gauge", "Worker token bucket fill level.")
    header("b2bua_worker_overload_token_bucket_ratio", "gauge", "Worker token bucket fill ratio (0.0-1.0).")
    header("b2bua_worker_loop_lag_ms_p95", "gauge", "Worker event loop lag p95 estimate in milliseconds.")
    header("b2bua_worker_routing_api_latency_p95_ms", "gauge", "Worker routing API latency p95 in milliseconds.")
    header("b2bua_worker_overload_fraction", "gauge", "Worker per-signal shedding fraction (0.0-1.0).")
    header("b2bua_worker_gc_pauses_total", "counter", "Total GC pauses since worker start.")
    header("b2bua_worker_gc_pause_seconds_total", "counter", "Total GC pause time in seconds since worker start.")
    header("b2bua_worker_gc_pause_max_seconds", "gauge", "Max GC pause in seconds within the last reporting window.")
    header("b2bua_worker_gc_window_pauses", "gauge", "GC pauses within the last reporting window.")
    header("b2bua_worker_gc_window_pause_seconds", "gauge", "Total GC pause time in seconds within the last reporting window.")
    header("b2bua_worker_gc_last_pause_timestamp_seconds", "gauge", "Unix timestamp of the most recent GC pause.")
    header("b2bua_worker_gc_last_pause_duration_seconds", "gauge", "Duration of the most recent GC pause in seconds.")
    header("b2bua_worker_gc_last_pause_kind", "gauge", "Kind of the most recent GC pause (label-encoded).")

    for (let i = 0; i < reg.workers.length; i++) {
      const w = reg.workers[i]
      if (w === undefined) continue
      const wl = { worker: String(i) }
      const wlr = (extra: Record<string, string>) => ({ ...wl, ...extra })

      // Call & message counters
      m("b2bua_worker_calls_concurrent", w.callsConcurrent, wl)
      m("b2bua_worker_calls_total", w.callsTotal, wl)
      m("b2bua_worker_transactions_active", w.transactionsActive, wl)
      m("b2bua_worker_messages_processed_total", w.messagesProcessed, wl)

      // Overload controller
      m("b2bua_worker_overload_admit_total", w.overload.admitTotal, wl)
      m("b2bua_worker_overload_reject_total", w.overload.rejectBucketEmpty, wlr({ reason: "bucket_empty" }))
      m("b2bua_worker_overload_reject_total", w.overload.rejectShedder, wlr({ reason: "shedder" }))
      m("b2bua_worker_overload_shed_probability", w.overload.shedProbability, wl)
      m("b2bua_worker_overload_token_bucket_level", w.overload.tokenBucketLevel, wl)
      m("b2bua_worker_overload_token_bucket_ratio", w.overload.tokenBucketRatio, wl)
      m("b2bua_worker_loop_lag_ms_p95", w.overload.loopLagMsP95, wl)
      m("b2bua_worker_routing_api_latency_p95_ms", w.overload.routingApiP95MsNewCall, wlr({ stage: "new_call" }))
      m("b2bua_worker_routing_api_latency_p95_ms", w.overload.routingApiP95MsInDialog, wlr({ stage: "in_dialog" }))
      m("b2bua_worker_overload_fraction", w.overload.fractionLoopLag, wlr({ signal: "loop_lag" }))
      m("b2bua_worker_overload_fraction", w.overload.fractionActiveCalls, wlr({ signal: "active_calls" }))
      m("b2bua_worker_overload_fraction", w.overload.fractionInDialogQueue, wlr({ signal: "in_dialog_queue" }))
      m("b2bua_worker_overload_fraction", w.overload.fractionRoutingLatency, wlr({ signal: "routing_latency" }))

      // GC pressure
      m("b2bua_worker_gc_pauses_total", w.gc.totalCount, wl)
      m("b2bua_worker_gc_pause_seconds_total", w.gc.totalPauseMs / 1000, wl)
      m("b2bua_worker_gc_pause_max_seconds", w.gc.maxPauseMs / 1000, wl)
      m("b2bua_worker_gc_window_pauses", w.gc.windowCount, wl)
      m("b2bua_worker_gc_window_pause_seconds", w.gc.windowPauseMs / 1000, wl)
      m("b2bua_worker_gc_last_pause_timestamp_seconds", w.gc.lastPauseTimestamp / 1000, wl)
      m("b2bua_worker_gc_last_pause_duration_seconds", w.gc.lastPauseDurationMs / 1000, wl)
      m("b2bua_worker_gc_last_pause_kind", 1, wlr({ kind: w.gc.lastPauseKind || "none" }))
    }
  }

  return lines.join("\n") + "\n"
}

export const StatusServerLayer: Layer.Layer<never, never, CallState | AppConfig | MetricsRegistry> = Layer.unwrap(
  Effect.gen(function* () {
    const callState = yield* CallState
    const config = yield* AppConfig
    const registry = yield* MetricsRegistry
    const startedAt = yield* Clock.currentTimeMillis

    const routes = HttpRouter.use(
      Effect.fnUntraced(function* (router) {
        yield* router.add(
          "GET",
          "/status",
          Effect.gen(function* () {
            const stats = yield* callState.stats()
            const nowMs = yield* Clock.currentTimeMillis
            const { overload, workers } = buildStatusBlocks(registry)
            return yield* HttpServerResponse.json({
              ok: true,
              concurrent: stats.concurrent,
              total: stats.total,
              uptimeMs: nowMs - startedAt,
              overload,
              workers,
            })
          })
        )

        yield* router.add(
          "GET",
          "/metrics",
          Effect.gen(function* () {
            return HttpServerResponse.text(renderPrometheus(registry), {
              headers: { "content-type": "text/plain; version=0.0.4" },
            })
          })
        )

        // ── Debug endpoints for memory profiling ───────────────────
        yield* router.add(
          "GET",
          "/debug/memory",
          Effect.gen(function* () {
            const memUsage = process.memoryUsage()
            const cpuUsg = process.cpuUsage()
            const workerData = registry.workers.map((w, i) =>
              w === undefined
                ? { worker: i, status: "no_data" as const }
                : {
                    worker: i,
                    status: "ok" as const,
                    memory: w.memory,
                    mapSizes: w.mapSizes,
                    cpuUsage: w.cpuUsage,
                    loopLagMsP95: w.overload.loopLagMsP95,
                    gc: w.gc,
                  }
            )
            return yield* HttpServerResponse.json({
              process: {
                pid: process.pid,
                title: process.title,
                memory: {
                  rss: memUsage.rss,
                  heapTotal: memUsage.heapTotal,
                  heapUsed: memUsage.heapUsed,
                  external: memUsage.external,
                  arrayBuffers: memUsage.arrayBuffers,
                },
                cpuUsage: {
                  user: cpuUsg.user,
                  system: cpuUsg.system,
                },
              },
              workers: workerData,
              timestamp: Date.now(),
            })
          })
        )

        yield* router.add(
          "POST",
          "/debug/gc",
          Effect.sync(() => {
            const gcAvailable = typeof globalThis.gc === "function"
            if (gcAvailable) globalThis.gc!()
            // Also relay to workers in cluster mode
            registry.broadcastToWorkers?.({ type: "force-gc" })
            return HttpServerResponse.json({
              triggered: gcAvailable,
              workersBroadcast: registry.broadcastToWorkers !== undefined,
            })
          }).pipe(Effect.flatten)
        )

        yield* router.add(
          "POST",
          "/debug/heap-snapshot",
          Effect.sync(() => {
            const dir = "/tmp/heapdumps"
            try {
              mkdirSync(dir, { recursive: true })
            } catch { /* ignore */ }
            const masterFile = writeHeapSnapshot(
              `${dir}/heap-master-${process.pid}-${Date.now()}.heapsnapshot`
            )
            // Also relay to workers in cluster mode
            registry.broadcastToWorkers?.({ type: "heap-snapshot", dir })
            return HttpServerResponse.json({
              master: masterFile,
              workersBroadcast: registry.broadcastToWorkers !== undefined,
              dir,
            })
          }).pipe(Effect.flatten)
        )

        yield* router.add(
          "POST",
          "/debug/cpu-profile",
          Effect.sync(() => {
            const dir = "/tmp/cpuprofiles"
            const durationMs = 10_000
            try {
              mkdirSync(dir, { recursive: true })
            } catch { /* ignore */ }
            // Profile master process in background (don't block response)
            profileProcess(dir, durationMs, "master")
            // Broadcast to workers
            registry.broadcastToWorkers?.({ type: "cpu-profile", dir, durationMs })
            return HttpServerResponse.json({
              status: "profiling_started",
              durationMs,
              dir,
              workersBroadcast: registry.broadcastToWorkers !== undefined,
            })
          }).pipe(Effect.flatten)
        )

        yield* addCallControlRoutes(router)
      })
    )

    return HttpRouter.serve(routes).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port: config.httpStatusPort })),
      Layer.orDie
    )
  })
)
