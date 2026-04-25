/**
 * RFC rules — re-exposes the existing per-message validators
 * ([tests/fullcall/framework/validation.ts]) as post-hoc PerCallRule
 * instances over a CallRecording.
 *
 * Reuse, don't rewrite (per the plan): each rule re-runs an existing
 * `ValidationFn` against every received message in the recording, after
 * rebuilding a per-agent dialog state from the recorded wire bytes.
 *
 * Rebuilding state from recordings (rather than threading it through
 * from the runner) keeps the rule pack fully driven by the on-disk
 * artifact — fixture YAML files can exercise these rules in isolation.
 */

import type { Rule, RuleViolation, PerCallRule } from "../types.js"
import type { CallRecording, RecordedMessage } from "../../recording.js"
import { Effect } from "effect"
import { SipParser } from "../../../../src/sip/Parser.js"
import type { SipMessage } from "../../../../src/sip/types.js"
import {
  correlateResponse,
  runValidationChecks,
  type ValidationCheckName,
} from "../../../fullcall/framework/validation.js"
import {
  createAgentDialogState,
  type AgentDialogState,
} from "../../../fullcall/framework/message-builder.js"

// ---------------------------------------------------------------------------
// Recording → per-agent message stream + dialog state
// ---------------------------------------------------------------------------

interface AgentView {
  /** Messages this agent received from the wire, in order. */
  readonly received: ReadonlyArray<{ idx: number; msg: SipMessage }>
  /** Messages this agent sent on the wire, in order. */
  readonly sent: ReadonlyArray<{ idx: number; msg: SipMessage }>
  readonly state: AgentDialogState
}

function parseMessage(raw: string): SipMessage | null {
  const eff = Effect.gen(function* () {
    const parser = yield* SipParser
    return yield* parser.parse(Buffer.from(raw, "utf8"))
  }).pipe(Effect.provide(SipParser.layer), Effect.result)
  const result = Effect.runSync(eff)
  if (result._tag === "Failure") return null
  return result.success
}

function parsedOf(rec: CallRecording, idx: number): SipMessage | null {
  const e = rec.entries[idx]
  if (!e || e.kind !== "message") return null
  if (e.parsed) return e.parsed
  return parseMessage(e.raw)
}

/** Build per-agent views over the recording. Uses agent endpoint name (from/to). */
function viewsFromRecording(rec: CallRecording): Map<string, AgentView> {
  const byAgent = new Map<string, { received: { idx: number; msg: SipMessage }[]; sent: { idx: number; msg: SipMessage }[] }>()
  rec.entries.forEach((e, idx) => {
    if (e.kind !== "message") return
    const msg = parsedOf(rec, idx)
    if (!msg) return
    const agent = e.direction === "received" ? e.to : e.from
    let v = byAgent.get(agent)
    if (!v) {
      v = { received: [], sent: [] }
      byAgent.set(agent, v)
    }
    if (e.direction === "received") v.received.push({ idx, msg })
    else v.sent.push({ idx, msg })
  })

  const out = new Map<string, AgentView>()
  for (const [agent, v] of byAgent.entries()) {
    out.set(agent, { received: v.received, sent: v.sent, state: createAgentDialogState("0.0.0.0") })
  }
  return out
}

/**
 * Walk the per-agent recording in order, applying state mutations needed
 * by the validators (mirrors interpreter.updateDialogState minus the
 * fields not used by validation). Then run the requested check at each
 * received message and collect violations.
 */
function runRfcCheck(
  rec: CallRecording,
  checkName: ValidationCheckName,
  ruleName: string
): RuleViolation[] {
  const violations: RuleViolation[] = []
  const views = viewsFromRecording(rec)

  for (const [agent, view] of views.entries()) {
    // Replay sent + received in interleaved time order to grow dialog state.
    const allEvents: Array<{ kind: "sent" | "received"; idx: number; msg: SipMessage }> = []
    for (const r of view.received) allEvents.push({ kind: "received", ...r })
    for (const s of view.sent) allEvents.push({ kind: "sent", ...s })
    allEvents.sort((a, b) => {
      const ea = rec.entries[a.idx] as RecordedMessage
      const eb = rec.entries[b.idx] as RecordedMessage
      const ta = a.kind === "sent" ? ea.sentMs : ea.receivedMs
      const tb = b.kind === "sent" ? eb.sentMs : eb.receivedMs
      return ta - tb
    })

    const ds = view.state
    const skipSet = new Set<ValidationCheckName>()
    for (const ev of allEvents) {
      if (ev.kind === "sent") {
        // Track sent messages so response correlation can find them.
        trackSent(ds, ev.msg)
        continue
      }
      // Received: correlate (for responses) and run the requested check only.
      const correlated = ev.msg.type === "response"
        ? correlateResponse(ev.msg, ds)
        : undefined
      const errors: string[] = []
      if (checkName === "contentLength") {
        // The custom parser slices body to exactly Content-Length bytes,
        // so msg.body.byteLength always matches the declared value. To
        // catch on-wire mismatches we re-check declared header vs raw
        // body length (bytes after the empty CRLF separator).
        const rawErr = checkRawContentLength(rec.entries[ev.idx] as RecordedMessage)
        if (rawErr) errors.push(rawErr)
      } else {
        const overrides = {} as Record<ValidationCheckName, never>
        // Run only the requested check by populating skipSet with all OTHERS.
        const allChecks: ValidationCheckName[] = [
          "tags", "cseq", "via", "callId", "maxForwards", "contentLength",
          "contentType", "contactPresence", "toTagPresence", "branchPrefix",
          "dialogUri", "recordRoute", "cancelRequestUri", "cancelViaBranch",
          "responseCorrelation", "rackCorrelation", "tagConsistency", "offerAnswer",
        ]
        const otherChecks = new Set<ValidationCheckName>(allChecks.filter((c) => c !== checkName))
        runValidationChecks(ev.msg, ds, correlated, otherChecks, overrides as never, errors)
      }
      for (const e of errors) {
        violations.push({
          message: `[${ruleName}] agent=${agent}: ${e}`,
          entryIndex: ev.idx,
        })
      }
      // After check, apply minimal dialog-state updates so subsequent
      // checks see consistent state.
      trackReceived(ds, ev.msg)
    }
    void skipSet // suppress unused
  }

  return violations
}

function checkRawContentLength(entry: RecordedMessage): string | null {
  const raw = entry.raw
  // Headers / body split: CRLF CRLF (preferred), fallback LF LF.
  let sep = raw.indexOf("\r\n\r\n")
  let sepLen = 4
  if (sep < 0) {
    sep = raw.indexOf("\n\n")
    sepLen = 2
  }
  if (sep < 0) return null
  const headerBlock = raw.slice(0, sep)
  const bodyStr = raw.slice(sep + sepLen)
  const declMatch = /^\s*Content-Length\s*:\s*(\d+)\s*$/im.exec(headerBlock)
  if (!declMatch) return null
  const declared = parseInt(declMatch[1]!, 10)
  const actual = Buffer.byteLength(bodyStr, "utf8")
  if (declared !== actual) {
    return `Content-Length mismatch: header says ${declared} but body is ${actual} bytes`
  }
  return null
}

function trackSent(ds: AgentDialogState, msg: SipMessage): void {
  if (msg.type === "request") {
    ds.sentRequests.push({
      msg,
      method: msg.method,
      cseqNumber: msg.parsed.cseq.seq,
      viaBranch: msg.parsed.via.branch ?? "",
    })

    // Capture local tag from outbound From-tag (UAC) so tag validation passes.
    const fromTag = msg.parsed.from.tag
    if (fromTag) ds.localTags.add(fromTag)
    return
  }

  // Response: capture local tag from outbound To-tag (UAS).
  // Mirrors interpreter.ts:399-405.
  const toTag = msg.parsed.to.tag
  if (toTag) ds.localTags.add(toTag)
}

function trackReceived(ds: AgentDialogState, msg: SipMessage): void {
  // Mirror the most-load-bearing parts of interpreter.updateDialogState.
  const callIdHeader = msg.parsed.callId

  if (msg.type === "request" && msg.method === "INVITE") {
    ds.callId = callIdHeader
    ds.callIdConfirmed = true
    ds.receivedInviteUri = msg.uri
    if (msg.parsed.via.branch) ds.receivedInviteBranch = msg.parsed.via.branch
    if (!ds.dialogRemoteUri) ds.dialogRemoteUri = msg.parsed.from.uri
  }

  if (msg.type === "response") {
    const toTag = msg.parsed.to.tag
    if (toTag && !ds.remoteTag) ds.remoteTag = toTag
  } else {
    const fromTag = msg.parsed.from.tag
    if (fromTag && !ds.remoteTag) ds.remoteTag = fromTag
  }

  if (msg.type === "request" && msg.method !== "ACK") {
    const cseqNum = msg.parsed.cseq.seq
    const cseqMethod = msg.parsed.cseq.method
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

    // Per-Call-ID INVITE baseline (RFC 3261 §12.2.1.1). Forked early
    // dialogs share this baseline.
    if (msg.method === "INVITE") {
      if (!ds.inviteCSeqByCallId.has(callIdHeader)) {
        ds.inviteCSeqByCallId.set(callIdHeader, cseqNum)
      }
    }

    // Per-dialog CSeq counter — skip CANCEL (reuses INVITE CSeq) and
    // messages without a full tag pair (out-of-dialog).
    if (msg.method !== "CANCEL" && cseqMethod !== "ACK") {
      const fromTag = msg.parsed.from.tag
      const toTag = msg.parsed.to.tag
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
// Rule factory
// ---------------------------------------------------------------------------

function makeRfcRule(name: string, check: ValidationCheckName, description: string): PerCallRule {
  return {
    name,
    family: "rfc",
    description,
    evaluate(ctx) {
      return runRfcCheck(ctx.recording, check, name)
    },
  }
}

export const rfcRules: ReadonlyArray<Rule> = [
  makeRfcRule("rfc.tags", "tags", "RFC 3261: To/From tag dialog identity"),
  makeRfcRule("rfc.cseq", "cseq", "RFC 3261 §8.1.3.3 / §12.2: CSeq monotonicity"),
  makeRfcRule("rfc.via", "via", "RFC 3261 §17: Via branch on responses"),
  makeRfcRule("rfc.callId", "callId", "RFC 3261: Call-ID consistency in dialog"),
  makeRfcRule("rfc.maxForwards", "maxForwards", "RFC 3261 §8.1.1.6: Max-Forwards"),
  makeRfcRule("rfc.contentLength", "contentLength", "RFC 3261 §20.14: Content-Length matches body"),
  makeRfcRule("rfc.contentType", "contentType", "RFC 3261 §7.4.1: Content-Type with body"),
  makeRfcRule("rfc.contactPresence", "contactPresence", "RFC 3261 §8.1.1.8: Contact on dialog-establishing methods"),
  makeRfcRule("rfc.toTagPresence", "toTagPresence", "RFC 3261 §8.2.6.2: To-tag on responses > 100"),
  makeRfcRule("rfc.branchPrefix", "branchPrefix", "RFC 3261 §8.1.1.7: branch z9hG4bK prefix"),
  makeRfcRule("rfc.dialogUri", "dialogUri", "RFC 3261 §12.2.1.1: in-dialog From URI"),
  makeRfcRule("rfc.recordRoute", "recordRoute", "RFC 3261 §16.6: B2BUA must not Record-Route"),
  makeRfcRule("rfc.cancelRequestUri", "cancelRequestUri", "RFC 3261 §9.1: CANCEL Request-URI matches INVITE"),
  makeRfcRule("rfc.cancelViaBranch", "cancelViaBranch", "RFC 3261 §9.1: CANCEL Via branch matches INVITE"),
  makeRfcRule("rfc.responseCorrelation", "responseCorrelation", "RFC 3261 §8.1.3.3: response CSeq echoes a sent request"),
  makeRfcRule("rfc.rackCorrelation", "rackCorrelation", "RFC 3262 §7.2: PRACK RAck correlates with reliable 1xx"),
  makeRfcRule("rfc.tagConsistency", "tagConsistency", "RFC 3261 §17.2.1: UAS final-response tag consistency"),
]
