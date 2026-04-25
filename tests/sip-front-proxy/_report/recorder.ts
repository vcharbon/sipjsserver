/**
 * Proxy-test recorder service.
 *
 * Captures every SIP packet a test endpoint sends or receives into a shared
 * in-memory ring. The runner drains the ring at scenario completion and
 * hands it to the report writers.
 *
 * Wires in via `bindRecordedEndpoint(name, addr)` (see ./runner.ts), which
 * wraps `SignalingNetwork.bindUdp` so `endpoint.send`, `.poll`, and `.take`
 * record before/after delegating to the real impl. `endpoint.messages` is
 * NOT instrumented — proxy tests don't consume it.
 */

import { Clock, Effect, Ref, ServiceMap, type Scope, Stream } from "effect"
import {
  SignalingNetwork,
  type UdpEndpoint,
  type SendError,
  type UdpPacket,
} from "../../../src/sip/SignalingNetwork.js"
import { customParser } from "../../../src/sip/parsers/custom/index.js"
import type { SipMessage } from "../../../src/sip/types.js"
import type { ProxyTraceEntry } from "./types.js"

const labelFor = (msg: SipMessage | undefined, raw: Buffer): string => {
  if (msg === undefined) return `<unparseable ${raw.length}B>`
  if (msg.type === "request") {
    return msg.uri ? `${msg.method} ${msg.uri}` : msg.method
  }
  const cseqMethod = msg.parsed.cseq.method
  return `${msg.status} ${msg.reason}${cseqMethod ? ` (${cseqMethod})` : ""}`
}

const tryParse = (raw: Buffer): SipMessage | undefined => {
  const r = customParser.parse(raw)
  return r._tag === "Success" ? r.success : undefined
}

export interface ProxyRecorderApi {
  readonly registerParticipant: (name: string) => Effect.Effect<void>
  readonly recordSend: (
    participant: string,
    dst: { readonly host: string; readonly port: number },
    raw: Buffer
  ) => Effect.Effect<void>
  readonly recordReceive: (
    participant: string,
    pkt: UdpPacket
  ) => Effect.Effect<void>
  readonly snapshot: Effect.Effect<{
    readonly participants: ReadonlyArray<string>
    readonly entries: ReadonlyArray<ProxyTraceEntry>
  }>
}

export class ProxyRecorder extends ServiceMap.Service<ProxyRecorder, ProxyRecorderApi>()(
  "ProxyRecorder"
) {}

const makeApi = Effect.gen(function* () {
  const entriesRef = yield* Ref.make<ReadonlyArray<ProxyTraceEntry>>([])
  const participantsRef = yield* Ref.make<ReadonlyArray<string>>([])

  const registerParticipant = (name: string): Effect.Effect<void> =>
    Ref.update(participantsRef, (xs) => (xs.includes(name) ? xs : [...xs, name]))

  const recordSend = (
    participant: string,
    dst: { readonly host: string; readonly port: number },
    raw: Buffer
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const ts = yield* Clock.currentTimeMillis
      const msg = tryParse(raw)
      const entry: ProxyTraceEntry = {
        timestampMs: ts,
        participant,
        direction: "send",
        peer: { host: dst.host, port: dst.port },
        message: msg,
        rawBytes: raw,
        label: labelFor(msg, raw),
      }
      yield* Ref.update(entriesRef, (xs) => [...xs, entry])
    })

  const recordReceive = (participant: string, pkt: UdpPacket): Effect.Effect<void> =>
    Effect.gen(function* () {
      const msg = tryParse(pkt.raw)
      const entry: ProxyTraceEntry = {
        timestampMs: pkt.arrivalMs,
        participant,
        direction: "receive",
        peer: { host: pkt.rinfo.address, port: pkt.rinfo.port },
        message: msg,
        rawBytes: pkt.raw,
        label: labelFor(msg, pkt.raw),
      }
      yield* Ref.update(entriesRef, (xs) => [...xs, entry])
    })

  const snapshot = Effect.gen(function* () {
    const participants = yield* Ref.get(participantsRef)
    const entries = yield* Ref.get(entriesRef)
    return { participants, entries }
  })

  return ProxyRecorder.of({
    registerParticipant,
    recordSend,
    recordReceive,
    snapshot,
  })
})

export const ProxyRecorderLive = Effect.gen(function* () {
  return yield* makeApi
})

/** Wrap an existing UdpEndpoint so its send/poll/take feed the recorder. */
export const wrapEndpoint = (
  participant: string,
  raw: UdpEndpoint,
  recorder: ProxyRecorderApi
): UdpEndpoint => {
  const send = (
    buf: Buffer,
    dstPort: number,
    dstAddress: string
  ): Effect.Effect<void, SendError> =>
    Effect.gen(function* () {
      yield* recorder.recordSend(participant, { host: dstAddress, port: dstPort }, buf)
      yield* raw.send(buf, dstPort, dstAddress)
    })

  const poll = (): Effect.Effect<UdpPacket | null> =>
    Effect.gen(function* () {
      const pkt = yield* raw.poll()
      if (pkt !== null) yield* recorder.recordReceive(participant, pkt)
      return pkt
    })

  const take = (): Effect.Effect<UdpPacket> =>
    Effect.gen(function* () {
      const pkt = yield* raw.take()
      yield* recorder.recordReceive(participant, pkt)
      return pkt
    })

  // Tap the messages stream too so consumers reading via Stream still record.
  const messages: Stream.Stream<UdpPacket> = raw.messages.pipe(
    Stream.tap((pkt) => recorder.recordReceive(participant, pkt))
  )

  return {
    localAddress: raw.localAddress,
    send,
    poll,
    take,
    messages,
    queueDepth: raw.queueDepth,
    queueMax: raw.queueMax,
    counters: raw.counters,
  }
}

/** Bind a named, recording UDP endpoint backed by `SignalingNetwork.bindUdp`. */
export const bindRecordedEndpoint = (
  participant: string,
  addr: { readonly host: string; readonly port: number },
  queueMax = 64
): Effect.Effect<UdpEndpoint, never, SignalingNetwork | ProxyRecorder | Scope.Scope> =>
  Effect.gen(function* () {
    const net = yield* SignalingNetwork
    const recorder = yield* ProxyRecorder
    yield* recorder.registerParticipant(participant)
    const raw = yield* net
      .bindUdp({ ip: addr.host, port: addr.port, queueMax })
      .pipe(Effect.orDie)
    return wrapEndpoint(participant, raw, recorder)
  })
