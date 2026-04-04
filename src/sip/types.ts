/**
 * Core SIP message types for the B2BUA.
 * Headers are stored as an ordered array to preserve multiplicity and order
 * (multiple Via headers, etc.).
 *
 * Eagerly parsed structured fields are available on `parsed` when the
 * custom parser is used. These are quote-aware and immune to injection
 * attacks that affect naive regex-based extraction.
 */

export interface SipHeader {
  readonly name: string   // original case
  readonly value: string  // trimmed value
}

/** Eagerly extracted structured fields from key SIP headers. */
export interface ParsedFields {
  /** From header: display name, URI, tag, all header params. Quote-aware. */
  readonly from: {
    readonly displayName: string | undefined
    readonly uri: string
    readonly tag: string | undefined
    readonly params: Record<string, string | true>
  } | undefined
  /** To header: display name, URI, tag, all header params. Quote-aware. */
  readonly to: {
    readonly displayName: string | undefined
    readonly uri: string
    readonly tag: string | undefined
    readonly params: Record<string, string | true>
  } | undefined
  /** Call-ID header value. */
  readonly callId: string | undefined
  /** CSeq: sequence number and method. */
  readonly cseq: {
    readonly seq: number
    readonly method: string
  } | undefined
  /** Top Via header: transport, host, port, branch, custom params (cr, lg). */
  readonly via: {
    readonly transport: string
    readonly host: string
    readonly port: number | undefined
    readonly branch: string | undefined
    readonly params: Record<string, string | true>
  } | undefined
  /** All Via headers parsed. */
  readonly vias: ReadonlyArray<{
    readonly transport: string
    readonly host: string
    readonly port: number | undefined
    readonly branch: string | undefined
    readonly params: Record<string, string | true>
  }>
  /** Contact header: URI and params. */
  readonly contact: {
    readonly displayName: string | undefined
    readonly uri: string
    readonly params: Record<string, string | true>
  } | undefined
  /** Request-URI parsed (requests only). */
  readonly requestUri: {
    readonly scheme: string
    readonly user: string | undefined
    readonly host: string
    readonly port: number | undefined
    readonly params: Record<string, string>
  } | undefined
}

export interface SipRequest {
  readonly type: "request"
  readonly method: string        // INVITE, ACK, BYE, CANCEL, OPTIONS…
  readonly uri: string           // Request-URI (raw string)
  readonly version: string       // SIP/2.0
  readonly headers: ReadonlyArray<SipHeader>
  readonly body: Uint8Array      // raw bytes — opaque to B2BUA
  readonly raw: Buffer           // original packet bytes
  readonly parsed?: ParsedFields // eagerly extracted structured data
}

export interface SipResponse {
  readonly type: "response"
  readonly version: string       // SIP/2.0
  readonly status: number        // 100, 180, 200…
  readonly reason: string
  readonly headers: ReadonlyArray<SipHeader>
  readonly body: Uint8Array      // raw bytes — opaque to B2BUA
  readonly raw: Buffer           // original packet bytes
  readonly parsed?: ParsedFields // eagerly extracted structured data
}

export type SipMessage = SipRequest | SipResponse

/** Remote address from which a UDP packet was received. */
export interface RemoteInfo {
  readonly address: string
  readonly port: number
}

/** State machine for a single B2BUA call. */
export interface CallRecord {
  readonly aLegCallId: string
  readonly aLegFromTag: string
  aLegToTag: string             // filled when 200 OK arrives from b-leg
  readonly aLegSource: RemoteInfo
  readonly aLegVia: string      // original Via header value from first INVITE

  readonly bLegCallId: string
  readonly bLegFromTag: string  // B2BUA-generated From tag on outgoing INVITE

  bLegToTag: string             // filled from b-leg 200 OK To tag
  bLegContact: string           // filled from b-leg 200 OK Contact

  state: "early" | "confirmed" | "terminated"
  readonly startedAt: number
}
