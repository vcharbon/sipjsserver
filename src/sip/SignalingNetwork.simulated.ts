/**
 * In-memory simulated SignalingNetwork.
 *
 * Routes packets by (ip, port) through an in-process MutableHashMap.
 * Each successful send is forked with a configurable transit delay so
 * fire-and-forget UDP semantics are preserved (send returns
 * immediately; packet arrives later). Designed for the fake-clock
 * test fabric: every `Effect.sleep` runs under TestClock so a
 * scenario completes in zero real time.
 */

import {
  Cause,
  Clock,
  Effect,
  Layer,
  MutableHashMap,
  Option,
  Queue,
  Stream,
} from "effect"
import * as Fiber from "effect/Fiber"
import { ConnectivityGate, type ConnectivityGateApi } from "./ConnectivityGate.js"
import {
  BindError,
  PreIngressAction,
  SendError,
  SignalingNetwork,
  type BindUdpOpts,
  type NetworkTraceEntry,
  type NetworkTraceSequencer,
  type PreIngressHook,
  type UdpEndpoint,
  type UdpEndpointCounters,
  type UdpPacket,
  type UndeliveredPacket,
} from "./SignalingNetwork.js"
import type { RemoteInfo } from "./types.js"
import { sleepRealMs } from "../runtime/sleepRealMs.js"

function currentConnectivityGate(): ConnectivityGateApi {
  const fiber = Fiber.getCurrent()
  if (fiber !== undefined) return fiber.getRef(ConnectivityGate)
  return ConnectivityGate.defaultValue()
}

export const simulatedLayer = (opts: {
  readonly transitDelayMs: number
  readonly traceSequencer?: NetworkTraceSequencer
  readonly sendFault?: (
    src: { readonly ip: string; readonly port: number },
    dst: { readonly ip: string; readonly port: number },
  ) => string | null
}): Layer.Layer<SignalingNetwork> =>
  Layer.effect(
    SignalingNetwork,
    Effect.gen(function* () {
      const { transitDelayMs, sendFault } = opts
      const allocSeq: () => number = (() => {
        if (opts.traceSequencer !== undefined) {
          return opts.traceSequencer.nextSync
        }
        let local = 0
        return () => ++local
      })()

      interface EndpointRecord {
        readonly endpoint: UdpEndpoint
        readonly queue: Queue.Queue<UdpPacket, Cause.Done>
        readonly counters: UdpEndpointCounters
        readonly preIngress: PreIngressHook | undefined
      }

      const routingTable = MutableHashMap.empty<string, EndpointRecord>()
      const undeliverable: UndeliveredPacket[] = []
      // Legacy trace buffer — kept so the many fake-stack helpers that
      // don't go through the contract wrapper still get hop-by-hop
      // reports via `drainTrace()`. Once every fixture pulls through
      // `Tag.withAllContracts`, the typed channel becomes the single
      // source of truth and this array can be dropped.
      const trace: NetworkTraceEntry[] = []
      let inFlightCount = 0

      const keyOf = (ip: string, port: number) => `${ip}:${port}`

      const bindUdp = (bindOpts: BindUdpOpts) =>
        Effect.gen(function* () {
          const key = keyOf(bindOpts.ip, bindOpts.port)
          if (Option.isSome(MutableHashMap.get(routingTable, key))) {
            return yield* new BindError({
              reason: "already_bound",
              ip: bindOpts.ip,
              port: bindOpts.port,
              message: `already bound: ${key}`,
            })
          }

          const queue = yield* Queue.bounded<UdpPacket, Cause.Done>(bindOpts.queueMax)
          const counters: UdpEndpointCounters = {
            enqueued: 0,
            tailDropped: 0,
            preIngressDropped: 0,
            preIngressReplies: 0,
          }
          const localAddress = { ip: bindOpts.ip, port: bindOpts.port }

          const deliver = (
            raw: Buffer,
            src: RemoteInfo,
            dst: RemoteInfo,
            sentMs: number,
          ): Effect.Effect<void> =>
            Effect.gen(function* () {
              const gate = currentConnectivityGate()
              if (
                !gate.canDeliver(
                  { ip: src.address, port: src.port },
                  { ip: dst.address, port: dst.port },
                )
              ) {
                yield* Effect.logDebug(
                  `[SignalingNetwork.simulated] gated drop ${src.address}:${src.port} → ${dst.address}:${dst.port} (connectivity)`
                )
                return
              }

              const target = Option.getOrUndefined(
                MutableHashMap.get(routingTable, keyOf(dst.address, dst.port))
              )
              if (target === undefined) {
                const nowMs = yield* Clock.currentTimeMillis
                undeliverable.push({
                  raw,
                  src: { ip: src.address, port: src.port },
                  dst: { ip: dst.address, port: dst.port },
                  timestampMs: nowMs,
                })
                trace.push({
                  raw,
                  src: { ip: src.address, port: src.port },
                  dst: { ip: dst.address, port: dst.port },
                  sentMs,
                  deliveredMs: nowMs,
                  delivered: false,
                  seq: allocSeq(),
                })
                yield* Effect.logWarning(
                  `[SignalingNetwork.simulated] undeliverable ${src.address}:${src.port} → ${dst.address}:${dst.port} (no endpoint bound)`
                )
                return
              }

              const depth = Queue.sizeUnsafe(target.queue)
              const action = target.preIngress !== undefined
                ? target.preIngress(raw, src, depth)
                : PreIngressAction.accept()

              switch (action._tag) {
                case "drop":
                  target.counters.preIngressDropped++
                  return
                case "reply": {
                  target.counters.preIngressReplies++
                  inFlightCount++
                  yield* Effect.forkDetach(
                    Effect.gen(function* () {
                      const replySentMs = yield* Clock.currentTimeMillis
                      yield* Effect.sleep(`${transitDelayMs} millis`)
                      yield* deliver(
                        action.buf,
                        { address: dst.address, port: dst.port },
                        src,
                        replySentMs,
                      )
                    }).pipe(Effect.ensuring(Effect.sync(() => { inFlightCount-- })))
                  )
                  return
                }
                case "accept": {
                  const arrivalMs = yield* Clock.currentTimeMillis
                  if (!Queue.offerUnsafe(target.queue, { raw, rinfo: src, arrivalMs })) {
                    target.counters.tailDropped++
                    return
                  }
                  target.counters.enqueued++
                  trace.push({
                    raw,
                    src: { ip: src.address, port: src.port },
                    dst: { ip: dst.address, port: dst.port },
                    sentMs,
                    deliveredMs: arrivalMs,
                    delivered: true,
                    seq: allocSeq(),
                  })
                }
              }
            })

          const send: UdpEndpoint["send"] = (buf, dstPort, dstAddress) =>
            Effect.gen(function* () {
              if (sendFault !== undefined) {
                const reason = sendFault(
                  { ip: localAddress.ip, port: localAddress.port },
                  { ip: dstAddress, port: dstPort },
                )
                if (reason !== null) {
                  return yield* new SendError({ message: reason })
                }
              }
              const sentMs = yield* Clock.currentTimeMillis
              inFlightCount++
              yield* Effect.forkDetach(
                Effect.sleep(`${transitDelayMs} millis`).pipe(
                  Effect.andThen(
                    deliver(
                      buf,
                      { address: localAddress.ip, port: localAddress.port },
                      { address: dstAddress, port: dstPort },
                      sentMs,
                    )
                  ),
                  Effect.ensuring(Effect.sync(() => { inFlightCount-- })),
                )
              )
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
            queueMax: bindOpts.queueMax,
            counters,
          }

          const record: EndpointRecord = {
            endpoint,
            queue,
            counters,
            preIngress: bindOpts.preIngress,
          }

          yield* Effect.sync(() => MutableHashMap.set(routingTable, key, record))
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              MutableHashMap.remove(routingTable, key)
              Queue.endUnsafe(queue)
            })
          )
          return endpoint
        })

      const drainUndeliverable = () =>
        Effect.sync(() => {
          const drained = undeliverable.slice()
          undeliverable.length = 0
          return drained as ReadonlyArray<UndeliveredPacket>
        })

      const drainTrace = () =>
        Effect.sync(() => {
          const drained = trace.slice()
          trace.length = 0
          return drained as ReadonlyArray<NetworkTraceEntry>
        })

      // Snapshot live queue depths so the contract wrapper's
      // layer-close finalizer can flag queue leaks.
      const queueDepths = () => {
        const out: Array<{
          readonly bindKey: { readonly ip: string; readonly port: number }
          readonly depth: number
        }> = []
        for (const [key, rec] of routingTable) {
          const [ip, portStr] = key.split(":")
          out.push({
            bindKey: { ip: ip!, port: Number(portStr) },
            depth: Queue.sizeUnsafe(rec.queue),
          })
        }
        return out
      }

      // Wall-clock deadline (not Effect's Clock) — must work under
      // TestClock too, where `Effect.sleep` would block on virtual
      // time advancement no one is driving inside a layer-close
      // finalizer. See `src/runtime/sleepRealMs.ts` for the rationale.
      const awaitInFlight = (timeoutMs: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          const deadline = Date.now() + timeoutMs
          while (inFlightCount > 0) {
            if (Date.now() >= deadline) return
            yield* sleepRealMs(5)
          }
        })

      return {
        bindUdp,
        drainUndeliverable,
        drainTrace,
        transitDelayMs: opts.transitDelayMs,
        inFlight: () => inFlightCount,
        bumpInFlight: (delta: number) => { inFlightCount += delta },
        queueDepths,
        awaitInFlight,
      }
    })
  )
