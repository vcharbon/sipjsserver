/**
 * MediaEndpoint — Tag + public types for the media (RTP) subsystem.
 *
 * The endpoint archetype (our endpoints = browsers): it *owns* media
 * generation — codec, RTP framing, SSRC/seq/timestamp, RTCP, pacing — and
 * never exposes raw RTP on its public frontier. The frontier is PCM: "play
 * this PCM" / "give me recorded PCM" + getStats()-style counts. It binds a
 * local RTP port on the shared SignalingNetwork (sim or real), so it runs
 * unchanged under fake-clock and real UDP.
 *
 * Model (Slice 2): one **MediaTransport** per offer (= one local port). It
 * demuxes inbound RTP into per-(remote,SSRC) **source buckets** and records
 * each, and carries one or more per-dialog **MediaSession**s. At most one
 * session is the committed **active peer** — the only one we send to and the
 * one a plain `hears(dialog)` resolves against. The SDP O/A engine
 * (`./sdp/`) produces the `NegotiatedMedia` each session is configured with.
 */

import { type Effect, type Scope, ServiceMap } from "effect"
import type { BindError } from "../sip/SignalingNetwork.js"
import type { G711Codec } from "./codec/g711.js"
import type { MediaNegotiationError, NegotiatedMedia } from "./sdp/types.js"

export interface CodecDesc {
  readonly name: G711Codec
  readonly payloadType: number
  readonly clockRate: 8000
}

export const PCMA: CodecDesc = { name: "PCMA", payloadType: 8, clockRate: 8000 }
export const PCMU: CodecDesc = { name: "PCMU", payloadType: 0, clockRate: 8000 }

export interface PcmBuffer {
  readonly pcm: Int16Array
  readonly sampleRate: number
}

export interface NetAddr {
  readonly ip: string
  readonly port: number
}

/**
 * A play directive. Slice 1 plays raw PCM; `sequence` (RBT-then-media on one
 * uninterrupted flow) lands in Slice 4.
 */
export type PlayScript =
  | { readonly kind: "pcm"; readonly pcm: Int16Array }
  | { readonly kind: "sequence"; readonly parts: ReadonlyArray<PlayScript> }

export interface MediaStreamStats {
  readonly direction: "outbound" | "inbound"
  readonly ssrc: number
  readonly codec: string
  readonly payloadType: number
  readonly packets: number
  readonly bytes: number
  readonly rtcpPacketsSent: number
  readonly rtcpPacketsReceived: number
  readonly remote?: NetAddr
}

/** A per-(remote,SSRC) inbound stream the transport demuxed and recorded. */
export interface SourceBucket {
  readonly remote: NetAddr
  readonly ssrc: number
  readonly payloadType: number
  readonly packets: number
  readonly bytes: number
  readonly pcm: PcmBuffer
}

export interface OpenOptions {
  readonly queueMax?: number
  /** RTCP report interval; defaults to the standard 5 s. */
  readonly rtcpIntervalMs?: number
  /** Frame duration (ptime); defaults to 20 ms. */
  readonly ptimeMs?: number
}

export type CommitReason = "early-pem" | "confirmed"

/** One per dialog (early or confirmed); shares a MediaTransport under forking. */
export interface MediaSession {
  readonly dialogId: string
  /** Codec, remote addr, direction — from the O/A engine's NegotiatedMedia. */
  configure: (remote: NegotiatedMedia) => Effect.Effect<void, MediaNegotiationError>
  /** Become the committed active peer; abandons sibling sessions. */
  commit: (reason: CommitReason) => Effect.Effect<void>
  /** Non-blocking; only emits once committed + active + send-enabled. */
  play: (script: PlayScript) => Effect.Effect<void>
  /** Inbound PCM attributed to this peer (matched by negotiated remote). */
  recorded: () => Effect.Effect<PcmBuffer>
  isActive: () => Effect.Effect<boolean>
}

/** One transport = one local RTP port (one offer). */
export interface MediaTransport {
  readonly localAddr: NetAddr
  readonly supportedCodecs: ReadonlyArray<CodecDesc>
  session: (dialogId: string) => Effect.Effect<MediaSession>
  sources: () => Effect.Effect<ReadonlyArray<SourceBucket>>
  activePeer: () => Effect.Effect<MediaSession | null>
  stats: () => Effect.Effect<ReadonlyArray<MediaStreamStats>>
  /** TS-only raw RTP inject escape hatch — reserved for negative wire tests. */
  sendRaw: (bytes: Uint8Array, remote: NetAddr) => Effect.Effect<void>
}

export interface MediaEndpointApi {
  /**
   * Bind a local RTP port. `localPort` omitted → the endpoint allocates the
   * next even port from its media range (RTP/RTCP are muxed, so ports step by
   * 2). The chosen port is reflected in `transport.localAddr` and feeds the
   * SDP offer/answer. Explicit ports are honoured for deterministic tests.
   */
  open: (localIp: string, localPort?: number, opts?: OpenOptions) => Effect.Effect<MediaTransport, BindError, Scope.Scope>
}

export class MediaEndpoint extends ServiceMap.Service<MediaEndpoint, MediaEndpointApi>()(
  "@sipjsserver/MediaEndpoint",
) {}
