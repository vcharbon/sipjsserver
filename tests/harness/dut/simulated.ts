/**
 * Simulated DUT — adapts the existing `createSimulatedTransport`
 * (TestTransport) to the new DutTransport interface.
 *
 * Reuses the in-process FakeStackLayer so Slice 0/1 don't need a parallel
 * stack implementation. The new harness builds on top of this adapter,
 * so the existing fake-clock test infrastructure continues to work.
 */

import { Effect } from "effect"
import { createSimulatedTransport } from "../../fullcall/framework/simulated-backend.js"
import type { AppConfigData } from "../../../src/config/AppConfig.js"
import type {
  AgentBind,
  DutAgentConfig,
  DutPacket,
  DutTransport,
  Endpoint,
} from "./types.js"

export interface SimulatedDutOpts {
  readonly sipPort?: number
  readonly httpPort?: number
  readonly configOverrides?: Partial<AppConfigData>
  /** Step function for receive-loop sleeps (TestClock-aware in fake-clock tests). */
  readonly clockSleep?: (ms: number) => Effect.Effect<void>
  readonly realClock?: boolean
}

export function createSimulatedDut(opts: SimulatedDutOpts = {}): DutTransport {
  const sipPort = opts.sipPort ?? 15060
  const httpPort = opts.httpPort ?? 13002
  const inner = createSimulatedTransport({
    sipPort,
    httpPort,
    ...(opts.configOverrides !== undefined ? { configOverrides: opts.configOverrides } : {}),
    ...(opts.clockSleep !== undefined ? { clockSleep: opts.clockSleep } : {}),
    ...(opts.realClock !== undefined ? { realClock: opts.realClock } : {}),
  })

  const dutEndpoint: Endpoint = { host: "127.0.0.1", port: sipPort }

  return {
    dutEndpoint,
    ...(inner.stackLayer !== undefined ? { stackLayer: inner.stackLayer } : {}),
    setup: (agents: Readonly<Record<string, DutAgentConfig>>) =>
      Effect.gen(function* () {
        const innerInfos = yield* Effect.mapError(
          inner.setup(agents, dutEndpoint),
          (e) => new Error(`SimulatedDut.setup: ${e.message}`)
        )
        const out: Record<string, AgentBind> = {}
        for (const [name, info] of Object.entries(innerInfos)) {
          out[name] = {
            host: info.ip,
            port: info.port,
            uri: info.uri,
            contact: info.contact,
          }
        }
        return out
      }),
    send: (agentName, buf, dst) =>
      Effect.mapError(
        inner.send(agentName, buf, dst.port, dst.host),
        (e) => new Error(`SimulatedDut.send: ${e.message}`)
      ),
    receive: (agentName, timeoutMs) =>
      Effect.gen(function* () {
        const pkt = yield* Effect.mapError(
          inner.receive(agentName, timeoutMs),
          (e) => new Error(`SimulatedDut.receive: ${e.message}`)
        )
        if (pkt === null) return null
        const out: DutPacket = {
          raw: pkt.raw,
          from: { host: pkt.rinfo.address, port: pkt.rinfo.port },
          arrivalMs: pkt.arrivalMs,
        }
        return out
      }),
    ...(inner.verifyCleanState !== undefined
      ? { verifyCleanState: () => inner.verifyCleanState!() as Effect.Effect<ReadonlyArray<string>> }
      : {}),
    ...(inner.settle !== undefined ? { settle: () => inner.settle!() as Effect.Effect<void> } : {}),
    ...(inner.networkDelayMs !== undefined ? { networkDelayMs: inner.networkDelayMs } : {}),
  }
}
