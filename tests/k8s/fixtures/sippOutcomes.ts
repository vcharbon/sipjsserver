/**
 * Parsers for sipp's `-trace_msg` (per-message log) and `-trace_stat`
 * (CSV stats) output. These produce the per-Call-ID outcome records
 * that `callLifecycle.classifyCalls` then joins with the proxy's
 * routing decisions and the test's `T_kill` to populate the 5×4
 * failover matrix.
 *
 * The sample under `__samples__/sipp-msg-trace.sample.txt` was captured
 * from a real sipp run in the kind cluster (`uac-basic.xml`, 5 calls @
 * 2 cps); see `sippOutcomes.test.ts` for the regression check.
 */

import * as fs from "node:fs"
import * as readline from "node:readline"
import { createGunzip } from "node:zlib"

export type SippOutcome =
  | "clean"
  | "retransmitted"
  | "establish-failed"
  | "bye-timeout"
  | "mid-dialog-error"

export interface CallOutcome {
  readonly outcome: SippOutcome
  readonly retransmits: number
  readonly lastResponse: number | undefined
  /** Wall-clock timestamp of the first INVITE sent for this Call-ID. */
  readonly tFirstInvite: Date | undefined
  /**
   * Wall-clock timestamp of the ACK that established the dialog (i.e.
   * the ACK following the 200 OK to INVITE). `undefined` when no ACK
   * was sent — i.e. the call never established. Used by
   * `classifyCalls` to bucket `established-on-dying`.
   */
  readonly tAck: Date | undefined
}

export interface SippStatTotals {
  readonly totalCalls: number
  readonly successful: number
  readonly failed: number
  readonly retransmitsTotal: number
}

interface MsgRecord {
  readonly t: Date
  readonly direction: "sent" | "received"
  readonly method: string | undefined
  readonly cseqNum: number | undefined
  readonly cseqMethod: string | undefined
  readonly responseStatus: number | undefined
  readonly callId: string
}

interface CallTrack {
  readonly callId: string
  records: Array<MsgRecord>
}

const SEPARATOR_RE = /^-+\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*$/
const DIRECTION_RE = /^UDP message (sent|received)\b/
const REQUEST_START_RE = /^([A-Z]+)\s+\S+\s+SIP\/2\.0\s*$/
const RESPONSE_START_RE = /^SIP\/2\.0\s+(\d{3})\b/
const HEADER_RE = /^([A-Za-z-]+)\s*:\s*(.*)$/
const CSEQ_RE = /^(\d+)\s+([A-Z]+)\s*$/

/**
 * Split sipp's message log into per-message blocks. Each block is the
 * lines between two `--- TIMESTAMP ---` separators (exclusive of the
 * leading separator, inclusive of everything until the next one).
 */
const parseBlocks = (
  log: string,
): ReadonlyArray<{ t: Date; lines: ReadonlyArray<string> }> => {
  const out: Array<{ t: Date; lines: Array<string> }> = []
  let current: { t: Date; lines: Array<string> } | undefined
  for (const rawLine of log.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    const sep = SEPARATOR_RE.exec(line)
    if (sep) {
      if (current) out.push(current)
      const t = new Date(`${sep[1]}T${sep[2]}Z`)
      current = { t, lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) out.push(current)
  return out
}

const parseBlock = (
  t: Date,
  lines: ReadonlyArray<string>,
): MsgRecord | undefined => {
  // First non-blank line of the block: `UDP message sent (N bytes):`
  let i = 0
  while (i < lines.length && lines[i]?.trim() === "") i++
  const headerLine = lines[i]
  if (headerLine === undefined) return undefined
  const dirMatch = DIRECTION_RE.exec(headerLine)
  if (!dirMatch) return undefined
  const direction = dirMatch[1] === "sent" ? "sent" : "received"
  i++
  // Skip blank line(s).
  while (i < lines.length && lines[i]?.trim() === "") i++
  const startLine = lines[i]
  if (startLine === undefined) return undefined
  let method: string | undefined
  let responseStatus: number | undefined
  const reqMatch = REQUEST_START_RE.exec(startLine)
  const respMatch = RESPONSE_START_RE.exec(startLine)
  if (reqMatch) {
    method = reqMatch[1]
  } else if (respMatch) {
    const code = parseInt(respMatch[1] ?? "", 10)
    if (Number.isFinite(code)) responseStatus = code
  } else {
    return undefined
  }
  i++
  // Headers until blank line.
  let callId = ""
  let cseqNum: number | undefined
  let cseqMethod: string | undefined
  for (; i < lines.length; i++) {
    const ln = lines[i] ?? ""
    if (ln.trim() === "") break
    const hm = HEADER_RE.exec(ln)
    if (!hm) continue
    const name = (hm[1] ?? "").toLowerCase()
    const value = hm[2] ?? ""
    if (name === "call-id") {
      callId = value.trim()
    } else if (name === "cseq") {
      const cm = CSEQ_RE.exec(value.trim())
      if (cm) {
        const num = parseInt(cm[1] ?? "", 10)
        if (Number.isFinite(num)) cseqNum = num
        cseqMethod = cm[2]
      }
    }
  }
  if (callId === "") return undefined
  return {
    t,
    direction,
    method,
    cseqNum,
    cseqMethod,
    responseStatus,
    callId,
  }
}

const groupByCall = (records: ReadonlyArray<MsgRecord>): Map<string, CallTrack> => {
  const map = new Map<string, CallTrack>()
  for (const r of records) {
    let track = map.get(r.callId)
    if (!track) {
      track = { callId: r.callId, records: [] }
      map.set(r.callId, track)
    }
    track.records.push(r)
  }
  return map
}

/**
 * For each call, count retransmissions: same `(direction=sent, method,
 * cseqNum)` triple seen more than once. Each duplicate beyond the first
 * counts as one retransmit.
 *
 * sipp emits the *same* (method, CSeq) twice when a request is
 * retransmitted by the retrans timer; the receiver counterpart shows up
 * as a single received block per actual UDP arrival.
 */
const countRetransmits = (track: CallTrack): number => {
  const seen = new Map<string, number>()
  for (const r of track.records) {
    if (r.direction !== "sent" || r.method === undefined || r.cseqNum === undefined) {
      continue
    }
    const key = `${r.method}|${r.cseqNum}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  let retransmits = 0
  for (const count of seen.values()) {
    if (count > 1) retransmits += count - 1
  }
  return retransmits
}

const classifyCall = (track: CallTrack): CallOutcome => {
  const records = track.records
  const inviteSent = records.find(
    (r) => r.direction === "sent" && r.method === "INVITE",
  )
  const inviteFinal = records.find(
    (r) =>
      r.direction === "received" &&
      r.responseStatus !== undefined &&
      r.responseStatus >= 200 &&
      r.cseqMethod === "INVITE",
  )
  const ackSent = records.find(
    (r) => r.direction === "sent" && r.method === "ACK",
  )
  const byeSent = records.find(
    (r) => r.direction === "sent" && r.method === "BYE",
  )
  const byeFinal = records.find(
    (r) =>
      r.direction === "received" &&
      r.responseStatus !== undefined &&
      r.responseStatus >= 200 &&
      r.cseqMethod === "BYE",
  )
  const lastResponse = [...records]
    .reverse()
    .find((r) => r.direction === "received" && r.responseStatus !== undefined)
    ?.responseStatus
  const retransmits = countRetransmits(track)
  const tFirstInvite = inviteSent?.t
  const tAck = ackSent?.t

  let outcome: SippOutcome
  if (
    inviteFinal === undefined ||
    inviteFinal.responseStatus === undefined ||
    inviteFinal.responseStatus >= 300
  ) {
    outcome = "establish-failed"
  } else if (byeSent !== undefined && byeFinal === undefined) {
    outcome = "bye-timeout"
  } else if (
    byeFinal !== undefined &&
    byeFinal.responseStatus !== undefined &&
    byeFinal.responseStatus >= 300
  ) {
    outcome = "mid-dialog-error"
  } else if (retransmits > 0) {
    outcome = "retransmitted"
  } else {
    outcome = "clean"
  }

  return {
    outcome,
    retransmits,
    lastResponse,
    tFirstInvite,
    tAck,
  }
}

/**
 * Parse a sipp `-message_file` log into per-Call-ID outcome records.
 *
 * The log is line-oriented but multi-line per message. Each message
 * block starts with a separator line containing the wall-clock
 * timestamp:
 *
 *   `----------- YYYY-MM-DD HH:MM:SS.ffffff`
 *
 * Followed by `UDP message {sent,received} ...` and the full SIP
 * message text. We extract:
 *   - direction (sent / received)
 *   - request method or response status
 *   - Call-ID, CSeq number + method
 *
 * From those records, we classify the outcome of each Call-ID and
 * count duplicate `(method, CSeq)` sends as retransmits.
 */
export const parseSippMessageTrace = (messageLog: string): Map<string, CallOutcome> => {
  const blocks = parseBlocks(messageLog)
  const records: Array<MsgRecord> = []
  for (const b of blocks) {
    const r = parseBlock(b.t, b.lines)
    if (r) records.push(r)
  }
  const tracks = groupByCall(records)
  const out = new Map<string, CallOutcome>()
  for (const [callId, track] of tracks) {
    out.set(callId, classifyCall(track))
  }
  return out
}

/**
 * Streaming variant of {@link parseSippMessageTrace} that reads a
 * gzipped sipp message-log file line by line and folds messages into a
 * per-Call-ID map as it goes. Required for runs whose decompressed
 * `msg.log` exceeds Node's max string length (~512 MB on x64) — long
 * endurance soaks at 20 cps short calls easily produce 600 MB+ of
 * decompressed trace.
 *
 * Memory grows with the number of distinct Call-IDs and messages, not
 * with file size, so heap pressure is the same as it would be for
 * `parseSippMessageTrace` on the same data minus the intermediate
 * monolithic string.
 */
export const parseSippMessageTraceFromGzFile = async (
  filePath: string,
): Promise<Map<string, CallOutcome>> => {
  const fileStream = fs.createReadStream(filePath)
  const decoded = fileStream.pipe(createGunzip())
  const rl = readline.createInterface({ input: decoded, crlfDelay: Infinity })
  const tracks = new Map<string, CallTrack>()
  let current: { t: Date; lines: Array<string> } | undefined
  const flushBlock = (): void => {
    if (!current) return
    const r = parseBlock(current.t, current.lines)
    if (r) {
      let track = tracks.get(r.callId)
      if (!track) {
        track = { callId: r.callId, records: [] }
        tracks.set(r.callId, track)
      }
      track.records.push(r)
    }
    current = undefined
  }
  for await (const rawLine of rl) {
    const line = rawLine.replace(/\r$/, "")
    const sep = SEPARATOR_RE.exec(line)
    if (sep) {
      flushBlock()
      const t = new Date(`${sep[1]}T${sep[2]}Z`)
      current = { t, lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  flushBlock()
  const out = new Map<string, CallOutcome>()
  for (const [callId, track] of tracks) {
    out.set(callId, classifyCall(track))
  }
  return out
}

/**
 * Parse sipp's `-stf` (statistics CSV) file. Sipp writes a header row
 * plus one row per period plus a final cumulative row. We extract the
 * cumulative totals (the last row) — the same numbers sipp prints in
 * its end-of-run "Statistics Screen".
 *
 * The CSV uses `;` as the field separator (sipp's default). Numeric
 * fields are bare decimals; non-numeric fields can contain whitespace
 * and TABs.
 */
export const parseSippStat = (statCsv: string): SippStatTotals | undefined => {
  const lines = statCsv.split("\n").filter((l) => l.trim().length > 0)
  if (lines.length < 2) return undefined
  const header = (lines[0] ?? "").split(";")
  // The cumulative-value row is the last data row sipp writes.
  const lastRow = (lines[lines.length - 1] ?? "").split(";")
  const idx = (name: string) => header.indexOf(name)
  const num = (i: number): number => {
    if (i < 0) return 0
    const v = lastRow[i] ?? ""
    const n = parseInt(v.trim(), 10)
    return Number.isFinite(n) ? n : 0
  }
  return {
    totalCalls: num(idx("TotalCallCreated")),
    successful: num(idx("SuccessfulCall(C)")),
    failed: num(idx("FailedCall(C)")),
    retransmitsTotal: num(idx("Retransmissions(C)")),
  }
}
