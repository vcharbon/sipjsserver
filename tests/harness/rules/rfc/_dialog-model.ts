/**
 * Pure helpers reused across the cross-message RFC rules. Detached from
 * the legacy `_replay.ts` (which Slice 6 deletes) so the new rules don't
 * outlive their dependency.
 *
 * `DialogModel` is a light per-agent state (UAC/UAS role, route set,
 * dialog URIs, INVITE branches). Each cross-message rule walks the
 * ordered (sent + received) event stream for one agent and feeds each
 * message through `advanceDialogModel` before / after its own check.
 */

import type { SipHeader, SipMessage, SipRequest } from "../../../../src/sip/types.js"

// ---------------------------------------------------------------------------
// Header utilities
// ---------------------------------------------------------------------------

export const getHeaderValue = (
  headers: ReadonlyArray<SipHeader>,
  name: string,
): string | undefined =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value

export const getAllHeaderValues = (
  headers: ReadonlyArray<SipHeader>,
  name: string,
): string[] =>
  headers
    .filter((h) => h.name.toLowerCase() === name.toLowerCase())
    .map((h) => h.value)

export const routeIsLoose = (routeValue: string): boolean =>
  /;lr(?=[;>,\s]|$)/i.test(routeValue)

export const extractRouteUri = (routeValue: string): string => {
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
  readonly rawOriginLine: string
  readonly bodyDigestExcludingOrigin: string
}

const TEXT_DECODER = new TextDecoder()

export const parseSdpOrigin = (body: Uint8Array): ParsedSdpOrigin | null => {
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
  readonly present: boolean
  readonly value: number | undefined
}

export const readRport = (
  viaParams: Record<string, string | true>,
): ViaRportInfo => {
  if (!("rport" in viaParams)) return { present: false, value: undefined }
  const v = viaParams.rport
  if (v === true) return { present: true, value: undefined }
  const parsed = Number.parseInt(v, 10)
  return { present: true, value: Number.isFinite(parsed) ? parsed : undefined }
}

// ---------------------------------------------------------------------------
// Light dialog model
// ---------------------------------------------------------------------------

export interface DialogModel {
  callId: string
  localTag: string
  remoteTag: string
  dialogLocalUri: string
  dialogRemoteUri: string
  routeSet: string[]
  isUac: boolean
  isUas: boolean
  initialInviteSentBranch: string
  initialInviteReceivedBranch: string
}

export const emptyDialogModel = (): DialogModel => ({
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
})

export interface OrderedAgentEvent {
  readonly kind: "sent" | "received"
  readonly idx: number
  readonly msg: SipMessage
}

export const advanceDialogModel = (
  m: DialogModel,
  ev: OrderedAgentEvent,
): void => {
  const msg = ev.msg

  if (ev.kind === "sent") {
    if (msg.type === "request") {
      if (msg.method === "INVITE" && !m.initialInviteSentBranch) {
        m.isUac = true
        m.initialInviteSentBranch = msg.getHeader("via")[0]?.branch ?? ""
        m.callId ||= msg.getHeader("call-id")
        const fromTag = msg.getHeader("from").tag
        if (fromTag) m.localTag ||= fromTag
        m.dialogLocalUri ||= msg.getHeader("from").uri
        m.dialogRemoteUri ||= msg.getHeader("to").uri
      }
      return
    }
    if (
      msg.getHeader("cseq").method === "INVITE" &&
      msg.status > 100 &&
      !m.localTag
    ) {
      const toTag = msg.getHeader("to").tag
      if (toTag) m.localTag = toTag
    }
    return
  }

  if (msg.type === "request") {
    if (msg.method === "INVITE" && !m.initialInviteReceivedBranch) {
      m.isUas = true
      m.initialInviteReceivedBranch = msg.getHeader("via")[0]?.branch ?? ""
      m.callId ||= msg.getHeader("call-id")
      m.dialogLocalUri ||= msg.getHeader("to").uri
      m.dialogRemoteUri ||= msg.getHeader("from").uri
      const fromTag = msg.getHeader("from").tag
      if (fromTag) m.remoteTag ||= fromTag
      if (m.routeSet.length === 0) {
        const rr = getAllHeaderValues(msg.headers, "record-route")
        if (rr.length > 0) m.routeSet = [...rr]
      }
    }
    return
  }

  if (msg.getHeader("cseq").method === "INVITE" && msg.status > 100) {
    const toTag = msg.getHeader("to").tag
    if (toTag) m.remoteTag ||= toTag
  }
  if (m.isUac && m.routeSet.length === 0) {
    const isDialogCreating =
      (msg.status >= 200 && msg.status < 300) ||
      (msg.status > 100 &&
        msg.status < 200 &&
        msg.getHeader("to").tag !== undefined)
    if (isDialogCreating && msg.getHeader("cseq").method === "INVITE") {
      const rr = getAllHeaderValues(msg.headers, "record-route")
      if (rr.length > 0) m.routeSet = [...rr].reverse()
    }
  }
}

export const isInDialogRequest = (msg: SipRequest, m: DialogModel): boolean => {
  const fromTag = msg.getHeader("from").tag
  const toTag = msg.getHeader("to").tag
  if (!fromTag || !toTag) return false
  if (msg.method === "INVITE") {
    const branch = msg.getHeader("via")[0]?.branch ?? ""
    if (branch && branch === m.initialInviteSentBranch) return false
  }
  return true
}
