/**
 * Centralised application configuration read from environment variables.
 */

import { Layer, Schema, ServiceMap } from "effect"
import { TERMINATING_TIMEOUT_MS } from "../call/timer-helpers.js"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AppConfigData = Schema.Struct({
  sipLocalIp: Schema.String,
  sipLocalPort: Schema.Int,
  redisUrl: Schema.String,
  /**
   * Redis URL for the **call limiter**. In an HA deployment with per-pod
   * sidecar Redis for call context (`docs/replication/call-cache-backup.md`),
   * the limiter MUST point at a separate cluster-shared Redis — otherwise
   * each worker's counter is independent and limits are not enforced
   * cluster-wide. Sourced from `LIMITER_REDIS_URL`; falls back to
   * `redisUrl` with a startup warning when unset.
   */
  limiterRedisUrl: Schema.String,
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
  /** Per-method adapter timeouts (ms). Used by HttpReferenceAdapter. */
  callControlNewCallTimeoutMs: Schema.Int,
  callControlFailureTimeoutMs: Schema.Int,
  callControlReferTimeoutMs: Schema.Int,
  /**
   * Per-event safety timeout applied to every `withCall` invocation in the
   * `SipRouter` consumer loop. Catches handler hangs that would otherwise
   * stall the event pump without surfacing in metrics. Must be greater
   * than the largest legitimate handler latency (the call-control HTTP
   * client timeouts above), so 10 s is the conservative default.
   */
  eventHandlerTimeoutMs: Schema.Int,
  /**
   * Per-timer safety timeout for the body of every fired timer. Timers
   * never call into the controller adapter, so a tighter bound is fine.
   * Tripping this counter ≠ a bug per se, but a sustained non-zero rate
   * means rule-chain handlers are doing more work than expected.
   */
  timerHandlerTimeoutMs: Schema.Int,
  redisFlushIdleMs: Schema.Int,
  traceSampleRate: Schema.Number,
  otelTracesUrl: Schema.String,
  /** Number of worker processes (0 = standalone, no clustering). */
  clusterWorkers: Schema.Int,
  /** This worker's index (set by dispatcher in child process env). -1 = standalone. */
  workerIndex: Schema.Int,
  /**
   * Stable string identifier for this worker — matches the `WorkerId`
   * the proxy uses in stickiness cookies. In production K8s this is
   * the StatefulSet pod hostname (e.g. `b2bua-worker-1`). When set,
   * `CallState`/`SipRouter` use this as the partition `owner` and the
   * dual-write `self` ordinal; when unset, falls back to
   * `String(workerIndex)` (legacy single-worker tests / dev).
   *
   * Slice 5 of the HA-resilience plan (D7 / D15).
   */
  workerOrdinalLabel: Schema.optional(Schema.String),
  /**
   * K8s namespace this worker pod runs in — required for the
   * headless-StatefulSet peer discovery used by the data-replication
   * layer (`PeerEnumerator.headlessStatefulSet`,
   * `PeerEndpointResolver.headlessStatefulSet`). Sourced from the
   * downward API (`fieldRef: metadata.namespace`).
   *
   * When unset (single-node / dev / non-K8s deployments), the worker
   * skips boot-time peer discovery entirely — `ReadyGate` is bypassed
   * and no `ReplPuller` fibers are forked. The B2BUA still starts and
   * serves SIP locally; just without cross-pod replication.
   */
  k8sNamespace: Schema.optional(Schema.String),
  /**
   * Headless-StatefulSet service name peer workers resolve through
   * (`<pod>.<workerServiceName>.<k8sNamespace>.svc.cluster.local`).
   * Defaults to `b2bua-worker` — matches the chart's `fullname`
   * template result in the typical deployment.
   */
  workerServiceName: Schema.String,
  /** TTL for Redis call context keys (seconds). Derived as keepaliveIntervalSec * 2. */
  callContextTtlSec: Schema.Int,
  /** Delay before deleting Redis keys after call termination (seconds). Covers SIP retransmissions. */
  callCleanupDelaySec: Schema.Int,

  // ── Overload protection ───────────────────────────────────────────────
  /** Bounded UDP recv queue capacity. Formula: 2 × target_cps × 0.1 (≈100ms buffer). */
  udpQueueMax: Schema.Int,
  /** Tier 1 emergency brake activation threshold (% of udpQueueMax). */
  udpQueueTier1ThresholdPct: Schema.Int,

  /**
   * SIP UDP stack selector — picks between the JS dgram + custom TS parser
   * pipeline ("js", the legacy default) and the native Rust pipeline
   * ("native") that owns the UDP socket, runs the Tier-1 brake in Rust,
   * parses inline, and emits pre-parsed messages over a threadsafe channel.
   *
   * Both stacks satisfy the same `SignalingNetwork` contract, so the same
   * binary can be deployed twice — one pod per stack — for endurance and
   * robustness A/B comparison. Sourced from `SIP_UDP_STACK`. Defaults to
   * "js" so existing deployments are unaffected.
   */
  sipUdpStack: Schema.Literals(["js", "native"]),
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
  /**
   * Panic threshold (0..1) on the worker's own EWMA-smoothed ELU.
   * Above this, non-emergency INVITEs are 503'd locally regardless of
   * the LB's AIMD cap. Slice 7 of the overload rework.
   */
  overloadPanicEluThreshold: Schema.Number,
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

  // ── B-leg target admission (DoS hardening) ────────────────────────────
  /**
   * Suffix allow-list for b-leg destination hosts returned by call-control.
   * A host is admitted when it is an IP literal OR ends with one of these
   * suffixes (case-insensitive). The literal `"*"` in the list disables
   * admission entirely (rollback sentinel). Default `.svc.cluster.local`
   * is the K8s in-cluster DNS suffix — production traffic should always
   * pass; bogus hostnames (typos, dev `/etc/hosts` entries) get rejected
   * with a 503 before any per-peer state is allocated.
   */
  workerAllowedTargetSuffixes: Schema.Array(Schema.String),

  // ── Proxy ingress concurrency ─────────────────────────────────────────
  /**
   * Concurrency for the proxy's per-endpoint ingress stream. Default 16:
   * a slow handler on one packet (rule chain, GC, occasional DNS slip)
   * no longer wedges every subsequent packet behind it. Set to 1 to
   * collapse to legacy sequential behavior.
   *
   * Known limitation: with concurrency > 1, an INVITE-CANCEL race can
   * surface as a CANCEL processed before its INVITE's `cancelLru.remember`.
   * In registrar mode this returns 481 instead of forwarding (LB mode falls
   * back to selectForNewDialog). The race window is microseconds for normal
   * traffic; future work may add per-Call-ID serialization via
   * `Stream.groupByKey`.
   */
  proxyIngressConcurrency: Schema.Int,

  // ── BufferedUdpEndpoint (non-blocking outbound send) ──────────────────
  /** Per-peer outbound queue capacity. Drop-newest on overflow. */
  bufferedSendPerPeerQueueMax: Schema.Int,
  /** A peer with no successful drain in this window is reclaimed. */
  bufferedSendIdleTtlMs: Schema.Int,
  /** Hard ceiling on total per-peer entries; new-peer creation evicts. */
  bufferedSendMaxPeers: Schema.Int,
  /** Cadence of the idle-reclamation sweeper. */
  bufferedSendSweepIntervalMs: Schema.Int,

  // ── BufferedCdrLayer (non-blocking CDR write) ──────────────────────────
  /**
   * Bounded queue capacity for the CDR drainer. `0` selects the direct
   * (un-buffered) writer — used by fake-clock tests to keep CDR writes in
   * the same fiber as the call termination. Production sets this >0 so
   * NDJSON `appendFile` cannot stall a worker on disk pressure.
   * Drop-on-overload is acceptable for CDR — losing a billing line is
   * preferable to stalling call termination.
   */
  cdrBufferQueueMax: Schema.Int,

  // ── BufferedTerminateWriter (non-blocking terminate-path Redis I/O) ────
  /**
   * Bounded queue capacity for the terminate-path Redis drainer pool.
   * `0` selects the direct path (no buffering) — used by fake-clock
   * tests. Production wraps Redis deleteCall/terminate-putCall here so
   * a stalled Redis cannot pin the call-eviction step.
   */
  storageBufferQueueMax: Schema.Int,
  /** Drainer fiber count for the terminate-path buffer. */
  storageBufferDrainers: Schema.Int,
  /**
   * Fall-through timeout when the buffer queue is full. State writes
   * cannot be dropped silently — fall back to a direct call bounded by
   * this timeout, catchTag(StorageError, log) on failure.
   */
  storageDropFallbackMs: Schema.Int,

  // ── Limiter DECR bound (Phase 7 — Trap 4) ──────────────────────────────
  /**
   * Per-item timeout for `limiter.decrement` on the terminate path.
   * The limiter window rotation is self-repairing — a missed decrement
   * leaks at most one window — so this can stay short. Trap 4 forbids
   * wrapping DECR in `ensuring`: that would convert a slow Redis hang
   * into an un-killable call-eviction stall.
   */
  limiterDecrementTimeoutMs: Schema.Int,

  // ── Per-call event dispatch (ADR-0004) ────────────────────────────────
  /**
   * Maximum total in-flight per-call event handlers across all worker
   * fibers. A bounded global semaphore caps how many distinct call
   * handlers can be running at once; one slow handler can stall its own
   * call but never blocks others.
   *
   * Justification (Q2 of the per-call FIFO plan): 100 CAPS × 10 s
   * worst-case slow downstream → ~1000 concurrent handlers, default 1024
   * leaves headroom for INVITE-storm spikes. Per-call FIFO is enforced
   * structurally by the per-callRef queue — overlap between events for
   * the same call is impossible.
   */
  eventDispatchConcurrency: Schema.Int,

  /**
   * Hard cap on the number of per-callRef queues the dispatcher will
   * track. Router refuses to lazy-create new queues past this cap and
   * increments `dispatch_worker_cap_drops` instead. Worst case heap at
   * cap: ~400 MB (200 K × ~2 KB per fiber + queue overhead).
   */
  perCallQueueCap: Schema.Int,

  /**
   * Per-call queue depth. A single call's events queueing past this
   * depth indicates either a stuck handler or a flooding peer; new
   * events are dropped and counted via `dispatch_queue_drops_total`.
   * A healthy call only ever has 0-1 events queued.
   */
  perCallQueueDepth: Schema.Int,

  // ── Tracing ───────────────────────────────────────────────────────────
  /** Header names whose values are redacted in sip.raw_message span attributes. */
  scrubHeaders: Schema.Array(Schema.String),
  /** Max span attribute value length (bytes) passed to OTel SDK spanLimits. */
  otelMaxAttributeValueLength: Schema.Int,
  /** Emit tombstone spans (call.started / call.ended) for non-sampled calls. */
  traceTombstoneEnabled: Schema.Boolean,

  // ── Outbound proxy (B-leg through SIP front proxy) ────────────────────
  /**
   * Optional ingress address of the SIP front proxy in deployments where
   * the worker sits *behind* it. When set, every B-leg dialog-creating
   * outbound (initial INVITE, REFER, …) is sent to this address with a
   * pre-loaded `Route: <sip:host:port;lr;outbound>` header rather than
   * directly to the controller-supplied `route.destination` (Bob).
   *
   * This lets the proxy:
   *   1. Insert its stickiness-cookie Record-Route on the B-leg too, so
   *      Bob-initiated in-dialog requests route back to the originating
   *      worker via the same cookie-decode path used on the A-leg.
   *   2. Serve as the only edge external peers ever see — survives worker
   *      restarts/draining without leaving the peer talking to a dead
   *      socket.
   *
   * Topology, not call routing. Wire-level egress only. The HTTP
   * controller's `route.destination` (logical truth) is unchanged; only
   * the wire-level send rewrites to the proxy.
   *
   * Source: `B2B_OUTBOUND_PROXY=<host>:<port>` env var; absent in
   * standalone-worker deployments. Tests inject it via
   * `proxyB2bFakeStack`.
   */
  b2bOutboundProxy: Schema.optional(Schema.Struct({
    host: Schema.String,
    port: Schema.Int,
  })),

  /**
   * Overall budget for peer-scan-bootstrap at worker boot. Counts wall
   * time across all parallel per-peer scans; once exhausted, remaining
   * peers' bootstrap attempts are abandoned and the worker proceeds to
   * start its puller fibers. See
   * docs/plan/echo-removal-grill-me-smooth-parasol.md §3.
   */
  replicationBootstrapTimeoutMs: Schema.Int,
})

export type AppConfigData = typeof AppConfigData.Type

// ---------------------------------------------------------------------------
// Env reader helper
// ---------------------------------------------------------------------------

function envOrDefault(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

function parseB2bOutboundProxy(): AppConfigData["b2bOutboundProxy"] {
  const raw = process.env["B2B_OUTBOUND_PROXY"]
  if (raw === undefined || raw.length === 0) return undefined
  const idx = raw.lastIndexOf(":")
  if (idx <= 0) return undefined
  const host = raw.slice(0, idx)
  const port = parseInt(raw.slice(idx + 1), 10)
  if (!Number.isFinite(port) || port <= 0) return undefined
  return { host, port }
}

/**
 * Resolve the worker's stable identifier — matches the `WorkerId` the
 * proxy stamps into stickiness cookies. Order of precedence:
 *   1. `WORKER_ORDINAL_LABEL` (explicit override; tests / non-K8s).
 *   2. `POD_NAME`             (K8s downward API: StatefulSet pod hostname).
 *   3. `HOSTNAME`             (every Linux container has this).
 * Returns `undefined` (no override) when none of the above are set —
 * downstream consumers fall back to `String(workerIndex)` then `"self"`.
 */
function resolveWorkerOrdinalLabel(): string | undefined {
  const explicit = process.env["WORKER_ORDINAL_LABEL"]
  if (explicit !== undefined && explicit.length > 0) return explicit
  const podName = process.env["POD_NAME"]
  if (podName !== undefined && podName.length > 0) return podName
  const hostname = process.env["HOSTNAME"]
  if (hostname !== undefined && hostname.length > 0) return hostname
  return undefined
}

/**
 * Resolve which SIP UDP stack this worker should run. Precedence:
 *   1. `SIP_UDP_STACK` — explicit `js` or `native`; wins outright.
 *   2. `SIP_UDP_STACK_BY_ORDINAL` — comma-separated list indexed by the
 *      worker's StatefulSet ordinal (parsed from `POD_NAME` /
 *      `WORKER_ORDINAL_LABEL` / `HOSTNAME`). Used by the K8s endurance
 *      A/B default so b2bua-worker-0 runs `js` and b2bua-worker-1 runs
 *      `native` from the same image without per-pod manifests.
 *   3. Default — `js` (current production pipeline).
 *
 * Exported so `main.ts` and `AppConfig.readConfigFromEnv` agree on the
 * resolved value; the layer selection in `main.ts` runs at module-eval
 * time before AppConfig has materialised.
 */
export function resolveSipUdpStack(): "js" | "native" {
  const direct = process.env["SIP_UDP_STACK"]
  if (direct === "native") return "native"
  if (direct === "js") return "js"

  const byOrdinal = process.env["SIP_UDP_STACK_BY_ORDINAL"]
  if (byOrdinal !== undefined && byOrdinal.length > 0) {
    const stacks = byOrdinal
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const label = resolveWorkerOrdinalLabel() ?? ""
    const m = label.match(/-(\d+)$/)
    if (m !== null && stacks.length > 0) {
      const ord = parseInt(m[1]!, 10)
      const picked = stacks[ord % stacks.length]
      if (picked === "native") return "native"
      if (picked === "js") return "js"
    }
  }
  return "js"
}

function readConfigFromEnv(): AppConfigData {
  const outbound = parseB2bOutboundProxy()
  const ordinal = resolveWorkerOrdinalLabel()
  const namespace = process.env["K8S_NAMESPACE"]
  return {
    sipLocalIp: envOrDefault("SIP_LOCAL_IP", "127.0.0.1"),
    sipLocalPort: parseInt(envOrDefault("SIP_LOCAL_PORT", "5060"), 10),
    redisUrl: envOrDefault("REDIS_URL", "redis://localhost:6379"),
    limiterRedisUrl:
      process.env["LIMITER_REDIS_URL"] ??
      envOrDefault("REDIS_URL", "redis://localhost:6379"),
    redisKeyPrefix: envOrDefault("REDIS_KEY_PREFIX", "sipas"),
    limiterWindowSeconds: parseInt(envOrDefault("LIMITER_WINDOW_SECONDS", "300"), 10),
    limiterActiveWindows: parseInt(envOrDefault("LIMITER_ACTIVE_WINDOWS", "3"), 10),
    limiterTtlSeconds: parseInt(envOrDefault("LIMITER_TTL_SECONDS", "1200"), 10),
    noAnswerTimeoutSec: parseInt(envOrDefault("NO_ANSWER_TIMEOUT_SEC", "30"), 10),
    keepaliveIntervalSec: parseInt(envOrDefault("KEEPALIVE_INTERVAL_SEC", "300"), 10),
    keepaliveTimeoutSec: parseInt(envOrDefault("KEEPALIVE_TIMEOUT_SEC", "10"), 10),
    callMaxDurationSec: parseInt(envOrDefault("CALL_MAX_DURATION_SEC", "7200"), 10),
    cdrFilePath: envOrDefault("CDR_FILE_PATH", "/tmp/cdr.jsonl"),
    httpStatusPort: parseInt(envOrDefault("HTTP_STATUS_PORT", "3002"), 10),
    callControlUrl: envOrDefault("CALL_CONTROL_URL", "http://localhost:3002"),
    callControlNewCallTimeoutMs: parseInt(envOrDefault("CALL_CONTROL_NEW_CALL_TIMEOUT_MS", "5000"), 10),
    callControlFailureTimeoutMs: parseInt(envOrDefault("CALL_CONTROL_FAILURE_TIMEOUT_MS", "5000"), 10),
    callControlReferTimeoutMs: parseInt(envOrDefault("CALL_CONTROL_REFER_TIMEOUT_MS", "5000"), 10),
    eventHandlerTimeoutMs: parseInt(envOrDefault("EVENT_HANDLER_TIMEOUT_MS", "10000"), 10),
    timerHandlerTimeoutMs: parseInt(envOrDefault("TIMER_HANDLER_TIMEOUT_MS", "5000"), 10),
    redisFlushIdleMs: parseInt(envOrDefault("REDIS_FLUSH_IDLE_MS", "2000"), 10),
    traceSampleRate: parseFloat(envOrDefault("TRACE_SAMPLE_RATE", "1.0")),
    otelTracesUrl: envOrDefault("OTEL_TRACES_URL", "http://localhost:4318/v1/traces"),
    clusterWorkers: parseInt(envOrDefault("CLUSTER_WORKERS", "0"), 10),
    workerIndex: parseInt(envOrDefault("WORKER_INDEX", "-1"), 10),
    callContextTtlSec: parseInt(envOrDefault("KEEPALIVE_INTERVAL_SEC", "300"), 10) * 2,
    callCleanupDelaySec: 32,
    udpQueueMax: parseInt(envOrDefault("UDP_QUEUE_MAX", "100"), 10),
    udpQueueTier1ThresholdPct: parseInt(envOrDefault("UDP_QUEUE_TIER1_THRESHOLD_PCT", "70"), 10),
    sipUdpStack: resolveSipUdpStack(),
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
    overloadPanicEluThreshold: Number.parseFloat(envOrDefault("OVERLOAD_PANIC_ELU_THRESHOLD", "0.75")),
    retryAfterBaseSec: parseInt(envOrDefault("RETRY_AFTER_BASE_SEC", "5"), 10),
    retryAfterJitterSec: parseInt(envOrDefault("RETRY_AFTER_JITTER_SEC", "5"), 10),
    emergencyListenerEnabled: envOrDefault("EMERGENCY_LISTENER_ENABLED", "false") === "true",
    emergencyListenerHost: envOrDefault("EMERGENCY_LISTENER_HOST", "127.0.0.1"),
    emergencyListenerPort: parseInt(envOrDefault("EMERGENCY_LISTENER_PORT", "5070"), 10),
    referSubscriptionExpirySec: parseInt(envOrDefault("REFER_SUBSCRIPTION_EXPIRY_SEC", "60"), 10),
    referReinviteAnswerSec: parseInt(envOrDefault("REFER_REINVITE_ANSWER_SEC", "32"), 10),
    referOverallSafetySec: parseInt(envOrDefault("REFER_OVERALL_SAFETY_SEC", "120"), 10),
    workerAllowedTargetSuffixes: envOrDefault(
      "WORKER_ALLOWED_TARGET_SUFFIXES",
      ".svc.cluster.local",
    )
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    proxyIngressConcurrency: parseInt(envOrDefault("PROXY_INGRESS_CONCURRENCY", "16"), 10),
    bufferedSendPerPeerQueueMax: parseInt(envOrDefault("BUFFERED_SEND_PER_PEER_QUEUE_MAX", "32"), 10),
    bufferedSendIdleTtlMs: parseInt(envOrDefault("BUFFERED_SEND_IDLE_TTL_MS", "5000"), 10),
    bufferedSendMaxPeers: parseInt(envOrDefault("BUFFERED_SEND_MAX_PEERS", "10000"), 10),
    bufferedSendSweepIntervalMs: parseInt(envOrDefault("BUFFERED_SEND_SWEEP_INTERVAL_MS", "1000"), 10),
    cdrBufferQueueMax: parseInt(envOrDefault("CDR_BUFFER_QUEUE_MAX", "10000"), 10),
    storageBufferQueueMax: parseInt(envOrDefault("STORAGE_BUFFER_QUEUE_MAX", "10000"), 10),
    storageBufferDrainers: parseInt(envOrDefault("STORAGE_BUFFER_DRAINERS", "4"), 10),
    storageDropFallbackMs: parseInt(envOrDefault("STORAGE_DROP_FALLBACK_MS", "1000"), 10),
    limiterDecrementTimeoutMs: parseInt(envOrDefault("LIMITER_DECREMENT_TIMEOUT_MS", "1000"), 10),
    eventDispatchConcurrency: parseInt(envOrDefault("EVENT_DISPATCH_CONCURRENCY", "1024"), 10),
    perCallQueueCap: parseInt(envOrDefault("PER_CALL_QUEUE_CAP", "200000"), 10),
    perCallQueueDepth: parseInt(envOrDefault("PER_CALL_QUEUE_DEPTH", "64"), 10),
    scrubHeaders: envOrDefault("SCRUB_HEADERS", "Authorization,Proxy-Authorization")
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0),
    otelMaxAttributeValueLength: parseInt(envOrDefault("OTEL_MAX_ATTRIBUTE_VALUE_LENGTH", "32768"), 10),
    traceTombstoneEnabled: envOrDefault("TRACE_TOMBSTONE_ENABLED", "true") === "true",
    ...(outbound !== undefined ? { b2bOutboundProxy: outbound } : {}),
    ...(ordinal !== undefined ? { workerOrdinalLabel: ordinal } : {}),
    ...(namespace !== undefined && namespace.length > 0
      ? { k8sNamespace: namespace }
      : {}),
    workerServiceName: envOrDefault("WORKER_SERVICE_NAME", "b2bua-worker"),
    replicationBootstrapTimeoutMs: parseInt(
      envOrDefault("REPLICATION_BOOTSTRAP_TIMEOUT_MS", "30000"),
      10
    ),
  }
}

// ---------------------------------------------------------------------------
// Cross-field validation
// ---------------------------------------------------------------------------

/**
 * The `terminating_timeout` safety net must exceed the longest expected
 * gap between peer activity by a comfortable margin. Otherwise a routine
 * silent interval (an OPTIONS keepalive cycle, a session-timer refresh
 * window) gets mistaken for "this call is dead" and the orphan sweep
 * force-purges live dialogs. See ADR-0004 and plan
 * docs/plan/to-review-and-properly-swift-moler.md Stage 4.
 *
 * Throws so the worker refuses to start on inconsistent configuration
 * — the platform must never run with this gate misconfigured.
 */
export function validateTerminatingTimeoutConsistency(cfg: AppConfigData): void {
  const requiredMs = cfg.keepaliveIntervalSec * 1000 + 60_000
  if (TERMINATING_TIMEOUT_MS <= requiredMs) {
    throw new Error(
      `Inconsistent config: TERMINATING_TIMEOUT_MS (${TERMINATING_TIMEOUT_MS}) ` +
        `must exceed keepaliveIntervalSec*1000 + 60000 (${requiredMs}). ` +
        `Bump TERMINATING_TIMEOUT_MS in src/call/timer-helpers.ts or lower ` +
        `KEEPALIVE_INTERVAL_SEC.`,
    )
  }
}

/**
 * Cluster-mode workers MUST route b-leg outbound traffic through the LB
 * proxy. The proxy is the single point that owns failover-aware routing
 * (cookie-decode, dead-worker promotion to backup); a worker that sends
 * b-leg INVITEs direct to bob bypasses this guarantee and the bob-side
 * responses + in-dialog requests have no path back to a healthy worker
 * when the original primary dies. The "direct to bob" path is reserved
 * for the basic standalone single-b2b deployment.
 *
 * Detection signal: `clusterWorkers > 0` (set via `CLUSTER_WORKERS`).
 * Single-node deployments leave it at 0 and bypass this gate.
 *
 * Throws so a misconfigured cluster worker refuses to boot.
 */
export function validateClusterModeOutboundProxy(cfg: AppConfigData): void {
  if (cfg.clusterWorkers > 0 && cfg.b2bOutboundProxy === undefined) {
    throw new Error(
      `Inconsistent config: CLUSTER_WORKERS=${cfg.clusterWorkers} (cluster mode) but ` +
        `B2B_OUTBOUND_PROXY is unset. Cluster-mode workers MUST route b-leg ` +
        `outbound traffic through the LB proxy so bob-side responses and ` +
        `in-dialog requests have a single failover-aware routing point ` +
        `(see docs/lb-proxy-ha.md). Set B2B_OUTBOUND_PROXY=<host>:<port> ` +
        `or unset CLUSTER_WORKERS to run as a standalone single-b2b worker.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AppConfig extends ServiceMap.Service<
  AppConfig,
  AppConfigData
>()("@sipjsserver/AppConfig") {
  static readonly layer = Layer.sync(AppConfig, () => {
    const cfg = readConfigFromEnv()
    validateTerminatingTimeoutConsistency(cfg)
    validateClusterModeOutboundProxy(cfg)
    return cfg
  })
}
