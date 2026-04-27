/**
 * Live UDP backend — real dgram sockets via `SignalingNetwork.real`, real
 * wall clock, real external B2BUA.
 *
 * Each test agent binds its own `UdpEndpoint` on the real fabric. By default
 * the OS picks a port; if `AgentConfig.port` is set, we honor it (required
 * for any scenario where the SUT or a peer needs to reach the agent at a
 * known address — e.g. peer-to-peer self-tests).
 *
 * The harness reads straight off the endpoint (`poll` / `take`) — no
 * intermediate per-agent queue. `arrivalMs` is stamped once at socket-
 * recv time inside `SignalingNetwork.real`.
 *
 * Endpoints are scoped resources: their underlying sockets are cleaned up
 * automatically when the surrounding test scope closes.
 */

import { Effect } from "effect"
import type { AgentInfo, NetworkTag, TestTransport } from "./types.js"
import { DEFAULT_NETWORK, TransportError } from "./types.js"
import { SignalingNetwork, type UdpEndpoint } from "../../../src/sip/SignalingNetwork.js"

interface LiveAgent {
  readonly ip: string
  readonly port: number
  readonly endpoint: UdpEndpoint
  readonly network: NetworkTag
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

  // Lazy: the `core` real fabric is built only if any agent declares
  // `network: "core"`. Each `SignalingNetwork.real` Layer creates an
  // independent dgram socket pool, so the two networks are physically
  // distinct (process-wide) — exactly the shape the dual-stack proxy
  // wants, without coupling them to the same kernel-side state.
  const participantNetworks = new Map<string, NetworkTag>()
  const labelKey = (ip: string, port: number) => `${ip}:${port}`

  return {
    setup: (agentConfigs, _b2buaTarget) =>
      Effect.gen(function* () {
        const network = yield* SignalingNetwork
        const agentInfos: Record<string, AgentInfo> = {}

        for (const [name, config] of Object.entries(agentConfigs)) {
          const requestedIp = config.ip ?? bindIp
          const agentNetwork: NetworkTag = config.network ?? DEFAULT_NETWORK
          // Slice 3 reconciliation: live-backend uses a single
          // `SignalingNetwork.real` fabric. The "core" agents are routed
          // via distinct IP subnets, not via a separate fabric. Mixing
          // real-ext + simulated-core is a future requirement; document
          // it via the `network` tag on the trace until that lands.
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
                  `Failed to bind agent "${name}" at ${requestedIp}:${config.port ?? 0} on network ${agentNetwork}: ${err.message}`,
                cause: err,
              })
            )
          )

          const { ip, port } = endpoint.localAddress
          agents.set(name, { ip, port, endpoint, network: agentNetwork })
          participantNetworks.set(labelKey(ip, port), agentNetwork)
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
          return yield* agent.endpoint.poll()
        }
        return yield* Effect.race(
          agent.endpoint.take(),
          Effect.sleep(`${timeoutMs} millis`).pipe(Effect.as(null))
        )
      }),

    participantNetwork: (ip: string, port: number) =>
      participantNetworks.get(labelKey(ip, port)),
  }
}
