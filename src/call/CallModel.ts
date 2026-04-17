/**
 * Effect Schema definitions for the B2BUA call model.
 *
 * Three-level hierarchy: Call → Leg → Dialog.
 * All types are serializable to/from JSON for Redis persistence.
 */

import { Schema } from "effect"

/**
 * Generate a random initial CSeq as a multiple of 1000 (1000–2_000_000).
 * RFC 3261 §8.1.1.5 recommends a random initial value.
 * Using multiples of 1000 makes it obvious in traces when a CSeq is wrong.
 */
export function randomInitialCSeq(): number {
  return (Math.floor(Math.random() * 2000) + 1) * 1000
}

// ── Remote address ──────────────────────────────────────────────────────────

export const RemoteInfo = Schema.Struct({
  address: Schema.String,
  port: Schema.Int
})

export type RemoteInfo = typeof RemoteInfo.Type

// ── Pending transparent-relay request (stored on target-leg dialog for response correlation) ─
//
// Captures a snapshot of the original inbound request so its response can be
// rebuilt with the correct Vias, From, To, Call-ID, and CSeq (RFC 3261
// §8.1.3.3). Used for every method the B2BUA relays transparently: INVITE
// (re-INVITE), OPTIONS, INFO, UPDATE, MESSAGE, PRACK, and any future custom
// method that flows through ActionExecutor.relayRequest.

export const PendingRequest = Schema.Struct({
  /** SIP method of the relayed request (e.g. INVITE, OPTIONS, INFO, UPDATE, MESSAGE, PRACK) */
  method: Schema.String,
  /** CSeq number on the outbound relayed request */
  outboundCSeq: Schema.Int,
  /** CSeq number on the original inbound request (for response CSeq rewrite) */
  inboundCSeq: Schema.Int,
  /** Via headers from the original inbound request (for response routing) */
  sourceVias: Schema.Array(Schema.String),
  /** Call-ID of the source leg (for response Call-ID) */
  sourceCallId: Schema.String,
  /** From header of the source leg (for response From) */
  sourceFrom: Schema.String,
  /** To header with proper tag (for response To) */
  sourceTo: Schema.String,
  /** Direction of the original request */
  direction: Schema.Literals(["from-a", "from-b"]),
})

export type PendingRequest = typeof PendingRequest.Type

// ── Dialog ──────────────────────────────────────────────────────────────────

export const Dialog = Schema.Struct({
  toTag: Schema.String,
  contact: Schema.String,
  localCSeq: Schema.Int,
  /**
   * CSeq of the most recently sent INVITE on this dialog (initial or re-INVITE).
   * Used by ACK-for-2xx, which echoes the INVITE's CSeq (RFC 3261 §13.2.2.4).
   * Distinct from localCSeq because intermediate PRACK/UPDATE may bump localCSeq
   * between the INVITE and its 2xx response.
   */
  lastInviteCSeq: Schema.optional(Schema.Int),
  /** Remote party's highest CSeq. Null until first message received from remote. */
  remoteCSeq: Schema.NullOr(Schema.Int),
  /**
   * Pending transparently-relayed inbound requests awaiting response on this dialog.
   * Stored on the dialog the request was sent TO (the target leg).
   * Covers every method that flows through ActionExecutor.relayRequest —
   * re-INVITE, OPTIONS, INFO, UPDATE, MESSAGE, PRACK, and custom transparent
   * methods. Glare detection (for re-INVITE specifically) checks the SOURCE
   * dialog where a new re-INVITE arrives FROM.
   */
  inboundPendingRequests: Schema.Array(PendingRequest),
  routeSet: Schema.Array(Schema.String),
  /**
   * Via branch of the first ACK sent for this dialog's 2xx INVITE response.
   * RFC 3261 §13.2.2.4 / §17.1.1.2: ACK for 2xx is a one-shot. When a UAS
   * retransmits the 2xx (lost ACK), the UAC must re-ACK. Reusing the same
   * Via branch keeps the re-ACK byte-identical so the UAS can correlate it
   * with the original and suppress further 2xx retransmissions.
   */
  ackBranch: Schema.optional(Schema.String)
})

export type Dialog = typeof Dialog.Type

// ── Tag mapping (B-leg remote tag ↔ B2BUA tag shown to A-leg) ──────────────

export const TagMapping = Schema.Struct({
  /** B2BUA-generated tag shown to Alice */
  aTag: Schema.String,
  /** Which B-leg this maps to */
  bLegId: Schema.String,
  /** Bob's actual remote tag */
  bTag: Schema.String,
})

export type TagMapping = typeof TagMapping.Type

// ── Leg state & disposition ─────────────────────────────────────────────────

export const LegState = Schema.Literals(["trying", "early", "confirmed", "terminated"])
export type LegState = typeof LegState.Type

export const LegDisposition = Schema.Literals(["pending", "bridged", "cancelling", "rejected"])
export type LegDisposition = typeof LegDisposition.Type

/**
 * Per-leg BYE disposition — tracks how each leg was (or will be) torn down.
 *
 * Used by the "terminating" call state to know when all outstanding BYE
 * transactions have resolved, so the call can be safely removed from memory.
 *
 * Terminal values (no further SIP traffic expected for this leg):
 *   - bye_confirmed: 200 OK received for our outbound BYE
 *   - bye_received:  remote sent BYE to us (we already replied 200)
 *   - bye_timeout:   BYE transaction timed out (far side unresponsive)
 *   - cancelled:     CANCEL sent (pre-dialog, no BYE needed)
 *   - rejected:      far side rejected INVITE (4xx/5xx/6xx, no BYE needed)
 *   - none:          leg never established (e.g. failover replaced it)
 *
 * Non-terminal (waiting for response):
 *   - bye_sent:      we sent BYE, awaiting 200 OK or timeout
 */
export const ByeDisposition = Schema.Literals([
  "bye_sent",
  "bye_received",
  "bye_confirmed",
  "bye_timeout",
  "cancelled",
  "rejected",
  "none",
])
export type ByeDisposition = typeof ByeDisposition.Type

/** Terminal bye dispositions — no more SIP traffic expected for this leg. */
const TERMINAL_BYE_DISPOSITIONS: ReadonlySet<ByeDisposition> = new Set([
  "bye_confirmed", "bye_received", "bye_timeout", "cancelled", "rejected", "none",
])

// ── Leg ─────────────────────────────────────────────────────────────────────

export const Leg = Schema.Struct({
  /** "a", "b-1", "b-2", ... */
  legId: Schema.String,
  callId: Schema.String,
  fromTag: Schema.String,
  source: RemoteInfo,
  state: LegState,
  disposition: LegDisposition,
  /** Multiple during early state (forking); one survives after confirmed */
  dialogs: Schema.Array(Dialog),
  noAnswerTimeoutSec: Schema.optional(Schema.Number),
  /**
   * Tracks how this leg was (or will be) torn down during call termination.
   * Undefined while the call is active. Set when BYE is sent/received or
   * when the leg is otherwise resolved (CANCEL, reject, timeout).
   * See ByeDisposition for the full state machine.
   */
  byeDisposition: Schema.optional(ByeDisposition),
  /**
   * B2BUA's local URI for this leg (used in From header for outbound requests).
   * RFC 3261 §12.2.1.1: local URI from dialog state.
   * - a-leg: To URI from Alice's INVITE (B2BUA's identity as UAS)
   * - b-leg: From URI used in the b-leg INVITE (Alice's identity, impersonated)
   */
  localUri: Schema.optional(Schema.String),
  /**
   * Remote party's URI for this leg (used in To header for outbound requests).
   * RFC 3261 §12.2.1.1: remote URI from dialog state.
   * - a-leg: From URI from Alice's INVITE (Alice's identity)
   * - b-leg: To URI used in the b-leg INVITE (called party's identity)
   */
  remoteUri: Schema.optional(Schema.String),
  /**
   * Request-URI used in the outbound INVITE for this b-leg.
   * Needed for CANCEL — RFC 3261 §9.1: CANCEL Request-URI must match the INVITE's.
   */
  inviteRequestUri: Schema.optional(Schema.String),
  /**
   * Via branch assigned to the outbound INVITE after SipRouter stamping.
   * Needed for CANCEL — RFC 3261 §9.1: CANCEL Via must match the INVITE's top Via.
   */
  inviteBranch: Schema.optional(Schema.String),
})

export type Leg = typeof Leg.Type

/** Find a dialog by remote To-tag (for early-state forking). */
export function findDialogByToTag(leg: Leg, toTag: string): Dialog | undefined {
  return leg.dialogs.find((d) => d.toTag === toTag)
}

/** Get the single confirmed dialog (only valid when leg.state === "confirmed"). */
export function confirmedDialog(leg: Leg): Dialog | undefined {
  return leg.dialogs[0]
}

// ── Timer entry (serializable intent, not runtime fiber) ────────────────────

/**
 * Timer type — closed union of all known timer types.
 * When adding custom rules that need new timer types (e.g., REFER),
 * extend this union with the new literal values.
 */
export const TimerType = Schema.Literals([
  "no_answer",
  "global_duration",
  "limiter_refresh",
  "keepalive",
  "keepalive_timeout",
  /**
   * Safety-net timer scheduled when entering "terminating" state.
   * If all legs haven't resolved within 64s (2× Timer B/F), force-remove
   * the call to prevent permanent memory leaks from lost BYE responses.
   */
  "terminating_timeout",
  /**
   * REFER subscription expiry (RFC 3515): bound on how long we keep the
   * implicit REFER subscription open before emitting the final NOTIFY.
   */
  "refer_subscription_expiry",
  /**
   * Per re-INVITE answer watchdog during REFER-driven blind transfer.
   * Fires if C or A do not answer our realigning re-INVITE in time.
   */
  "refer_reinvite_answer",
  /**
   * Overall REFER safety timer: covers the full transfer state machine
   * end-to-end (authorize → ring → realign C → realign A → merge).
   */
  "refer_overall_safety"
])
export type TimerType = typeof TimerType.Type

export const TimerEntry = Schema.Struct({
  id: Schema.String,
  type: TimerType,
  /** Epoch ms — absolute deadline */
  fireAt: Schema.Number,
  /** undefined = call-level timer */
  legId: Schema.optional(Schema.String)
})

export type TimerEntry = typeof TimerEntry.Type

// ── Call limiter state ──────────────────────────────────────────────────────

export const CallLimiterState = Schema.Struct({
  limiterId: Schema.String,
  limit: Schema.Int,
  /** Rounded timestamp when this call's count was INCRed */
  originWindow: Schema.Number
})

export type CallLimiterState = typeof CallLimiterState.Type

// ── CDR event ───────────────────────────────────────────────────────────────

export const CdrEventType = Schema.Literals([
  "invite_received",
  "invite_sent",
  "provisional",
  "answer",
  "bye",
  "cancel",
  "timeout",
  "reject"
])
export type CdrEventType = typeof CdrEventType.Type

export const CdrEvent = Schema.Struct({
  type: CdrEventType,
  timestamp: Schema.Number,
  legId: Schema.String,
  statusCode: Schema.optional(Schema.Int),
  reason: Schema.optional(Schema.String)
})

export type CdrEvent = typeof CdrEvent.Type

// ── A-leg INVITE snapshot (for failover b-leg reconstruction) ───────────────

export const SipHeaderSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String
})

export const ALegInviteSnapshot = Schema.Struct({
  uri: Schema.String,
  headers: Schema.Array(SipHeaderSchema),
  body: Schema.Uint8ArrayFromBase64
})

export type ALegInviteSnapshot = typeof ALegInviteSnapshot.Type

// ── Policy flags (set by HTTP routing response, checked by PolicyModule guards) ─

/** Policy flags set by the HTTP routing response. PolicyModule guards check these. */
export const CallPolicies = Schema.Struct({
  /** Transform first 18x to bare 180, suppress subsequent, force tag consistency across failover. */
  relayFirst18xTo180: Schema.optional(Schema.Boolean),
})
export type CallPolicies = typeof CallPolicies.Type

// ── Transfer state (REFER-driven blind transfer) ──────────────────────────
//
// Populated by TransferRules when the B-leg issues a REFER. Drives the
// transfer phase state machine (declared via Match.transferPhase on rules)
// and anchors the realigning re-INVITE exchanges. Pointer + payload data
// only — no inline fiber/handle state.

/** Phase marker for the REFER-driven transfer state machine. */
export const TransferPhase = Schema.Literals([
  /** REFER received, awaiting HTTP authorization decision. */
  "refer-authorizing",
  /** C-leg INVITE sent, awaiting final response. */
  "c-ringing",
  /** Re-INVITE toward C with A's SDP in flight. */
  "c-realigning",
  /** Re-INVITE toward A with C's endpoint in flight. */
  "a-realigning",
])
export type TransferPhase = typeof TransferPhase.Type

export const TransferState = Schema.Struct({
  /** Current transfer phase — gates which TransferRules can match. */
  phase: TransferPhase,
  /** B-leg that issued the REFER (origin of the implicit subscription). */
  referrerLegId: Schema.String,
  /** Raw Refer-To URI as received from the referrer. */
  referToUri: Schema.String,
  /** Refer-To URI after any HTTP-driven rewrite (`new_refer_to`). */
  effectiveReferToUri: Schema.optional(Schema.String),
  /** Callback context propagated from the /call/refer response. */
  callbackContext: Schema.optional(Schema.String),
  /** Newly-created C-leg identifier (set when create-leg fires). */
  cLegId: Schema.optional(Schema.String),
  /** CSeq of the REFER request on the referrer's dialog (for NOTIFY correlation). */
  referCSeq: Schema.optional(Schema.Int),
  /** Wall-clock ms when the REFER was received — drives the overall safety timer. */
  startedAtMs: Schema.Number,
})
export type TransferState = typeof TransferState.Type

// ── Rule system (active rules + per-rule state on Call) ────────────────────

/** A rule activated on this call by the HTTP API response. */
export const ActiveRule = Schema.Struct({
  /** Rule identifier — must match a registered RuleDefinition.id */
  id: Schema.String,
  /** Lower number runs first. Default 100. */
  priority: Schema.Int,
  /** Rule-specific configuration from HTTP response (frozen at activation) */
  params: Schema.optional(Schema.Unknown),
  /** Whether this rule is currently active (can be deactivated mid-call) */
  active: Schema.Boolean,
})

export type ActiveRule = typeof ActiveRule.Type

/** Per-rule opaque state blob, decoded by the owning rule's stateSchema. */
export const RuleStateEntry = Schema.Struct({
  ruleId: Schema.String,
  state: Schema.optional(Schema.Unknown),
})

export type RuleStateEntry = typeof RuleStateEntry.Type

// ── Call state ──────────────────────────────────────────────────────────────

/**
 * Call lifecycle states:
 *   - "active":      normal operation, call in progress
 *   - "terminating": BYE(s) sent, waiting for all legs to resolve (200 OK or timeout).
 *                    Call stays in memory and Redis. New non-BYE-response messages dropped.
 *   - "terminated":  all legs resolved, call can be safely removed from memory/Redis.
 */
export const CallModelState = Schema.Literals(["active", "terminating", "terminated"])
export type CallModelState = typeof CallModelState.Type

// ── Call ─────────────────────────────────────────────────────────────────────

export const Call = Schema.Struct({
  /** Deterministic: derived from aLegCallId + aLegFromTag */
  callRef: Schema.String,
  aLeg: Leg,
  /** Ordered by attempt ("b-1", "b-2", ...) */
  bLegs: Schema.Array(Leg),
  /**
   * Active peering — exactly one pair of legs connected at a time (1<->1),
   * or null when no legs are peered (1<->0, e.g., during call establishment).
   *
   * The typed pair makes N<->N structurally unrepresentable — the schema
   * itself enforces the 1<->1 / 1<->0 invariant.
   *
   * Design:
   * - merge(A, B) sets activePeer to { legA: A, legB: B }
   * - split(A) sets activePeer to null
   * - getPeer(call, legId) returns the other side, or undefined
   * - Rules use "relay-to-peer" action which calls getPeer internally
   * - activePeer is cleared on terminate-call / begin-termination
   */
  activePeer: Schema.NullOr(Schema.Struct({ legA: Schema.String, legB: Schema.String })),
  callbackContext: Schema.optional(Schema.String),
  /** Snapshot of the original a-leg INVITE for failover b-leg reconstruction. */
  aLegInviteSnapshot: Schema.optional(ALegInviteSnapshot),
  /**
   * Active limiter entries for this call.
   * Framework concern — InvariantEnforcer guarantees decrement on termination.
   * Limiter refresh (window migration) is handled by the framework, not rules:
   * auto-scheduled on call confirmation when limiterEntries.length > 0,
   * runs limiter.refresh() for each entry and reschedules itself.
   */
  limiterEntries: Schema.Array(CallLimiterState),
  /**
   * Serializable timer intents (not runtime fibers).
   * Timer type is an open string — built-in types in BuiltinTimerType,
   * custom rules can define additional types (e.g., "refer_timeout").
   * Rules schedule/cancel timers via actions; timers fire as CallEvent.timer.
   */
  timers: Schema.Array(TimerEntry),
  cdrEvents: Schema.Array(CdrEvent),
  state: CallModelState,
  createdAt: Schema.Number,
  /** Original Via header values from the a-leg INVITE (for relaying INVITE responses). */
  aLegVias: Schema.Array(Schema.String),
  /** Via headers from the most recent non-INVITE a-leg request (PRACK, etc.) for response relay. */
  aLegPendingVias: Schema.optional(Schema.Array(Schema.String)),
  /** CSeq number of the most recent non-INVITE a-leg request (PRACK, etc.) — echoed on the response toward alice (RFC 3261 §8.1.3.3). */
  aLegPendingCSeq: Schema.optional(Schema.Int),
  /** Original From header value from the a-leg INVITE (for relaying responses). */
  aLegFrom: Schema.String,
  /** Original To header value from the a-leg INVITE (for relaying responses). */
  aLegTo: Schema.String,
  /**
   * CSeq number of the a-leg INVITE as received from Alice. Echoed on the
   * final INVITE response back to her (RFC 3261 §8.1.3.3: response CSeq
   * must equal request CSeq). A single per-call fact, not a dialog counter.
   */
  aLegInviteCSeq: Schema.Int,
  /** Maps B-leg remote To-tags to B2BUA-generated tags shown to Alice. */
  tagMap: Schema.Array(TagMapping),
  /** OpenTelemetry trace ID for this call (set at INVITE time). */
  traceId: Schema.optional(Schema.String),
  /** Span ID of the root INVITE span (parent for all child spans). */
  rootSpanId: Schema.optional(Schema.String),
  /** Head-based sampling decision made at INVITE time. */
  sampled: Schema.optional(Schema.Boolean),
  /** Worker index that owns this call (for cluster-mode recovery). */
  workerIndex: Schema.optional(Schema.Int),
  /**
   * True if this call carries an emergency Resource-Priority
   * (esnet.0 / wps.0 / q735.0). Set at initial INVITE time. Drives the
   * SipRouter `;emerg=1` / `;em=1` URI/Via marker stamping that lets the
   * dispatcher byte-classifier route subsequent in-dialog packets into
   * the emergency priority queue without parsing.
   */
  emergency: Schema.optional(Schema.Boolean),
  /** Policy flags set by HTTP routing response. PolicyModule guards check these. */
  policies: Schema.optional(CallPolicies),
  /**
   * Header overrides derived from policy flags, applied to all b-leg INVITEs
   * (including failover). Set during initial INVITE handling. ActionExecutor
   * merges these with per-action updateHeaders in executeCreateLeg.
   */
  policyUpdateHeaders: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  /**
   * Rules activated on this call by the HTTP API response.
   * Per-call rules run alongside always-active built-in rules.
   * Per-call rules with the same ID as a built-in rule override the built-in.
   * Empty/undefined = only built-in always-active rules run.
   */
  activeRules: Schema.optional(Schema.Array(ActiveRule)),
  /**
   * Per-rule opaque state blobs, decoded by the owning rule's stateSchema.
   * Rules update their state via RuleHandleResult.state; the RuleExecutor
   * persists it here before action execution. Serialized through Redis.
   */
  ruleState: Schema.optional(Schema.Array(RuleStateEntry)),
  /**
   * REFER-driven blind transfer state. Populated on REFER receipt, cleared
   * once the transfer completes (success or failure). The `phase` field
   * gates which TransferRules can match via Match.transferPhase.
   */
  transfer: Schema.optional(Schema.NullOr(TransferState)),
})

export type Call = typeof Call.Type

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Derive a deterministic callRef from the a-leg identifiers. */
export function deriveCallRef(aLegCallId: string, aLegFromTag: string): string {
  return `${aLegCallId}|${aLegFromTag}`
}

/** Build the initial empty dialog stub with a random initial CSeq. */
export function makeEmptyDialog(toTag: string): Dialog {
  return {
    toTag,
    contact: "",
    localCSeq: randomInitialCSeq(),
    remoteCSeq: null,
    inboundPendingRequests: [],
    routeSet: []
  }
}

/**
 * Build a dialog initialized from a received request's CSeq.
 * Used for the a-leg dialog where we know Alice's CSeq from her INVITE.
 */
export function makeDialogFromIncoming(toTag: string, remoteCSeq: number): Dialog {
  return {
    toTag,
    contact: "",
    localCSeq: randomInitialCSeq(),
    remoteCSeq,
    inboundPendingRequests: [],
    routeSet: []
  }
}

// ── Lens helpers ───────────────────────────────────────────────────────────

/** Update a specific leg by legId. */
export function updateLeg(call: Call, legId: string, fn: (leg: Leg) => Leg): Call {
  if (call.aLeg.legId === legId) {
    return { ...call, aLeg: fn(call.aLeg) }
  }
  return { ...call, bLegs: call.bLegs.map((l) => l.legId === legId ? fn(l) : l) }
}

/** Update a specific dialog within a leg. */
export function updateDialog(
  call: Call,
  legId: string,
  toTag: string,
  fn: (dialog: Dialog) => Dialog
): Call {
  return updateLeg(call, legId, (leg) => ({
    ...leg,
    dialogs: leg.dialogs.map((d) => d.toTag === toTag ? fn(d) : d)
  }))
}

/** Set the state of a specific leg. */
export function setLegState(call: Call, legId: string, state: LegState): Call {
  return updateLeg(call, legId, (leg) => ({ ...leg, state }))
}

/** Set the disposition of a specific leg. */
export function setLegDisposition(call: Call, legId: string, disposition: LegDisposition): Call {
  return updateLeg(call, legId, (leg) => ({ ...leg, disposition }))
}

/** Set the BYE disposition of a specific leg. */
export function setByeDisposition(call: Call, legId: string, byeDisposition: ByeDisposition): Call {
  return updateLeg(call, legId, (leg) => ({ ...leg, byeDisposition }))
}

/**
 * Check if all legs of a terminating call have reached a terminal BYE disposition,
 * meaning no more SIP BYE-related traffic is expected.
 *
 * A call transitions from "terminating" → "terminated" when this returns true.
 *
 * Rules:
 * - Legs in "trying" state with no byeDisposition are considered resolved
 *   (they never established a dialog, so no BYE is needed).
 * - All other legs must have a terminal byeDisposition.
 */
export function isFullyResolved(call: Call): boolean {
  const legsToCheck = [call.aLeg, ...call.bLegs]
  return legsToCheck.every((leg) => {
    // Legs that never established don't need BYE resolution
    if (leg.state === "trying" && leg.byeDisposition === undefined) return true
    // Must have a terminal disposition
    return leg.byeDisposition !== undefined && TERMINAL_BYE_DISPOSITIONS.has(leg.byeDisposition)
  })
}

/** Append a CDR event. */
export function addCdrEvent(call: Call, event: CdrEvent): Call {
  return { ...call, cdrEvents: [...call.cdrEvents, event] }
}

/** Add a new b-leg. */
export function addBLeg(call: Call, leg: Leg): Call {
  return { ...call, bLegs: [...call.bLegs, leg] }
}

/** Find a b-leg by legId. */
export function findBLeg(call: Call, legId: string): Leg | undefined {
  return call.bLegs.find((l) => l.legId === legId)
}

/** Find a b-leg by callId. */
export function findBLegByCallId(call: Call, callId: string): Leg | undefined {
  return call.bLegs.find((l) => l.callId === callId)
}

/**
 * Bump the local CSeq of a specific dialog by a given delta.
 *
 * RFC 3261 §12.2.1.1: CSeq is scoped to the dialog, not the Call-ID/leg.
 * Forked early dialogs each maintain an independent CSeq sequence from
 * the shared INVITE baseline, so this MUST NOT sync across sibling dialogs.
 */
export function bumpLocalCSeq(call: Call, legId: string, toTag: string, delta: number = 1): Call {
  return updateDialog(call, legId, toTag, (d) => ({ ...d, localCSeq: d.localCSeq + delta }))
}

/**
 * Update the remoteCSeq on a dialog (track the other side's latest CSeq).
 */
export function updateRemoteCSeq(call: Call, legId: string, toTag: string, remoteCSeq: number): Call {
  return updateDialog(call, legId, toTag, (d) => ({ ...d, remoteCSeq }))
}

/**
 * Compute the CSeq delta for a relayed request.
 * Delta = inbound CSeq - source leg's last known remoteCSeq.
 * Clamped to minimum 1 (safety: CSeq must always advance).
 */
export function relayCSeqDelta(inboundCSeq: number, sourceRemoteCSeq: number | null): number {
  if (sourceRemoteCSeq === null) return 1
  return Math.max(1, inboundCSeq - sourceRemoteCSeq)
}

// ── Pending transparent-relay request helpers ────────────────────────────

/** Add a pending transparent-relay entry to a dialog. */
export function addPendingRequest(call: Call, legId: string, toTag: string, entry: PendingRequest): Call {
  return updateDialog(call, legId, toTag, (d) => ({
    ...d, inboundPendingRequests: [...d.inboundPendingRequests, entry]
  }))
}

/** Find a pending transparent-relay entry by outbound CSeq. */
export function findPendingRequest(dialog: Dialog, outboundCSeq: number): PendingRequest | undefined {
  return dialog.inboundPendingRequests.find((p) => p.outboundCSeq === outboundCSeq)
}

/** Remove a pending transparent-relay entry after its response is handled. */
export function removePendingRequest(call: Call, legId: string, toTag: string, outboundCSeq: number): Call {
  return updateDialog(call, legId, toTag, (d) => ({
    ...d, inboundPendingRequests: d.inboundPendingRequests.filter((p) => p.outboundCSeq !== outboundCSeq)
  }))
}

// ── Leg tag helpers ───────────────────────────────────────────────────────
//
// On the a-leg, B2BUA is UAS: its tag lives in dialog.toTag, remote is fromTag.
// On the b-leg, B2BUA is UAC: its tag lives in fromTag, remote is dialog.toTag.
// These helpers hide that asymmetry.

/**
 * Returns the B2BUA's own tag for a given leg.
 * - a-leg: B2BUA put its tag in To when responding → `dialog.toTag`
 * - b-leg: B2BUA put its tag in From when sending INVITE → `leg.fromTag`
 */
export function b2buaTag(call: Call, legId: string): string | undefined {
  if (legId === "a") {
    return call.aLeg.dialogs[0]?.toTag
  }
  const bLeg = findBLeg(call, legId)
  return bLeg?.fromTag
}

/**
 * Returns the remote party's tag for a given leg.
 * - a-leg: Alice put her tag in From when sending INVITE → `leg.fromTag`
 * - b-leg: Bob put his tag in To when responding → `dialog.toTag`
 */
export function remoteTag(call: Call, legId: string): string | undefined {
  if (legId === "a") {
    return call.aLeg.fromTag
  }
  const bLeg = findBLeg(call, legId)
  return bLeg?.dialogs[0]?.toTag
}

// ── Tag mapping helpers ───────────────────────────────────────────────────

/** Add a tag mapping entry. */
export function addTagMapping(call: Call, mapping: TagMapping): Call {
  return { ...call, tagMap: [...call.tagMap, mapping] }
}

/** Look up a mapping by the B2BUA's a-facing tag. */
export function findByATag(call: Call, aTag: string): TagMapping | undefined {
  return call.tagMap.find((m) => m.aTag === aTag)
}

/** Look up a mapping by the B-leg's real tag. */
export function findByBTag(call: Call, bLegId: string, bTag: string): TagMapping | undefined {
  return call.tagMap.find((m) => m.bLegId === bLegId && m.bTag === bTag)
}

// ── Active peer helpers (INAP-style split/merge) ─────────────────────────
//
// activePeer is a typed pair { legA, legB } or null — structurally enforces
// the 1<->1 / 1<->0 invariant. All relay routing uses getPeer().

/** Get the peer leg for routing. Returns undefined if leg is not peered. */
export function getPeer(call: Call, legId: string): string | undefined {
  if (call.activePeer === null) return undefined
  if (call.activePeer.legA === legId) return call.activePeer.legB
  if (call.activePeer.legB === legId) return call.activePeer.legA
  return undefined
}

/**
 * Connect two legs (INAP MergeCallSegments).
 * Replaces any existing peering — only one pair can be active at a time.
 */
export function mergeLeg(call: Call, legA: string, legB: string): Call {
  return { ...call, activePeer: { legA, legB } }
}

/**
 * Disconnect a leg from its peer (INAP SplitLeg).
 * Clears activePeer if the leg is part of the current pair.
 */
export function splitLeg(call: Call, legId: string): Call {
  if (call.activePeer === null) return call
  if (call.activePeer.legA === legId || call.activePeer.legB === legId) {
    return { ...call, activePeer: null }
  }
  return call
}

/** Get all leg IDs that currently have a peer. */
export function allPeeredLegs(call: Call): string[] {
  if (call.activePeer === null) return []
  return [call.activePeer.legA, call.activePeer.legB]
}

// ── Rule state helpers ───────────────────────────────────────────────────

/** Get the rule state entry for a given rule ID. */
export function getRuleState(call: Call, ruleId: string): unknown | undefined {
  return call.ruleState?.find((e) => e.ruleId === ruleId)?.state
}

/** Update or insert a rule state entry. */
export function setRuleState(call: Call, ruleId: string, state: unknown): Call {
  const existing = call.ruleState ?? []
  const idx = existing.findIndex((e) => e.ruleId === ruleId)
  const entry: RuleStateEntry = { ruleId, state }
  const updated = idx >= 0
    ? [...existing.slice(0, idx), entry, ...existing.slice(idx + 1)]
    : [...existing, entry]
  return { ...call, ruleState: updated }
}

/** Deactivate a rule (set active = false). Preserves state for tracing/CDR. */
export function deactivateRule(call: Call, ruleId: string): Call {
  const rules = (call.activeRules ?? []).map((r) =>
    r.id === ruleId ? { ...r, active: false } : r
  )
  return { ...call, activeRules: rules }
}
