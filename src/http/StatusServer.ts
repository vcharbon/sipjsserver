/**
 * HTTP server exposing B2BUA runtime stats and call control API.
 */

import { NodeHttpServer } from "@effect/platform-node"
import { Clock, Effect, Layer } from "effect"
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { createServer } from "node:http"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { writeHeapSnapshot } from "node:v8"
import { CallState } from "../call/CallState.js"
import { WorkerReadiness } from "../cache/WorkerReadiness.js"
import { DrainingState } from "../b2bua/DrainingState.js"
import { AppConfig } from "../config/AppConfig.js"
import { addPeerRelayRoutes } from "../cache/PeerRelay.js"
import { PartitionedRelayStorage } from "../cache/PartitionedRelayStorage.js"
import { addCallControlRoutes } from "../decision/adapters/http-reference/MockServer.js"
import { MetricsRegistry, type MetricsRegistryState } from "../observability/MetricsRegistry.js"
import { addReplLogRoutes, ReplLogServer } from "../replication/ReplLogServer.js"
import { getByeDispositionInvariantViolationCount } from "../b2bua/rules/framework/ByeDispositionInvariant.js"


/**
 * Start a V8 CPU profile in the current process, write to dir after
 * durationMs. Returns the file path on success, or `null` if the
 * inspector failed. Awaiting the promise is required for the
 * orchestrator's pre-kill capture path; fire-and-forget callers can
 * just discard it.
 */
async function profileProcess(
  dir: string,
  durationMs: number,
  label: string,
): Promise<string | null> {
  try {
    const { Session } = await import("node:inspector/promises")
    const session = new Session()
    session.connect()
    await session.post("Profiler.enable")
    await session.post("Profiler.start")
    await new Promise<void>((r) => setTimeout(r, durationMs))
    const { profile } = await session.post("Profiler.stop")
    await session.post("Profiler.disable")
    session.disconnect()
    const file = `${dir}/cpu-${label}-${process.pid}-${Date.now()}.cpuprofile`
    writeFileSync(file, JSON.stringify(profile))
    console.log(`[${label}] CPU profile written: ${file}`)
    return file
  } catch (err) {
    console.error(`[${label}] CPU profile failed:`, err)
    return null
  }
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

function renderPrometheus(
  reg: MetricsRegistryState
): string {
  // Slice 7c: legacy ReplMetrics removed; the new ReplicationMetrics
  // module (Slice 8) will reintroduce per-peer counters / gauges /
  // histograms via the redesigned protocol. The Prometheus output
  // currently drops the `b2bua_repl_*` family — operator dashboards
  // referencing those names need to be updated when Slice 8 lands.
  const lines: string[] = []

  /** Emit a single metric line with optional labels. */
  const m = (name: string, value: number, labels?: Record<string, string>) => {
    const labelStr = labels
      ? "{" + Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",") + "}"
      : ""
    lines.push(`${name}${labelStr} ${value}`)
  }

  /** Emit # HELP and # TYPE header for a metric family. */
  const header = (
    name: string,
    type: "counter" | "gauge" | "histogram",
    help: string
  ) => {
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

  // ── TransactionLayer event-queue (Slice 2/4) ───────────────────────
  if (reg.transactionLayer) {
    const tl = reg.transactionLayer
    header(
      "b2bua_worker_event_queue_depth",
      "gauge",
      "Current depth of the inbound TransactionLayer event queue.",
    )
    m("b2bua_worker_event_queue_depth", tl.eventQueueDepth())

    header(
      "b2bua_worker_event_queue_capacity",
      "gauge",
      "Static capacity of the inbound TransactionLayer event queue (drop-on-full above this).",
    )
    m("b2bua_worker_event_queue_capacity", tl.eventQueueCapacity)

    header(
      "b2bua_worker_event_queue_drops_total",
      "counter",
      "Inbound events dropped because the bounded event queue was full, by reason class.",
    )
    m("b2bua_worker_event_queue_drops_total", tl.eventQueueDrops.request_invite, { reason: "request_invite" })
    m("b2bua_worker_event_queue_drops_total", tl.eventQueueDrops.request_other, { reason: "request_other" })
    m("b2bua_worker_event_queue_drops_total", tl.eventQueueDrops.response, { reason: "response" })
    m("b2bua_worker_event_queue_drops_total", tl.eventQueueDrops.cancelled, { reason: "cancelled" })
    m("b2bua_worker_event_queue_drops_total", tl.eventQueueDrops.timeout, { reason: "timeout" })
  }

  // ── Active timer fibers (Slice 4) ──────────────────────────────────
  if (reg.timers) {
    header(
      "b2bua_worker_active_timers",
      "gauge",
      "Live count of timer fibers tracked by TimerService.",
    )
    m("b2bua_worker_active_timers", reg.timers.activeCount())

    header(
      "b2bua_worker_timer_handler_timeouts_total",
      "counter",
      "Timer handlers that exceeded timerHandlerTimeoutMs and were force-cancelled.",
    )
    m("b2bua_worker_timer_handler_timeouts_total", reg.timers.handlerTimeoutTotal())
  }

  // ── SipRouter consumer safety (Slice 1.4 / event-timeout) ──────────
  if (reg.sipRouter) {
    const r = reg.sipRouter
    header(
      "b2bua_worker_event_handler_timeouts_total",
      "counter",
      "Inbound events whose withCall handler exceeded eventHandlerTimeoutMs.",
    )
    m("b2bua_worker_event_handler_timeouts_total", r.eventHandlerTimeoutTotal())

    header(
      "b2bua_worker_call_force_purge_total",
      "counter",
      "Calls force-purged after the safety-net terminating_timeout handler errored or hung.",
    )
    m("b2bua_worker_call_force_purge_total", r.forcePurgeTotal())

    header(
      "b2bua_stale_response_dropped_total",
      "counter",
      "Inbound SIP responses dropped because the call no longer exists. Per RFC 3261 §17.1.1.2 these MUST be silently dropped; non-zero indicates teardown-racing in-flight transactions (typically OPTIONS keepalive 200 OKs).",
    )
    const stale = r.staleResponseDroppedTotal()
    for (const key of Object.keys(stale)) {
      const sep = key.indexOf("|")
      const method = sep > 0 ? key.slice(0, sep) : key
      const status = sep > 0 ? key.slice(sep + 1) : "0"
      m("b2bua_stale_response_dropped_total", stale[key] ?? 0, { method, status })
    }
  }

  // ── Calls in 'terminating' state, bucketed by age (Slice 4 canary) ─
  if (reg.callState) {
    const buckets = reg.callState.terminatingByBucket()
    header(
      "b2bua_worker_terminating_calls",
      "gauge",
      "Calls currently in 'terminating' state, bucketed by time spent in that state. The 'gte300s' bucket should always read zero.",
    )
    m("b2bua_worker_terminating_calls", buckets.lt10s, { age_bucket: "lt10s" })
    m("b2bua_worker_terminating_calls", buckets.lt60s, { age_bucket: "lt60s" })
    m("b2bua_worker_terminating_calls", buckets.lt300s, { age_bucket: "lt300s" })
    m("b2bua_worker_terminating_calls", buckets.gte300s, { age_bucket: "gte300s" })

    header(
      "b2bua_active_dialogs",
      "gauge",
      "Active dialogs on this worker — size of the in-memory callsMap (every call this worker currently owns as primary or holds as backup). Authoritative dialog count; not derived from the proxy LRU.",
    )
    m("b2bua_active_dialogs", reg.callState.concurrentCallsCount())
  }

  // ── PerCallDispatcher gauges + counters (ADR-0004) ────────────────
  if (reg.dispatch) {
    const d = reg.dispatch
    const counts = d.queueCounts()
    const inFlight = d.inFlight()
    const creations = d.creationsTotal()
    const removals = d.removalsTotal()

    header(
      "b2bua_dispatch_queues",
      "gauge",
      "Current number of per-callRef event queues, by partition (primary = owned by this worker, backup = held for another peer).",
    )
    m("b2bua_dispatch_queues", counts.primary, { partition: "primary" })
    m("b2bua_dispatch_queues", counts.backup, { partition: "backup" })

    header(
      "b2bua_dispatch_in_flight",
      "gauge",
      "Per-call event handlers currently running, by partition.",
    )
    m("b2bua_dispatch_in_flight", inFlight.primary, { partition: "primary" })
    m("b2bua_dispatch_in_flight", inFlight.backup, { partition: "backup" })

    header(
      "b2bua_dispatch_queue_creations_total",
      "counter",
      "Per-call queues created since boot, labelled by reason (boot, lazy, failover).",
    )
    m("b2bua_dispatch_queue_creations_total", creations.boot, { reason: "boot" })
    m("b2bua_dispatch_queue_creations_total", creations.lazy, { reason: "lazy" })
    m("b2bua_dispatch_queue_creations_total", creations.failover, { reason: "failover" })

    header(
      "b2bua_dispatch_queue_removals_total",
      "counter",
      "Per-call queues removed since boot, labelled by reason (terminate, reaper).",
    )
    m("b2bua_dispatch_queue_removals_total", removals.terminate, { reason: "terminate" })
    m("b2bua_dispatch_queue_removals_total", removals.reaper, { reason: "reaper" })

    header(
      "b2bua_dispatch_worker_cap_drops_total",
      "counter",
      "Events dropped because the perCallQueues map was at the configured cap.",
    )
    m("b2bua_dispatch_worker_cap_drops_total", d.capDropsTotal())

    header(
      "b2bua_dispatch_queue_drops_total",
      "counter",
      "Events dropped because a per-call queue was full at its configured depth.",
    )
    m("b2bua_dispatch_queue_drops_total", d.queueDropsTotal())

    header(
      "b2bua_dispatch_saturation_total",
      "counter",
      "Times a worker had to park on the global concurrency permit (in-flight cap hit).",
    )
    m("b2bua_dispatch_saturation_total", d.saturationTotal())

    header(
      "b2bua_dispatch_concurrency_cap",
      "gauge",
      "Configured global concurrency cap for in-flight per-call event handlers.",
    )
    m("b2bua_dispatch_concurrency_cap", d.concurrencyCap)

    header(
      "b2bua_dispatch_queue_cap",
      "gauge",
      "Configured hard cap on the number of per-call queues tracked.",
    )
    m("b2bua_dispatch_queue_cap", d.queueCap)
  }

  // ── Call limiter per-result counters ───────────────────────────────
  // Primary in-cluster verification signal for the limiter-Redis cascade
  // fix (docs/plan/to-review-and-properly-swift-moler.md). The four
  // outcomes are mutually exclusive and exhaustive: every
  // `checkAndIncrement` call lands on exactly one of them.
  if (reg.callLimiter) {
    const cl = reg.callLimiter
    header(
      "b2bua_call_limiter_results_total",
      "counter",
      "CallLimiter checkAndIncrement outcomes, by result label. " +
        "allowed=admitted under cap; rejected=cap hit (normal); " +
        "redis_error=ioredis RedisError (fail-open admission); " +
        "timeout=Effect-level 150ms safety net fired (fail-open admission).",
    )
    m("b2bua_call_limiter_results_total", cl.allowedTotal(), { result: "allowed" })
    m("b2bua_call_limiter_results_total", cl.rejectedTotal(), { result: "rejected" })
    m("b2bua_call_limiter_results_total", cl.redisErrorTotal(), { result: "redis_error" })
    m("b2bua_call_limiter_results_total", cl.timeoutTotal(), { result: "timeout" })
  }

  // ── Redis call-key counts (periodic SCAN snapshot) ─────────────────
  if (reg.redisCallKeyCounts) {
    const counts = reg.redisCallKeyCounts
    header(
      "b2bua_redis_call_keys",
      "gauge",
      "Periodic-SCAN snapshot of call keys in Redis. partition=nominal counts `pri:{self}:call:*` (this worker as primary); partition=backup is labelled by `primary` and counts `bak:{primary}:call:*` (calls this worker holds on behalf of another pod).",
    )
    m("b2bua_redis_call_keys", counts.nominalCount(), { partition: "nominal" })
    const backups = counts.backupCountsByPrimary()
    for (const [primary, count] of Object.entries(backups)) {
      m("b2bua_redis_call_keys", count, { partition: "backup", primary })
    }

    header(
      "b2bua_redis_call_keys_scan_timestamp_seconds",
      "gauge",
      "Unix timestamp at which the call-key SCAN snapshot above was last refreshed. now() - this value is the scrape staleness.",
    )
    m("b2bua_redis_call_keys_scan_timestamp_seconds", counts.lastScanTimestampMs() / 1000)
  }

  // ── Peer-scan-bootstrap (echo-removal slice) ───────────────────────
  if (reg.replicationBootstrap) {
    const b = reg.replicationBootstrap
    header(
      "b2bua_replication_bootstrap_started_total",
      "counter",
      "Worker-boot peer-scan-bootstrap attempts started. One per worker incarnation.",
    )
    m("b2bua_replication_bootstrap_started_total", b.startedTotal())

    header(
      "b2bua_replication_bootstrap_completed_total",
      "counter",
      "Per-peer bootstrap outcomes — ok / timeout / error. Sum across labels equals the count of peers seen at boot.",
    )
    const outcomes = b.completedTotal()
    for (const key of Object.keys(outcomes)) {
      const sep = key.indexOf("|")
      const peer = sep > 0 ? key.slice(0, sep) : key
      const outcome = sep > 0 ? key.slice(sep + 1) : "unknown"
      m("b2bua_replication_bootstrap_completed_total", outcomes[key] ?? 0, {
        peer,
        outcome,
      })
    }

    header(
      "b2bua_replication_bootstrap_entries_imported_total",
      "counter",
      "Calls retrieved from each source peer during boot bootstrap (1 entry = 1 call replicated into the local `pri:{self}:*` partition).",
    )
    const imported = b.entriesImportedTotal()
    for (const [peer, value] of Object.entries(imported)) {
      m("b2bua_replication_bootstrap_entries_imported_total", value, { peer })
    }

    header(
      "b2bua_replication_bootstrap_duration_ms",
      "gauge",
      "Per-peer bootstrap wall-time (last sample). Exposed as a gauge to keep scrape cardinality low; promote to a histogram if distribution becomes load-bearing.",
    )
    const durations = b.durationMs()
    for (const [peer, samples] of Object.entries(durations)) {
      const last = samples.length > 0 ? samples[samples.length - 1]! : 0
      m("b2bua_replication_bootstrap_duration_ms", last, { peer })
    }
  }

  // ── Worker-readiness transition (cold-boot context-load time) ──────
  if (reg.workerReadiness) {
    const ms = reg.workerReadiness.readyInMs()
    const reason = reg.workerReadiness.readyReason()
    if (ms !== undefined && reason !== undefined) {
      header(
        "b2bua_worker_ready_in_ms",
        "gauge",
        "Wall-clock ms from worker process boot to Ready=true. `reason=all_caught_up` is the happy path (every peer's bootstrap caught up before T_max); `reason=t_max_timeout` means the controller flipped Ready by ceiling — the proxy may route to this worker before its state is fully restored. See ReadinessController.ts.",
      )
      m("b2bua_worker_ready_in_ms", ms, { reason })
    }
  }

  // ── OTel pipeline (Slice 5) ────────────────────────────────────────
  if (reg.otelPipeline) {
    const o = reg.otelPipeline
    header("b2bua_otel_bsp_queue_depth", "gauge", "Current OTel BatchSpanProcessor queue depth.")
    m("b2bua_otel_bsp_queue_depth", o.bspQueueDepth())

    header("b2bua_otel_bsp_queue_capacity", "gauge", "Configured BSP maxQueueSize.")
    m("b2bua_otel_bsp_queue_capacity", o.bspQueueCapacity)

    header("b2bua_otel_bsp_dropped_total", "counter", "Spans dropped at the BSP because its queue was full.")
    m("b2bua_otel_bsp_dropped_total", o.bspDroppedTotal())

    header("b2bua_otel_tracer_disabled_total", "counter", "Tracer kill-switch transitions, by reason.")
    const reasons = o.tracerDisabledTotal()
    for (const [reason, value] of Object.entries(reasons)) {
      m("b2bua_otel_tracer_disabled_total", value, { reason })
    }
  }

  // ── Replication metrics ────────────────────────────────────────────
  // Slice 7c: the legacy ReplMetrics module is gone; new metrics
  // (Slice 8 ReplicationMetrics) will land in a follow-up. The
  // `b2bua_repl_*` family is currently absent from /metrics.

  return lines.join("\n") + "\n"
}

export const StatusServerLayer: Layer.Layer<
  never,
  never,
  CallState | AppConfig | MetricsRegistry | ReplLogServer | WorkerReadiness | DrainingState | PartitionedRelayStorage
> = Layer.unwrap(
  Effect.gen(function* () {
    const callState = yield* CallState
    const config = yield* AppConfig
    const registry = yield* MetricsRegistry
    const readiness = yield* WorkerReadiness
    const draining = yield* DrainingState
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
          Effect.sync(() =>
            HttpServerResponse.text(renderPrometheus(registry), {
              headers: { "content-type": "text/plain; version=0.0.4" },
            })
          )
        )

        // Slice D9 — Kubernetes readiness gate.
        //
        // Returns 200 only when the worker is past its boot-time
        // ReadyGate handshake (so its `pri:` partition has been
        // hydrated from peer `bak:` snapshots) AND not currently
        // draining (SIGTERM received). Either signal alone keeps
        // the pod out of the K8s Service Endpoints, which transitively
        // keeps the proxy's `decode_forward` from sending in-dialog
        // traffic to a worker that isn't ready to absorb it.
        yield* router.add(
          "GET",
          "/ready",
          Effect.gen(function* () {
            const ready = yield* readiness.currentReady
            const mode = yield* draining.mode
            const ok = ready && mode === "serving"
            return yield* HttpServerResponse.json(
              { ready: ok, replicationReady: ready, draining: mode !== "serving" },
              { status: ok ? 200 : 503 }
            )
          })
        )

        // ── Debug endpoints for memory profiling ───────────────────
        yield* router.add(
          "GET",
          "/debug/memory",
          Effect.gen(function* () {
            const memUsage = process.memoryUsage()
            const cpuUsg = process.cpuUsage()
            // Sample CallState map sizes from THIS process. In single-
            // process deployments (k8s b2bua-worker pods) `workers[]`
            // below is empty, so without this block the leak harness
            // would see no map-size data at all.
            const callStateStats = callState.statsSync()
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
            // Endurance hardening (Slice 4): surface the new event-queue,
            // timer, terminating-bucket, and OTel metrics into the
            // /debug/memory JSON so the leak harness picks them up
            // directly, without scraping Prometheus text.
            const eventQueue = registry.transactionLayer
              ? {
                  depth: registry.transactionLayer.eventQueueDepth(),
                  capacity: registry.transactionLayer.eventQueueCapacity,
                  drops: registry.transactionLayer.eventQueueDrops,
                }
              : undefined
            const activeTimers = registry.timers?.activeCount()
            const terminating = registry.callState?.terminatingByBucket()
            const otel = registry.otelPipeline
              ? {
                  bspQueueDepth: registry.otelPipeline.bspQueueDepth(),
                  bspQueueCapacity: registry.otelPipeline.bspQueueCapacity,
                  bspDroppedTotal: registry.otelPipeline.bspDroppedTotal(),
                  tracerDisabledTotal: registry.otelPipeline.tracerDisabledTotal(),
                }
              : undefined

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
                mapSizes: {
                  callsMap: callStateStats.concurrent,
                  sipIndex: callStateStats.sipIndexSize,
                  semaphores: callStateStats.semaphoresSize,
                  activeTimers,
                },
                callStateRemoveInvocations: callStateStats.removeInvocations,
                callStateOrphanSweepRecovered: callStateStats.orphanSweepRecoveredCount,
                byeDispositionInvariantViolations: getByeDispositionInvariantViolationCount(),
                callStateTotal: callStateStats.total,
                eventQueue,
                terminating,
                otel,
              },
              workers: workerData,
              timestamp: Date.now(),
            })
          })
        )

        // ADR-0004 — PerCallDispatcher gauges + counters. Surfaces the
        // partition-tagged queue counts, in-flight handler counts, and
        // saturation / cap-drop totals so operators can correlate a
        // call-handling stall with which dispatcher dimension is
        // exhausted (queue cap vs concurrency cap vs single-call
        // queue depth).
        yield* router.add(
          "GET",
          "/debug/dispatch",
          Effect.gen(function* () {
            const d = registry.dispatch
            if (d === undefined) {
              return yield* HttpServerResponse.json({ enabled: false })
            }
            return yield* HttpServerResponse.json({
              enabled: true,
              concurrencyCap: d.concurrencyCap,
              queueCap: d.queueCap,
              queueCounts: d.queueCounts(),
              inFlight: d.inFlight(),
              creationsTotal: d.creationsTotal(),
              removalsTotal: d.removalsTotal(),
              capDropsTotal: d.capDropsTotal(),
              queueDropsTotal: d.queueDropsTotal(),
              saturationTotal: d.saturationTotal(),
              timestamp: Date.now(),
            })
          }),
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
            // Prefer /heapdumps when its emptyDir is mounted (helm
            // values `heapdumps.enabled: true`) — survives container
            // restart so the orchestrator can still copy the file out
            // after an OOM. Falls back to /tmp/heapdumps when the
            // volume isn't mounted (writable container layer, lost on
            // restart) so the endpoint stays usable in dev shells.
            const dir = existsSync("/heapdumps") ? "/heapdumps" : "/tmp/heapdumps"
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
          Effect.gen(function* () {
            const req = yield* HttpServerRequest.HttpServerRequest
            const url = new URL(req.url, "http://localhost")
            // Reuse the heapdumps emptyDir so a CPU profile survives
            // container restart and rides the same `kubectl cp` path
            // operators already wired for heap snapshots.
            const dir = existsSync("/heapdumps")
              ? "/heapdumps"
              : "/tmp/cpuprofiles"
            const durationMs = (() => {
              const raw = url.searchParams.get("seconds")
              const parsed = raw === null ? NaN : Number.parseInt(raw, 10)
              return Number.isFinite(parsed) && parsed > 0
                ? parsed * 1_000
                : 10_000
            })()
            const wait = url.searchParams.get("wait") === "1"
            yield* Effect.sync(() => {
              try {
                mkdirSync(dir, { recursive: true })
              } catch {
                /* ignore */
              }
            })
            registry.broadcastToWorkers?.({
              type: "cpu-profile",
              dir,
              durationMs,
            })
            if (wait) {
              // Pre-kill capture: caller needs the file on disk before
              // we issue a kill, so block until profileProcess resolves.
              const file = yield* Effect.promise(() =>
                profileProcess(dir, durationMs, "master"),
              )
              return HttpServerResponse.jsonUnsafe({
                status: file === null ? "failed" : "completed",
                master: file,
                durationMs,
                dir,
                workersBroadcast: registry.broadcastToWorkers !== undefined,
              })
            }
            // Fire-and-forget for ad-hoc operator use.
            void profileProcess(dir, durationMs, "master")
            return HttpServerResponse.jsonUnsafe({
              status: "profiling_started",
              durationMs,
              dir,
              workersBroadcast: registry.broadcastToWorkers !== undefined,
            })
          }),
        )

        yield* addCallControlRoutes(router)
        yield* addReplLogRoutes(router)
        yield* addPeerRelayRoutes(router)
      })
    )

    return HttpRouter.serve(routes).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port: config.httpStatusPort })),
      Layer.orDie
    )
  })
)
