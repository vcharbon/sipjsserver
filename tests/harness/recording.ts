/**
 * CallRecording — the artifact captured by the drive-only runner and
 * consumed by the rule engine.
 *
 * Per the TestHarnessRefactor plan: the runner only DRIVES (sends &
 * waits); validation is post-hoc and runs against this recording.
 *
 * One CallRecording per call (keyed by Call-ID — populated when the
 * runner observes the first INVITE). Multi-call scenarios produce many
 * CallRecordings, all surfaced for cross-call rule evaluation.
 */

import type { SipMessage } from "../../src/sip/types.js"

/** A SIP message captured at the wire boundary (sent or received). */
export interface RecordedMessage {
  readonly kind: "message"
  readonly direction: "sent" | "received"
  /** Endpoint that originated the packet (agent name or "DUT"). */
  readonly from: string
  /** Endpoint that observed the packet (agent name or "DUT"). */
  readonly to: string
  /** Optional driver label, e.g. "bob1.inboundInvite". Free-form. */
  readonly label?: string
  /** Virtual-clock instant the sender placed the packet on the wire. */
  readonly sentMs: number
  /** Virtual-clock instant the receiver observed the packet. */
  readonly receivedMs: number
  /** Verbatim wire bytes (preserved for hand-editable YAML round-trip). */
  readonly raw: string
  /**
   * True when the message did not match any driver expect step. Set by
   * the runner, observable in YAML so call-shape rules can flag it
   * post-hoc rather than aborting the call.
   */
  readonly unexpected?: boolean
  /** Parsed SIP — present after the runner parses; absent when read from YAML until parsed by codec consumers. */
  readonly parsed?: SipMessage
}

/** A wait-deadline that fired without a matching message (driver-emitted). */
export interface RecordedTimeout {
  readonly kind: "timeout"
  /** Agent that was waiting. */
  readonly agent: string
  /** Description of what was being waited for, e.g. "180 ringing". */
  readonly waitingFor: string
  /** Wall-clock instant the deadline elapsed. */
  readonly atMs: number
  /** Optional driver label set on the wait (paired with the missing message's label). */
  readonly label?: string
}

/** Free-form driver-emitted marker (call-end, scenario-phase, etc.). */
export interface RecordedMarker {
  readonly kind: "marker"
  readonly atMs: number
  readonly label: string
  readonly note?: string
}

export type RecordingEntry = RecordedMessage | RecordedTimeout | RecordedMarker

/** A complete recording for one logical call. */
export interface CallRecording {
  /** Stable scenario identifier (e.g. "basic-call"). */
  readonly scenarioId: string
  /** ServiceCase identifier paired with the scenario, or null when none. */
  readonly serviceCaseId: string | null
  /** Call-ID this recording belongs to (or "<pre-call>" for setup-only logs). */
  readonly callId: string
  /** Wall-clock instant the runner started this call (virtual under TestClock). */
  readonly startMs: number
  /** Ordered entries: messages, timeouts, markers. */
  readonly entries: ReadonlyArray<RecordingEntry>
}

/** Helper: filter just the messages in order. */
export function messagesOf(rec: CallRecording): ReadonlyArray<RecordedMessage> {
  return rec.entries.filter((e): e is RecordedMessage => e.kind === "message")
}

/** Helper: find a recorded message by label. Returns the first match. */
export function findByLabel(
  rec: CallRecording,
  label: string
): RecordedMessage | undefined {
  for (const e of rec.entries) {
    if (e.kind === "message" && e.label === label) return e
  }
  return undefined
}
