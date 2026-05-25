/**
 * stackLayer — unified B2BUA stack builder for fake-clock and live-clock
 * tests. Replaces the parallel `fakeStack.ts` / `liveStack.ts` modules;
 * those two now ship as thin transitional re-exports that forward to
 * `stackLayer({ mode: "fake" | "live" })`.
 *
 * Composition, bottom-up:
 *
 *   - `Recorder.fake` or `Recorder.live`     — typed-channel recording
 *       surface; the audit wrappers per Tag read from this.
 *   - `RunContext.testWithRecorder`          — drives wrapper severity tier
 *       (D5: deferred-fail in tests, advisory in real-run).
 *   - `AppConfig`, `MetricsRegistry`         — leaves shared everywhere.
 *   - `SignalingNetwork`                     — fake-mode pipes
 *       `simulated(...)` through `withAllContracts({ scopedAudit })`
 *       gated by `perfMode`; live-mode uses `realTracing()` directly
 *       (real UDP isn't audited the same way — `realTracing` retains
 *       Buffer payloads so reports render hop-by-hop).
 *   - `UdpTransport` bound on the network.
 *   - `CallLimiter`, call-control, tracing, CDR — fake uses
 *       memory/mock/no-op; live uses redis-backed services.
 *   - `OverloadController`, `B2buaCoreLayer` (`SipRouter`,
 *       `TransactionLayer`, `CallState`, `TimerService`, `SipParser`).
 *
 * Sharing rule (same as the old fakeStack.ts comment): every leaf is
 * defined exactly once inside this function, and every consumer that
 * needs it gets it from the same `Leaves` bundle. The `b2buaWorkerStackLayer`
 * helper enforces this internally for fake-mode; live-mode does the
 * same composition explicitly.
 *
 * Tests must not mix modes in a single scenario — that is the whole
 * point of the fake/live split (see CLAUDE.md "Test structure").
 */

import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AppConfig, type AppConfigData } from "../../src/config/AppConfig.js"
import { CallLimiter } from "../../src/call/CallLimiter.js"
import { withAllContracts as withCallLimiterContracts } from "../../src/call/CallLimiter.contracts.js"
import { PartitionedRelayStorage } from "../../src/cache/PartitionedRelayStorage.js"
import { EpochCounter } from "../../src/replication/EpochCounter.js"
import { CdrWriter } from "../../src/cdr/CdrWriter.js"
import { BufferedTerminateWriter } from "../../src/cache/BufferedTerminateWriter.js"
import { MetricsRegistry } from "../../src/observability/MetricsRegistry.js"
import { LoadSampler } from "../../src/observability/LoadSampler.js"
import { OverloadController } from "../../src/b2bua/OverloadController.js"
import { RedisClient } from "../../src/redis/RedisClient.js"
import { SignalingNetwork } from "../../src/sip/SignalingNetwork.js"
import {
  withAllContracts as withSignalingNetworkContracts,
  type ScopedAuditOptions as SignalingNetworkScopedAuditOptions,
} from "../../src/sip/SignalingNetwork.contracts.js"
import { withAllContracts as withPartitionedRelayStorageContracts } from "../../src/cache/PartitionedRelayStorage.contracts.js"
import { TracingService } from "../../src/tracing/TracingService.js"
import { TracerHealthSignal } from "../../src/observability/tracer-health.js"
import { UdpTransport } from "../../src/sip/UdpTransport.js"
import { B2buaCoreLayer } from "../../src/b2bua/B2buaCore.js"
import { DrainingState } from "../../src/b2bua/DrainingState.js"
import { WorkerReadiness } from "../../src/cache/WorkerReadiness.js"
import { HttpReferenceAdapterLayer } from "../../src/decision/adapters/http-reference/HttpReferenceAdapter.js"
import { Recorder } from "../../src/test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../../src/test-harness/framework/RunContext.js"
import { SipHarness } from "../../src/test-harness/framework/SipHarness.js"
import { b2buaWorkerStackLayer, NoOpCdrLayer, NoOpTracingLayer } from "./networkLeaves.js"
import { PumpableClockLayer } from "./PumpableClock.js"
import { basePeerRules } from "../harness/rules/rfc/starter-peer-rules.js"
import { crossMessagePeerRules } from "../harness/rules/rfc/cross-message-rules.js"

/**
 * Default simulated-network transit delay — picked high enough to expose
 * races across forked delivery fibers but low enough that TestClock
 * advances stay cheap. Only meaningful in `mode: "fake"`.
 */
export const DEFAULT_TRANSIT_DELAY_MS = 15

export { NoOpCdrLayer, NoOpTracingLayer, Recorder }

/**
 * `perfMode` toggles between three configurations consumed by D11's
 * perf checkpoints (fake mode only):
 *   - `baseline`: no wrappers (raw `SignalingNetwork.simulated`).
 *   - `no-audit`: wrappers active, zero rules.
 *   - `full`:     wrappers + the five starter peer rules.
 *
 * Defaults to `full` so every existing test runs against the audited
 * stack without opting in.
 */
export type StackPerfMode = "baseline" | "no-audit" | "full"

export interface FakeModeOpts {
  readonly mode: "fake"
  readonly config: AppConfigData
  readonly transitDelayMs?: number
  readonly realClock?: boolean
  readonly perfMode?: StackPerfMode
  /**
   * Extra peer rules added on top of the default starter pack. Used by
   * the canary to seed a known-failing rule without touching the
   * starter pack.
   */
  readonly extraPeerRules?: SignalingNetworkScopedAuditOptions["rules"]
  /**
   * Override the default DUT bind-key exemption. The B2BUA worker
   * rewrites Call-IDs across legs on one socket, which trips per-dialog
   * validators authored against pure UAC/UAS agents — by default this
   * predicate returns `false` for `${sipLocalIp}:${sipLocalPort}` and
   * `true` everywhere else. Tests can pass a custom predicate (e.g. to
   * audit the DUT) without rebuilding the fabric.
   */
  readonly shouldAuditBind?: SignalingNetworkScopedAuditOptions["shouldAuditBind"]
}

export interface LiveModeOpts {
  readonly mode: "live"
  readonly config: AppConfigData
}

export type StackLayerOpts = FakeModeOpts | LiveModeOpts

/**
 * Build the full B2BUA stack for either fake or live mode. Returns a
 * Layer exposing every service the tests need — `Recorder`, the SIP
 * core (`SipRouter`, `TransactionLayer`, `CallState`, `TimerService`,
 * `SipParser`), `SignalingNetwork`, transport, call-control, tracing,
 * CDR, metrics, config, and the readiness/draining test variants.
 */
export function stackLayer(opts: StackLayerOpts) {
  return opts.mode === "fake" ? buildFake(opts) : buildLive(opts)
}

function buildFake(opts: FakeModeOpts) {
  const perfMode = opts.perfMode ?? "full"
  const RecorderLayer = Recorder.fake
  const RunContextLayer = RunContext.testWithRecorder

  const RawNetworkLayer = SignalingNetwork.simulated({
    transitDelayMs: opts.transitDelayMs ?? DEFAULT_TRANSIT_DELAY_MS,
  })

  // Default: exempt the DUT's own bind from per-peer RFC checks. The
  // B2BUA worker terminates multiple call legs on one socket and
  // rewrites Call-IDs across legs, so per-(callId, peer) state runs
  // into legitimate B2BUA behaviour that the `runValidationChecks`
  // validators were authored against pure UAC/UAS agents.
  const dutBindKey = `${opts.config.sipLocalIp}:${opts.config.sipLocalPort}`
  const shouldAuditBind =
    opts.shouldAuditBind ?? ((bindKey: string) => bindKey !== dutBindKey)

  const NetworkLayer = (() => {
    if (perfMode === "baseline") {
      return RawNetworkLayer
    }
    const rules = perfMode === "no-audit"
      ? []
      : [...basePeerRules, ...(opts.extraPeerRules ?? [])]
    const crossMessageRules = perfMode === "no-audit" ? [] : crossMessagePeerRules
    // `no-audit` measures recording-channel overhead only; paranoidInputs
    // adds per-method preconditions that aren't part of the recording cost.
    const paranoidInputs = perfMode !== "no-audit"
    return withSignalingNetworkContracts(RawNetworkLayer, {
      scopedAudit: {
        rules,
        crossMessageRules,
        shouldAuditBind,
      },
      paranoidInputs,
    }).pipe(Layer.provide(Layer.mergeAll(RecorderLayer, RunContextLayer)))
  })()

  const SipHarnessLayer = SipHarness.layer.pipe(Layer.provide(RecorderLayer))

  // PartitionedRelayStorage wrapper. `baseline` skips wrappers entirely;
  // `no-audit` keeps the typed-channel recording but feeds an empty
  // scopedAudit (no rule cost); `full` enables refcount / scan-drained
  // / replication-frame audits.
  const StorageLayer = (() => {
    const raw = PartitionedRelayStorage.memoryLayer
    if (perfMode === "baseline") return raw
    const wrapped = withPartitionedRelayStorageContracts(raw, {
      scopedAudit:
        perfMode === "no-audit"
          ? { checkRefcount: false, checkScanDrained: false }
          : true,
      paranoidInputs: perfMode !== "no-audit",
    })
    return wrapped.pipe(
      Layer.provide(Layer.mergeAll(RecorderLayer, RunContextLayer)),
    )
  })()

  // CallLimiter wrapper. ADR-0004's counter-back-to-zero invariant is
  // enforced at scope close. `baseline` skips wrappers entirely;
  // `no-audit` keeps recording but disables both audit invariants so
  // the perf checkpoint isolates recording-channel overhead.
  const AppConfigLayer = Layer.succeed(AppConfig, opts.config)
  const CallLimiterLayer = (() => {
    const raw = CallLimiter.memoryLayer.pipe(Layer.provide(AppConfigLayer))
    if (perfMode === "baseline") return raw
    const wrapped = withCallLimiterContracts(raw, {
      paranoidInputs: perfMode !== "no-audit",
      scopedAudit:
        perfMode === "no-audit"
          ? {
              checkCounterBackToZero: false,
              checkNoOrphanDecrement: false,
            }
          : true,
    })
    return wrapped.pipe(
      Layer.provide(Layer.mergeAll(RecorderLayer, RunContextLayer)),
    )
  })()

  const base = b2buaWorkerStackLayer({
    config: opts.config,
    storageLayer: StorageLayer,
    limiterLayer: CallLimiterLayer,
  }).pipe(
    Layer.provideMerge(NetworkLayer),
    Layer.provideMerge(SipHarnessLayer),
    Layer.provideMerge(RecorderLayer),
    Layer.provideMerge(RunContextLayer),
  )
  return opts.realClock === true
    ? base
    : base.pipe(Layer.provideMerge(PumpableClockLayer))
}

function buildLive(opts: LiveModeOpts) {
  const AppConfigLayer = Layer.succeed(AppConfig, opts.config)
  const MetricsLayer = MetricsRegistry.layer
  const RecorderLayer = Recorder.live
  const RunContextLayer = RunContext.testWithRecorder

  // `realTracing` (not `real`): the live harness renders hop-by-hop
  // reports via `drainTrace()`. Production layers MUST use `real`
  // (recording disabled) — `realTracing` retains every Buffer payload
  // forever, which leaks under sustained load.
  const NetworkLayer = SignalingNetwork.realTracing()

  const RedisLayer = RedisClient.layer.pipe(Layer.provide(AppConfigLayer))

  // gen derived from Date.now() for live tests (production uses
  // fromKubernetesDownwardAPI).
  const EpochCounterLayer = EpochCounter.fromWallClock("live-test-self")

  const CallStateCacheLayer = Layer.unwrap(
    Effect.gen(function* () {
      const epoch = yield* EpochCounter
      const raw = PartitionedRelayStorage.redisLayer({
        self: "live-test-self",
        gen: epoch.gen,
      })
      // Apply contracts in live mode too — test-time enforcement, not
      // production. Live storage is a real Redis client, so paranoid
      // input checks catch caller-side mistakes early.
      return withPartitionedRelayStorageContracts(raw, {
        scopedAudit: true,
        paranoidInputs: true,
      }).pipe(Layer.provide(Layer.mergeAll(RecorderLayer, RunContextLayer)))
    })
  ).pipe(Layer.provide(RedisLayer), Layer.provide(EpochCounterLayer))
  const RawCallLimiterLayer = CallLimiter.redisLayer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(RedisLayer),
    Layer.provide(MetricsLayer),
  )
  // Apply contracts in live mode too — test-time enforcement, not
  // production. ADR-0004's counter-back-to-zero invariant catches the
  // structural symmetry property; ADR-0007's reconcile bound is
  // observed externally and is not what this audit checks.
  const CallLimiterLayer = withCallLimiterContracts(RawCallLimiterLayer, {
    paranoidInputs: true,
    scopedAudit: true,
  }).pipe(Layer.provide(Layer.mergeAll(RecorderLayer, RunContextLayer)))

  const UdpLayer = UdpTransport.layer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(MetricsLayer),
    Layer.provide(NetworkLayer)
  )

  const OverloadLayer = OverloadController.layer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(MetricsLayer),
    Layer.provide(LoadSampler.liveLayer)
  )

  const CallControlLayer = HttpReferenceAdapterLayer.pipe(
    Layer.provide(AppConfigLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(OverloadLayer)
  )

  const TracingLayer = TracingService.layer.pipe(
    Layer.provide(AppConfigLayer),
    // Live stack doesn't run a BSP supervisor, so wire the
    // always-healthy noop signal so the per-request hot path in
    // TracingService is never gated.
    Layer.provide(TracerHealthSignal.noop),
  )
  const CdrLayer = CdrWriter.layer.pipe(Layer.provide(AppConfigLayer))
  const BufferedTerminateL = BufferedTerminateWriter.layer.pipe(
    Layer.provide(CallStateCacheLayer),
    Layer.provide(AppConfigLayer),
    Layer.provide(MetricsLayer),
  )

  const SipHarnessLayer = SipHarness.layer.pipe(Layer.provide(RecorderLayer))

  return B2buaCoreLayer.pipe(
    Layer.provideMerge(UdpLayer),
    Layer.provideMerge(OverloadLayer),
    Layer.provideMerge(CallStateCacheLayer),
    Layer.provideMerge(BufferedTerminateL),
    Layer.provideMerge(CallLimiterLayer),
    Layer.provideMerge(CallControlLayer),
    Layer.provideMerge(TracingLayer),
    Layer.provideMerge(CdrLayer),
    Layer.provideMerge(MetricsLayer),
    Layer.provideMerge(NetworkLayer),
    Layer.provideMerge(RedisLayer),
    Layer.provideMerge(AppConfigLayer),
    // Live stack runs against real sockets but tests still drive
    // markDraining explicitly — skip the SIGTERM hook.
    Layer.provideMerge(DrainingState.test),
    // Live tests don't run ReadyGate; default to ready=true so the
    // OPTIONS keepalive path answers 200.
    Layer.provideMerge(WorkerReadiness.test(true)),
    // Recorder + RunContext exposed outward for symmetry with the fake
    // stack so consumers can yield `Recorder` regardless of mode.
    Layer.provideMerge(SipHarnessLayer),
    Layer.provideMerge(RecorderLayer),
    Layer.provideMerge(RunContextLayer),
  )
}
