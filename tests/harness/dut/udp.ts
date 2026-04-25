/**
 * UDP DUT — adapts `createLiveTransport` (real dgram sockets via
 * `SignalingNetwork.real`) to the new DutTransport interface.
 *
 * Lifecycle (per Q14): the DUT (the B2BUA) is pre-provisioned by the
 * test runner / CI; the harness only opens client UDP endpoints and
 * sends/receives. `reset()` is best-effort: the simulated path resets
 * via in-process state, but for an external B2BUA the operator is
 * responsible for clearing state between runs (or restarting the
 * process). When no admin endpoint is available, reset() is a no-op.
 *
 * Slice 5 wires this in but does not run it in CI — exercising it
 * requires an external B2BUA listening on `dutEndpoint`. The runner
 * accepts a `transport: TestTransport` so a smoke test can do:
 *
 *     const dut = createUdpDut({ dutEndpoint: { host, port } })
 *     yield* runDriveOnly({ ...opts, transport: dut.transport, target: dut.dutEndpoint })
 */

import { Effect } from "effect"
import { createLiveTransport } from "../../fullcall/framework/live-backend.js"
import type { TestTransport } from "../../fullcall/framework/types.js"
import type {
  AgentBind,
  DutAgentConfig,
  DutHandle,
  DutPacket,
  DutTransport,
  Endpoint,
} from "./types.js"

export interface UdpDutOpts {
  /** Address of the external B2BUA's SIP port. */
  readonly dutEndpoint: Endpoint
  /** Local IP for agent binds. Defaults to 127.0.0.1. */
  readonly bindIp?: string
}

/**
 * Returns both a DutTransport (the high-level interface) and the
 * underlying TestTransport (what the runner currently consumes).
 * The runner accepts the latter; the former is offered for parity
 * with [tests/harness/dut/simulated.ts] and future migrations.
 */
export interface UdpDut {
  readonly dut: DutTransport
  readonly transport: TestTransport
  readonly dutEndpoint: Endpoint
  readonly handle: DutHandle
}

export function createUdpDut(opts: UdpDutOpts): UdpDut {
  const dutEndpoint = opts.dutEndpoint
  const inner = createLiveTransport({
    bindIp: opts.bindIp ?? "127.0.0.1",
    b2buaHost: dutEndpoint.host,
    b2buaPort: dutEndpoint.port,
  })

  const dut: DutTransport = {
    dutEndpoint,
    setup: (agents: Readonly<Record<string, DutAgentConfig>>) =>
      Effect.gen(function* () {
        const innerInfos = yield* Effect.mapError(
          inner.setup(agents, dutEndpoint),
          (e) => new Error(`UdpDut.setup: ${e.message}`)
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
        (e) => new Error(`UdpDut.send: ${e.message}`)
      ),
    receive: (agentName, timeoutMs) =>
      Effect.gen(function* () {
        const pkt = yield* Effect.mapError(
          inner.receive(agentName, timeoutMs),
          (e) => new Error(`UdpDut.receive: ${e.message}`)
        )
        if (pkt === null) return null
        const out: DutPacket = {
          raw: pkt.raw,
          from: { host: pkt.rinfo.address, port: pkt.rinfo.port },
          arrivalMs: pkt.arrivalMs,
        }
        return out
      }),
  }

  const handle: DutHandle = {
    reset: () => Effect.void,
  }

  return { dut, transport: inner, dutEndpoint, handle }
}
