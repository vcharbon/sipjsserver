/**
 * RFC base validators ported to the new SignalingNetwork.scopedAudit
 * path.
 *
 * Each rule receives the events captured for ONE peer's bindUdp scope
 * (everything sent through `endpoint.send` and everything received via
 * `endpoint.messages`) and runs the existing per-message
 * `runValidationChecks` validator filtered to a single check name.
 *
 * The seventeen base validators exposed here cover every single-message
 * ValidationCheckName the old `tests/harness/rules/rfc/index.ts` runner
 * exercised:
 *
 *   - rfc.cseq                 — CSeq monotonicity / correlation
 *   - rfc.tags                 — To/From tag dialog identity
 *   - rfc.branchPrefix         — Via branch z9hG4bK prefix
 *   - rfc.contentLength        — Content-Length matches body byte count
 *   - rfc.callId               — Call-ID consistency within a dialog
 *   - rfc.via                  — Via branch on responses
 *   - rfc.maxForwards          — Max-Forwards
 *   - rfc.contentType          — Content-Type with body
 *   - rfc.contactPresence      — Contact on dialog-establishing methods
 *   - rfc.toTagPresence        — To-tag on responses > 100
 *   - rfc.dialogUri            — in-dialog From URI
 *   - rfc.recordRoute          — B2BUA must not Record-Route
 *   - rfc.cancelRequestUri     — CANCEL Request-URI matches INVITE
 *   - rfc.cancelViaBranch      — CANCEL Via branch matches INVITE
 *   - rfc.responseCorrelation  — response CSeq echoes a sent request
 *   - rfc.rackCorrelation      — PRACK RAck correlates with reliable 1xx
 *   - rfc.tagConsistency       — UAS final-response tag consistency
 *
 * The corresponding entries in `tests/harness/rules/rfc/index.ts`
 * (`rfcRules` array) are deleted — the new path enforces them.
 */

import { Effect, Result } from "effect"
import { createCustomParser } from "../../../../src/sip/parsers/custom/index.js"
import type { SipMessage } from "../../../../src/sip/types.js"
import {
  correlateResponse,
  runValidationChecks,
  type ValidationCheckName,
} from "../../../../src/test-harness/framework/validation.js"
import {
  createAgentDialogState,
  type AgentDialogState,
} from "../../../../src/test-harness/framework/message-builder.js"
import { ALL_UA_ROLES } from "../../../../src/sip/SignalingNetwork.js"
import type {
  PeerAuditRule,
  SignalingNetworkEvent,
} from "../../../../src/sip/SignalingNetwork.contracts.js"

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

const LENIENT_PARSER = createCustomParser({ wireGrammar: false })

const tryParse = (raw: Buffer): SipMessage | null => {
  const res = LENIENT_PARSER.parse(raw)
  return Result.isSuccess(res) ? res.success : null
}

interface OrderedMsg {
  readonly kind: "sent" | "received"
  readonly atMs: number
  readonly seq: number
  readonly msg: SipMessage
  readonly rawLen: number
  readonly rawBytes: Buffer
}

const extractOrderedMessages = (
  events: ReadonlyArray<SignalingNetworkEvent & { atMs: number; seq: number }>,
): OrderedMsg[] => {
  const out: OrderedMsg[] = []
  for (const e of events) {
    if (e.tag === "send.called") {
      const msg = tryParse(e.msg)
      if (msg !== null) {
        out.push({
          kind: "sent",
          atMs: e.atMs,
          seq: e.seq,
          msg,
          rawLen: e.msg.length,
          rawBytes: e.msg,
        })
      }
    } else if (e.tag === "messages.streamItem") {
      const msg = tryParse(e.envelope.raw)
      if (msg !== null) {
        out.push({
          kind: "received",
          atMs: e.atMs,
          seq: e.seq,
          msg,
          rawLen: e.envelope.raw.length,
          rawBytes: e.envelope.raw,
        })
      }
    }
  }
  out.sort((a, b) => (a.atMs === b.atMs ? a.seq - b.seq : a.atMs - b.atMs))
  return out
}

// ---------------------------------------------------------------------------
// State-replay helpers (mirrors the old runner)
// ---------------------------------------------------------------------------

function trackSent(ds: AgentDialogState, msg: SipMessage): void {
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

function trackReceived(ds: AgentDialogState, msg: SipMessage): void {
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

// ---------------------------------------------------------------------------
// Raw Content-Length check (kept independent of the parser since the
// custom parser already slices the body to the declared length).
// ---------------------------------------------------------------------------

function checkRawContentLength(raw: Buffer): string | null {
  const text = raw.toString("utf8")
  let sep = text.indexOf("\r\n\r\n")
  let sepLen = 4
  if (sep < 0) {
    sep = text.indexOf("\n\n")
    sepLen = 2
  }
  if (sep < 0) return null
  const headerBlock = text.slice(0, sep)
  const bodyStr = text.slice(sep + sepLen)
  const declMatch = /^\s*Content-Length\s*:\s*(\d+)\s*$/im.exec(headerBlock)
  if (declMatch === null) return null
  const declared = parseInt(declMatch[1]!, 10)
  const actual = Buffer.byteLength(bodyStr, "utf8")
  if (declared !== actual) {
    return `Content-Length mismatch: header says ${declared} but body is ${actual} bytes`
  }
  return null
}

// ---------------------------------------------------------------------------
// Generic per-check rule factory
// ---------------------------------------------------------------------------

const ALL_CHECKS: ValidationCheckName[] = [
  "tags", "cseq", "via", "callId", "maxForwards", "contentLength",
  "contentType", "contactPresence", "noContactOnBye", "toTagPresence",
  "branchPrefix", "dialogUri", "recordRoute", "cancelRequestUri",
  "cancelViaBranch", "responseCorrelation", "rackCorrelation",
  "tagConsistency", "offerAnswer",
]

const makeCheckRule = (
  name: string,
  check: ValidationCheckName,
): PeerAuditRule => ({
  name,
  subject: ALL_UA_ROLES,
  check: (events) =>
    Effect.sync(() => {
      const ordered = extractOrderedMessages(events)
      if (ordered.length === 0) return []
      const violations: string[] = []
      const skipSet = new Set<ValidationCheckName>(
        ALL_CHECKS.filter((c) => c !== check),
      )
      // A single bind can carry many independent dialogs (e.g. a B2BUA
      // worker socket terminates two legs of every call with distinct
      // Call-IDs). Partition state per Call-ID so per-dialog rules
      // don't cross-contaminate.
      const dsByCallId = new Map<string, AgentDialogState>()
      const getDs = (callId: string): AgentDialogState => {
        let ds = dsByCallId.get(callId)
        if (ds === undefined) {
          ds = createAgentDialogState("0.0.0.0")
          dsByCallId.set(callId, ds)
        }
        return ds
      }

      // Pre-compute branch → final-response-status for sent responses,
      // so a received request that the agent rejected with 481
      // ("Call/Transaction Does Not Exist") can be skipped from
      // dialog-state validators — the rejection itself IS the correct
      // handling, and re-asserting the same condition in the validator
      // is duplicative noise.
      const responseStatusByBranch = new Map<string, number>()
      for (const ev of ordered) {
        if (ev.kind !== "sent" || ev.msg.type !== "response") continue
        if (ev.msg.status < 200) continue
        const branch = ev.msg.getHeader("via")[0]?.branch
        if (branch === undefined) continue
        if (!responseStatusByBranch.has(branch)) {
          responseStatusByBranch.set(branch, ev.msg.status)
        }
      }
      const DIALOG_STATE_CHECKS: ReadonlySet<ValidationCheckName> = new Set<ValidationCheckName>([
        "tags",
        "cseq",
        "dialogUri",
      ])

      for (const ev of ordered) {
        const callId = ev.msg.getHeader("call-id")
        if (callId === undefined || callId === "") continue
        const ds = getDs(callId)
        if (ev.kind === "sent") {
          trackSent(ds, ev.msg)
          continue
        }
        // If this received request was 481-rejected by the agent, skip
        // dialog-state validators on it. The rejection is the correct
        // application-level handling for unknown-dialog probes.
        if (
          ev.msg.type === "request" &&
          DIALOG_STATE_CHECKS.has(check)
        ) {
          const branch = ev.msg.getHeader("via")[0]?.branch
          const status = branch !== undefined
            ? responseStatusByBranch.get(branch)
            : undefined
          if (status === 481) {
            trackReceived(ds, ev.msg)
            continue
          }
        }
        if (check === "contentLength") {
          const rawErr = checkRawContentLength(ev.rawBytes)
          if (rawErr !== null) violations.push(rawErr)
        } else {
          const correlated = ev.msg.type === "response"
            ? correlateResponse(ev.msg, ds)
            : undefined
          const errors: string[] = []
          runValidationChecks(ev.msg, ds, correlated, skipSet, undefined, errors)
          for (const e of errors) violations.push(e)
        }
        trackReceived(ds, ev.msg)
      }
      return violations
    }),
})

// ---------------------------------------------------------------------------
// Rule exports
// ---------------------------------------------------------------------------

export const rfcCseq: PeerAuditRule = makeCheckRule("rfc.cseq", "cseq")
export const rfcTags: PeerAuditRule = makeCheckRule("rfc.tags", "tags")
export const rfcBranchPrefix: PeerAuditRule = makeCheckRule(
  "rfc.branchPrefix",
  "branchPrefix",
)
export const rfcContentLength: PeerAuditRule = makeCheckRule(
  "rfc.contentLength",
  "contentLength",
)
export const rfcCallId: PeerAuditRule = makeCheckRule("rfc.callId", "callId")

export const rfcVia: PeerAuditRule = makeCheckRule("rfc.via", "via")
export const rfcMaxForwards: PeerAuditRule = makeCheckRule(
  "rfc.maxForwards",
  "maxForwards",
)
export const rfcContentType: PeerAuditRule = makeCheckRule(
  "rfc.contentType",
  "contentType",
)
export const rfcContactPresence: PeerAuditRule = makeCheckRule(
  "rfc.contactPresence",
  "contactPresence",
)
export const rfcNoContactOnBye: PeerAuditRule = makeCheckRule(
  "rfc.noContactOnBye",
  "noContactOnBye",
)
export const rfcToTagPresence: PeerAuditRule = makeCheckRule(
  "rfc.toTagPresence",
  "toTagPresence",
)
export const rfcDialogUri: PeerAuditRule = makeCheckRule(
  "rfc.dialogUri",
  "dialogUri",
)
export const rfcRecordRoute: PeerAuditRule = makeCheckRule(
  "rfc.recordRoute",
  "recordRoute",
)
export const rfcCancelRequestUri: PeerAuditRule = makeCheckRule(
  "rfc.cancelRequestUri",
  "cancelRequestUri",
)
export const rfcCancelViaBranch: PeerAuditRule = makeCheckRule(
  "rfc.cancelViaBranch",
  "cancelViaBranch",
)
export const rfcResponseCorrelation: PeerAuditRule = makeCheckRule(
  "rfc.responseCorrelation",
  "responseCorrelation",
)
export const rfcRackCorrelation: PeerAuditRule = makeCheckRule(
  "rfc.rackCorrelation",
  "rackCorrelation",
)
export const rfcTagConsistency: PeerAuditRule = makeCheckRule(
  "rfc.tagConsistency",
  "tagConsistency",
)

/**
 * Original five starter rules. Preserved as a named export for the
 * canary regression gate, which deliberately exercises only the
 * minimal set.
 */
export const starterPeerRules: ReadonlyArray<PeerAuditRule> = [
  rfcCseq,
  rfcTags,
  rfcBranchPrefix,
  rfcContentLength,
  rfcCallId,
]

/**
 * The full pack of 17 base ValidationCheckName-backed rules, replacing
 * the original `rfcRules` array entries. Cross-message rules ship
 * separately under `./cross-message-rules.ts`.
 */
export const basePeerRules: ReadonlyArray<PeerAuditRule> = [
  rfcCseq,
  rfcTags,
  rfcBranchPrefix,
  rfcContentLength,
  rfcCallId,
  rfcVia,
  rfcMaxForwards,
  rfcContentType,
  rfcContactPresence,
  rfcNoContactOnBye,
  rfcToTagPresence,
  rfcDialogUri,
  rfcRecordRoute,
  rfcCancelRequestUri,
  rfcCancelViaBranch,
  rfcResponseCorrelation,
  rfcRackCorrelation,
  rfcTagConsistency,
]
