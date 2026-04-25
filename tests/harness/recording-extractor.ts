/**
 * recording-extractor — converts the existing `ScenarioResult.trace`
 * into `CallRecording[]`, one per Call-ID.
 *
 * This lets the new record/verify harness reuse the existing interpreter
 * for the drive phase (Slice 0/1 wiring) while still consuming a clean
 * `CallRecording` artifact for rule evaluation.
 */

import { Buffer } from "node:buffer"
import type { SipMessage } from "../../src/sip/types.js"
import { serialize } from "../../src/sip/Serializer.js"
import { getHeader } from "../../src/sip/MessageHelpers.js"
import type { ScenarioResult } from "../fullcall/framework/types.js"
import type {
  CallRecording,
  RecordedMessage,
  RecordingEntry,
} from "./recording.js"

const PRE_CALL_KEY = "<pre-call>"

interface MutableRecording {
  callId: string
  startMs: number
  entries: RecordingEntry[]
}

/**
 * B-leg Call-IDs are minted as `${legNumber}-${aLegCallId}` (see
 * [src/b2bua/helpers.ts:152]). For per-call rule evaluation we want
 * both legs of the same logical call grouped together — so we strip a
 * leading `\d+-` prefix when bucketing. This intentionally collapses
 * the multi-leg fan-out into a single CallRecording per logical call,
 * which is the right shape for service-case rules that talk about
 * "the alice INVITE" and "the leg INVITE" as siblings.
 */
function logicalCallId(raw: string): string {
  const m = /^\d+-(.+)$/.exec(raw)
  return m?.[1] ?? raw
}

/**
 * Bucket trace entries by logical Call-ID. Entries without a Call-ID
 * (parser failures, dangling-state synthetic entries) accumulate under
 * the "<pre-call>" bucket — surfaced for completeness but generally
 * empty in well-formed runs.
 */
export interface ExtractOpts {
  readonly scenarioId: string
  readonly serviceCaseId: string | null
  /** label resolver: stepIndex → label, or undefined for none. */
  readonly labelOfStep?: (stepIndex: number) => string | undefined
}

export function extractRecordings(
  result: ScenarioResult,
  opts: ExtractOpts
): CallRecording[] {
  const buckets = new Map<string, MutableRecording>()

  for (const entry of result.trace) {
    if (entry.message === undefined) continue
    const rawCallId = getHeader(entry.message.headers, "call-id") ?? PRE_CALL_KEY
    const callId = rawCallId === PRE_CALL_KEY ? rawCallId : logicalCallId(rawCallId)
    let bucket = buckets.get(callId)
    if (!bucket) {
      bucket = {
        callId,
        startMs: entry.sentMs,
        entries: [],
      }
      buckets.set(callId, bucket)
    }
    bucket.startMs = Math.min(bucket.startMs, entry.sentMs)

    const direction: RecordedMessage["direction"] =
      entry.direction === "send" ? "sent" : "received"
    const label = opts.labelOfStep?.(entry.stepIndex)
    const raw = serializeMessage(entry.message)
    const unexpected = entry.status === "unexpected"

    const base: RecordedMessage = {
      kind: "message",
      direction,
      from: entry.from,
      to: entry.to,
      sentMs: entry.sentMs,
      receivedMs: entry.receivedMs,
      raw,
      parsed: entry.message,
    }
    const withLabel = label !== undefined ? { ...base, label } : base
    const msg: RecordedMessage = unexpected ? { ...withLabel, unexpected: true } : withLabel
    bucket.entries.push(msg)
  }

  const recordings: CallRecording[] = []
  for (const bucket of buckets.values()) {
    recordings.push({
      scenarioId: opts.scenarioId,
      serviceCaseId: opts.serviceCaseId,
      callId: bucket.callId,
      startMs: bucket.startMs,
      entries: bucket.entries,
    })
  }
  // Stable order: by startMs, then callId.
  recordings.sort((a, b) =>
    a.startMs === b.startMs ? a.callId.localeCompare(b.callId) : a.startMs - b.startMs
  )
  return recordings
}

function serializeMessage(msg: SipMessage): string {
  // Serializer.serialize returns a Buffer of the wire format.
  const buf: Buffer = Buffer.from(serialize(msg))
  return buf.toString("utf8")
}
