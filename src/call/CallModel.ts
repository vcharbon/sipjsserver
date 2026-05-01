/**
 * Effect Schema definitions for the B2BUA call model.
 *
 * Three-level hierarchy: Call → Leg → Dialog.
 * All types are serializable to/from JSON for Redis persistence.
 */

import { Schema } from "effect"
import { FeatureActivations } from "../decision/schemas/features.js"
import { currentRng } from "../sip/MessageHelpers.js"

// ── INVITE client transaction handle (in-memory; opaque to JSON) ──────────
//
// B.2 introduces `pendingInviteTxn` on Leg (initial INVITE) and on
// `B2buaDialogExt` (re-INVITE). The handle carries enough to reconstruct
// the CANCEL / ACK-for-2xx wire format without consulting Call state:
// branch (§9.1 CANCEL reuse), original INVITE (§13.2.2.4 ACK CSeq), and
// destination.
//
// `originalInvite` is kept `Schema.Unknown` because `SipRequest` carries
// `Buffer` / `Uint8Array` fields that aren't worth round-tripping — handles
// live only in-memory and are best-effort through Redis. Consumers that
// need the typed SipRequest cast the field at the call site.
export const InviteTxnHandleSchema = Schema.Struct({
  kind: Schema.Literal("invite"),
  branch: Schema.String,
  originalInvite: Schema.Unknown,
  destination: Schema.Struct({
    host: Schema.String,
    port: Schema.Number,
  }),
})

export type InviteTxnHandle = typeof InviteTxnHandleSchema.Type


/**
 * Generate a random initial CSeq as a multiple of 1000 (1000–2_000_000).
 * RFC 3261 §8.1.1.5 recommends a random initial value.
 * Using multiples of 1000 makes it obvious in traces when a CSeq is wrong.
 *
 * Reads from the current fiber's Effect `Random` reference via
 * `currentRng()`, so seeded test runs reproduce the CSeq sequence.
 */
export function randomInitialCSeq(): number {
  return (Math.floor(currentRng().nextDoubleUnsafe() * 2000) + 1) * 1000
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

/**
 * RFC 3261 §12 dialog state, stack-owned. Mirrors the `StackDialog`
 * interface exported from `src/sip/Dialog.ts`. The stack generators
 * (`generateInDialogRequest`, `generateAckFor2xx`) consume exactly this
 * shape — they don't know about `ext`.
 *
 * Tag convention (resolves the a/b-leg asymmetry that lived in the old
 * `dialog.toTag` field):
 *   - `localTag`  — B2BUA's tag on this leg. On the a-leg this is the tag
 *                   the B2BUA pinned in its To response; on the b-leg it
 *                   equals `leg.fromTag`.
 *   - `remoteTag` — peer tag on this leg. On the a-leg this equals
 *                   `leg.fromTag` (Alice's tag); on the b-leg it's the
 *                   To-tag Bob returned in his 1xx/2xx.
 *
 * `callId`, `localUri`, `remoteUri` are denormalised from the enclosing
 * leg so the generators can consume a dialog without any leg context.
 */
export const StackDialogSchema = Schema.Struct({
  callId: Schema.String,
  localTag: Schema.String,
  remoteTag: Schema.String,
  localUri: Schema.String,
  remoteUri: Schema.String,
  /** Peer Contact URI — Request-URI for in-dialog requests (§12.2.1.1). */
  remoteTarget: Schema.String,
  /** Last-sent CSeq on this dialog (§8.1.1.5). */
  localCSeq: Schema.Int,
  /** Outbound route set, derived from Record-Route of the dialog-creating response (§12.1.2). */
  routeSet: Schema.Array(Schema.String),
})

export type StackDialogSchemaType = typeof StackDialogSchema.Type

/**
 * B2BUA-only dialog extensions that never surface to the SIP stack.
 * Kept separate from `sip` so the stack generators can consume just the
 * §12 state without seeing B2BUA internals.
 */
export const B2buaDialogExtSchema = Schema.Struct({
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
  /**
   * Via branch of the first ACK sent for this dialog's 2xx INVITE response.
   * RFC 3261 §13.2.2.4 / §17.1.1.2: ACK for 2xx is a one-shot. When a UAS
   * retransmits the 2xx (lost ACK), the UAC must re-ACK. Reusing the same
   * Via branch keeps the re-ACK byte-identical so the UAS can correlate it
   * with the original and suppress further 2xx retransmissions.
   */
  ackBranch: Schema.optional(Schema.String),
  /**
   * Handle for an in-flight re-INVITE client transaction on this dialog.
   * Set when the B2BUA sends a re-INVITE; cleared once the INVITE txn
   * terminates (2xx+ACK, 3xx–6xx final, or 491 glare). Canonical source
   * for ACK-for-2xx CSeq (§13.2.2.4).
   */
  pendingInviteTxn: Schema.optional(InviteTxnHandleSchema),
})

export type B2buaDialogExt = typeof B2buaDialogExtSchema.Type

/**
 * Composite Dialog = stack-level §12 state + B2BUA-only extensions.
 *
 * Callers migrating from the old flat shape:
 *   - `dialog.toTag`          → `dialog.sip.localTag` (a-leg) or `dialog.sip.remoteTag` (b-leg)
 *   - `dialog.contact`        → `dialog.sip.remoteTarget`
 *   - `dialog.localCSeq`      → `dialog.sip.localCSeq`
 *   - `dialog.routeSet`       → `dialog.sip.routeSet`
 *   - `dialog.remoteCSeq`     → `dialog.ext.remoteCSeq`
 *   - `dialog.inboundPending…`→ `dialog.ext.inboundPendingRequests`
 *   - `dialog.ackBranch`      → `dialog.ext.ackBranch`
 */
export const Dialog = Schema.Struct({
  sip: StackDialogSchema,
  ext: B2buaDialogExtSchema,
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
   * Handle for the in-flight initial-INVITE client transaction on this leg.
   * Set when the B2BUA sends the initial INVITE (before a dialog exists);
   * cleared once the dialog is confirmed / ACK is sent. The canonical source
   * for CANCEL branch reuse (§9.1) and ACK-for-2xx CSeq (§13.2.2.4).
   */
  pendingInviteTxn: Schema.optional(InviteTxnHandleSchema),
})

export type Leg = typeof Leg.Type

/**
 * Find a dialog by remote tag (for early-state forking on the b-leg).
 * The caller passes Bob's tag from a 1xx/2xx; we match `sip.remoteTag`.
 */
export function findDialogByToTag(leg: Leg, toTag: string): Dialog | undefined {
  return leg.dialogs.find((d) => d.sip.remoteTag === toTag)
}

/** Get the single confirmed dialog (only valid when leg.state === "confirmed"). */
export function confirmedDialog(leg: Leg): Dialog | undefined {
  return leg.dialogs[0]
}

/**
 * Dialog-identity match — resolves the a/b-leg asymmetry.
 *
 * On the a-leg, the B2BUA pins its own tag as the dialog's local tag, so
 * early-fork identity is keyed off `sip.localTag`. On the b-leg, Bob's tag
 * (originally `dialog.toTag`) drives identity and lives in `sip.remoteTag`.
 *
 * Callers still pass a single "identity tag" — internally we route to the
 * correct side. Kept local to this module so external callers don't
 * accidentally use the wrong side.
 */
function matchDialogIdentity(legId: string, identityTag: string, d: Dialog): boolean {
  return legId === "a" ? d.sip.localTag === identityTag : d.sip.remoteTag === identityTag
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

// ── Feature activations (structured closed union from the decision engine) ─
//
// Canonical `FeatureActivations` imported from `src/decision/schemas/features.ts`.
// PolicyModule guards key on presence (`features.X !== undefined`) rather
// than boolean truthiness, so absence means "explicitly disabled" per
// SplitServiceLogic.md §D5.

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
  /**
   * Last 1xx status code forwarded on the REFER subscription as a NOTIFY
   * sipfrag. Used by `transfer-c-1xx-to-notify` to dedupe repeats (180,
   * then another 180 → only one NOTIFY). Unset until the first provisional
   * is translated.
   */
  lastCLegNotifiedStatus: Schema.optional(Schema.Int),
  /**
   * C-leg's initial answer SDP (captured from C's 200 OK to the initial
   * INVITE). Carried across the c-realigning phase so that when the
   * c-realign re-INVITE (with A's SDP) succeeds we already know the SDP
   * to offer back to A in the a-realigning re-INVITE.
   */
  cInitialSdp: Schema.optional(Schema.Uint8ArrayFromBase64),
})
export type TransferState = typeof TransferState.Type

// ── Rule system (active rules + per-rule state on Call) ────────────────────

/** A rule activated on this call by the HTTP API response. */
export const ActiveRule = Schema.Struct({
  /** Rule identifier — must match a registered RuleDefinition.id */
  id: Schema.String,
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

// ── HA topology hint ────────────────────────────────────────────────────────

/**
 * Persisted topology hint (D7 of the HA-resilience plan).
 *
 * Captures the worker pair the proxy stamped into the call's stickiness
 * cookie at INVITE time, plus a monotonic generation that increments on
 * every state flush. On recovery / reclaim:
 *
 *   - A peer scanning its sidecar Redis filters by `pri == self` (calls I
 *     was primary for) or `bak == self` (calls I was backup for) to decide
 *     which entries to rehydrate.
 *   - On conflict (e.g. partition heal where two writers raced), the
 *     newest `gen` wins — matches "lost-update" tolerance per F10.
 *
 * `pri` matches the cookie's `w_pri` (a `WorkerId` opaque string). `bak`
 * matches `w_bak`; the empty string means "single-worker cluster, no
 * backup chosen at encode time" (documented small-cluster limitation).
 *
 * Optional on the Call schema: a worker that hasn't yet decoded a v2
 * cookie (e.g. tests using the legacy single-Redis path) leaves the
 * field absent. Slice 4 of the implementation plan populates it on the
 * dual-write path.
 */
export const CallTopology = Schema.Struct({
  pri: Schema.String,
  bak: Schema.String,
  gen: Schema.Int,
})

export type CallTopology = typeof CallTopology.Type

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
  /**
   * Opaque adapter-owned attribution blob. Threaded by the CallDecisionEngine
   * adapter through lifecycle responses (Route / RejectA / ReferAllow) and
   * emitted once into the terminal CDR record. Latest-wins across lifecycle
   * overrides. Stack has zero opinions about its shape (see SplitServiceLogic.md §D9).
   */
  billingContext: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * Snapshot of the original a-leg INVITE. Source of truth for:
   *   - failover b-leg reconstruction (createBLegFromRoute),
   *   - relaying INVITE responses back to Alice (RFC 3261 §8.2.6.2: echo
   *     Via/From/To/Call-ID/CSeq from the request),
   *   - transfer scenarios that need Alice's SDP offer.
   * Populated at call creation in SipRouter; never mutated.
   */
  aLegInvite: ALegInviteSnapshot,
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
  /** Via headers from the most recent non-INVITE a-leg request (PRACK, etc.) for response relay. */
  aLegPendingVias: Schema.optional(Schema.Array(Schema.String)),
  /** CSeq number of the most recent non-INVITE a-leg request (PRACK, etc.) — echoed on the response toward alice (RFC 3261 §8.1.3.3). */
  aLegPendingCSeq: Schema.optional(Schema.Int),
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
   * HA topology hint (D7 of HA-resilience plan): names the cookie's
   * `{w_pri, w_bak}` pair plus a monotonic `gen`. Populated by the
   * dual-write path (Slice 4); absent on legacy single-Redis flushes
   * and on calls established before a v2 cookie was stamped.
   */
  _topology: Schema.optional(CallTopology),
  /**
   * True if this call carries an emergency Resource-Priority
   * (esnet.0 / wps.0 / q735.0). Set at initial INVITE time. Drives the
   * SipRouter `;emerg=1` / `;em=1` URI/Via marker stamping that lets the
   * dispatcher byte-classifier route subsequent in-dialog packets into
   * the emergency priority queue without parsing.
   */
  emergency: Schema.optional(Schema.Boolean),
  /**
   * Feature activations decoded from the CallDecisionEngine adapter response
   * (SplitServiceLogic.md §D5). Present on every Route / RejectA / ReferAllow
   * decision once B.7 lands; currently synthesised from the legacy flat-field
   * shape by the handler. PolicyModule guards check `features.X !== undefined`.
   */
  features: Schema.optional(FeatureActivations),
  /**
   * Header overrides derived from active features (e.g. the
   * `relayFirst18xTo180` activation strips `100rel` from `Supported`),
   * applied to all b-leg INVITEs including failover. Set during initial
   * INVITE handling. `createBLegFromRoute` applies them when building the
   * outbound INVITE, and per-action `headerUpdates` layer on top afterwards
   * in ActionExecutor.
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

/**
 * Derive a deterministic callRef from the natural primary's worker
 * ordinal + a-leg identifiers.
 *
 * Format: `{primaryOrdinal}|{aLegCallId}|{aLegFromTag}`
 *
 * Encoding the primary in the callRef itself (Option C of the
 * HA-resilience plan, slice 4) makes every callRef self-describing:
 * any worker holding a callRef can parse the primary ordinal, compare
 * to its own, and derive whether it should read/write under the
 * `pri:{primary}:` or `bak:{primary}:` partition without consulting
 * the proxy or scanning multiple namespaces.
 */
export function deriveCallRef(
  primaryOrdinal: string,
  aLegCallId: string,
  aLegFromTag: string
): string {
  return `${primaryOrdinal}|${aLegCallId}|${aLegFromTag}`
}

/**
 * Parse a callRef produced by `deriveCallRef` back into its three
 * segments. Returns `null` on malformed input — legacy two-segment
 * refs (pre-Slice-4) round-trip as `null` so callers can detect and
 * upgrade them at the boundary.
 */
export function parseCallRef(
  ref: string
): { primary: string; callId: string; fromTag: string } | null {
  const i1 = ref.indexOf("|")
  if (i1 <= 0) return null
  const i2 = ref.indexOf("|", i1 + 1)
  if (i2 <= i1 + 1 || i2 >= ref.length - 1) return null
  return {
    primary: ref.slice(0, i1),
    callId: ref.slice(i1 + 1, i2),
    fromTag: ref.slice(i2 + 1),
  }
}

/**
 * Compute the flat list of index keys associated with a call.
 *
 * Mirrors the wire format `CallState` uses when persisting via
 * `PartitionedRelayStorage.putCall(role, owner, callRef, json,
 * indexes, ttl)`: each index key is `idx:{key}` on the wire, with
 * the `key` returned here. The list covers every leg-tag pair, every
 * b-leg call-id, every dialog's remote tag, and the optional callback
 * context.
 *
 * Used by both `CallState.flushToRedis` (write path) and
 * `ReclaimRunner` (copy-into-local on recovery, slice 6) so the two
 * stay in lock-step. Pure over the Call shape; safe to call on any
 * decoded snapshot.
 */
export function callIndexKeys(call: Call): Array<string> {
  const keys: Array<string> = [`leg:${call.aLeg.callId}|${call.aLeg.fromTag}`]
  for (const bLeg of call.bLegs) {
    keys.push(`leg:${bLeg.callId}|${bLeg.fromTag}`)
    keys.push(`leg:${bLeg.callId}`)
    for (const dialog of bLeg.dialogs) {
      const bTag = dialog.sip.remoteTag
      if (bTag) keys.push(`leg:${bLeg.callId}|${bTag}`)
    }
  }
  if (call.callbackContext !== undefined) {
    keys.push(`ctx:${call.callbackContext}`)
  }
  return keys
}

/**
 * Best-effort structural extraction of `callIndexKeys` from an opaque
 * JSON-decoded call body. Used by the replication puller to reconstruct
 * the `idx:*` set from a streamed `bak:` body without coupling the
 * puller to the full `Call` schema decode (the puller is intentionally
 * schema-tolerant — see `ReplPuller`).
 *
 * Walks exactly the same field path as `callIndexKeys` above. Missing
 * or wrong-typed fields are skipped silently; the worst case is an
 * empty key list, which leaves the bak-side `idx:` partition unstamped
 * for that entry — same as the pre-fix behaviour. A correctly-shaped
 * `Call` JSON always produces the identical key set as `callIndexKeys`,
 * which is the property `docs/replication/call-cache-backup.md` §4.1
 * relies on for cross-partition lookup.
 */
export function callIndexKeysFromUnknown(state: unknown): Array<string> {
  if (state === null || typeof state !== "object") return []
  const c = state as Record<string, unknown>
  const keys: Array<string> = []

  const aLeg = c["aLeg"]
  if (aLeg !== null && typeof aLeg === "object") {
    const aL = aLeg as Record<string, unknown>
    const callId = aL["callId"]
    const fromTag = aL["fromTag"]
    if (typeof callId === "string" && typeof fromTag === "string") {
      keys.push(`leg:${callId}|${fromTag}`)
    }
  }

  const bLegs = c["bLegs"]
  if (Array.isArray(bLegs)) {
    for (const b of bLegs) {
      if (b === null || typeof b !== "object") continue
      const bL = b as Record<string, unknown>
      const bCallId = bL["callId"]
      const bFromTag = bL["fromTag"]
      if (typeof bCallId === "string" && typeof bFromTag === "string") {
        keys.push(`leg:${bCallId}|${bFromTag}`)
      }
      if (typeof bCallId === "string") {
        keys.push(`leg:${bCallId}`)
      }
      const dialogs = bL["dialogs"]
      if (Array.isArray(dialogs) && typeof bCallId === "string") {
        for (const d of dialogs) {
          if (d === null || typeof d !== "object") continue
          const sip = (d as Record<string, unknown>)["sip"]
          if (sip !== null && typeof sip === "object") {
            const remoteTag = (sip as Record<string, unknown>)["remoteTag"]
            if (typeof remoteTag === "string" && remoteTag.length > 0) {
              keys.push(`leg:${bCallId}|${remoteTag}`)
            }
          }
        }
      }
    }
  }

  const callbackContext = c["callbackContext"]
  if (typeof callbackContext === "string") {
    keys.push(`ctx:${callbackContext}`)
  }
  return keys
}

/** Parameters the dialog constructors need from the enclosing leg. */
export interface MakeDialogLegCtx {
  readonly callId: string
  readonly localUri: string
  readonly remoteUri: string
  readonly localTag: string
  readonly remoteTag: string
}

/** Build the initial empty dialog stub with a random initial CSeq. */
export function makeEmptyDialog(leg: MakeDialogLegCtx): Dialog {
  return {
    sip: {
      callId: leg.callId,
      localTag: leg.localTag,
      remoteTag: leg.remoteTag,
      localUri: leg.localUri,
      remoteUri: leg.remoteUri,
      remoteTarget: "",
      localCSeq: randomInitialCSeq(),
      routeSet: [],
    },
    ext: {
      remoteCSeq: null,
      inboundPendingRequests: [],
    },
  }
}

/**
 * Build a dialog initialized from a received request's CSeq.
 * Used for the a-leg dialog where we know Alice's CSeq from her INVITE.
 *
 * `routeSet` carries the dialog-creating request's `Record-Route`
 * headers **in order** — RFC 3261 §12.1.1 (UAS dialog construction).
 * The B2BUA is the UAS on the a-leg, so any worker-originated A-leg
 * in-dialog request (BYE relayed from b-side, worker-initiated UPDATE,
 * etc.) must traverse this route set to reach Alice through the
 * upstream front proxy. Defaults to `[]` for callers that don't have
 * a request to pull headers from.
 */
export function makeDialogFromIncoming(
  leg: MakeDialogLegCtx,
  remoteCSeq: number,
  routeSet: ReadonlyArray<string> = []
): Dialog {
  return {
    sip: {
      callId: leg.callId,
      localTag: leg.localTag,
      remoteTag: leg.remoteTag,
      localUri: leg.localUri,
      remoteUri: leg.remoteUri,
      remoteTarget: "",
      localCSeq: randomInitialCSeq(),
      routeSet,
    },
    ext: {
      remoteCSeq,
      inboundPendingRequests: [],
    },
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

/**
 * Update a specific dialog within a leg, identified by its "identity tag".
 *
 * Identity tag semantics (see `matchDialogIdentity`):
 *   - a-leg: the B2BUA's pinned tag → matches `sip.localTag`
 *   - b-leg: the peer's tag (was `dialog.toTag`) → matches `sip.remoteTag`
 */
export function updateDialog(
  call: Call,
  legId: string,
  identityTag: string,
  fn: (dialog: Dialog) => Dialog
): Call {
  return updateLeg(call, legId, (leg) => ({
    ...leg,
    dialogs: leg.dialogs.map((d) => matchDialogIdentity(legId, identityTag, d) ? fn(d) : d)
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
export function bumpLocalCSeq(call: Call, legId: string, identityTag: string, delta: number = 1): Call {
  return updateDialog(call, legId, identityTag, (d) => ({
    ...d,
    sip: { ...d.sip, localCSeq: d.sip.localCSeq + delta },
  }))
}

/**
 * Update the remoteCSeq on a dialog (track the other side's latest CSeq).
 */
export function updateRemoteCSeq(call: Call, legId: string, identityTag: string, remoteCSeq: number): Call {
  return updateDialog(call, legId, identityTag, (d) => ({
    ...d,
    ext: { ...d.ext, remoteCSeq },
  }))
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
export function addPendingRequest(call: Call, legId: string, identityTag: string, entry: PendingRequest): Call {
  return updateDialog(call, legId, identityTag, (d) => ({
    ...d,
    ext: { ...d.ext, inboundPendingRequests: [...d.ext.inboundPendingRequests, entry] },
  }))
}

/** Find a pending transparent-relay entry by outbound CSeq. */
export function findPendingRequest(dialog: Dialog, outboundCSeq: number): PendingRequest | undefined {
  return dialog.ext.inboundPendingRequests.find((p) => p.outboundCSeq === outboundCSeq)
}

/** Remove a pending transparent-relay entry after its response is handled. */
export function removePendingRequest(call: Call, legId: string, identityTag: string, outboundCSeq: number): Call {
  return updateDialog(call, legId, identityTag, (d) => ({
    ...d,
    ext: {
      ...d.ext,
      inboundPendingRequests: d.ext.inboundPendingRequests.filter((p) => p.outboundCSeq !== outboundCSeq),
    },
  }))
}

// ── Leg tag helpers ───────────────────────────────────────────────────────
//
// After the StackDialog reshape, both sides of the asymmetry live on the
// dialog itself (`sip.localTag` / `sip.remoteTag`). These helpers survive
// as thin shortcuts over the first dialog.

/** Returns the B2BUA's own tag for a given leg (sip.localTag of dialogs[0]). */
export function b2buaTag(call: Call, legId: string): string | undefined {
  if (legId === "a") {
    return call.aLeg.dialogs[0]?.sip.localTag
  }
  const bLeg = findBLeg(call, legId)
  return bLeg?.dialogs[0]?.sip.localTag ?? bLeg?.fromTag
}

/** Returns the remote party's tag for a given leg (sip.remoteTag of dialogs[0]). */
export function remoteTag(call: Call, legId: string): string | undefined {
  if (legId === "a") {
    return call.aLeg.dialogs[0]?.sip.remoteTag ?? call.aLeg.fromTag
  }
  const bLeg = findBLeg(call, legId)
  return bLeg?.dialogs[0]?.sip.remoteTag
}

// ── Tag mapping helpers ───────────────────────────────────────────────────

/**
 * Add a tag mapping entry, keyed by (bLegId, bTag). If a mapping with the
 * same (bLegId, bTag) is already present the call is returned unchanged —
 * the tagMap is a dialog-identity index, duplicate rows would break
 * findByATag / findByBTag lookups.
 */
export function addTagMapping(call: Call, mapping: TagMapping): Call {
  const exists = call.tagMap.some(
    (m) => m.bLegId === mapping.bLegId && m.bTag === mapping.bTag,
  )
  if (exists) return call
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

/**
 * Extract the CSeq number from the retained a-leg INVITE.
 * Responses and in-dialog requests targeting alice echo this number
 * (RFC 3261 §8.1.3.3 / §13.2.2.4).
 */
export function aLegInviteCSeqNum(call: Call): number {
  const headers = call.aLegInvite.headers
  for (const h of headers) {
    if (h.name.toLowerCase() === "cseq") {
      const n = parseInt(h.value, 10)
      if (Number.isFinite(n)) return n
    }
  }
  return 1
}
