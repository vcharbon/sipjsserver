/**
 * IpcTransport — a UdpTransport-compatible layer that communicates with the
 * dispatcher main process via IPC instead of binding a real UDP socket.
 *
 * Inbound: raw packets arrive as IPC messages from the dispatcher.
 * Outbound: serialized buffers are sent back to the dispatcher via IPC.
 *
 * This layer is used by worker child processes in cluster mode.
 */

import { Cause, Effect, Layer, Queue, Stream } from "effect"
import { UdpTransport, type UdpPacket, type UdpTransportMetrics } from "../sip/UdpTransport.js"
import type { MainToWorkerMessage, WorkerToMainMessage } from "./IpcProtocol.js"

/**
 * UdpTransport layer backed by IPC with the parent dispatcher process.
 * Must only be used inside a worker child process (process.send must exist).
 */
export const IpcTransportLayer: Layer.Layer<UdpTransport> = Layer.effect(
  UdpTransport,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<UdpPacket, Cause.Done>()

    // Workers see only IPC packets from the dispatcher; the real UDP-level
    // metrics live in the dispatcher process. Expose a zeroed stub so the
    // service interface is satisfied.
    const metrics: UdpTransportMetrics = {
      queueDepth: 0,
      queueMax: 0,
      dropsTier1Brake: 0,
      dropsTailDrop: 0,
      tier1RejectSent: 0,
    }

    // Listen for inbound packets from the dispatcher
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onMessage = (msg: MainToWorkerMessage) => {
          if (msg.type === "packet") {
            const raw = Buffer.from(msg.raw, "base64")
            Queue.offerUnsafe(queue, {
              raw,
              rinfo: { address: msg.address, port: msg.port }
            })
          }
          // "shutdown" is handled by WorkerEntry, not here
        }
        process.on("message", onMessage)
        return onMessage
      }),
      (onMessage) =>
        Effect.sync(() => {
          process.removeListener("message", onMessage)
          Queue.endUnsafe(queue)
        })
    )

    const send = Effect.fn("IpcTransport.send")(function* (
      msg: Buffer,
      port: number,
      address: string
    ) {
      // Send outbound packet to dispatcher via IPC
      const ipcMsg: WorkerToMainMessage = {
        type: "send",
        raw: msg.toString("base64"),
        address,
        port
      }
      if (process.send && process.connected) {
        yield* Effect.catch(
          Effect.sync(() => process.send!(ipcMsg)),
          (e) => Effect.logInfo("IPC send skipped — channel closed during shutdown").pipe(
            Effect.annotateLogs("error", String(e))
          )
        )
      } else if (!process.send) {
        yield* Effect.logError("IpcTransport.send called but process.send is not available")
      }
    })

    const messages = Stream.fromQueue(queue)

    return { send, messages, metrics }
  })
)
