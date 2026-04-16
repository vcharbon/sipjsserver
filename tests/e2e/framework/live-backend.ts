/**
 * Live UDP backend — real dgram sockets, real wall clock, real B2BUA.
 *
 * Each test agent gets a real UDP socket. By default the OS picks a
 * port; if `AgentConfig.port` is set, we honor it (required for any
 * scenario where the SUT or a peer needs to reach the agent at a known
 * address — e.g. peer-to-peer self-tests).
 *
 * Sockets are created via Effect.acquireRelease so they're cleaned up
 * automatically when the surrounding test scope closes — no explicit
 * teardown method on the transport.
 */

import type { Scope } from "effect"
import { Effect, Option, Queue } from "effect"
import * as dgram from "node:dgram"
import type { AgentInfo, ReceivedPacket, TestTransport } from "./types.js"
import { TransportError } from "./types.js"

interface LiveAgent {
  readonly socket: dgram.Socket
  readonly ip: string
  readonly port: number
  readonly queue: Queue.Queue<ReceivedPacket>
}

const createLiveAgent = (
  bindIp: string,
  bindPort: number
): Effect.Effect<LiveAgent, TransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ReceivedPacket>()

    const socket = yield* Effect.acquireRelease(
      Effect.callback<dgram.Socket, TransportError>((resume) => {
        const sock = dgram.createSocket("udp4")
        sock.once("listening", () => resume(Effect.succeed(sock)))
        sock.once("error", (err: Error) =>
          resume(Effect.fail(new TransportError({ message: err.message, cause: err })))
        )
        sock.bind(bindPort, bindIp)
      }),
      (sock) =>
        Effect.callback<void>((resume) => {
          sock.close(() => resume(Effect.void))
        })
    )

    socket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      Queue.offerUnsafe(queue, {
        raw: msg,
        rinfo: { address: rinfo.address, port: rinfo.port },
        arrivalMs: Date.now(),
      })
    })

    const addr = socket.address()
    return { socket, ip: addr.address, port: addr.port, queue }
  })

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
        const agentInfos: Record<string, AgentInfo> = {}
        for (const [name, config] of Object.entries(agentConfigs)) {
          const agent = yield* createLiveAgent(bindIp, config.port ?? 0)
          agents.set(name, agent)
          agentInfos[name] = {
            ip: agent.ip,
            port: agent.port,
            uri: config.uri,
            contact: `<sip:${agent.ip}:${agent.port};transport=udp>`,
          }
        }
        // Sockets are cleaned up by their own acquireRelease finalizers,
        // but the agents map needs clearing for repeated runs.
        yield* Effect.addFinalizer(() => Effect.sync(() => agents.clear()))
        return agentInfos
      }),

    send: (agentName, buf, port, address) =>
      Effect.gen(function* () {
        const agent = agents.get(agentName)
        if (!agent) {
          return yield* new TransportError({ message: `Unknown agent "${agentName}"` })
        }
        yield* Effect.callback<void, TransportError>((resume) => {
          agent.socket.send(buf, 0, buf.length, port, address, (err) => {
            resume(
              err
                ? Effect.fail(new TransportError({ message: err.message, cause: err }))
                : Effect.void
            )
          })
        })
      }),

    receive: (agentName, timeoutMs) =>
      Effect.gen(function* () {
        const agent = agents.get(agentName)
        if (!agent) {
          return yield* new TransportError({ message: `Unknown agent "${agentName}"` })
        }
        // Non-blocking poll path (drain phase).
        if (timeoutMs <= 0) {
          const polled = yield* Queue.poll(agent.queue)
          return Option.getOrNull(polled)
        }
        // Blocking take, racing the timeout. Real wall clock here.
        return yield* Effect.race(
          Queue.take(agent.queue),
          Effect.sleep(`${timeoutMs} millis`).pipe(Effect.as(null))
        )
      }),
  }
}
