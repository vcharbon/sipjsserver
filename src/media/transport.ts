/**
 * Media transport engine — one local RTP port over the shared
 * SignalingNetwork, paced on the shared Clock. Parameterized by an
 * `RtpFraming` so the TS and rtp.js implementations share this whole engine
 * and differ only in the wire codec (each an independent witness of the
 * other).
 *
 * It demuxes inbound RTP into per-(remote,SSRC) source buckets and records
 * each continuously (regardless of play state). It carries one or more
 * per-dialog `MediaSession`s; at most one is the committed **active peer** —
 * the only session we send from, and the one a plain `recorded()`/`hears`
 * resolves against. Committing one session abandons the rest (their senders
 * stop); inbound recording continues for all sources so forked early media is
 * still observable for the report. RTP and RTCP are muxed on the one port
 * (RFC 5761); RTCP is counts-only.
 */

import { Clock, Effect, Layer, Stream } from "effect"
import { SignalingNetwork } from "../sip/SignalingNetwork.js"
import { alawDecode, alawEncode, mulawDecode, mulawEncode } from "./codec/g711.js"
import {
  type CodecDesc,
  type CommitReason,
  MediaEndpoint,
  type MediaEndpointApi,
  type MediaSession,
  type MediaStreamStats,
  type MediaTransport,
  type NetAddr,
  PCMA,
  PCMU,
  type PcmBuffer,
  type PlayScript,
  type SourceBucket,
} from "./MediaEndpoint.js"
import type { RtpFraming } from "./rtp/packet.js"
import { encodeReceiverReport, encodeSenderReport, isRtcp } from "./rtp/rtcp.js"
import { MediaNegotiationError, type NegotiatedMedia } from "./sdp/types.js"

const SAMPLE_RATE = 8000
const DEFAULT_PTIME_MS = 20
const DEFAULT_RTCP_INTERVAL_MS = 5000
const DEFAULT_QUEUE_MAX = 2048
/** Base of the endpoint's auto-allocated RTP port range (even ports, +2 step). */
const AUTO_PORT_BASE = 40000

function deriveSsrc(ip: string, port: number): number {
  let h = 0x811c9dc5
  const s = `${ip}:${port}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function encodePcm(pcm: Int16Array, codec: CodecDesc): Uint8Array {
  return codec.name === "PCMA" ? alawEncode(pcm) : mulawEncode(pcm)
}

function decodePayload(payload: Uint8Array, payloadType: number): Int16Array {
  return payloadType === PCMU.payloadType ? mulawDecode(payload) : alawDecode(payload)
}

/** Flatten a (possibly nested) PlayScript into one continuous PCM stream. */
function flattenScript(script: PlayScript): Int16Array {
  if (script.kind === "pcm") return script.pcm
  const parts = script.parts.map(flattenScript)
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Int16Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

interface InternalBucket {
  readonly ssrc: number
  readonly remote: NetAddr
  payloadType: number
  packets: number
  bytes: number
  readonly pcm: number[]
}

interface SessionState {
  readonly dialogId: string
  negotiated: NegotiatedMedia | null
  committed: boolean
  abandoned: boolean
}

function sameAddr(a: NetAddr, b: NetAddr): boolean {
  return a.ip === b.ip && a.port === b.port
}

export function mediaEndpointLayer(
  framing: RtpFraming,
): Layer.Layer<MediaEndpoint, never, SignalingNetwork> {
  return Layer.effect(
    MediaEndpoint,
    Effect.gen(function* () {
      const net = yield* SignalingNetwork
      // Per-endpoint RTP port allocator (shared across opens on this layer).
      let nextAutoPort = AUTO_PORT_BASE

      const open: MediaEndpointApi["open"] = (localIp, localPort, opts) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          const ptimeMs = opts?.ptimeMs ?? DEFAULT_PTIME_MS
          const rtcpIntervalMs = opts?.rtcpIntervalMs ?? DEFAULT_RTCP_INTERVAL_MS
          const samplesPerFrame = Math.round((ptimeMs / 1000) * SAMPLE_RATE)
          const port = localPort ?? (() => {
            const p = nextAutoPort
            nextAutoPort += 2
            return p
          })()

          const endpoint = yield* net.bindUdp({
            ip: localIp,
            port,
            queueMax: opts?.queueMax ?? DEFAULT_QUEUE_MAX,
            raw: true, // RTP — not SIP; bypass the audit channel + tracer.
          })

          const localAddr: NetAddr = { ip: localIp, port }
          const ssrc = deriveSsrc(localIp, port)

          // Shared sender state — one local SSRC; only the active peer sends.
          let seq = 0
          let rtpTimestamp = 0
          let outPackets = 0
          let outBytes = 0
          let outCodec: CodecDesc | null = null
          let lastRemote: NetAddr | null = null
          let rtcpSent = 0
          let rtcpReceived = 0

          const sources = new Map<string, InternalBucket>()
          const sessions = new Map<string, SessionState>()
          let activeSessionId: string | null = null

          const handlePacket = (raw: Buffer, rinfoIp: string, rinfoPort: number) =>
            Effect.sync(() => {
              const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
              if (isRtcp(bytes)) {
                rtcpReceived++
                return
              }
              const parsed = framing.parseRtp(bytes)
              if (parsed === null) return
              const key = `${rinfoIp}:${rinfoPort}:${parsed.header.ssrc}`
              let bucket = sources.get(key)
              if (!bucket) {
                bucket = {
                  ssrc: parsed.header.ssrc,
                  remote: { ip: rinfoIp, port: rinfoPort },
                  payloadType: parsed.header.payloadType,
                  packets: 0,
                  bytes: 0,
                  pcm: [],
                }
                sources.set(key, bucket)
              }
              bucket.packets++
              bucket.bytes += bytes.length
              bucket.payloadType = parsed.header.payloadType
              const decoded = decodePayload(parsed.payload, parsed.header.payloadType)
              for (let i = 0; i < decoded.length; i++) bucket.pcm.push(decoded[i]!)
            })

          // Continuous inbound recorder (all sources).
          yield* Effect.forkIn(
            Stream.runForEach(endpoint.messages, (pkt) =>
              handlePacket(pkt.raw, pkt.rinfo.address, pkt.rinfo.port),
            ),
            scope,
          )

          // RTCP report fiber — counts only. SR once we've sent media, else RR.
          yield* Effect.forkIn(
            Effect.forever(
              Effect.gen(function* () {
                yield* Effect.sleep(`${rtcpIntervalMs} millis`)
                if (lastRemote === null) return
                const nowMs = yield* Clock.currentTimeMillis
                const report =
                  outPackets > 0
                    ? encodeSenderReport({
                        ssrc,
                        ntpMs: nowMs,
                        rtpTimestamp,
                        packetCount: outPackets,
                        octetCount: outBytes,
                      })
                    : encodeReceiverReport(ssrc)
                yield* endpoint
                  .send(Buffer.from(report), lastRemote.port, lastRemote.ip)
                  .pipe(Effect.catchTag("SendError", () => Effect.void))
                rtcpSent++
              }),
            ),
            scope,
          )

          const sendOne = (bytes: Uint8Array, remote: NetAddr) =>
            endpoint
              .send(Buffer.from(bytes), remote.port, remote.ip)
              .pipe(Effect.catchTag("SendError", () => Effect.void))

          const bucketsFor = (remote: NetAddr): InternalBucket[] =>
            [...sources.values()].filter((b) => sameAddr(b.remote, remote))

          const mergePcm = (buckets: ReadonlyArray<InternalBucket>): PcmBuffer => {
            const total = buckets.reduce((n, b) => n + b.pcm.length, 0)
            const merged = new Int16Array(total)
            let off = 0
            for (const b of buckets) {
              merged.set(Int16Array.from(b.pcm), off)
              off += b.pcm.length
            }
            return { pcm: merged, sampleRate: SAMPLE_RATE }
          }

          const makeSession = (st: SessionState): MediaSession => ({
            dialogId: st.dialogId,
            configure: (remote) =>
              Effect.gen(function* () {
                const supported = remote.codec.name === "PCMA" || remote.codec.name === "PCMU"
                if (!supported) {
                  return yield* new MediaNegotiationError({
                    reason: `unsupported codec ${remote.codec.name}`,
                  })
                }
                st.negotiated = remote
              }),
            commit: (_reason: CommitReason) =>
              Effect.sync(() => {
                st.committed = true
                st.abandoned = false
                activeSessionId = st.dialogId
                for (const other of sessions.values()) {
                  if (other.dialogId !== st.dialogId) {
                    other.committed = false
                    other.abandoned = true
                  }
                }
                if (st.negotiated) lastRemote = st.negotiated.remote
              }),
            play: (script) =>
              Effect.gen(function* () {
                const neg = st.negotiated
                if (neg === null || !st.committed || activeSessionId !== st.dialogId || !neg.send) {
                  // Not the active, send-enabled peer → stay silent.
                  return
                }
                const pcm = flattenScript(script)
                const codec = neg.codec
                outCodec = codec
                lastRemote = neg.remote
                const sender = Effect.gen(function* () {
                  let first = true
                  for (let off = 0; off < pcm.length; off += samplesPerFrame) {
                    // Stop if this session lost the active-peer role mid-play.
                    if (activeSessionId !== st.dialogId || st.abandoned) return
                    const chunk = pcm.subarray(off, off + samplesPerFrame)
                    const payload = encodePcm(chunk, codec)
                    rtpTimestamp = (rtpTimestamp + chunk.length) >>> 0
                    seq = (seq + 1) & 0xffff
                    const packet = framing.encodeRtp(
                      {
                        version: 2,
                        padding: false,
                        extension: false,
                        marker: first,
                        payloadType: codec.payloadType,
                        sequenceNumber: seq,
                        timestamp: rtpTimestamp,
                        ssrc,
                      },
                      payload,
                    )
                    first = false
                    outPackets++
                    outBytes += packet.length
                    yield* sendOne(packet, neg.remote)
                    yield* Effect.sleep(`${ptimeMs} millis`)
                  }
                })
                yield* Effect.forkIn(sender, scope)
              }),
            recorded: () =>
              Effect.sync(() => {
                if (st.negotiated === null) return { pcm: new Int16Array(0), sampleRate: SAMPLE_RATE }
                return mergePcm(bucketsFor(st.negotiated.remote))
              }),
            isActive: () => Effect.sync(() => activeSessionId === st.dialogId && !st.abandoned),
          })

          const session: MediaTransport["session"] = (dialogId) =>
            Effect.sync(() => {
              let st = sessions.get(dialogId)
              if (!st) {
                st = { dialogId, negotiated: null, committed: false, abandoned: false }
                sessions.set(dialogId, st)
              }
              return makeSession(st)
            })

          const sourcesList: MediaTransport["sources"] = () =>
            Effect.sync(() =>
              [...sources.values()].map(
                (b): SourceBucket => ({
                  remote: b.remote,
                  ssrc: b.ssrc,
                  payloadType: b.payloadType,
                  packets: b.packets,
                  bytes: b.bytes,
                  pcm: mergePcm([b]),
                }),
              ),
            )

          const activePeer: MediaTransport["activePeer"] = () =>
            Effect.sync(() => {
              if (activeSessionId === null) return null
              const st = sessions.get(activeSessionId)
              return st ? makeSession(st) : null
            })

          const stats: MediaTransport["stats"] = () =>
            Effect.sync(() => {
              const out: MediaStreamStats[] = []
              if (outCodec !== null && lastRemote !== null) {
                out.push({
                  direction: "outbound",
                  ssrc,
                  codec: outCodec.name,
                  payloadType: outCodec.payloadType,
                  packets: outPackets,
                  bytes: outBytes,
                  rtcpPacketsSent: rtcpSent,
                  rtcpPacketsReceived: rtcpReceived,
                  remote: lastRemote,
                })
              }
              for (const b of sources.values()) {
                out.push({
                  direction: "inbound",
                  ssrc: b.ssrc,
                  codec: b.payloadType === PCMU.payloadType ? "PCMU" : "PCMA",
                  payloadType: b.payloadType,
                  packets: b.packets,
                  bytes: b.bytes,
                  rtcpPacketsSent: 0,
                  rtcpPacketsReceived: rtcpReceived,
                  remote: b.remote,
                })
              }
              return out
            })

          const sendRaw: MediaTransport["sendRaw"] = (bytes, remote) => sendOne(bytes, remote)

          const transport: MediaTransport = {
            localAddr,
            supportedCodecs: [PCMA, PCMU],
            session,
            sources: sourcesList,
            activePeer,
            stats,
            sendRaw,
          }
          return transport
        })

      return { open }
    }),
  )
}
