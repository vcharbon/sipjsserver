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
import { SignalingNetwork, type UdpEndpoint } from "../../sip/SignalingNetwork.js"

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
  /**
   * Transport-wide advertised IP. Used as the default Contact / Via / From
   * address for every agent that does not set its own `advertisedIp`. Lets
   * the hybrid runner bind on 0.0.0.0 (so kind pods can reach the host via
   * the bridge gateway) while advertising a single host-reachable IP.
   */
  advertisedIp?: string
  /**
   * When `true`, the transport DOES NOT provide its own `SignalingNetwork.real`
   * and instead requires one from the surrounding scope. The hybrid harness
   * uses this so the in-process register-proxy and the alice/bob agents
   * share a single `SignalingNetwork.real` instance — and therefore a single
   * trace buffer (drained via `drainNetworkTrace`).
   */
  useExternalNetwork?: boolean
  /**
   * Optional per-(ip,port) name registry. Returned by `participantLabel`,
   * combined with the wire address by the trace renderer to produce labels
   * like `proxy(ext) (172.20.0.1:5060)`. Defaults to no labels (the renderer
   * falls back to `ip:port`).
   */
  participantLabels?: ReadonlyMap<string, string>
  /** Optional per-(ip,port) network tag override. */
  participantNetworkOverrides?: ReadonlyMap<string, NetworkTag>
}): TestTransport {
  const bindIp = opts?.bindIp ?? "127.0.0.1"
  const transportAdvertisedIp = opts?.advertisedIp
  const useExternalNetwork = opts?.useExternalNetwork === true
  const externalLabels = opts?.participantLabels
  const externalNetworks = opts?.participantNetworkOverrides
  const agents = new Map<string, LiveAgent>()
  const participantLabels = new Map<string, string>()

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
            Effect.mapError((err) =>
              new TransportError({
                message:
                  `Failed to bind agent "${name}" at ${requestedIp}:${config.port ?? 0} on network ${agentNetwork}: ${err.message}`,
                cause: err,
              })
            )
          )

          const { ip, port } = endpoint.localAddress
          // Contact / Via / From URIs use `advertisedIp` when set; this lets
          // the hybrid runner bind on 0.0.0.0 (so kind pods can reach the
          // host via the bridge gateway) while advertising a routable IP.
          const advertisedIp = config.advertisedIp ?? transportAdvertisedIp ?? ip
          agents.set(name, { ip, port, endpoint, network: agentNetwork })
          participantNetworks.set(labelKey(ip, port), agentNetwork)
          // Register the agent under both its bind addr (what shows up
          // as the SOURCE of its outbound trace records) and its
          // advertised addr (what other peers address it as), so the
          // interpreter's "skip hops where either side is an agent"
          // filter (drainNetworkTrace path) catches all duplicates.
          participantLabels.set(labelKey(ip, port), name)
          if (advertisedIp !== ip) {
            participantLabels.set(labelKey(advertisedIp, port), name)
          }
          agentInfos[name] = {
            ip: advertisedIp,
            port,
            uri: config.uri,
            contact: `<sip:${advertisedIp}:${port};transport=udp>`,
          }
        }

        yield* Effect.addFinalizer(() => Effect.sync(() => agents.clear()))
        return agentInfos
      // `realTracing` (not `real`): the fullcall framework drains the
      // network trace via `simulated-backend.ts`'s `drainTrace()` to
      // build hop-by-hop reports. Production MUST use `real`.
      }).pipe(
        useExternalNetwork
          ? (e) => e as Effect.Effect<Record<string, AgentInfo>, TransportError, never>
          : Effect.provide(SignalingNetwork.realTracing)
      ),

    send: (agentName, buf, port, address) =>
      Effect.gen(function* () {
        const agent = agents.get(agentName)
        if (!agent) {
          return yield* new TransportError({ message: `Unknown agent "${agentName}"` })
        }
        yield* agent.endpoint.send(buf, port, address).pipe(
          Effect.mapError((err) =>
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
      externalNetworks?.get(labelKey(ip, port))
        ?? participantNetworks.get(labelKey(ip, port)),
    participantLabel: (ip: string, port: number) =>
      externalLabels?.get(labelKey(ip, port))
        ?? participantLabels.get(labelKey(ip, port)),
  }
}
