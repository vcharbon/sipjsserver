/**
 * NativeSignalingNetwork — `SignalingNetwork` implementation backed by the
 * napi-rs Rust UDP stack. Drop-in replacement for `SignalingNetwork.real`
 * activated via `SIP_UDP_STACK=native`.
 *
 * The native side owns the UDP socket: a tokio runtime runs the recv loop,
 * each datagram is parsed inline by rvoip-sip-core in strict mode, and the
 * resulting envelope is dispatched to JS via a `ThreadsafeFunction`. The JS
 * callback then:
 *
 *   1. Runs the same ADR-0007 strict-grammar gates (`extractRequestFields` /
 *      `extractResponseFields`) the other parser adapters use, materialising
 *      a `SipMessage`. Failures surface as `parsed === undefined` and the
 *      downstream `TransactionLayer` re-parses + logs (same path the JS dgram
 *      fabric takes on a malformed packet).
 *   2. Runs the per-bind `preIngressHook` if supplied (Tier-1 overload brake).
 *      Phase 2A keeps the hook in JS for parity; Phase 2B will port the brake
 *      into Rust so the wasted parse on rejected packets goes away.
 *   3. Offers the resulting `UdpPacket` (with `parsed` pre-set) into the
 *      Effect `Queue`. Tail-drop on full mirrors the JS dgram impl.
 *
 * `drainUndeliverable` / `drainTrace` return empty — same as the production
 * `SignalingNetwork.real` layer (the test-only tracing variant is JS-only).
 */

import { createRequire } from "node:module"
import {
  Cause,
  Effect,
  Layer,
  Queue,
  Result,
  Stream,
  Option,
} from "effect"
import {
  BindError,
  SendError,
  SignalingNetwork,
  type NetworkTraceEntry,
  type SignalingNetworkApi,
  type UdpEndpoint,
  type UdpEndpointCounters,
  type UdpPacket,
  type UndeliveredPacket,
} from "./SignalingNetwork.js"
import {
  extractRequestFields,
  extractResponseFields,
  finalizeRequest,
  finalizeResponse,
} from "./parsers/extract-fields.js"
import type { RemoteInfo, SipHeader, SipMessage } from "./types.js"

// ---------------------------------------------------------------------------
// Native binding (loaded lazily)
// ---------------------------------------------------------------------------

interface NativeHeader {
  readonly name: string
  readonly value: string
}

interface NativeParsedMessage {
  readonly kind: "request" | "response"
  readonly version: string
  readonly method: string | null
  readonly uri: string | null
  readonly status: number | null
  readonly reason: string | null
  readonly headers: ReadonlyArray<NativeHeader>
  readonly body: Buffer
}

interface NativeRecvPacket {
  readonly raw: Buffer
  readonly remoteAddress: string
  readonly remotePort: number
  readonly arrivalMs: number
  readonly parsed: NativeParsedMessage
}

interface NativeUdpHandle {
  send(buf: Buffer, port: number, address: string): void
  close(): void
  metrics(): {
    readonly packetsReceived: number
    readonly packetsSent: number
    readonly parseDrops: number
    readonly dropsTier1Brake: number
    readonly tier1RejectSent: number
  }
  localAddress(): { readonly ip: string; readonly port: number }
}

interface NativeBinding {
  openUdp(
    opts: { ip: string; port: number; queueMax: number },
    onMessage: (packet: NativeRecvPacket) => void,
  ): NativeUdpHandle
}

const require = createRequire(import.meta.url)

let cachedBinding: NativeBinding | undefined
let cachedLoadError: Error | undefined

function loadBinding(): NativeBinding {
  if (cachedBinding !== undefined) return cachedBinding
  if (cachedLoadError !== undefined) throw cachedLoadError
  try {
    cachedBinding = require("../../native/sip-parser/index.cjs") as NativeBinding
    return cachedBinding
  } catch (err) {
    cachedLoadError = err instanceof Error ? err : new Error(String(err))
    throw cachedLoadError
  }
}

// ---------------------------------------------------------------------------
// Adapter: NativeParsedMessage → SipMessage (mirrors src/sip/parsers/native-adapter.ts)
// ---------------------------------------------------------------------------

function adaptHeaders(native: ReadonlyArray<NativeHeader>): SipHeader[] {
  const out: SipHeader[] = []
  for (const h of native) out.push({ name: h.name, value: h.value })
  return out
}

function materializeSipMessage(native: NativeParsedMessage, raw: Buffer): SipMessage | undefined {
  const headers = adaptHeaders(native.headers)
  const body: Uint8Array = native.body.length === 0 ? new Uint8Array(0) : native.body

  if (native.kind === "response") {
    if (native.status === null) return undefined
    const fields = extractResponseFields(headers, native.status)
    if (Result.isFailure(fields)) return undefined
    return finalizeResponse({
      version: native.version,
      status: native.status,
      reason: native.reason ?? "",
      headers,
      body,
      raw,
      eager: fields.success,
    })
  }

  if (native.method === null || native.uri === null) return undefined
  const method = native.method.toUpperCase()
  const fields = extractRequestFields(headers, native.uri, undefined, method)
  if (Result.isFailure(fields)) return undefined
  return finalizeRequest({
    method,
    uri: native.uri,
    version: native.version,
    headers,
    body,
    raw,
    eager: fields.success,
  })
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

function makeNativeImpl(): SignalingNetworkApi {
  return {
    bindUdp: (opts) =>
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<UdpPacket, Cause.Done>(opts.queueMax)
        const counters: UdpEndpointCounters = {
          enqueued: 0,
          tailDropped: 0,
          preIngressDropped: 0,
          preIngressReplies: 0,
        }

        const binding = yield* Effect.try({
          try: () => loadBinding(),
          catch: (err) =>
            new BindError({
              reason: "os_error",
              ip: opts.ip,
              port: opts.port,
              message: `native UDP binding unavailable: ${
                err instanceof Error ? err.message : String(err)
              }`,
            }),
        })

        // Mutable ref so the recv callback can call back into the handle's
        // own `send` for the pre-ingress reply path. `binding.openUdp`
        // synchronously requires the callback at call time, so we close
        // over a slot and fill it after the handle exists.
        const handleRef: { current: NativeUdpHandle | undefined } = {
          current: undefined,
        }

        const onMessage = (packet: NativeRecvPacket): void => {
          const src: RemoteInfo = {
            address: packet.remoteAddress,
            port: packet.remotePort,
          }
          const depth = Queue.sizeUnsafe(queue)

          // Pre-ingress brake (Phase 2A: in JS, after native parse).
          if (opts.preIngress !== undefined) {
            const action = opts.preIngress(packet.raw, src, depth)
            if (action._tag === "drop") {
              counters.preIngressDropped++
              return
            }
            if (action._tag === "reply") {
              counters.preIngressReplies++
              const h = handleRef.current
              if (h !== undefined) {
                // Best-effort native send; failures are dropped silently
                // here to mirror the dgram impl which fire-and-forgets
                // the response (an ICMP-unreach reply will surface as a
                // SendError later on a real send).
                try {
                  h.send(action.buf, src.port, src.address)
                } catch {
                  // intentional: see comment above
                }
              }
              return
            }
          }

          const sip = materializeSipMessage(packet.parsed, packet.raw)
          const udpPacket: UdpPacket = {
            raw: packet.raw,
            rinfo: src,
            arrivalMs: packet.arrivalMs,
            ...(sip !== undefined ? { parsed: sip } : {}),
          }
          if (!Queue.offerUnsafe(queue, udpPacket)) {
            counters.tailDropped++
            return
          }
          counters.enqueued++
        }

        const handle = yield* Effect.try({
          try: () =>
            binding.openUdp(
              { ip: opts.ip, port: opts.port, queueMax: opts.queueMax },
              onMessage,
            ),
          catch: (err) =>
            new BindError({
              reason: "os_error",
              ip: opts.ip,
              port: opts.port,
              message: err instanceof Error ? err.message : String(err),
            }),
        })
        handleRef.current = handle

        const localAddr = handle.localAddress()
        const localAddress = { ip: localAddr.ip, port: localAddr.port }

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              handle.close()
            } catch {
              // close is best-effort; the runtime drop also closes the socket
            }
            Queue.endUnsafe(queue)
          }),
        )

        const send: UdpEndpoint["send"] = (buf, dstPort, dstAddress) =>
          Effect.try({
            try: () => handle.send(buf, dstPort, dstAddress),
            catch: (err) =>
              new SendError({
                message: err instanceof Error ? err.message : String(err),
              }),
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

    drainUndeliverable: () =>
      Effect.succeed([] as ReadonlyArray<UndeliveredPacket>),
    drainTrace: () => Effect.succeed([] as ReadonlyArray<NetworkTraceEntry>),
    transitDelayMs: undefined,
    inFlight: () => 0,
    bumpInFlight: (_: number) => undefined,
    queueDepths: () => [],
  }
}

export const NativeSignalingNetwork: {
  readonly layer: Layer.Layer<SignalingNetwork>
} = {
  layer: Layer.sync(SignalingNetwork, () => makeNativeImpl()),
}
