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
import * as Fiber from "effect/Fiber"
import { ConnectivityGate, type ConnectivityGateApi } from "./ConnectivityGate.js"
import type { RemoteInfo } from "./types.js"

/**
 * Read the active fiber's `ConnectivityGate` reference. Falls back to
 * the always-allow default when invoked from bare sync code (tests that
 * mount the simulated layer outside an Effect — none today, but this
 * keeps the helper symmetric with `currentRng()` in MessageHelpers).
 */
function currentConnectivityGate(): ConnectivityGateApi {
  const fiber = Fiber.getCurrent()
  if (fiber !== undefined) return fiber.getRef(ConnectivityGate)
  return ConnectivityGate.defaultValue()
}

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
   * used to live in `tests/fullcall/framework/{live,simulated}-backend.ts`.
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
 * Sequencer hook for `NetworkTraceEntry.seq`. Opaque to this module so
 * `src/sip/...` stays independent of `src/test-harness/...`. The test
 * harness builds an `EventSequencer` and adapts it into this shape so
 * one counter spans SIP network entries, interpreter step traces, and
 * replication frames — guaranteeing a deterministic render order even
 * when events collide on the same ms.
 */
export interface NetworkTraceSequencer {
  readonly nextSync: () => number
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

/**
 * Network-level trace entry — captured by the simulated fabric on every
 * successful delivery. Lets the test harness reconstruct the full
 * end-to-end exchange (including internal proxy↔worker hops) without
 * wrapping every endpoint at bind time.
 *
 * Real fabric returns an empty trace; this is a simulated-only feature.
 */
export interface NetworkTraceEntry {
  readonly src: { readonly ip: string; readonly port: number }
  readonly dst: { readonly ip: string; readonly port: number }
  readonly raw: Buffer
  /** Virtual-clock instant the sender called `send()`. */
  readonly sentMs: number
  /** Virtual-clock instant the packet was enqueued at the destination. */
  readonly deliveredMs: number
  /** False when no endpoint was bound at `dst`; the packet was dropped. */
  readonly delivered: boolean
  /**
   * Monotonic capture-order tiebreaker. Allocated from the harness's
   * shared `EventSequencer` at the moment the entry is appended, so
   * renderers can stable-sort events that share the same `deliveredMs`.
   * Zero when no sequencer was supplied to the network layer (low-level
   * unit tests that don't render reports).
   */
  readonly seq: number
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
  /**
   * Set `SO_REUSEPORT` on the underlying UDP socket. Multiple processes can
   * bind the same `(ip, port)` and the kernel load-balances incoming packets
   * across them. Used by the SIP front proxy (see
   * `docs/todos/SIP-Front-Proxy.md`, D6/D7) so multiple proxy processes can
   * share an ingress port without an in-pod supervisor.
   *
   * Real impl: forwarded to `dgram.createSocket({ reusePort })`.
   * Simulated impl: accepted and ignored (single-process in-memory fabric).
   *
   * Defaults to `false` to preserve existing behavior for B2BUA workers.
   */
  readonly reusePort?: boolean
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

/**
 * Shape shared by every SignalingNetwork-flavoured service tag. Extracted
 * so sibling tags (e.g. `SignalingNetworkCore`, used by the hybrid runner
 * to split the proxy's ext vs core endpoints across two distinct fabrics)
 * can re-use the same surface without re-declaring it.
 */
export interface SignalingNetworkApi {
  readonly bindUdp: (opts: BindUdpOpts) => Effect.Effect<UdpEndpoint, BindError, Scope.Scope>
  /**
   * Drain undeliverable packets accumulated since last drain. Real
   * implementation always returns []; simulated implementation returns
   * and clears its buffer.
   */
  readonly drainUndeliverable: () => Effect.Effect<ReadonlyArray<UndeliveredPacket>>
  /**
   * Drain network-level trace entries accumulated since last drain.
   * Simulated implementation populates this on every delivery; real
   * implementation returns an empty array (real-UDP recording lives
   * elsewhere, if anywhere).
   *
   * Used by the test harness to reconstruct the full end-to-end
   * exchange — including internal proxy↔worker hops that no agent
   * endpoint would otherwise observe.
   */
  readonly drainTrace: () => Effect.Effect<ReadonlyArray<NetworkTraceEntry>>
  /**
   * Simulated: configured endpoint-to-endpoint transit delay (ms). The
   * trace renderer reads this to compute the peer-side observation time
   * from a single captured send/receive clock.
   *
   * Real: `undefined` — on real sockets each side stamps its own clock.
   */
  readonly transitDelayMs: number | undefined
  /**
   * Number of packets currently mid-transit on the simulated fabric — i.e.
   * a `send()` was called but the destination-side `deliver` hasn't run
   * yet. Synchronous getter; cheap.
   *
   * Used by `tests/support/pumpAll.ts` as a defense-in-depth signal that
   * "no pending sleep" doesn't mean "no transit fiber waiting to run".
   *
   * Real impl: always returns 0 — real UDP has no notion of in-flight
   * tracked here (the kernel owns it).
   */
  readonly inFlight: () => number
  /**
   * External hook the `BufferedUdpEndpoint` wrapper calls to register
   * its in-flight buffered packets with the simulated network's
   * `inFlight` counter. Production layers (real UDP) accept the call
   * and discard — there's nothing to coordinate with `pumpAll` outside
   * tests. Simulated layer adds `delta` to the shared `inFlightCount`
   * so `pumpAll` waits for buffered packets to drain.
   */
  readonly bumpInFlight: (delta: number) => void
}

export class SignalingNetwork extends ServiceMap.Service<
  SignalingNetwork,
  SignalingNetworkApi
>()("@sipjsserver/SignalingNetwork") {
  // -------------------------------------------------------------------------
  // Real (dgram-backed) implementation
  // -------------------------------------------------------------------------

  /**
   * Production layer — `dgram`-backed, **trace recording disabled**.
   *
   * `drainTrace()` on this layer always returns an empty array; the
   * send/recv hot paths never allocate a `NetworkTraceEntry` and never
   * retain the inbound/outbound `Buffer`. This is what `bin/proxy.ts`
   * and `dist/main.js` must use; using `realTracing` in production
   * causes unbounded `arrayBuffers` growth (every SIP frame retained
   * for the lifetime of the process — see git history of this file
   * for the original observation).
   */
  static readonly real: Layer.Layer<SignalingNetwork> = Layer.sync(
    SignalingNetwork,
    () => makeRealImpl({ recordTrace: false })
  )

  /**
   * Functional-test layer — `dgram`-backed, **trace recording enabled**.
   *
   * Identical wire behaviour to `real`. Additionally records every
   * accepted recv and every successful send into an in-memory buffer;
   * `drainTrace()` returns + clears that buffer. Test harnesses
   * (`tests/sip-front-proxy/_report/runner.ts`,
   * `tests/support/hybridRunner.ts`,
   * `tests/fullcall/framework/simulated-backend.ts`) use this so they
   * can reconstruct the full hop-by-hop SIP exchange even across
   * proxy↔worker boundaries that no test agent would otherwise see.
   *
   * **Never** layer this in production. The trace buffer is unbounded
   * and pins every `Buffer` payload — at SIP traffic rates this is a
   * leak. The split into a separate symbol exists so production code
   * paths can't accidentally enable recording.
   */
  /**
   * Test-harness factory: `realTracing(opts?)`. Optionally accepts a
   * `traceSequencer` so the harness's shared `EventSequencer` stamps
   * `seq` on every recorded packet. Called with no arg, the layer
   * falls back to a per-instance counter — sufficient for standalone
   * trace tests but not for rendering merged reports across fabrics.
   */
  static readonly realTracing = (opts?: {
    readonly traceSequencer?: NetworkTraceSequencer
  }): Layer.Layer<SignalingNetwork> =>
    Layer.sync(SignalingNetwork, () =>
      makeRealImpl(
        opts?.traceSequencer !== undefined
          ? { recordTrace: true, traceSequencer: opts.traceSequencer }
          : { recordTrace: true },
      ),
    )

  // -------------------------------------------------------------------------
  // Simulated (in-memory fabric) implementation
  // -------------------------------------------------------------------------

  static readonly simulated = (opts: {
    readonly transitDelayMs: number
    /**
     * Optional shared sequencer (see `NetworkTraceSequencer` above).
     * When the harness passes one, every `NetworkTraceEntry.seq` is
     * allocated from this counter so the render path can tiebreak
     * same-ms events across multiple fabrics + recording layers.
     */
    readonly traceSequencer?: NetworkTraceSequencer
    /**
     * Test-only: when set, every `UdpEndpoint.send` runs this predicate
     * before enqueueing the packet. A non-null return makes the send fail
     * with `SendError({ message })` — used by drop-handling tests
     * (NXDOMAIN, EAI_AGAIN, ICMP unreachable) without going through real
     * UDP. Default `undefined`: send never fails (legacy behaviour).
     */
    readonly sendFault?: (
      src: { readonly ip: string; readonly port: number },
      dst: { readonly ip: string; readonly port: number },
    ) => string | null
  }): Layer.Layer<SignalingNetwork> =>
    Layer.effect(
      SignalingNetwork,
      Effect.gen(function* () {
        const { transitDelayMs, sendFault } = opts
        // Falls back to a per-instance counter when the harness didn't
        // supply a shared sequencer (low-level unit tests). Ordering
        // within this fabric stays monotonic; cross-fabric ordering is
        // only guaranteed when a shared sequencer is plumbed in.
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

        // ip:port → EndpointRecord. Hot path for routing; MutableHashMap per
        // repo convention for hot-path maps.
        const routingTable = MutableHashMap.empty<string, EndpointRecord>()
        // Undeliverable packet buffer; drained by the harness.
        const undeliverable: UndeliveredPacket[] = []
        // Successful-delivery trace; drained by the harness for the
        // network-view report. One entry per successful enqueue at
        // destination — covers internal proxy↔worker hops that no agent
        // endpoint observes directly.
        const trace: NetworkTraceEntry[] = []
        // Number of forked transit fibers currently between send() and
        // deliver() completion. Read by `tests/support/pumpAll.ts` to know
        // when the simulated fabric is fully drained.
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

            /**
             * Deliver a buffer from `src` to the endpoint at `dst`. Applies
             * preIngress if configured. The preIngress-reply path forks
             * another delivery back to src through the same code path, so
             * reply packets honor the same transit delay and routing rules.
             *
             * `sentMs` is the wall-clock the *sender* called `send()`, kept
             * for the network trace so the trace renderer can show the
             * sent-vs-delivered gap (= transit delay) accurately.
             */
            const deliver = (
              raw: Buffer,
              src: RemoteInfo,
              dst: RemoteInfo,
              sentMs: number,
            ): Effect.Effect<void> =>
              Effect.gen(function* () {
                // Connectivity-gate check (slice 1.3): if the test layer
                // has disconnected/partitioned this src→dst pair, drop
                // the packet without enqueueing or recording an
                // undeliverable. Distinct from "no endpoint bound" —
                // the endpoint exists, the network just refuses to
                // carry the packet right now.
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
                    // Fork the reply back to the source on the same transit
                    // profile. deliver() handles the lookup — if the source
                    // happened to close, the reply becomes undeliverable.
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

        return {
          bindUdp,
          drainUndeliverable,
          drainTrace,
          transitDelayMs: opts.transitDelayMs,
          inFlight: () => inFlightCount,
          bumpInFlight: (delta: number) => { inFlightCount += delta },
        }
      })
    )
}

// ---------------------------------------------------------------------------
// Sibling tag for the proxy's core endpoint
// ---------------------------------------------------------------------------

/**
 * Optional second-fabric tag, consumed by `ProxyCore` when it needs to
 * bind its `core` endpoint on a different physical fabric than its `ext`
 * endpoint. Production and the fake-clock fakestack do NOT provide this;
 * the proxy then falls back to reusing the single `SignalingNetwork`
 * instance for both endpoints (current behaviour).
 *
 * The hybrid `register-fakeExt-realCore` runner provides it as a real
 * dgram-backed layer while keeping `SignalingNetwork` simulated, so the
 * ext side stays fully in-memory while the core side talks to real
 * sockets.
 */
export class SignalingNetworkCore extends ServiceMap.Service<
  SignalingNetworkCore,
  SignalingNetworkApi
>()("@sipjsserver/SignalingNetworkCore") {
  static readonly real: Layer.Layer<SignalingNetworkCore> = Layer.sync(
    SignalingNetworkCore,
    () => makeRealImpl({ recordTrace: false })
  )

  static readonly realTracing = (opts?: {
    readonly traceSequencer?: NetworkTraceSequencer
  }): Layer.Layer<SignalingNetworkCore> =>
    Layer.sync(SignalingNetworkCore, () =>
      makeRealImpl(
        opts?.traceSequencer !== undefined
          ? { recordTrace: true, traceSequencer: opts.traceSequencer }
          : { recordTrace: true },
      ),
    )
}

// ─────────────────────────────────────────────────────────────────────────
// Shared real-network implementation factory (used by SignalingNetwork.real
// and SignalingNetwork.realTracing). The only difference between the two
// layers is `recordTrace`: when false, the per-packet `trace.push(...)`
// calls are skipped — no `NetworkTraceEntry` is allocated, no `Buffer` is
// retained — so the production hot path stays leak-free.
// ─────────────────────────────────────────────────────────────────────────
function makeRealImpl({
  recordTrace,
  traceSequencer,
}: {
  readonly recordTrace: boolean
  readonly traceSequencer?: NetworkTraceSequencer
}) {
  // Per-instance trace buffer. Always allocated; `recordTrace` gates the
  // writes. Drains return [] on the non-recording layer regardless of
  // contents (defence in depth).
  const trace: NetworkTraceEntry[] = []
  // See `simulated()` for the same fallback logic. UDP recv handlers
  // run in non-Effect Node callbacks, so we need the synchronous
  // accessor here.
  const allocSeq: () => number = (() => {
    if (traceSequencer !== undefined) return traceSequencer.nextSync
    let local = 0
    return () => ++local
  })()

  return {
    bindUdp: (opts: BindUdpOpts) =>
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
  }
}
