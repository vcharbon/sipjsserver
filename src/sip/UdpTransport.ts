/**
 * UdpTransport — facade over SignalingNetwork.real.bindUdp.
 *
 * Owns the B2BUA-specific policy glue that sits on top of the raw UDP
 * primitive:
 *   - Tier 1 overload brake (preIngress hook: stateless 503 template
 *     for new, non-emergency INVITEs when the ingress queue crosses
 *     `udpQueueTier1ThresholdPct` of `udpQueueMax`).
 *   - UdpTransportMetrics — the Prometheus-visible shape expected by
 *     StatusServer. Brake counters are mutated in the preIngress hook;
 *     queue depth and tail-drop count are proxied live from the
 *     underlying UdpEndpoint.
 *   - `localAddress` — the transport's bound (ip, port), surfaced from
 *     `endpoint.localAddress`. Single source of truth for Via/Contact
 *     stamping (SipRouter reads this instead of raw AppConfig fields).
 *
 * The IpcTransport (cluster worker variant) satisfies the same
 * interface, sourcing `localAddress` from shared AppConfig.
 */

import { Effect, Layer, ServiceMap, Stream } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import { MetricsRegistry } from "../observability/MetricsRegistry.js"
import {
  buildStatelessReject503Buffer,
  bufferHasEmergencyMarker,
  isInviteRequestBuffer,
  jitteredRetryAfter,
} from "./MessageHelpers.js"
import {
  PreIngressAction,
  SignalingNetwork,
  type PreIngressHook,
  type UdpPacket,
} from "./SignalingNetwork.js"
import { wrapEndpoint, type BufferedSendCounters, makeBufferedSendCounters } from "./BufferedUdpEndpoint.js"

export type { UdpPacket } from "./SignalingNetwork.js"

/**
 * Lightweight per-instance counters for overload observability. Exposed via
 * the StatusServer / Prometheus endpoint. Reads are O(1); `queueDepth` and
 * `dropsTailDrop` are live getters backed by the underlying endpoint.
 */
export interface UdpTransportMetrics {
  queueDepth: number
  queueMax: number
  dropsTier1Brake: number
  dropsTailDrop: number
  tier1RejectSent: number
  /** BufferedUdpEndpoint counters — non-blocking outbound send. */
  bufferedSend: BufferedSendCounters
  /** Active per-peer drainer fibers. */
  bufferedSendPeerCount: number
}

export class UdpTransport extends ServiceMap.Service<
  UdpTransport,
  {
    readonly send: (msg: Buffer, port: number, address: string) => Effect.Effect<void>
    readonly messages: Stream.Stream<UdpPacket>
    readonly metrics: UdpTransportMetrics
    readonly localAddress: { readonly ip: string; readonly port: number }
  }
>()("@sipjsserver/UdpTransport") {
  static readonly layer = Layer.effect(
    UdpTransport,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const registry = yield* MetricsRegistry
      const network = yield* SignalingNetwork
      const queueMax = config.udpQueueMax
      const tier1Threshold = Math.floor((queueMax * config.udpQueueTier1ThresholdPct) / 100)
      const retryAfterBase = config.retryAfterBaseSec
      const retryAfterJitter = config.retryAfterJitterSec

      // Brake counters — mutated synchronously inside preIngress.
      let dropsTier1Brake = 0
      let tier1RejectSent = 0

      const preIngress: PreIngressHook = (raw, _rinfo, depth) => {
        if (
          depth >= tier1Threshold &&
          isInviteRequestBuffer(raw) &&
          !bufferHasEmergencyMarker(raw)
        ) {
          const retryAfter = jitteredRetryAfter(retryAfterBase, retryAfterJitter)
          const respBuf = buildStatelessReject503Buffer(raw, retryAfter)
          if (respBuf !== null) {
            dropsTier1Brake++
            tier1RejectSent++
            return PreIngressAction.reply({ buf: respBuf })
          }
          // Templating failed (malformed buffer) — accept and let the
          // normal pipeline reject.
        }
        return PreIngressAction.accept()
      }

      const rawEndpoint = yield* network
        .bindUdp({
          ip: config.sipLocalIp,
          port: config.sipLocalPort,
          queueMax,
          preIngress,
        })
        .pipe(Effect.orDie)

      // Non-blocking outbound send. Per-peer queue + drainer fiber isolate
      // a slow `getaddrinfo` or `EAGAIN` to that peer; other peers continue.
      // Setting `bufferedSendPerPeerQueueMax === 0` disables the wrapper
      // entirely (rollback sentinel) — used by fake-clock tests where the
      // extra fiber-hop interacts poorly with TestClock quiescence.
      const bufferedCounters = makeBufferedSendCounters()
      const wrappedEndpoint = config.bufferedSendPerPeerQueueMax > 0
        ? yield* wrapEndpoint(rawEndpoint, {
            perPeerQueueMax: config.bufferedSendPerPeerQueueMax,
            idleTtlMs: config.bufferedSendIdleTtlMs,
            maxPeers: config.bufferedSendMaxPeers,
            sweepIntervalMs: config.bufferedSendSweepIntervalMs,
            counters: bufferedCounters,
            pendingWorkDelta: (delta: number) => network.bumpInFlight(delta),
          })
        : undefined
      const endpoint = wrappedEndpoint ?? rawEndpoint

      // Prometheus-visible shape. Every field is a live getter — both
      // the scrape endpoint and test reads want the instantaneous value.
      const metrics: UdpTransportMetrics = {
        queueMax,
        get queueDepth() { return endpoint.queueDepth() },
        get dropsTailDrop() { return endpoint.counters.tailDropped },
        get dropsTier1Brake() { return dropsTier1Brake },
        get tier1RejectSent() { return tier1RejectSent },
        bufferedSend: bufferedCounters,
        get bufferedSendPeerCount() { return wrappedEndpoint?.peerCount() ?? 0 },
      }
      registry.udp = metrics

      yield* Effect.logInfo(
        `UDP socket listening on ${endpoint.localAddress.ip}:${endpoint.localAddress.port} (queueMax=${queueMax}, tier1Threshold=${tier1Threshold})`
      )

      // Buffered send never fails — the wrapper enqueues and the per-peer
      // drainer fiber absorbs SendErrors. `Effect.orDie` retained for
      // signature parity (`Effect<void, never>`) in case the wrapper API
      // is ever extended to surface a typed error.
      const send = Effect.fnUntraced(function* (
        msg: Buffer,
        port: number,
        address: string
      ) {
        yield* endpoint.send(msg, port, address)
      })

      return {
        send,
        messages: endpoint.messages,
        metrics,
        localAddress: endpoint.localAddress,
      }
    })
  )
}
