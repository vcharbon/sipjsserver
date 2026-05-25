/**
 * SignalingNetwork — abstraction over the SIP-signaling network layer.
 *
 * Implementations live in sibling files:
 *   - `./SignalingNetwork.real.ts`         dgram-backed, no trace recording
 *   - `./SignalingNetwork.realTracing.ts`  dgram-backed, test-only recording
 *   - `./SignalingNetwork.simulated.ts`    in-memory routing fabric
 *
 * This file keeps the public types, `BindError` / `SendError`, the Tag
 * class, and thin static-method sugar (`real`, `realTracing`,
 * `simulated`) that re-exports the Layer constructors.
 *
 * Pre-ingress hook: an optional filter supplied at bindUdp() that runs at
 * arrival time. Returns a PreIngressAction (`accept` / `drop` / `reply`).
 *
 * Fake-IP support: the simulated fabric routes purely by dstIp:dstPort,
 * so tests can bind endpoints at arbitrary fake IPs.
 */

import {
  Data,
  type Effect,
  type Layer,
  Schema,
  type Scope,
  ServiceMap,
  type Stream,
} from "effect"
import type { RemoteInfo, SipMessage } from "./types.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UdpPacket {
  readonly raw: Buffer
  readonly rinfo: RemoteInfo
  readonly arrivalMs: number
  readonly parsed?: SipMessage
}

/** Per-endpoint counters. Plain object; O(1) reads/writes. */
export interface UdpEndpointCounters {
  enqueued: number
  tailDropped: number
  preIngressDropped: number
  preIngressReplies: number
}

export interface UdpEndpoint {
  readonly localAddress: { readonly ip: string; readonly port: number }
  readonly send: (buf: Buffer, dstPort: number, dstAddress: string) => Effect.Effect<void, SendError>
  readonly messages: Stream.Stream<UdpPacket>
  readonly poll: () => Effect.Effect<UdpPacket | null>
  readonly take: () => Effect.Effect<UdpPacket>
  readonly queueDepth: () => number
  readonly queueMax: number
  readonly counters: UdpEndpointCounters
}

/**
 * Sequencer hook for `NetworkTraceEntry.seq`. Opaque to this module so
 * `src/sip/...` stays independent of `src/test-harness/...`.
 */
export interface NetworkTraceSequencer {
  readonly nextSync: () => number
}

export interface UndeliveredPacket {
  readonly raw: Buffer
  readonly src: { readonly ip: string; readonly port: number }
  readonly dst: { readonly ip: string; readonly port: number }
  readonly timestampMs: number
}

export interface NetworkTraceEntry {
  readonly src: { readonly ip: string; readonly port: number }
  readonly dst: { readonly ip: string; readonly port: number }
  readonly raw: Buffer
  readonly sentMs: number
  readonly deliveredMs: number
  readonly delivered: boolean
  readonly seq: number
}

export type PreIngressAction = Data.TaggedEnum<{
  accept: {}
  drop: {}
  reply: { readonly buf: Buffer }
}>

export const PreIngressAction = Data.taggedEnum<PreIngressAction>()

export type PreIngressHook = (
  raw: Buffer,
  rinfo: RemoteInfo,
  depth: number
) => PreIngressAction

export interface BindUdpOpts {
  readonly ip: string
  readonly port: number
  readonly queueMax: number
  readonly preIngress?: PreIngressHook
  /**
   * `SO_REUSEPORT`. Real impl: forwarded to `dgram.createSocket({ reusePort })`.
   * Simulated impl: ignored.
   */
  readonly reusePort?: boolean
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BindError extends Schema.TaggedErrorClass<BindError>()("BindError", {
  reason: Schema.Literals(["already_bound", "os_error"]),
  ip: Schema.String,
  port: Schema.Number,
  message: Schema.String,
}) {}

export class SendError extends Schema.TaggedErrorClass<SendError>()("SendError", {
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Service tags
// ---------------------------------------------------------------------------

export interface SignalingNetworkApi {
  readonly bindUdp: (opts: BindUdpOpts) => Effect.Effect<UdpEndpoint, BindError, Scope.Scope>
  readonly drainUndeliverable: () => Effect.Effect<ReadonlyArray<UndeliveredPacket>>
  readonly drainTrace: () => Effect.Effect<ReadonlyArray<NetworkTraceEntry>>
  readonly transitDelayMs: number | undefined
  readonly inFlight: () => number
  readonly bumpInFlight: (delta: number) => void
  /**
   * Snapshot of currently bound endpoints and their queue depths. Used
   * by the contract wrapper's layer-close finalizer to detect leaked
   * packets (queue items present at scope close). Implementations that
   * don't route through an in-memory queue return an empty array.
   */
  readonly queueDepths: () => ReadonlyArray<{
    readonly bindKey: { readonly ip: string; readonly port: number }
    readonly depth: number
  }>
  /**
   * Simulated-only quiescence wait: detached transit fibers run on
   * `Effect.sleep(transitDelayMs)`, so the layer-close finalizer can
   * race with mid-sleep transit and observe a transient non-zero
   * `inFlight`. A bounded poll lets in-flight transit drain before the
   * structural audit reads. Returns once `inFlight === 0` or the
   * timeout elapses (whichever first). Stubbed `Effect.void` on
   * real/realTracing/Native (no in-memory transit to drain).
   */
  readonly awaitInFlight: (timeoutMs: number) => Effect.Effect<void>
}

export class SignalingNetwork extends ServiceMap.Service<
  SignalingNetwork,
  SignalingNetworkApi
>()("@sipjsserver/SignalingNetwork") {
  /**
   * Production layer — `dgram`-backed, trace recording disabled. See
   * `./SignalingNetwork.real.ts`.
   */
  static get real(): Layer.Layer<SignalingNetwork> {
    return realLayer
  }

  static readonly realTracing = (opts?: {
    readonly traceSequencer?: NetworkTraceSequencer
  }): Layer.Layer<SignalingNetwork> => realTracingLayer(opts)

  static readonly simulated = (opts: {
    readonly transitDelayMs: number
    readonly traceSequencer?: NetworkTraceSequencer
    readonly sendFault?: (
      src: { readonly ip: string; readonly port: number },
      dst: { readonly ip: string; readonly port: number },
    ) => string | null
  }): Layer.Layer<SignalingNetwork> => simulatedLayer(opts)
}

/**
 * Optional second-fabric tag, consumed by `ProxyCore` when it needs to
 * bind its `core` endpoint on a different physical fabric than its `ext`
 * endpoint.
 */
export class SignalingNetworkCore extends ServiceMap.Service<
  SignalingNetworkCore,
  SignalingNetworkApi
>()("@sipjsserver/SignalingNetworkCore") {
  static get real(): Layer.Layer<SignalingNetworkCore> {
    return realCoreLayer
  }

  static readonly realTracing = (opts?: {
    readonly traceSequencer?: NetworkTraceSequencer
  }): Layer.Layer<SignalingNetworkCore> => realTracingCoreLayer(opts)
}

// Sibling-module imports run AFTER the class declarations above. The
// impl files only dereference `SignalingNetwork` inside the thunks
// passed to `Layer.sync` (or behind `Layer.suspend` for top-level
// constants), so the cycle is safe.
//
// `eslint-disable` is not relevant here — this file has no eslint.
import {
  realLayer,
  realCoreLayer,
} from "./SignalingNetwork.real.js"
import {
  realTracingLayer,
  realTracingCoreLayer,
} from "./SignalingNetwork.realTracing.js"
import { simulatedLayer } from "./SignalingNetwork.simulated.js"
