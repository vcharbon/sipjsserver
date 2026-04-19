/**
 * SignalingNetwork — abstraction over the SIP-signaling network layer.
 *
 * Two implementations:
 *   - `real`: dgram-backed. Each bindUdp opens a Node.js UDP socket.
 *   - `simulated({ transitDelayMs })`: in-memory routing table keyed on
 *     ip:port. Each packet delivery is forked with a configurable transit
 *     delay so fire-and-forget UDP semantics are preserved (send returns
 *     immediately; packet arrives later).
 *
 * Concrete endpoint types live alongside the service: `UdpEndpoint` here,
 * room for `TcpEndpoint` / `TlsEndpoint` as sibling factories later.
 *
 * Pre-ingress hook: an optional filter supplied at bindUdp() that runs at
 * *arrival* time (not send time). It sees (raw, source rinfo, current queue
 * depth) and returns a PreIngressAction:
 *   - `accept` → packet is enqueued normally
 *   - `drop`   → packet is discarded
 *   - `reply`  → fabric delivers the `reply.buf` back to the source
 *                on the same transit-delay profile (simulated) or via the
 *                bound socket (real). Original packet is discarded.
 *
 * This is the mechanism used by the B2BUA's Tier 1 overload brake: the
 * brake's INVITE-not-emergency classifier + templated-503 response live
 * in the UdpTransport facade and plug in as a PreIngressHook.
 *
 * Fake-IP support: the simulated fabric routes purely by dstIp:dstPort, so
 * tests can bind endpoints at arbitrary fake IPs (10.0.0.1, etc.) and the
 * B2BUA's outbound path exercises the same code it would in production.
 */

import * as dgram from "node:dgram"
import {
  Cause,
  Clock,
  Data,
  Effect,
  Layer,
  MutableHashMap,
  Option,
  Queue,
  Schema,
  Scope,
  ServiceMap,
  Stream,
} from "effect"
import type { RemoteInfo } from "./types.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UdpPacket {
  readonly raw: Buffer
  readonly rinfo: RemoteInfo
  /**
   * Wall-clock (`Clock.currentTimeMillis`) captured at ingress — i.e. the
   * instant SignalingNetwork observed the packet, before it lands on the
   * endpoint queue. Under `TestClock` this is virtual time.
   *
   * Stamping here instead of at dequeue time is what lets the test harness
   * read straight off `endpoint` without the `Stream.runForEach` hop that
   * used to live in `tests/e2e/framework/{live,simulated}-backend.ts`.
   */
  readonly arrivalMs: number
}

/** Per-endpoint counters. Plain object; O(1) reads/writes. */
export interface UdpEndpointCounters {
  enqueued: number
  tailDropped: number
  preIngressDropped: number
  preIngressReplies: number
}

export interface UdpEndpoint {
  readonly localAddress: { readonly ip: string; readonly port: number }
  readonly send: (buf: Buffer, dstPort: number, dstAddress: string) => Effect.Effect<void, SendError>
  readonly messages: Stream.Stream<UdpPacket>
  /**
   * Non-blocking read. Returns the next enqueued packet, or `null` if the
   * queue is empty. Exposed so the test harness can poll straight off the
   * endpoint instead of forking a drain loop into a secondary queue.
   */
  readonly poll: () => Effect.Effect<UdpPacket | null>
  /**
   * Blocking read. Never returns until a packet arrives or the endpoint
   * closes. Intended for the test harness — production code consumes the
   * `messages` stream.
   */
  readonly take: () => Effect.Effect<UdpPacket>
  readonly queueDepth: () => number
  readonly queueMax: number
  readonly counters: UdpEndpointCounters
}

/**
 * Undeliverable record — simulated-only. Accumulated when a sender targets
 * an ip:port that has no bound endpoint. The test harness drains this in
 * verifyCleanState() and fails scenarios that leave undelivered packets.
 */
export interface UndeliveredPacket {
  readonly raw: Buffer
  readonly src: { readonly ip: string; readonly port: number }
  readonly dst: { readonly ip: string; readonly port: number }
  readonly timestampMs: number
}

export type PreIngressAction = Data.TaggedEnum<{
  accept: {}
  drop: {}
  reply: { readonly buf: Buffer }
}>

export const PreIngressAction = Data.taggedEnum<PreIngressAction>()

export type PreIngressHook = (
  raw: Buffer,
  rinfo: RemoteInfo,
  depth: number
) => PreIngressAction

export interface BindUdpOpts {
  readonly ip: string
  readonly port: number
  readonly queueMax: number
  readonly preIngress?: PreIngressHook
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BindError extends Schema.TaggedErrorClass<BindError>()("BindError", {
  reason: Schema.Literals(["already_bound", "os_error"]),
  ip: Schema.String,
  port: Schema.Number,
  message: Schema.String,
}) {}

export class SendError extends Schema.TaggedErrorClass<SendError>()("SendError", {
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SignalingNetwork extends ServiceMap.Service<
  SignalingNetwork,
  {
    readonly bindUdp: (opts: BindUdpOpts) => Effect.Effect<UdpEndpoint, BindError, Scope.Scope>
    /**
     * Drain undeliverable packets accumulated since last drain. Real
     * implementation always returns []; simulated implementation returns
     * and clears its buffer.
     */
    readonly drainUndeliverable: () => Effect.Effect<ReadonlyArray<UndeliveredPacket>>
    /**
     * Simulated: configured endpoint-to-endpoint transit delay (ms). The
     * trace renderer reads this to compute the peer-side observation time
     * from a single captured send/receive clock.
     *
     * Real: `undefined` — on real sockets each side stamps its own clock.
     */
    readonly transitDelayMs: number | undefined
  }
>()("@sipjsserver/SignalingNetwork") {
  // -------------------------------------------------------------------------
  // Real (dgram-backed) implementation
  // -------------------------------------------------------------------------

  static readonly real: Layer.Layer<SignalingNetwork> = Layer.succeed(
    SignalingNetwork,
    {
      bindUdp: (opts) =>
        Effect.gen(function* () {
          const queue = yield* Queue.bounded<UdpPacket, Cause.Done>(opts.queueMax)
          const counters: UdpEndpointCounters = {
            enqueued: 0,
            tailDropped: 0,
            preIngressDropped: 0,
            preIngressReplies: 0,
          }

          const socket = yield* Effect.acquireRelease(
            Effect.callback<dgram.Socket, BindError>((resume) => {
              const sock = dgram.createSocket("udp4")
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

          // Attach recv handler and detach on scope close. Must run inside
          // acquireRelease so the listener is removed even if a later
          // finalizer fails.
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
                    // Fire-and-forget: wire-level send back to the source.
                    // Socket errors surface on the "error" handler below.
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
                  }
                }
              }
              const errorHandler = (err: Error) => {
                // Log via console to avoid pulling in structured logging here.
                // Real callers can subscribe additional handlers if needed.
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
              socket.send(buf, 0, buf.length, dstPort, dstAddress, (err) => {
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
      transitDelayMs: undefined,
    }
  )

  // -------------------------------------------------------------------------
  // Simulated (in-memory fabric) implementation
  // -------------------------------------------------------------------------

  static readonly simulated = (opts: {
    readonly transitDelayMs: number
  }): Layer.Layer<SignalingNetwork> =>
    Layer.effect(
      SignalingNetwork,
      Effect.gen(function* () {
        const { transitDelayMs } = opts

        interface EndpointRecord {
          readonly endpoint: UdpEndpoint
          readonly queue: Queue.Queue<UdpPacket, Cause.Done>
          readonly counters: UdpEndpointCounters
          readonly preIngress: PreIngressHook | undefined
        }

        // ip:port → EndpointRecord. Hot path for routing; MutableHashMap per
        // repo convention for hot-path maps.
        const routingTable = MutableHashMap.empty<string, EndpointRecord>()
        // Undeliverable packet buffer; drained by the harness.
        const undeliverable: UndeliveredPacket[] = []

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

            /**
             * Deliver a buffer from `src` to the endpoint at `dst`. Applies
             * preIngress if configured. The preIngress-reply path forks
             * another delivery back to src through the same code path, so
             * reply packets honor the same transit delay and routing rules.
             */
            const deliver = (raw: Buffer, src: RemoteInfo, dst: RemoteInfo): Effect.Effect<void> =>
              Effect.gen(function* () {
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
                    // Fork the reply back to the source on the same transit
                    // profile. deliver() handles the lookup — if the source
                    // happened to close, the reply becomes undeliverable.
                    yield* Effect.forkDetach(
                      Effect.sleep(`${transitDelayMs} millis`).pipe(
                        Effect.andThen(
                          deliver(
                            action.buf,
                            { address: dst.address, port: dst.port },
                            src
                          )
                        )
                      )
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
                  }
                }
              })

            const send: UdpEndpoint["send"] = (buf, dstPort, dstAddress) =>
              Effect.forkDetach(
                Effect.sleep(`${transitDelayMs} millis`).pipe(
                  Effect.andThen(
                    deliver(
                      buf,
                      { address: localAddress.ip, port: localAddress.port },
                      { address: dstAddress, port: dstPort }
                    )
                  )
                )
              ).pipe(Effect.asVoid)

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

        return { bindUdp, drainUndeliverable, transitDelayMs: opts.transitDelayMs }
      })
    )
}
