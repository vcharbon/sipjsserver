/**
 * Real dgram-backed SignalingNetwork implementation.
 *
 * The factory `makeRealImpl({ recordTrace })` is shared between the
 * production `.real` Layer (recording OFF — leak-free hot path) and the
 * test-only `.realTracing` Layer (recording ON — retains every recv/send
 * Buffer for the report renderer). The boolean is the ONLY difference
 * between the two: split into two Layer constants so production code
 * paths cannot accidentally enable recording.
 */

import * as dgram from "node:dgram"
import {
  Cause,
  Effect,
  Layer,
  Option,
  Queue,
  Stream,
} from "effect"
import {
  BindError,
  SendError,
  SignalingNetwork,
  SignalingNetworkCore,
  type BindUdpOpts,
  type NetworkTraceEntry,
  type NetworkTraceSequencer,
  type SignalingNetworkApi,
  type UdpEndpoint,
  type UdpEndpointCounters,
} from "./SignalingNetwork.js"
import { PreIngressAction } from "./SignalingNetwork.js"
import type { RemoteInfo } from "./types.js"

export function makeRealImpl({
  recordTrace,
  traceSequencer,
}: {
  readonly recordTrace: boolean
  readonly traceSequencer?: NetworkTraceSequencer
}): SignalingNetworkApi {
  const trace: NetworkTraceEntry[] = []
  const allocSeq: () => number = (() => {
    if (traceSequencer !== undefined) return traceSequencer.nextSync
    let local = 0
    return () => ++local
  })()

  return {
    bindUdp: (opts: BindUdpOpts) =>
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<import("./SignalingNetwork.js").UdpPacket, Cause.Done>(opts.queueMax)
        const counters: UdpEndpointCounters = {
          enqueued: 0,
          tailDropped: 0,
          preIngressDropped: 0,
          preIngressReplies: 0,
        }

        const socket = yield* Effect.acquireRelease(
          Effect.callback<dgram.Socket, BindError>((resume) => {
            const sock = dgram.createSocket({
              type: "udp4",
              reusePort: opts.reusePort ?? false,
            })
            sock.once("listening", () => resume(Effect.succeed(sock)))
            sock.once("error", (err: Error) =>
              resume(
                Effect.fail(
                  new BindError({
                    reason: "os_error",
                    ip: opts.ip,
                    port: opts.port,
                    message: err.message,
                  })
                )
              )
            )
            sock.bind(opts.port, opts.ip)
          }),
          (sock) =>
            Effect.callback<void>((resume) => {
              sock.close(() => resume(Effect.void))
            })
        )

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const preIngress = opts.preIngress
            const handler = (raw: Buffer, rinfo: dgram.RemoteInfo) => {
              const depth = Queue.sizeUnsafe(queue)
              const src: RemoteInfo = { address: rinfo.address, port: rinfo.port }
              const action = preIngress !== undefined
                ? preIngress(raw, src, depth)
                : PreIngressAction.accept()
              switch (action._tag) {
                case "drop":
                  counters.preIngressDropped++
                  return
                case "reply": {
                  counters.preIngressReplies++
                  socket.send(action.buf, 0, action.buf.length, rinfo.port, rinfo.address, () => {})
                  return
                }
                case "accept": {
                  const arrivalMs = Date.now()
                  if (!Queue.offerUnsafe(queue, { raw, rinfo: src, arrivalMs })) {
                    counters.tailDropped++
                    return
                  }
                  counters.enqueued++
                  if (recordTrace) {
                    trace.push({
                      raw,
                      src: { ip: src.address, port: src.port },
                      dst: { ip: localAddress.ip, port: localAddress.port },
                      sentMs: arrivalMs,
                      deliveredMs: arrivalMs,
                      delivered: true,
                      seq: allocSeq(),
                    })
                  }
                }
              }
            }
            const errorHandler = (err: Error) => {
              console.error(`[SignalingNetwork.real] socket error: ${err.message}`)
            }
            socket.on("message", handler)
            socket.on("error", errorHandler)
            return { handler, errorHandler }
          }),
          ({ handler, errorHandler }) =>
            Effect.sync(() => {
              socket.off("message", handler)
              socket.off("error", errorHandler)
              Queue.endUnsafe(queue)
            })
        )

        const addr = socket.address()
        const localAddress = { ip: addr.address, port: addr.port }

        const send: UdpEndpoint["send"] = (buf, dstPort, dstAddress) =>
          Effect.callback<void, SendError>((resume) => {
            const sentMs = Date.now()
            socket.send(buf, 0, buf.length, dstPort, dstAddress, (err) => {
              if ((err === null || err === undefined) && recordTrace) {
                trace.push({
                  raw: buf,
                  src: { ip: localAddress.ip, port: localAddress.port },
                  dst: { ip: dstAddress, port: dstPort },
                  sentMs,
                  deliveredMs: sentMs,
                  delivered: true,
                  seq: allocSeq(),
                })
              }
              resume(
                err
                  ? Effect.fail(new SendError({ message: err.message }))
                  : Effect.void
              )
            })
          })

        const poll = () =>
          Effect.map(Queue.poll(queue), (opt) => Option.getOrNull(opt))
        const take = () => Queue.take(queue).pipe(Effect.orDie)

        const endpoint: UdpEndpoint = {
          localAddress,
          send,
          messages: Stream.fromQueue(queue),
          poll,
          take,
          queueDepth: () => Queue.sizeUnsafe(queue),
          queueMax: opts.queueMax,
          counters,
        }
        return endpoint
      }),

    drainUndeliverable: () => Effect.succeed([]),
    drainTrace: () =>
      Effect.sync(() => {
        if (!recordTrace) return [] as ReadonlyArray<NetworkTraceEntry>
        const out = trace.slice()
        trace.length = 0
        return out as ReadonlyArray<NetworkTraceEntry>
      }),
    transitDelayMs: undefined,
    inFlight: () => 0,
    bumpInFlight: (_: number) => undefined,
    // dgram-backed sockets don't expose a structural queue snapshot;
    // the layer-close finalizer skips queue-leak checks for the real
    // impl by detecting `transitDelayMs === undefined`.
    queueDepths: () => [],
    awaitInFlight: () => Effect.void,
  }
}

// `Layer.suspend` defers the Tag dereference to layer-build time,
// keeping module-evaluation safe under the circular import with
// `./SignalingNetwork.ts` (which exposes the Tag's static sugar).
export const realLayer: Layer.Layer<SignalingNetwork> = Layer.suspend(() =>
  Layer.sync(SignalingNetwork, () => makeRealImpl({ recordTrace: false })),
)

export const realCoreLayer: Layer.Layer<SignalingNetworkCore> = Layer.suspend(() =>
  Layer.sync(SignalingNetworkCore, () => makeRealImpl({ recordTrace: false })),
)
