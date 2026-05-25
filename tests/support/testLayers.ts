/**
 * Curated test-layer bundles (ADR-0013 D6) — the single import point
 * for fake-stack and unit-of-layer tests. Tests pull one bundle off
 * this shelf; no `Layer.merge` in test files.
 *
 *   context    : RunContext provider layers (real-run, test-with-recorder, unit-test-of)
 *   recorder   : Recorder transport variants (fake / live / hybrid)
 *   contracts  : per-Tag `withAllContracts` forwarders (populated as slices land)
 *   stacks     : `stackLayer({ mode })` builders
 */

import { Layer, type ServiceMap } from "effect"
import { Recorder } from "../../src/test-harness/framework/report-recorder/Recorder.js"
import { RunContext } from "../../src/test-harness/framework/RunContext.js"
import { SipHarness } from "../../src/test-harness/framework/SipHarness.js"
import { withAllContracts as withPartitionedRelayStorageContracts } from "../../src/cache/PartitionedRelayStorage.contracts.js"
import {
  withAllContracts as withCallLimiterContracts,
  parity as callLimiterParity,
  type CallLimiterContractsOptions,
} from "../../src/call/CallLimiter.contracts.js"
import { CallLimiter } from "../../src/call/CallLimiter.js"
import {
  stackLayer,
  type FakeModeOpts,
  type LiveModeOpts,
} from "./stackLayer.js"

const context = {
  realRun: RunContext.realRun,
  testWithRecorder: RunContext.testWithRecorder,
  unitTestOf: <S, A>(tag: ServiceMap.Key<S, A>): Layer.Layer<RunContext> =>
    RunContext.unitTestOf(tag),
}

const recorder = {
  fake: Recorder.fake,
  live: Recorder.live,
  hybrid: Recorder.hybrid,
  /**
   * SipHarness layer — typed-channel companion to Recorder. Provided
   * automatically by `stacks.fake` / `stacks.live`; exposed here for
   * unit-of-layer tests that want it without the full stack.
   */
  sipHarness: SipHarness.layer,
}

// Populated as wrapper slices land.
const contracts = {
  partitionedRelayStorage: withPartitionedRelayStorageContracts,
  callLimiter: withCallLimiterContracts,
  /**
   * CallLimiter parity bundle — composes `parity(memory, redis)` first,
   * then wraps with `withAllContracts`. `parity` stays outside the
   * canonical helper per D7; this convenience function only exists so
   * tests don't have to remember the construction order.
   */
  callLimiterParity: (
    memoryImpl: Layer.Layer<CallLimiter>,
    redisImpl: Layer.Layer<CallLimiter>,
    options?: CallLimiterContractsOptions,
  ) => withCallLimiterContracts(callLimiterParity(memoryImpl, redisImpl), options),
} as const

const stacks = {
  fake: (opts: Omit<FakeModeOpts, "mode">) =>
    stackLayer({ mode: "fake", ...opts }),
  live: (opts: Omit<LiveModeOpts, "mode">) =>
    stackLayer({ mode: "live", ...opts }),
  /**
   * Minimal "unit-of-layer" stack: the bare impl Layer for one Tag,
   * provided alongside `Recorder.fake` and `RunContext.unitTestOf(tag)`.
   * Intentionally narrow — no SignalingNetwork wiring, no SipRouter,
   * no Redis. Use this when a test exercises a single service's
   * contract surface in isolation (per-rule unit-of-layer fixtures
   * land here in Slice 6).
   */
  unit: <S, A>(
    tag: ServiceMap.Key<S, A>,
    impl: Layer.Layer<S, never, never>,
  ): Layer.Layer<S | Recorder | RunContext, never, never> =>
    Layer.mergeAll(impl, Recorder.fake, RunContext.unitTestOf(tag)),
}

export const testLayers = {
  context,
  recorder,
  contracts,
  stacks,
} as const
