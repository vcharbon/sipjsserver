/**
 * Real dgram-backed SignalingNetwork with trace recording enabled.
 *
 * Test-harness only. Identical wire behaviour to `.real` except every
 * accepted recv and every successful send is recorded into an in-memory
 * buffer — drained by the test harness for cross-process call-flow
 * reports. The buffer is unbounded; never use in production.
 */

import { Layer } from "effect"
import { makeRealImpl } from "./SignalingNetwork.real.js"
import {
  SignalingNetwork,
  SignalingNetworkCore,
  type NetworkTraceSequencer,
} from "./SignalingNetwork.js"

export const realTracingLayer = (opts?: {
  readonly traceSequencer?: NetworkTraceSequencer
}): Layer.Layer<SignalingNetwork> =>
  Layer.sync(SignalingNetwork, () =>
    makeRealImpl(
      opts?.traceSequencer !== undefined
        ? { recordTrace: true, traceSequencer: opts.traceSequencer }
        : { recordTrace: true },
    ),
  )

export const realTracingCoreLayer = (opts?: {
  readonly traceSequencer?: NetworkTraceSequencer
}): Layer.Layer<SignalingNetworkCore> =>
  Layer.sync(SignalingNetworkCore, () =>
    makeRealImpl(
      opts?.traceSequencer !== undefined
        ? { recordTrace: true, traceSequencer: opts.traceSequencer }
        : { recordTrace: true },
    ),
  )
