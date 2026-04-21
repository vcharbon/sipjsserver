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

      const endpoint = yield* network
        .bindUdp({
          ip: config.sipLocalIp,
          port: config.sipLocalPort,
          queueMax,
          preIngress,
        })
        .pipe(Effect.orDie)

      // Prometheus-visible shape. Every field is a live getter — both
      // the scrape endpoint and test reads want the instantaneous value.
      const metrics: UdpTransportMetrics = {
        queueMax,
        get queueDepth() { return endpoint.queueDepth() },
        get dropsTailDrop() { return endpoint.counters.tailDropped },
        get dropsTier1Brake() { return dropsTier1Brake },
        get tier1RejectSent() { return tier1RejectSent },
      }
      registry.udp = metrics

      yield* Effect.logInfo(
        `UDP socket listening on ${endpoint.localAddress.ip}:${endpoint.localAddress.port} (queueMax=${queueMax}, tier1Threshold=${tier1Threshold})`
      )

      // Fire-and-forget from TransactionLayer's perspective. SendErrors are
      // infrastructure-level (socket gone, kernel queue full) — surface as
      // defects so they're logged by the top-level runtime rather than
      // polluting the typed failure channel of every caller.
      const send = Effect.fnUntraced(function* (
        msg: Buffer,
        port: number,
        address: string
      ) {
        yield* endpoint.send(msg, port, address).pipe(Effect.orDie)
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
