/**
 * Test-side projector — derives per-(bindKey, Call-ID) slices from the
 * typed SignalingNetwork channel and rebuilds per-agent dialog state on
 * each slice.
 *
 * Cross-message RFC rules consume `PerDialogSlice[]` directly. Per
 * `bindKey` already gives "per-agent" (each peer binds its own socket);
 * adding `Call-ID` as a second key gives per-dialog isolation so SDP /
 * Allow / Trying / etc. don't bleed across unrelated calls multiplexed
 * on the same socket.
 */

import { Result } from "effect"
import { createCustomParser } from "../../src/sip/parsers/custom/index.js"
import type { SipMessage } from "../../src/sip/types.js"
import {
  createAgentDialogState,
  type AgentDialogState,
} from "../../src/test-harness/framework/message-builder.js"
import type {
  SignalingNetworkEvent,
} from "../../src/sip/SignalingNetwork.contracts.js"
import type {
  LaneKey,
  RecordedStamps,
} from "../../src/test-harness/framework/report-recorder/types.js"

const LENIENT_PARSER = createCustomParser({ wireGrammar: false })

const tryParse = (raw: Buffer): SipMessage | null => {
  const res = LENIENT_PARSER.parse(raw)
  return Result.isSuccess(res) ? res.success : null
}

/**
 * Per-(bindKey, Call-ID) slice. `perAgent` is a one-element array kept
 * to satisfy the documented shape — each bindKey owns one slot in the
 * dialog. Cross-peer correlation lives at the caller (the layer-close
 * finalizer iterates every slice it produced).
 */
export interface PerDialogSlice {
  readonly callId: string
  readonly fromTag: string
  readonly toTag: string | null
  readonly perAgent: ReadonlyArray<{
    readonly bindKey: LaneKey
    readonly received: ReadonlyArray<{ idx: number; msg: SipMessage }>
    readonly sent: ReadonlyArray<{ idx: number; msg: SipMessage }>
    readonly state: AgentDialogState
  }>
}

interface OrderedEntry {
  readonly kind: "sent" | "received"
  readonly bindKey: LaneKey
  readonly atMs: number
  readonly seq: number
  readonly msg: SipMessage
  readonly rawBytes: Buffer
}

const stamped = (
  e: SignalingNetworkEvent & RecordedStamps,
): OrderedEntry | null => {
  if (e.tag === "send.called") {
    const m = tryParse(e.msg)
    if (m === null) return null
    return {
      kind: "sent",
      bindKey: e.bindKey,
      atMs: e.atMs,
      seq: e.seq,
      msg: m,
      rawBytes: e.msg,
    }
  }
  if (e.tag === "messages.streamItem") {
    const m = tryParse(e.envelope.raw)
    if (m === null) return null
    return {
      kind: "received",
      bindKey: e.bindKey,
      atMs: e.atMs,
      seq: e.seq,
      msg: m,
      rawBytes: e.envelope.raw,
    }
  }
  return null
}

const trackSent = (ds: AgentDialogState, msg: SipMessage): void => {
  if (msg.type === "request") {
    ds.sentRequests.push({
      msg,
      method: msg.method,
      cseqNumber: msg.getHeader("cseq").seq,
      viaBranch: msg.getHeader("via")[0]?.branch ?? "",
    })
    const fromTag = msg.getHeader("from").tag
    if (fromTag) ds.localTags.add(fromTag)
    return
  }
  const toTag = msg.getHeader("to").tag
  if (toTag) ds.localTags.add(toTag)
}

const trackReceived = (ds: AgentDialogState, msg: SipMessage): void => {
  const callIdHeader = msg.getHeader("call-id")

  if (msg.type === "request" && msg.method === "INVITE") {
    ds.callId = callIdHeader
    ds.callIdConfirmed = true
    ds.receivedInviteUri = msg.uri
    const branch = msg.getHeader("via")[0]?.branch
    if (branch !== undefined) ds.receivedInviteBranch = branch
    if (!ds.dialogRemoteUri) ds.dialogRemoteUri = msg.getHeader("from").uri
  }

  if (msg.type === "response") {
    const toTag = msg.getHeader("to").tag
    if (toTag && !ds.remoteTag) ds.remoteTag = toTag
  } else {
    const fromTag = msg.getHeader("from").tag
    if (fromTag && !ds.remoteTag) ds.remoteTag = fromTag
  }

  if (msg.type === "request" && msg.method !== "ACK") {
    const cseqNum = msg.getHeader("cseq").seq
    const cseqMethod = msg.getHeader("cseq").method
    ds.pendingRequests.push({
      refId: -1,
      msg,
      method: msg.method,
      cseqNumber: cseqNum,
      finalResponseSent: false,
    })
    if (ds.remoteCSeq === undefined || cseqNum > ds.remoteCSeq) {
      ds.remoteCSeq = cseqNum
    }
    if (msg.method !== "CANCEL" && cseqMethod !== "ACK") {
      const fromTag = msg.getHeader("from").tag
      const toTag = msg.getHeader("to").tag
      if (fromTag && toTag) {
        const key = `${callIdHeader}|${fromTag}|${toTag}`
        const prev = ds.remoteCSeqByDialog.get(key)
        if (prev === undefined || cseqNum > prev) {
          ds.remoteCSeqByDialog.set(key, cseqNum)
        }
      }
    }
  }
}

const isUacFromTag = (msg: SipMessage): string | null => {
  // UAC's local tag is the From-tag on the messages they author.
  // For sent requests this is from From; for received responses
  // their (peer's) From comes from the originator — but the
  // UAC's tag is on the From header in both directions when the UAC
  // sent the request that started the dialog.
  if (msg.type === "request") return msg.getHeader("from").tag ?? null
  // For responses, From tag identifies the UAC.
  return msg.getHeader("from").tag ?? null
}

const isUasToTag = (msg: SipMessage): string | null => {
  if (msg.type === "request") return msg.getHeader("to").tag ?? null
  return msg.getHeader("to").tag ?? null
}

/**
 * Group typed SignalingNetwork events into per-(bindKey, Call-ID)
 * slices and rebuild per-agent dialog state.
 *
 * "Per-dialog" here means (callId, fromTag, toTag). fromTag is the
 * UAC's tag (lifted off any in-dialog message); toTag is the UAS's
 * tag, or `null` until the dialog is confirmed.
 *
 * Forked early dialogs share a Call-ID + From-tag but differ on
 * To-tag — they appear as distinct slices once the To-tag is observed.
 * Messages without a confirmed To-tag (initial INVITE, 100 Trying)
 * land in the slice keyed by `toTag = null`.
 */
export const projectPerDialog = (
  events: ReadonlyArray<SignalingNetworkEvent & RecordedStamps>,
): ReadonlyArray<PerDialogSlice> => {
  // First pass: ordered entries by capture order across all bindKeys.
  const ordered: OrderedEntry[] = []
  let idx = 0
  for (const e of events) {
    const o = stamped(e)
    if (o === null) continue
    ordered.push(o)
    idx += 1
  }
  void idx
  // idx isn't used as identity; we use position in `ordered` below.
  ordered.sort((a, b) => (a.atMs === b.atMs ? a.seq - b.seq : a.atMs - b.atMs))

  // Per-(bindKey, callId, fromTag, toTag|null) buckets. Use a Map of
  // Maps so iteration is bounded by actually-seen keys.
  type BucketKey = string
  const bucketKey = (
    bindKey: LaneKey,
    callId: string,
    fromTag: string,
    toTag: string | null,
  ): BucketKey => `${bindKey}\x00${callId}\x00${fromTag}\x00${toTag ?? ""}`

  interface Bucket {
    readonly callId: string
    readonly fromTag: string
    toTag: string | null
    readonly bindKey: LaneKey
    readonly received: Array<{ idx: number; msg: SipMessage }>
    readonly sent: Array<{ idx: number; msg: SipMessage }>
    readonly state: AgentDialogState
  }
  const buckets = new Map<BucketKey, Bucket>()

  // Helper: locate a bucket and migrate from the pending (toTag=null)
  // bucket once a To-tag is observed.
  const lookup = (
    bindKey: LaneKey,
    callId: string,
    fromTag: string,
    toTag: string | null,
  ): Bucket => {
    if (toTag !== null) {
      const confirmedKey = bucketKey(bindKey, callId, fromTag, toTag)
      const confirmed = buckets.get(confirmedKey)
      if (confirmed !== undefined) return confirmed
      // Migrate from the pending bucket if one exists.
      const pendingKey = bucketKey(bindKey, callId, fromTag, null)
      const pending = buckets.get(pendingKey)
      if (pending !== undefined) {
        pending.toTag = toTag
        buckets.delete(pendingKey)
        buckets.set(confirmedKey, pending)
        return pending
      }
    }
    const key = bucketKey(bindKey, callId, fromTag, toTag)
    const existing = buckets.get(key)
    if (existing !== undefined) return existing
    const fresh: Bucket = {
      callId,
      fromTag,
      toTag,
      bindKey,
      received: [],
      sent: [],
      state: createAgentDialogState("0.0.0.0"),
    }
    buckets.set(key, fresh)
    return fresh
  }

  ordered.forEach((entry, position) => {
    const callId = entry.msg.getHeader("call-id")
    if (callId === undefined || callId === "") return
    const fromTag = isUacFromTag(entry.msg) ?? ""
    if (fromTag === "") return
    const toTagOrNull = isUasToTag(entry.msg)
    const bucket = lookup(entry.bindKey, callId, fromTag, toTagOrNull)
    if (entry.kind === "sent") {
      bucket.sent.push({ idx: position, msg: entry.msg })
      trackSent(bucket.state, entry.msg)
    } else {
      bucket.received.push({ idx: position, msg: entry.msg })
      trackReceived(bucket.state, entry.msg)
    }
  })

  // Re-group buckets by (callId, fromTag, toTag) — each grouping
  // becomes one PerDialogSlice with one perAgent entry per bindKey.
  const slices = new Map<
    string,
    {
      callId: string
      fromTag: string
      toTag: string | null
      perAgent: Array<PerDialogSlice["perAgent"][number]>
    }
  >()
  for (const b of buckets.values()) {
    const k = `${b.callId}\x00${b.fromTag}\x00${b.toTag ?? ""}`
    let group = slices.get(k)
    if (group === undefined) {
      group = {
        callId: b.callId,
        fromTag: b.fromTag,
        toTag: b.toTag,
        perAgent: [],
      }
      slices.set(k, group)
    }
    group.perAgent.push({
      bindKey: b.bindKey,
      received: b.received,
      sent: b.sent,
      state: b.state,
    })
  }

  return [...slices.values()].map((g) => ({
    callId: g.callId,
    fromTag: g.fromTag,
    toTag: g.toTag,
    perAgent: g.perAgent,
  }))
}
