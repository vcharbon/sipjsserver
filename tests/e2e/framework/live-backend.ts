/**
 * Live UDP backend — real dgram sockets via `SignalingNetwork.real`, real
 * wall clock, real external B2BUA.
 *
 * Each test agent binds its own `UdpEndpoint` on the real fabric. By default
 * the OS picks a port; if `AgentConfig.port` is set, we honor it (required
 * for any scenario where the SUT or a peer needs to reach the agent at a
 * known address — e.g. peer-to-peer self-tests).
 *
 * Endpoints are scoped resources: their underlying sockets are cleaned up
 * automatically when the surrounding test scope closes.
 */

import { Clock, Effect, Option, Queue, Stream } from "effect"
import type { AgentInfo, ReceivedPacket, TestTransport } from "./types.js"
import { TransportError } from "./types.js"
import {
  SignalingNetwork,
  type UdpEndpoint,
  type UdpPacket,
} from "../../../src/sip/SignalingNetwork.js"

interface LiveAgent {
  readonly ip: string
  readonly port: number
  readonly endpoint: UdpEndpoint
  readonly queue: Queue.Queue<ReceivedPacket>
}

/** Per-agent ingress queue capacity — see simulated-backend for rationale. */
const AGENT_QUEUE_MAX = 1024

export function createLiveTransport(opts?: {
  bindIp?: string
  b2buaHost?: string
  b2buaPort?: number
}): TestTransport {
  const bindIp = opts?.bindIp ?? "127.0.0.1"
  const agents = new Map<string, LiveAgent>()

  return {
    setup: (agentConfigs, _b2buaTarget) =>
      Effect.gen(function* () {
        const network = yield* SignalingNetwork
        const agentInfos: Record<string, AgentInfo> = {}

        for (const [name, config] of Object.entries(agentConfigs)) {
          const requestedIp = config.ip ?? bindIp
          // Port 0 = let the OS pick. The real endpoint reports the
          // actual bound port via endpoint.localAddress.
          const endpoint = yield* network.bindUdp({
            ip: requestedIp,
            port: config.port ?? 0,
            queueMax: AGENT_QUEUE_MAX,
          }).pipe(
            Effect.catch((err) =>
              new TransportError({
                message:
                  `Failed to bind agent "${name}" at ${requestedIp}:${config.port ?? 0}: ${err.message}`,
                cause: err,
              })
            )
          )

          const queue = yield* Queue.unbounded<ReceivedPacket>()

          // Drain endpoint stream → per-agent ReceivedPacket queue.
          // `arrivalMs` stamped here, at dequeue time.
          yield* Effect.forkScoped(
            Stream.runForEach(endpoint.messages, (pkt: UdpPacket) =>
              Effect.gen(function* () {
                const arrivalMs = yield* Clock.currentTimeMillis
                Queue.offerUnsafe(queue, {
                  raw: pkt.raw,
                  rinfo: pkt.rinfo,
                  arrivalMs,
                })
              })
            )
          )

          const { ip, port } = endpoint.localAddress
          agents.set(name, { ip, port, endpoint, queue })
          agentInfos[name] = {
            ip,
            port,
            uri: config.uri,
            contact: `<sip:${ip}:${port};transport=udp>`,
          }
        }

        yield* Effect.addFinalizer(() => Effect.sync(() => agents.clear()))
        return agentInfos
      }).pipe(Effect.provide(SignalingNetwork.real)),

    send: (agentName, buf, port, address) =>
      Effect.gen(function* () {
        const agent = agents.get(agentName)
        if (!agent) {
          return yield* new TransportError({ message: `Unknown agent "${agentName}"` })
        }
        yield* agent.endpoint.send(buf, port, address).pipe(
          Effect.catch((err) =>
            new TransportError({ message: err.message, cause: err })
          )
        )
      }),

    receive: (agentName, timeoutMs) =>
      Effect.gen(function* () {
        const agent = agents.get(agentName)
        if (!agent) {
          return yield* new TransportError({ message: `Unknown agent "${agentName}"` })
        }
        if (timeoutMs <= 0) {
          const polled = yield* Queue.poll(agent.queue)
          return Option.getOrNull(polled)
        }
        return yield* Effect.race(
          Queue.take(agent.queue),
          Effect.sleep(`${timeoutMs} millis`).pipe(Effect.as(null))
        )
      }),

    settle: () =>
      // Real UDP + a Stream-based drain fork introduces two points of
      // asynchrony between send-return and queue-arrival: the kernel
      // delivering the packet to the socket, then the drain fork
      // transferring it into the ReceivedPacket queue. A brief wall-clock
      // wait + scheduler yields guarantees both have settled before the
      // drain phase polls for unexpected messages.
      Effect.gen(function* () {
        yield* Effect.sleep("10 millis")
        for (let i = 0; i < 20; i++) {
          yield* Effect.yieldNow
        }
      }),
  }
}
