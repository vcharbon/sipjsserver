/**
 * Shared AppConfigData factory for tests. Avoids the (M1) duplication that
 * used to live in both `tests/sip/UdpTransport-brake.test.ts` and
 * `tests/fullcall/framework/simulated-backend.ts` — two independent copies of
 * the same ~40 fields that drifted whenever a new AppConfig entry landed.
 *
 * Deliberately kept in `tests/support/`, not `src/`. Test fixtures don't
 * ship with prod; keeping them next to the test tree (and out of the
 * service boundary) prevents accidental production reuse.
 */

import type { AppConfigData } from "../config/AppConfig.js"

/**
 * Return a sensible default AppConfigData for in-memory / fake-stack tests.
 * Callers override only the fields they care about for their scenario.
 *
 * Redis-related fields still have production-shaped values so live-stack
 * tests that point at a real Redis can use the same baseline.
 */
export function testAppConfigDefaults(overrides?: Partial<AppConfigData>): AppConfigData {
  return {
    sipLocalIp: "127.0.0.1",
    sipLocalPort: 15060,
    sipUdpStack: "js",
    workerServiceName: "b2bua-worker",
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    limiterRedisUrl:
      process.env.LIMITER_REDIS_URL ??
      process.env.REDIS_URL ??
      "redis://localhost:6379",
    redisKeyPrefix: `test-${Date.now()}`,
    limiterWindowSeconds: 300,
    limiterActiveWindows: 3,
    limiterTtlSeconds: 1200,
    noAnswerTimeoutSec: 30,
    keepaliveIntervalSec: 900,
    keepaliveTimeoutSec: 10,
    callMaxDurationSec: 7200,
    cdrFilePath: "/tmp/test-cdr.jsonl",
    httpStatusPort: 13002,
    callControlUrl: "http://localhost:13002",
    callControlNewCallTimeoutMs: 5000,
    callControlFailureTimeoutMs: 5000,
    callControlReferTimeoutMs: 5000,
    eventHandlerTimeoutMs: 10000,
    timerHandlerTimeoutMs: 5000,
    maxMessagesPerCall: 100,
    redisFlushIdleMs: 2000,
    traceSampleRate: 0,
    otelTracesUrl: "http://localhost:4318/v1/traces",
    clusterWorkers: 0,
    workerIndex: -1,
    callContextTtlSec: 1800,
    callCleanupDelaySec: 0,
    udpQueueMax: 100,
    udpQueueTier1ThresholdPct: 70,
    workerQueueEmergencyMax: 500,
    workerQueueInDialogMax: 400,
    workerQueueNewCallMax: 100,
    workerInDialogFullKillAfterMs: 60000,
    cpsBucketSize: 1000,
    cpsBucketRate: 500,
    overloadLoopLagSoftMs: 50,
    overloadLoopLagHardMs: 200,
    overloadRoutingNewCallSoftMs: 200,
    overloadRoutingNewCallHardMs: 1000,
    overloadPanicEluThreshold: 0.75,
    retryAfterBaseSec: 5,
    retryAfterJitterSec: 5,
    emergencyListenerEnabled: false,
    emergencyListenerHost: "127.0.0.1",
    emergencyListenerPort: 5070,
    referSubscriptionExpirySec: 60,
    referReinviteAnswerSec: 32,
    referOverallSafetySec: 120,
    otelMaxAttributeValueLength: 32768,
    scrubHeaders: [],
    workerAllowedTargetSuffixes: ["*"],
    // Sequential ingress under fake clock — same reason as the buffered
    // send below: concurrent stream processing interacts poorly with
    // TestClock determinism. Production defaults to 16.
    proxyIngressConcurrency: 1,
    // Disable the BufferedUdpEndpoint wrapper in fake-clock tests:
    // its per-peer drainer fiber adds a scheduler hop between offer and
    // inner.send, which interacts poorly with TestClock quiescence
    // detection and the scenario's hand-tuned `s.pause(...)` windows.
    // Production wires the wrapper on (default value in AppConfig is 32).
    bufferedSendPerPeerQueueMax: 0,
    bufferedSendIdleTtlMs: 3_600_000,
    bufferedSendMaxPeers: 10_000,
    bufferedSendSweepIntervalMs: 600_000,
    // 0 = direct (un-buffered) CDR writer for fake-clock determinism.
    // Production sets >0 so disk pressure can't stall the worker.
    cdrBufferQueueMax: 0,
    // Same opt-out for the terminate-path Redis buffer. Fake-clock
    // tests want every storage delete in the same fiber as the call.
    storageBufferQueueMax: 0,
    storageBufferDrainers: 4,
    storageDropFallbackMs: 1000,
    limiterDecrementTimeoutMs: 1000,
    eventDispatchConcurrency: 1024,
    perCallQueueCap: 200_000,
    perCallQueueDepth: 64,
    traceTombstoneEnabled: false,
    replicationBootstrapTimeoutMs: 30_000,
    ...overrides,
  }
}
