/**
 * UdpTransport service — wraps a Node.js dgram socket as an Effect service.
 *
 * Incoming packets land in a *bounded* Queue and are exposed as a Stream.
 * Effect.acquireRelease inside Layer.effect ensures clean socket shutdown.
 *
 * Overload protection (Tier 1 — pre-parse emergency brake):
 *   When the queue depth crosses `udpQueueTier1ThresholdPct` of `udpQueueMax`,
 *   the recv callback runs a cheap byte-level classifier on incoming packets.
 *   New, non-emergency INVITEs are answered with a templated stateless 503
 *   built by header-line slicing (no JsSIP parse, no transaction, no fiber).
 *   In-dialog traffic, responses, ACKs, BYEs, and emergency INVITEs all pass
 *   through untouched.
 *
 *   When the bounded queue is *fully* saturated even after the brake, the
 *   recv callback tail-drops the packet (counter increment + log).
 */

import * as dgram from "node:dgram"
import { Cause, Effect, Layer, Queue, ServiceMap, Stream } from "effect"
import { AppConfig } from "../config/AppConfig.js"
import { MetricsRegistry } from "../observability/MetricsRegistry.js"
import {
  buildStatelessReject503Buffer,
  bufferHasEmergencyMarker,
  isInviteRequestBuffer,
  jitteredRetryAfter,
} from "./MessageFactory.js"
import type { RemoteInfo } from "./types.js"

export interface UdpPacket {
  readonly raw: Buffer
  readonly rinfo: RemoteInfo
}

/**
 * Lightweight per-instance counters for overload observability. Exposed via
 * the StatusServer / Prometheus endpoint. Intentionally plain-object so reads
 * are O(1) and writes are zero-cost.
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
    readonly send: (msg: Buffer, port: number, address: string) => Effect.Effect<void, Error>
    readonly messages: Stream.Stream<UdpPacket>
    readonly metrics: UdpTransportMetrics
  }
>()("@sipjsserver/UdpTransport") {
  static readonly layer = (bindPort: number) =>
    Layer.effect(
      UdpTransport,
      Effect.gen(function* () {
        const config = yield* AppConfig
        const registry = yield* MetricsRegistry
        const queueMax = config.udpQueueMax
        const tier1Threshold = Math.floor((queueMax * config.udpQueueTier1ThresholdPct) / 100)
        const retryAfterBase = config.retryAfterBaseSec
        const retryAfterJitter = config.retryAfterJitterSec

        // Bounded queue. Queue error type includes Cause.Done so Stream.fromQueue terminates cleanly.
        const queue = yield* Queue.bounded<UdpPacket, Cause.Done>(queueMax)

        const metrics: UdpTransportMetrics = {
          queueDepth: 0,
          queueMax,
          dropsTier1Brake: 0,
          dropsTailDrop: 0,
          tier1RejectSent: 0,
        }
        registry.udp = metrics

        const socket = yield* Effect.acquireRelease(
          Effect.callback<dgram.Socket>((resume) => {
            const sock = dgram.createSocket("udp4")
            sock.once("listening", () => resume(Effect.succeed(sock)))
            sock.once("error", (err) => resume(Effect.die(err)))
            sock.bind(bindPort)
          }),
          (sock) =>
            Effect.callback<void>((resume) => {
              sock.close(() => resume(Effect.void))
            })
        )

        // Stateless reject — bypasses TransactionLayer entirely.
        const sendStatelessReject = (raw: Buffer, rinfo: dgram.RemoteInfo): boolean => {
          const retryAfter = jitteredRetryAfter(retryAfterBase, retryAfterJitter)
          const respBuf = buildStatelessReject503Buffer(raw, retryAfter)
          if (respBuf === null) return false
          // Fire-and-forget send. Errors are logged via the socket error handler.
          socket.send(respBuf, 0, respBuf.length, rinfo.port, rinfo.address, () => {})
          metrics.tier1RejectSent++
          return true
        }

        // Register message handler — push into bounded queue from event loop.
        // Uses Queue.offerUnsafe + size check to keep the recv callback synchronous.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            socket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
              // O(1) depth read for the brake decision
              const depth = Queue.sizeUnsafe(queue)
              metrics.queueDepth = depth

              // Tier 1 — pre-parse emergency brake.
              // Activates only when ingress queue is past the configured threshold.
              if (depth >= tier1Threshold) {
                if (isInviteRequestBuffer(msg) && !bufferHasEmergencyMarker(msg)) {
                  // Templated 503 — bypasses TransactionLayer entirely.
                  if (sendStatelessReject(msg, rinfo)) {
                    metrics.dropsTier1Brake++
                    return
                  }
                  // Templating failed (malformed buffer): fall through to enqueue.
                }
                // Emergency / in-dialog / response: pass through.
              }

              const packet: UdpPacket = {
                raw: msg,
                rinfo: { address: rinfo.address, port: rinfo.port },
              }
              // offerUnsafe returns false if the bounded queue is full (tail-drop).
              if (!Queue.offerUnsafe(queue, packet)) {
                metrics.dropsTailDrop++
                return
              }
              metrics.queueDepth = Queue.sizeUnsafe(queue)
            })
            socket.on("error", (err: Error) => {
              console.error(`UDP socket error: ${err.message}`)
            })
          }),
          () => Effect.sync(() => Queue.endUnsafe(queue))
        )

        yield* Effect.logInfo(
          `UDP socket listening on port ${bindPort} (queueMax=${queueMax}, tier1Threshold=${tier1Threshold})`
        )

        const send = Effect.fn("UdpTransport.send")(function* (
          msg: Buffer,
          port: number,
          address: string
        ) {
          yield* Effect.callback<void, Error>((resume) => {
            socket.send(msg, 0, msg.length, port, address, (err) => {
              resume(err ? Effect.fail(err) : Effect.void)
            })
          })
        })

        const messages = Stream.fromQueue(queue)

        return { send, messages, metrics }
      })
    )
}
