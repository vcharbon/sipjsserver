/**
 * Centralised application configuration read from environment variables.
 */

import { Layer, Schema, ServiceMap } from "effect"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AppConfigData = Schema.Struct({
  sipLocalIp: Schema.String,
  sipLocalPort: Schema.Int,
  redisUrl: Schema.String,
  redisKeyPrefix: Schema.String,
  limiterWindowSeconds: Schema.Int,
  limiterActiveWindows: Schema.Int,
  limiterTtlSeconds: Schema.Int,
  noAnswerTimeoutSec: Schema.Int,
  keepaliveIntervalSec: Schema.Int,
  keepaliveTimeoutSec: Schema.Int,
  callMaxDurationSec: Schema.Int,
  cdrFilePath: Schema.String,
  httpStatusPort: Schema.Int,
  callControlUrl: Schema.String,
  redisFlushIdleMs: Schema.Int,
  traceSampleRate: Schema.Number,
  otelTracesUrl: Schema.String,
  /** Number of worker processes (0 = standalone, no clustering). */
  clusterWorkers: Schema.Int,
  /** This worker's index (set by dispatcher in child process env). -1 = standalone. */
  workerIndex: Schema.Int,
  /** TTL for Redis call context keys (seconds). Derived as keepaliveIntervalSec * 2. */
  callContextTtlSec: Schema.Int,
  /** Delay before deleting Redis keys after call termination (seconds). Covers SIP retransmissions. */
  callCleanupDelaySec: Schema.Int,

  // ── Overload protection ───────────────────────────────────────────────
  /** Bounded UDP recv queue capacity. Formula: 2 × target_cps × 0.1 (≈100ms buffer). */
  udpQueueMax: Schema.Int,
  /** Tier 1 emergency brake activation threshold (% of udpQueueMax). */
  udpQueueTier1ThresholdPct: Schema.Int,
  /** Per-worker emergency-class queue capacity. */
  workerQueueEmergencyMax: Schema.Int,
  /** Per-worker in-dialog-class queue capacity. */
  workerQueueInDialogMax: Schema.Int,
  /** Per-worker normal-new-call-class queue capacity. */
  workerQueueNewCallMax: Schema.Int,
  /** Worker-kill escalation timer when in-dialog queue stays full (ms). */
  workerInDialogFullKillAfterMs: Schema.Int,
  /** Tier 3 token bucket capacity. */
  cpsBucketSize: Schema.Int,
  /** Tier 3 token refill rate (tokens/sec). */
  cpsBucketRate: Schema.Int,
  /** Tier 3 loop-lag soft threshold (ms). */
  overloadLoopLagSoftMs: Schema.Int,
  /** Tier 3 loop-lag hard threshold (ms). */
  overloadLoopLagHardMs: Schema.Int,
  /** Tier 3 routing-API new-call latency soft threshold (ms). */
  overloadRoutingNewCallSoftMs: Schema.Int,
  /** Tier 3 routing-API new-call latency hard threshold (ms). */
  overloadRoutingNewCallHardMs: Schema.Int,
  /** Base value for Retry-After header on 503 responses (seconds). */
  retryAfterBaseSec: Schema.Int,
  /** Random jitter added to Retry-After (seconds). */
  retryAfterJitterSec: Schema.Int,
  /** Optional dual-listener for emergency b-leg traffic. */
  emergencyListenerEnabled: Schema.Boolean,
  /** Bind host for emergency listener (when enabled). */
  emergencyListenerHost: Schema.String,
  /** Bind port for emergency listener (when enabled). */
  emergencyListenerPort: Schema.Int,

  // ── REFER transfer timers (RFC 3515 / v1 blind transfer) ─────────────
  /** NOTIFY subscription expiry for a REFER transfer while /call/refer is pending (seconds). */
  referSubscriptionExpirySec: Schema.Int,
  /** Watchdog for each B2BUA-originated realign re-INVITE (seconds). */
  referReinviteAnswerSec: Schema.Int,
  /** End-to-end safety net for a whole REFER transfer (seconds). */
  referOverallSafetySec: Schema.Int,

  // ── Tracing ───────────────────────────────────────────────────────────
  /** Header names whose values are redacted in sip.raw_message span attributes. */
  scrubHeaders: Schema.Array(Schema.String),
  /** Max span attribute value length (bytes) passed to OTel SDK spanLimits. */
  otelMaxAttributeValueLength: Schema.Int,
  /** Emit tombstone spans (call.started / call.ended) for non-sampled calls. */
  traceTombstoneEnabled: Schema.Boolean
})

export type AppConfigData = typeof AppConfigData.Type

// ---------------------------------------------------------------------------
// Env reader helper
// ---------------------------------------------------------------------------

function envOrDefault(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

function readConfigFromEnv(): AppConfigData {
  return {
    sipLocalIp: envOrDefault("SIP_LOCAL_IP", "127.0.0.1"),
    sipLocalPort: parseInt(envOrDefault("SIP_LOCAL_PORT", "5060"), 10),
    redisUrl: envOrDefault("REDIS_URL", "redis://localhost:6379"),
    redisKeyPrefix: envOrDefault("REDIS_KEY_PREFIX", "sipas"),
    limiterWindowSeconds: parseInt(envOrDefault("LIMITER_WINDOW_SECONDS", "300"), 10),
    limiterActiveWindows: parseInt(envOrDefault("LIMITER_ACTIVE_WINDOWS", "3"), 10),
    limiterTtlSeconds: parseInt(envOrDefault("LIMITER_TTL_SECONDS", "1200"), 10),
    noAnswerTimeoutSec: parseInt(envOrDefault("NO_ANSWER_TIMEOUT_SEC", "30"), 10),
    keepaliveIntervalSec: parseInt(envOrDefault("KEEPALIVE_INTERVAL_SEC", "900"), 10),
    keepaliveTimeoutSec: parseInt(envOrDefault("KEEPALIVE_TIMEOUT_SEC", "10"), 10),
    callMaxDurationSec: parseInt(envOrDefault("CALL_MAX_DURATION_SEC", "7200"), 10),
    cdrFilePath: envOrDefault("CDR_FILE_PATH", "/tmp/cdr.jsonl"),
    httpStatusPort: parseInt(envOrDefault("HTTP_STATUS_PORT", "3002"), 10),
    callControlUrl: envOrDefault("CALL_CONTROL_URL", "http://localhost:3002"),
    redisFlushIdleMs: parseInt(envOrDefault("REDIS_FLUSH_IDLE_MS", "2000"), 10),
    traceSampleRate: parseFloat(envOrDefault("TRACE_SAMPLE_RATE", "1.0")),
    otelTracesUrl: envOrDefault("OTEL_TRACES_URL", "http://localhost:4318/v1/traces"),
    clusterWorkers: parseInt(envOrDefault("CLUSTER_WORKERS", "0"), 10),
    workerIndex: parseInt(envOrDefault("WORKER_INDEX", "-1"), 10),
    callContextTtlSec: parseInt(envOrDefault("KEEPALIVE_INTERVAL_SEC", "900"), 10) * 2,
    callCleanupDelaySec: 32,
    udpQueueMax: parseInt(envOrDefault("UDP_QUEUE_MAX", "100"), 10),
    udpQueueTier1ThresholdPct: parseInt(envOrDefault("UDP_QUEUE_TIER1_THRESHOLD_PCT", "70"), 10),
    workerQueueEmergencyMax: parseInt(envOrDefault("WORKER_QUEUE_EMERGENCY_MAX", "500"), 10),
    workerQueueInDialogMax: parseInt(envOrDefault("WORKER_QUEUE_INDIALOG_MAX", "400"), 10),
    workerQueueNewCallMax: parseInt(envOrDefault("WORKER_QUEUE_NEWCALL_MAX", "100"), 10),
    workerInDialogFullKillAfterMs: parseInt(envOrDefault("WORKER_INDIALOG_FULL_KILL_AFTER_MS", "60000"), 10),
    cpsBucketSize: parseInt(envOrDefault("CPS_BUCKET_SIZE", "1000"), 10),
    cpsBucketRate: parseInt(envOrDefault("CPS_BUCKET_RATE", "500"), 10),
    overloadLoopLagSoftMs: parseInt(envOrDefault("OVERLOAD_LOOP_LAG_SOFT_MS", "50"), 10),
    overloadLoopLagHardMs: parseInt(envOrDefault("OVERLOAD_LOOP_LAG_HARD_MS", "200"), 10),
    overloadRoutingNewCallSoftMs: parseInt(envOrDefault("OVERLOAD_ROUTING_NEWCALL_SOFT_MS", "200"), 10),
    overloadRoutingNewCallHardMs: parseInt(envOrDefault("OVERLOAD_ROUTING_NEWCALL_HARD_MS", "1000"), 10),
    retryAfterBaseSec: parseInt(envOrDefault("RETRY_AFTER_BASE_SEC", "5"), 10),
    retryAfterJitterSec: parseInt(envOrDefault("RETRY_AFTER_JITTER_SEC", "5"), 10),
    emergencyListenerEnabled: envOrDefault("EMERGENCY_LISTENER_ENABLED", "false") === "true",
    emergencyListenerHost: envOrDefault("EMERGENCY_LISTENER_HOST", "127.0.0.1"),
    emergencyListenerPort: parseInt(envOrDefault("EMERGENCY_LISTENER_PORT", "5070"), 10),
    referSubscriptionExpirySec: parseInt(envOrDefault("REFER_SUBSCRIPTION_EXPIRY_SEC", "60"), 10),
    referReinviteAnswerSec: parseInt(envOrDefault("REFER_REINVITE_ANSWER_SEC", "32"), 10),
    referOverallSafetySec: parseInt(envOrDefault("REFER_OVERALL_SAFETY_SEC", "120"), 10),
    scrubHeaders: envOrDefault("SCRUB_HEADERS", "Authorization,Proxy-Authorization")
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0),
    otelMaxAttributeValueLength: parseInt(envOrDefault("OTEL_MAX_ATTRIBUTE_VALUE_LENGTH", "32768"), 10),
    traceTombstoneEnabled: envOrDefault("TRACE_TOMBSTONE_ENABLED", "true") === "true"
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AppConfig extends ServiceMap.Service<
  AppConfig,
  AppConfigData
>()("@sipjsserver/AppConfig") {
  static readonly layer = Layer.sync(AppConfig, () => readConfigFromEnv())
}
