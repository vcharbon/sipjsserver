/**
 * Shared replay scaffolding for RFC rules.
 *
 * Rules consume a `CallRecording` and walk per-agent event streams to
 * build a small dialog model, then evaluate compliance. Helpers here
 * are intentionally minimal — the heavy `AgentDialogState` mirror
 * lives in [./index.ts](./index.ts) (it ports the validators in
 * [tests/fullcall/framework/validation.ts](../../../fullcall/framework/validation.ts)).
 *
 * New per-rule replays use the lighter `DialogModel` below: just the
 * fields the new RFC checks need (dialog URIs, route set, SDP origin
 * history, rport bookkeeping, sent-request branch index).
 */

import { Effect } from "effect"
import { SipParser } from "../../../../src/sip/Parser.js"
import type { SipMessage, SipRequest, SipHeader } from "../../../../src/sip/types.js"
import type { CallRecording, RecordedMessage } from "../../recording.js"

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

export function parseMessage(raw: string): SipMessage | null {
  const eff = Effect.gen(function* () {
    const parser = yield* SipParser
    return yield* parser.parse(Buffer.from(raw, "utf8"))
  }).pipe(Effect.provide(SipParser.layer), Effect.result)
  const result = Effect.runSync(eff)
  if (result._tag === "Failure") return null
  return result.success
}

export function parsedOf(rec: CallRecording, idx: number): SipMessage | null {
  const e = rec.entries[idx]
  if (!e || e.kind !== "message") return null
  if (e.parsed) return e.parsed
  return parseMessage(e.raw)
}

// ---------------------------------------------------------------------------
// Per-agent event stream
// ---------------------------------------------------------------------------

export interface AgentEvent {
  readonly kind: "sent" | "received"
  /** Index into rec.entries. */
  readonly idx: number
  readonly msg: SipMessage
  readonly entry: RecordedMessage
}

/**
 * Build per-agent event streams (sent + received) sorted by virtual-clock
 * time. The agent label is the *originator* on sent messages and the
 * *observer* on received messages — i.e. always the agent itself, not the
 * peer / SUT.
 */
export function eventsByAgent(rec: CallRecording): Map<string, AgentEvent[]> {
  const out = new Map<string, AgentEvent[]>()
  rec.entries.forEach((e, idx) => {
    if (e.kind !== "message") return
    const msg = parsedOf(rec, idx)
    if (!msg) return
    const agent = e.direction === "received" ? e.to : e.from
    let bucket = out.get(agent)
    if (!bucket) {
      bucket = []
      out.set(agent, bucket)
    }
    bucket.push({ kind: e.direction, idx, msg, entry: e })
  })
  for (const evs of out.values()) {
    evs.sort((a, b) => {
      const ta = a.kind === "sent" ? a.entry.sentMs : a.entry.receivedMs
      const tb = b.kind === "sent" ? b.entry.sentMs : b.entry.receivedMs
      return ta - tb
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Header utilities
// ---------------------------------------------------------------------------

export function getHeaderValue(headers: ReadonlyArray<SipHeader>, name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
}

export function getAllHeaderValues(headers: ReadonlyArray<SipHeader>, name: string): string[] {
  return headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value)
}

/**
 * True if the Record-Route / Route value carries the `;lr` loose-route flag.
 * Mirrors `firstRouteIsLoose` in
 * [tests/fullcall/framework/message-builder.ts](../../../fullcall/framework/message-builder.ts).
 */
export function routeIsLoose(routeValue: string): boolean {
  return /;lr(?=[;>,\s]|$)/i.test(routeValue)
}

/** Pull the URI portion out of a `<sip:...>` Route header value. */
export function extractRouteUri(routeValue: string): string {
  const trimmed = routeValue.trim()
  const m = trimmed.match(/^<([^>]+)>/)
  return m ? m[1]! : trimmed
}

// ---------------------------------------------------------------------------
// SDP origin parsing
// ---------------------------------------------------------------------------

export interface ParsedSdpOrigin {
  readonly username: string
  readonly sessionId: string
  readonly sessionVersion: number
  readonly nettype: string
  readonly addrtype: string
  readonly unicastAddress: string
  /** Raw o= line, for diagnostic messages. */
  readonly rawOriginLine: string
  /**
   * SHA-like signature of the SDP body MINUS the o= line. Lets RFC 3264 §8
   * decide "did anything other than the version change?" by simple equality.
   */
  readonly bodyDigestExcludingOrigin: string
}

const TEXT_DECODER = new TextDecoder()

export function parseSdpOrigin(body: Uint8Array): ParsedSdpOrigin | null {
  if (body.byteLength === 0) return null
  const text = TEXT_DECODER.decode(body)
  if (!text.startsWith("v=0")) return null
  const lines = text.split(/\r?\n/)
  const oIdx = lines.findIndex((l) => l.startsWith("o="))
  if (oIdx < 0) return null
  const oLine = lines[oIdx]!
  const parts = oLine.slice(2).trim().split(/\s+/)
  if (parts.length < 6) return null
  const sessionVersion = Number.parseInt(parts[2]!, 10)
  if (!Number.isFinite(sessionVersion)) return null
  const others = lines.filter((_, i) => i !== oIdx).join("\n")
  return {
    username: parts[0]!,
    sessionId: parts[1]!,
    sessionVersion,
    nettype: parts[3]!,
    addrtype: parts[4]!,
    unicastAddress: parts[5]!,
    rawOriginLine: oLine,
    bodyDigestExcludingOrigin: others,
  }
}

// ---------------------------------------------------------------------------
// Via parameter helpers
// ---------------------------------------------------------------------------

export interface ViaRportInfo {
  /** True iff `;rport` parameter is present at all. */
  readonly present: boolean
  /** Parsed numeric port if `;rport=N`, undefined for `;rport` no-value. */
  readonly value: number | undefined
}

export function readRport(viaParams: Record<string, string | true>): ViaRportInfo {
  if (!("rport" in viaParams)) return { present: false, value: undefined }
  const v = viaParams.rport
  if (v === true) return { present: true, value: undefined }
  const parsed = Number.parseInt(v, 10)
  return { present: true, value: Number.isFinite(parsed) ? parsed : undefined }
}

// ---------------------------------------------------------------------------
// Light dialog model — used by the new mid-dialog-aware rules.
// ---------------------------------------------------------------------------

export interface DialogModel {
  /** Anchored on first INVITE seen on this dialog. */
  callId: string
  /** This agent's tag — From-tag for UAC, To-tag stamped on response for UAS. */
  localTag: string
  /** Peer's tag. */
  remoteTag: string
  /** The URI this agent considers its own in the dialog (RFC 3261 §12.2.1.1). */
  dialogLocalUri: string
  /** The URI of the remote party (RFC 3261 §12.2.1.1). */
  dialogRemoteUri: string
  /**
   * Route set in the order this agent should emit it (UAC: reversed
   * received order; UAS: received order — see §12.1.1 / §12.1.2).
   */
  routeSet: string[]
  /** Set when the agent has confirmed it is the UAC (sent the initial INVITE). */
  isUac: boolean
  /** Set when the agent has confirmed it is the UAS (received the initial INVITE). */
  isUas: boolean
  /** Sent INVITE branch (top Via) — used to disambiguate initial vs re-INVITE. */
  initialInviteSentBranch: string
  /** Received INVITE branch (top Via). */
  initialInviteReceivedBranch: string
}

export function emptyDialogModel(): DialogModel {
  return {
    callId: "",
    localTag: "",
    remoteTag: "",
    dialogLocalUri: "",
    dialogRemoteUri: "",
    routeSet: [],
    isUac: false,
    isUas: false,
    initialInviteSentBranch: "",
    initialInviteReceivedBranch: "",
  }
}

/**
 * Apply a single message to the agent's dialog model. Mutates `m` in place.
 * Pure function of (m, ev) — re-runnable.
 */
export function advanceDialogModel(m: DialogModel, ev: AgentEvent): void {
  const msg = ev.msg

  if (ev.kind === "sent") {
    if (msg.type === "request") {
      if (msg.method === "INVITE" && !m.initialInviteSentBranch) {
        m.isUac = true
        m.initialInviteSentBranch = msg.getHeader("via")[0].branch ?? ""
        m.callId ||= msg.getHeader("call-id")
        const fromTag = msg.getHeader("from").tag
        if (fromTag) m.localTag ||= fromTag
        m.dialogLocalUri ||= msg.getHeader("from").uri
        m.dialogRemoteUri ||= msg.getHeader("to").uri
      }
      return
    }
    // Sent response — UAS path. Local tag is the To-tag we stamped.
    if (msg.getHeader("cseq").method === "INVITE" && msg.status > 100 && !m.localTag) {
      const toTag = msg.getHeader("to").tag
      if (toTag) m.localTag = toTag
    }
    return
  }

  // Received message — peer perspective.
  if (msg.type === "request") {
    if (msg.method === "INVITE" && !m.initialInviteReceivedBranch) {
      m.isUas = true
      m.initialInviteReceivedBranch = msg.getHeader("via")[0].branch ?? ""
      m.callId ||= msg.getHeader("call-id")
      // UAS: dialog-local URI is the To URI of the received INVITE,
      // dialog-remote URI is the From URI.
      m.dialogLocalUri ||= msg.getHeader("to").uri
      m.dialogRemoteUri ||= msg.getHeader("from").uri
      const fromTag = msg.getHeader("from").tag
      if (fromTag) m.remoteTag ||= fromTag
      // UAS route set: keep Record-Route in received order (RFC 3261 §12.1.1).
      if (m.routeSet.length === 0) {
        const rr = getAllHeaderValues(msg.headers, "record-route")
        if (rr.length > 0) m.routeSet = [...rr]
      }
    }
    return
  }

  // Received response — UAC path.
  if (msg.getHeader("cseq").method === "INVITE" && msg.status > 100) {
    const toTag = msg.getHeader("to").tag
    if (toTag) m.remoteTag ||= toTag
  }
  // UAC route set established from the FIRST dialog-creating response —
  // i.e. a 1xx>100 with a To-tag, or any 2xx (RFC 3261 §12.1.2). Reverse
  // the Record-Route order so routeSet[0] is the UAC's first hop.
  if (m.isUac && m.routeSet.length === 0) {
    const isDialogCreating =
      (msg.status >= 200 && msg.status < 300) ||
      (msg.status > 100 && msg.status < 200 && msg.getHeader("to").tag !== undefined)
    if (isDialogCreating && msg.getHeader("cseq").method === "INVITE") {
      const rr = getAllHeaderValues(msg.headers, "record-route")
      if (rr.length > 0) m.routeSet = [...rr].reverse()
    }
  }
}

// ---------------------------------------------------------------------------
// Common predicates
// ---------------------------------------------------------------------------

/**
 * True when the request is "in dialog" — both From and To carry a tag,
 * and it's not the initial INVITE on this dialog.
 */
export function isInDialogRequest(msg: SipRequest, m: DialogModel): boolean {
  const fromTag = msg.getHeader("from").tag
  const toTag = msg.getHeader("to").tag
  if (!fromTag || !toTag) return false
  // CSeq matches the agent's initial-INVITE branch (UAC view) or
  // the received-INVITE branch (UAS view) — but at sender side we don't
  // have correlated branches. Use heuristic: if it's INVITE and matches
  // the initial branch, treat as initial; otherwise in-dialog.
  if (msg.method === "INVITE") {
    const branch = msg.getHeader("via")[0].branch ?? ""
    if (branch && branch === m.initialInviteSentBranch) return false
  }
  return true
}
