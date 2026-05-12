/**
 * Rule system type definitions for the INAP-inspired B2BUA framework.
 *
 * Rules are high-level event interceptors that express decisions
 * (relay, reject, create leg, merge, split) — not SIP message construction.
 * The ActionExecutor translates rule actions into SIP messages and call state updates.
 */

import type { Effect, Schema } from "effect"
import type {
  SipRequest,
  SipResponse,
  RemoteInfo,
  InDialogMethodRequest,
  MethodRequest,
  SipResponseTagged,
  ParsedCSeqField,
} from "../../../sip/types.js"
import type { Call, CallModelState, Leg, LegState, LegDisposition, Dialog, CdrEventType, TimerType, TransferPhase, TransferState } from "../../../call/CallModel.js"
import type { AppConfigData } from "../../../config/AppConfig.js"
import type { CallEvent } from "../../../sip/SipRouter.js"
import type { CallDecisionEngine } from "../../../decision/CallDecisionEngine.js"
import type { CallLimiter } from "../../../call/CallLimiter.js"
import type { CallReferRequest as CallReferRequestType } from "../../../decision/schemas/requests.js"
import type { BodyUpdate, HeaderUpdates, RuriOp } from "./actions/types.js"

// ── Declarative match schema (reified predicates) ─────────────────────────
//
// Every rule declares a `match` object. Columns are discriminated by event
// kind; the Matcher picks the strictly-most-specific rule at runtime, and
// the RuleRegistry validates shadowing at startup. See
// docs/AdvancedCallModel.md for the full design and column semantics.

/** SIP methods the B2BUA discriminates on in rule matching. */
export type SipMethod =
  | "INVITE" | "ACK" | "BYE" | "CANCEL" | "OPTIONS"
  | "INFO" | "PRACK" | "UPDATE" | "REFER" | "MESSAGE" | "NOTIFY" | "SUBSCRIBE"

/** SIP status-class buckets. */
export type StatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "6xx"

/** Direction an event arrived from. */
export type Direction = "from-a" | "from-b"

/** Singleton or array form for enum columns. */
type OneOrMany<T> = T | ReadonlyArray<T>

/**
 * Post-match corner-case predicate. Pure, sync, reads only RuleContext state.
 *
 * Generic over the Match shape so each match interface declares its filter as
 * `MatchFilter<RequestMatch>` etc. — the matcher only invokes the filter after
 * `columnMatches` has verified the event kind, so per-shape narrowing is sound.
 * The wide-default `M = Match` form is the historical signature and remains
 * usable for filters that don't care about narrowing.
 */
export type MatchFilter<M extends Match = Match> = (ctx: RuleContext<M>) => boolean

/**
 * Transfer-phase gate.
 *
 * Rules opt into a TransferPhase to express that they should only match while
 * the call's `transfer.phase` is in a particular state (or set of states).
 *
 * - `undefined` (omitted): rule runs regardless of transfer state — the
 *   normal case for default rules that know nothing about REFER.
 * - `null` (or array containing `null`): rule requires `call.transfer` to be
 *   absent/cleared. Use this to assert "non-transfer" when necessary.
 * - phase literal(s): rule only fires when `call.transfer?.phase` is one of
 *   the listed phases.
 */
export type TransferPhaseGate =
  | TransferPhase
  | ReadonlyArray<TransferPhase | null>
  | null

/** Match descriptor for an inbound SIP request. */
export interface RequestMatch {
  readonly kind: "request"
  /** Omitted = match any method. */
  readonly method?: OneOrMany<SipMethod>
  readonly callState?: OneOrMany<CallModelState>
  readonly legState?: OneOrMany<LegState>
  readonly legDisposition?: OneOrMany<LegDisposition>
  readonly direction?: Direction
  readonly transferPhase?: TransferPhaseGate
  readonly filter?: MatchFilter<RequestMatch>
}

/** Match descriptor for an inbound SIP response. */
export interface ResponseMatch {
  readonly kind: "response"
  /** Omitted = match any CSeq method. */
  readonly cseqMethod?: OneOrMany<SipMethod>
  /** Exact SIP status code. Mutually exclusive with statusClass. */
  readonly status?: number
  /** One or more status classes. Mutually exclusive with status. */
  readonly statusClass?: OneOrMany<StatusClass>
  readonly callState?: OneOrMany<CallModelState>
  readonly legState?: OneOrMany<LegState>
  readonly legDisposition?: OneOrMany<LegDisposition>
  readonly direction?: Direction
  readonly transferPhase?: TransferPhaseGate
  readonly filter?: MatchFilter<ResponseMatch>
}

/** Match descriptor for a background timer firing. */
export interface TimerMatch {
  readonly kind: "timer"
  /** Omitted = match any timer type. */
  readonly timerType?: OneOrMany<TimerType>
  readonly callState?: OneOrMany<CallModelState>
  readonly transferPhase?: TransferPhaseGate
  readonly filter?: MatchFilter<TimerMatch>
}

/** Match descriptor for transaction timeouts (Timer B/F expiry). */
export interface TimeoutMatch {
  readonly kind: "timeout"
  readonly method?: OneOrMany<SipMethod>
  readonly callState?: OneOrMany<CallModelState>
  readonly transferPhase?: TransferPhaseGate
  readonly filter?: MatchFilter<TimeoutMatch>
}

/** Match descriptor for CANCEL-of-initial-INVITE signal (from a-leg). */
export interface CancelledMatch {
  readonly kind: "cancelled"
  readonly callState?: OneOrMany<CallModelState>
  readonly transferPhase?: TransferPhaseGate
  readonly filter?: MatchFilter<CancelledMatch>
}

/**
 * Match descriptor for synthetic in-process events (e.g. async HTTP result
 * from /call/refer). Rules discriminate by `topic` + `outcome` and may
 * additionally gate by transfer phase.
 */
export interface InternalEventMatch {
  readonly kind: "internal-event"
  /** Omitted = match any topic. */
  readonly topic?: OneOrMany<string>
  /** Omitted = match any outcome. */
  readonly outcome?: OneOrMany<string>
  readonly callState?: OneOrMany<CallModelState>
  readonly transferPhase?: TransferPhaseGate
  readonly filter?: MatchFilter<InternalEventMatch>
}

/** Declarative match descriptor. Replaces imperative matches(). */
export type Match =
  | RequestMatch
  | ResponseMatch
  | TimerMatch
  | TimeoutMatch
  | CancelledMatch
  | InternalEventMatch

// ── Type-level projections from Match → narrowed RuleContext ──────────────
//
// These conditional types map a rule's declarative `match` descriptor into
// the static guarantees its handler can rely on. The narrowing is purely
// type-level — at runtime the dispatcher hands the rule the same wide
// `RuleContext` value, but the dispatcher has already verified the runtime
// invariants the conditional types depend on (kind, direction, transferPhase,
// legState, callState gates), so the assertion is sound.
//
// See docs/AdvancedCallModel.md "Match-driven RuleContext narrowing".

/** Pull a single literal out of `T | ReadonlyArray<T>`-shaped match fields. */
type Singleton<T> = T extends ReadonlyArray<infer U> ? U : T

/**
 * `true` when the request match-criteria imply an in-dialog (confirmed-leg)
 * request — i.e. the router will only route to this rule after matching the
 * incoming request to an existing confirmed dialog. RFC 3261 §12.2 then
 * guarantees both From-tag and To-tag.
 */
type IsInDialogRequest<M extends RequestMatch> =
    M extends { readonly legState: "confirmed" } ? true
  : M extends { readonly legState: ReadonlyArray<infer LS> } ? "confirmed" extends LS ? true : false
  : M extends { readonly transferPhase: TransferPhase } ? true
  : M extends { readonly transferPhase: ReadonlyArray<infer P> }
      ? P extends TransferPhase ? true : false
  : M extends { readonly callState: "bridged" } ? true
  : false

/** Extract a SIP-method literal from a `RequestMatch.method` gate, or fall back to the wide union. */
type MethodFor<M extends RequestMatch> =
  Singleton<M["method"]> extends infer Mt
    ? Mt extends SipMethod ? Mt : SipMethod
    : SipMethod

/** Extract a SIP-method literal from a `ResponseMatch.cseqMethod` gate, or fall back. */
type CseqMethodFor<M extends ResponseMatch> =
  Singleton<M["cseqMethod"]> extends infer Mt
    ? Mt extends SipMethod ? Mt : SipMethod
    : SipMethod

/** Narrow the inbound request type from a `RequestMatch`. */
type RequestMessageFor<M extends RequestMatch> =
  IsInDialogRequest<M> extends true
    ? InDialogMethodRequest<MethodFor<M>>
    : MethodRequest<MethodFor<M>>

/** Narrow the inbound response type from a `ResponseMatch`. */
type ResponseMessageFor<M extends ResponseMatch> =
  CseqMethodFor<M> extends infer Mt extends SipMethod
    ? SipResponseTagged & {
        getHeader(name: "cseq"): ParsedCSeqField & { readonly method: Mt }
      }
    : SipResponseTagged

/** Narrow `ctx.event` from any `Match`. The tuple-wrap on the wide guard
 *  prevents distribution so `EventFor<Match>` reduces back to `CallEvent`. */
export type EventFor<M extends Match> =
    [Match] extends [M] ? CallEvent
  : M extends RequestMatch
      ? { readonly type: "sip"; readonly message: RequestMessageFor<M>; readonly rinfo: RemoteInfo }
  : M extends ResponseMatch
      ? { readonly type: "sip"; readonly message: ResponseMessageFor<M>; readonly rinfo: RemoteInfo }
  : M extends TimerMatch
      ? Extract<CallEvent, { type: "timer" }>
  : M extends TimeoutMatch
      ? Extract<CallEvent, { type: "timeout" }>
  : M extends CancelledMatch
      ? Extract<CallEvent, { type: "cancelled" }>
  : M extends InternalEventMatch
      ? Extract<CallEvent, { type: "internal-event" }>
  : CallEvent

/** Narrow `ctx.direction` from a `RequestMatch` / `ResponseMatch` gate. */
export type DirectionFor<M extends Match> =
  [Match] extends [M] ? Direction
    : M extends { readonly direction: infer D } ? D extends Direction ? D : Direction : Direction

/**
 * Narrow `ctx.call.transfer` from `Match.transferPhase`.
 *
 * - `transferPhase: null`              → transfer is `null | undefined`
 * - `transferPhase: <TransferPhase>`   → transfer non-null, `phase` literal-narrowed
 * - `transferPhase: ReadonlyArray<…>`  → transfer non-null, `phase` is the union
 * - omitted                             → transfer stays at the wide type
 */
export type TransferFor<M extends Match> =
    M extends { readonly transferPhase: null } ? null | undefined
  : M extends { readonly transferPhase: infer P }
      ? P extends TransferPhase
          ? Omit<TransferState, "phase"> & { readonly phase: P }
      : P extends ReadonlyArray<infer Q>
          ? Q extends TransferPhase
              ? Omit<TransferState, "phase"> & { readonly phase: Q }
              : TransferState | null | undefined
          : TransferState | null | undefined
  : TransferState | null | undefined

/** Narrow `ctx.call.state` from `Match.callState`. */
type CallStateFor<M extends Match> =
  M extends { readonly callState: infer S }
    ? Singleton<S> extends infer S2
        ? S2 extends CallModelState ? S2 : CallModelState
        : CallModelState
    : CallModelState

/**
 * Narrow `ctx.call`. The wide-case guard makes `CallFor<Match>` reduce back to
 * `Call` (preserving `transfer?` optionality and `state` width); only specific
 * matches synthesize the narrowed shape.
 */
export type CallFor<M extends Match> =
  [Match] extends [M]
    ? Call
    : Omit<Call, "transfer" | "state"> & {
        readonly transfer: TransferFor<M>
        readonly state: CallStateFor<M>
      }

/** Narrow `ctx.sourceDialog` — non-undefined when the match implies a confirmed dialog. */
export type DialogFor<M extends Match> =
  [Match] extends [M] ? Dialog | undefined
    : M extends RequestMatch
        ? IsInDialogRequest<M> extends true ? Dialog : Dialog | undefined
        : Dialog | undefined

// ── Rule context (what rules see) ──────────────────────────────────────────

/**
 * Read-only context passed to rule handlers.
 *
 * Generic over the rule's `Match` so that handlers see exactly the guarantees
 * the dispatcher already enforces — no defensive `if (event.type !== "sip")`
 * guards in the body. `RuleContext` (no parameter) is the wide form, used by
 * legacy rules that take any event.
 *
 * Peer resolution is intentionally NOT included — `activePeer` is null during
 * early dialog (before confirm-dialog/merge), making any eagerly-resolved
 * `peer` field unreliable. Rules that need the peer should emit
 * `relay-to-peer` and let ActionExecutor resolve the target with its richer
 * fallback logic (tagMap, single-b-leg fallback, etc.).
 */
export interface RuleContext<TMatch extends Match = Match> {
  /** Full call state — narrowed transfer / state when match-criteria imply it. */
  readonly call: CallFor<TMatch>
  /** Deterministic call reference (callId|fromTag). */
  readonly callRef: string
  /** The event being processed — narrowed to the kind declared by `match.kind`. */
  readonly event: EventFor<TMatch>
  /** Which leg the event came from. */
  readonly sourceLeg: Leg
  /** Dialog on the source leg — non-undefined when `match` implies a confirmed dialog. */
  readonly sourceDialog: DialogFor<TMatch>
  /** Direction from which the event arrived — literal-narrowed when `match.direction` is set. */
  readonly direction: DirectionFor<TMatch>
  /** App configuration. */
  readonly config: AppConfigData
  /** Canonical call-decision engine for routing / failure / refer decisions. */
  readonly callControl: CallDecisionEngine["Service"]
  /** Call limiter service. */
  readonly limiter: CallLimiter["Service"]
  /** Wall-clock-equivalent timestamp (from Effect Clock). */
  readonly nowMs: number
}

// ── Message transform ──────────────────────────────────────────────────────

/**
 * Transform applied to a message during relay (e.g., 183→200 conversion).
 *
 * Header and body mutations go through the typed ADT shapes (`HeaderUpdates`,
 * `BodyUpdate`) so the executor can share the same `applyHeaderUpdates` /
 * `applyBodyUpdate` helpers used by `create-leg`. Rules build these via the
 * factories in `./actions/factories.ts`.
 */
export interface MessageTransform {
  /** Override response status code (e.g., 183 → 200). */
  readonly status?: number
  /** Override reason phrase. */
  readonly reason?: string
  /** Typed header mutation — replace/remove per header name. */
  readonly headerUpdates?: HeaderUpdates
  /** Typed body mutation — inherit/set/drop. */
  readonly bodyUpdate?: BodyUpdate
}

// ── Rule actions (what rules can do) ───────────────────────────────────────

/** Destination for leg creation. */
export interface LegDestination {
  readonly host: string
  readonly port?: number
  readonly transport?: string
}

export type RuleAction =
  // ── Message relay (framework handles CSeq, tags, Via, Contact) ──
  | { readonly type: "relay-to-peer"; readonly transform?: MessageTransform }
  | { readonly type: "relay-to-leg"; readonly legId: string; readonly transform?: MessageTransform }
  | { readonly type: "respond"; readonly status: number; readonly reason?: string;
      /** Optional response body (e.g. SDP answer for a locally-handled UPDATE). */
      readonly body?: Uint8Array;
      /** Required when `body` is set. Stamped as `Content-Type`. */
      readonly contentType?: string }
  | { readonly type: "ack-leg"; readonly legId: string }

  // ── Generate new request to a leg (keepalive OPTIONS, INFO, etc.) ──
  | { readonly type: "send-request-to-leg"; readonly legId: string; readonly method: string;
      readonly body?: Uint8Array }

  // ── Synthesize a PRACK toward a leg in response to a reliable 1xx we
  // received but are not relaying to the peer (RFC 3262 §3-4). Uses the
  // leg's early dialog (toTag from the reliable 1xx) to build the PRACK. ──
  | { readonly type: "send-prack-to-leg"; readonly legId: string;
      readonly rseq: number; readonly inviteCSeq: number; readonly bTag: string }

  // ── Cache an SDP body on a specific b-leg dialog (identified by bTag) so
  // that the 200 OK INVITE relay path can substitute it when forwarding to
  // alice. Used by the `relayFirst18xTo180` `fake-prack` strategy to capture
  // bob's reliable-1xx SDP answer or UPDATE re-offer per dialog without
  // exposing it to alice prematurely. ──
  | { readonly type: "cache-sdp-on-leg-dialog";
      readonly legId: string;
      readonly bTag: string;
      readonly body: Uint8Array }

  // ── Set call.policyUpdateBody — generic body override applied by the
  // response relay path on the next 200 OK INVITE toward alice. The
  // `fake-prack` rule writes the cached b-leg SDP here so alice sees the
  // negotiated answer at confirmation time. `null` means "force empty body". ──
  | { readonly type: "set-policy-update-body";
      readonly body: Uint8Array | null }

  // ── Dialog lifecycle primitives (Slice B of the rule-framework refactor) ──
  //
  // The old composite `confirm-dialog` has been decomposed into three
  // single-reach primitives plus the existing `add-tag-mapping`. Rules that
  // want the old "confirm source + sync a-leg" behaviour compose them via
  // `confirmBridgedCall(...)` from `./actions/composites.ts`.
  //
  // Reach discipline (see AdvancedCallModel.md §"Action reach"):
  //   - confirm-dialog    → legs.{legId}.dialogs[0]
  //   - update-leg-state  → legs.{legId}.state + .disposition
  //   - stamp-dialog-to-tag → legs.{legId}.dialogs[0].toTag (creates dialog[0] if absent)
  //   - add-tag-mapping   → tagMap
  | {
      /**
       * Confirm the named leg's dialog using the current SIP *response* event.
       * Reads Contact + Record-Route + CSeq from ctx.event and writes them
       * onto dialog[0]; creates dialog[0] from the response toTag when the
       * leg has no dialog or only a placeholder (toTag === "") entry.
       *
       * Scope is narrow: this action does NOT touch leg.state, leg.disposition,
       * the tagMap, or any other leg's dialog. For the full A↔B bridging
       * sequence (b-leg dialog + a-leg state + tag mapping), use the
       * `confirmBridgedCall(...)` composite helper.
       *
       * Must be emitted while ctx.event.type === "sip" and the message is a
       * response; otherwise the action is a no-op.
       */
      readonly type: "confirm-dialog"
      readonly legId: string
    }
  | {
      /**
       * Set `leg.state` (and optionally `leg.disposition`) on the named leg.
       * Generic leg-lifecycle primitive; reach is exactly the two fields
       * named in its parameters.
       */
      readonly type: "update-leg-state"
      readonly legId: string
      readonly state: import("../../../call/CallModel.js").LegState
      readonly disposition?: import("../../../call/CallModel.js").LegDisposition
    }
  | {
      /**
       * Stamp an explicit toTag onto the named leg's dialog[0]. Used on the
       * a-leg (UAS side) when the B2BUA picks the a-facing tag at 200-OK
       * time and needs to align the a-leg dialog with it.
       *
       * Creates dialog[0] when the leg has no dialogs:
       *   - legId === "a" → makeDialogFromIncoming(toTag, aLegInviteCSeqNum(call))
       *   - other legs    → makeEmptyDialog(toTag)
       *
       * Does not touch leg.state, leg.disposition, or tagMap.
       */
      readonly type: "stamp-dialog-to-tag"
      readonly legId: string
      readonly toTag: string
    }

  // ── Leg lifecycle ──
  //
  // Body / headers / Request-URI mutations go through the typed ADT slots
  // (`bodyUpdate`, `headerUpdates`, `ruri` — see `./actions/types.ts`).
  // Rules build these via `./actions/factories.ts` and read source values
  // via `./actions/readers.ts`.
  | {
      readonly type: "create-leg"
      readonly destination: LegDestination
      /** "snapshot" = use call.aLegInvite; or provide a specific SipRequest. */
      readonly fromInvite?: "snapshot" | SipRequest
      readonly noAnswerTimeoutSec?: number
      /** Propagate callback_context from failover response for subsequent failovers. */
      readonly callbackContext?: string
      /** Typed body mutation for the cloned base INVITE (inherit/set/drop). */
      readonly bodyUpdate?: BodyUpdate
      /** Typed header mutations layered on the outbound INVITE. */
      readonly headerUpdates?: HeaderUpdates
      /** Typed Request-URI operation (inherit — default — or set BareSipUri). */
      readonly ruri?: RuriOp
    }
  | {
      /**
       * Destroy a single leg by sending the appropriate teardown SIP message
       * (BYE for `confirmed`, CANCEL for `trying`/`early`, nothing for a leg
       * that is already `cancelling`) and marking the leg terminated.
       *
       * Reach (Slice C audit — intentional call-scope composite):
       *   legs.{legId}.state        → "terminated" (always)
       *   legs.{legId}.byeDisposition → "bye_sent" | "cancelled"
       *   legs.{legId}.disposition  → "cancelling" (trying/early path only)
       *   call.activePeer           → null, when `legId` is part of the
       *                                current pair — this is structural: a
       *                                destroyed leg cannot remain peered,
       *                                and the semantics of "destroy" include
       *                                breaking its peer pair. Unlike the
       *                                confirm-dialog hidden reach (Slice B),
       *                                this peer-split is declared in the
       *                                action's contract rather than hidden.
       *
       * Prefer `cancel-leg` for trying/early legs when you need the leg to
       * stay alive long enough to resolve a CANCEL/200 crossing race
       * (RFC 3261 §9.1).
       */
      readonly type: "destroy-leg"
      readonly legId: string
    }

  | {
      /**
       * Send CANCEL for an outstanding early/trying b-leg INVITE but KEEP the
       * leg alive. Sets `leg.disposition = "cancelling"` so subsequent rules
       * resolve the leg when bob responds:
       *   - Final non-2xx (e.g. 487) → resolve-cancel-response terminates the leg.
       *   - Crossing 2xx            → cancel-200-crossing ACKs and BYEs (RFC 3261 §9.1).
       *
       * Reach (Slice C audit — primitive, no hidden reach):
       *   legs.{legId}.disposition → "cancelling"
       *
       * No state change on any other leg; no call-level mutation; no
       * byeDisposition change (that is deliberately deferred to the
       * cancel-resolving rule). For confirmed legs, use `destroy-leg` (BYE).
       */
      readonly type: "cancel-leg"
      readonly legId: string
    }

  // ── Peering (INAP split/merge) ──
  //
  // Reach (Slice C audit — both primitive):
  //   merge(legA, legB) → call.activePeer = { legA, legB } (both named)
  //   split(legId)      → call.activePeer = null when legId is part of the
  //                        current pair. The structural consequence of
  //                        un-peering the other side is inherent to the
  //                        singleton `activePeer` — both legs are implied
  //                        by the pair, even though only one is named.
  | { readonly type: "merge"; readonly legA: string; readonly legB: string }
  | { readonly type: "split"; readonly legId: string }

  // ── Timers ──
  | { readonly type: "schedule-timer"; readonly timerType: TimerType;
      readonly delaySec: number; readonly legId?: string }
  | { readonly type: "cancel-timer"; readonly timerId: string }
  | { readonly type: "cancel-all-timers" }

  // ── Call lifecycle ──
  | {
      /**
       * Immediate call death — reserved for pre-dialog failures where no
       * confirmed legs exist and no BYE exchange is needed. Marks every leg
       * `terminated`, sets `call.state = "terminated"`, clears `activePeer`.
       *
       * Reach (Slice C audit — intentional call-scope composite):
       *   Every leg: state → "terminated"
       *   call.state        → "terminated"
       *   call.activePeer   → null
       *   Outbound          → one BYE per confirmed leg, one CANCEL per
       *                        trying/early b-leg (best-effort; no wait for
       *                        transaction-level confirmation — that is what
       *                        distinguishes this from `begin-termination`).
       *
       * All production rules should prefer `begin-termination` so the
       * framework can observe BYE/CANCEL responses and schedule the safety
       * timer. `terminate-call` exists for onError:"terminate" fallout.
       */
      readonly type: "terminate-call"
    }
  | {
      /**
       * Graceful call termination — sends BYE/CANCEL to all live legs, sets
       * byeDisposition: "bye_sent", transitions call to "terminating", and
       * schedules a 64s safety timer.
       *
       * Reach (Slice C audit — intentional call-scope composite):
       *   For each live leg (not terminated, no byeDisposition, not cancelling):
       *     - confirmed       → send BYE; byeDisposition = "bye_sent"
       *     - trying/early b  → send CANCEL; byeDisposition = "cancelled";
       *                          state = "terminated"
       *     - trying/early a  → byeDisposition = "none" (rule already
       *                          handled the SIP reply)
       *   call.state        → "terminating"
       *   call.timers       → append `terminating_timeout-{callRef}` (64s)
       *   effects           → cancel-all-timers, schedule-timer (safety),
       *                        write-cdr, flush-redis
       *
       * Scope IS the call — this is deliberately a composite. Rules that
       * need to skip one leg (because they already resolved it) MUST
       * pre-mark it via `terminate-leg` with the appropriate byeDisposition
       * before emitting `begin-termination`. If all legs are already
       * resolved, the framework transitions straight to `"terminated"`
       * via `isFullyResolved()` — same code path, no special case.
       *
       * The call holds its limiter slot and stays in memory/Redis during the
       * "terminating" phase. Framework (InvariantEnforcer) handles cleanup
       * only after all legs reach a terminal byeDisposition and the call
       * transitions to "terminated".
       *
       * `reason` (optional) — RFC 3326 Reason header value stamped on every
       * BYE this composite emits. Pass it when the teardown carries a
       * meaningful upstream cause (e.g. `SIP;cause=503;text="..."` after
       * b's failure post-promote, or `SIP;cause=488;text="resync-failed"`
       * after the resync re-INVITE was rejected). The value is forwarded
       * verbatim — callers must format it per RFC 3326.
       */
      readonly type: "begin-termination"
      readonly reason?: string
    }
  | {
      /**
       * Mark a single leg as terminated, optionally setting its byeDisposition.
       * Use this to pre-mark legs before begin-termination so they're skipped
       * during the graceful teardown (e.g., the leg that sent us a BYE is
       * already resolved — mark it "bye_received" before begin-termination).
       *
       * Reach (Slice C audit — primitive, no hidden reach):
       *   legs.{legId}.state          → "terminated"
       *   legs.{legId}.byeDisposition → action.byeDisposition (only when set)
       *
       * No outbound message; no call-level mutation; no peer touch. The
       * framework will auto-promote the call to "terminated" via
       * isFullyResolved() once all legs reach a terminal disposition.
       */
      readonly type: "terminate-leg"
      readonly legId: string
      readonly byeDisposition?: import("../../../call/CallModel.js").ByeDisposition
    }

  // ── CDR ──
  | { readonly type: "add-cdr-event"; readonly eventType: CdrEventType;
      readonly legId: string; readonly statusCode?: number; readonly reason?: string }

  // ── Rule state ──
  | { readonly type: "deactivate-rule" }

  // ── Tag mapping (pre-seed before composed rule, e.g. force tag on 200 OK) ──
  | { readonly type: "add-tag-mapping";
      readonly aTag: string; readonly bLegId: string; readonly bTag: string }

  // ── Escape hatch (NOTIFY body, custom messages) ──
  | { readonly type: "send-raw"; readonly message: SipRequest | SipResponse;
      readonly destination: RemoteInfo; readonly label: string }

  // ── REFER subscription NOTIFY (structured) ──
  // Builds a NOTIFY on the target leg's dialog (typically the referrer B-leg).
  // Body (if any) is passed through verbatim — REFER uses message/sipfrag
  // bodies (RFC 3420) built via SipFragUtils.
  | { readonly type: "send-notify"; readonly legId: string;
      readonly event: string; readonly subscriptionState: string;
      readonly contentType?: string; readonly body?: Uint8Array }

  // ── B2BUA-originated re-INVITE (REFER realigning flows) ──
  //
  // Emits a re-INVITE on the named leg's confirmed dialog with a chosen SDP
  // body. Framework bumps the dialog CSeq, stamps Contact/Via placeholders,
  // applies the route set, and tracks a pendingRequest so the response is
  // correlated back via findPendingRequest just like a relayed re-INVITE.
  //
  // Body / header mutations use the same typed ADT slots as `create-leg`:
  //   - bodyUpdate: BodyUpdate — `{ kind: "set", value }` for a fresh SDP
  //                 offer, `{ kind: "drop" }` for a body-less re-INVITE.
  //                 `inherit` is invalid (there is no base body to inherit
  //                 from) and is treated as drop by the executor.
  //   - headerUpdates: HeaderUpdates — optional extra headers layered onto
  //                 the outbound INVITE via replaceH/removeH factories.
  //
  // Reach (Slice C audit — primitive, single named leg):
  //   legs.{legId}.dialogs[0].localCSeq     → +1
  //   legs.{legId}.dialogs[0].pendingRequests → add { method: "INVITE", ... }
  //
  // Used by REFER transfer rules (c-realign, a-realign). Not a general
  // "re-negotiate SDP" action — that would belong in a different primitive.
  | { readonly type: "send-reinvite"; readonly legId: string;
      readonly bodyUpdate?: BodyUpdate; readonly headerUpdates?: HeaderUpdates }

  // ── REFER transfer state management ──
  // update-transfer merges onto Call.transfer (creating it if absent).
  // clear-transfer nulls Call.transfer outright (final cleanup).
  | { readonly type: "update-transfer"; readonly update: Partial<TransferState> }
  | { readonly type: "clear-transfer" }

  // ── Early-promote (promote-pem-to-200) state ──
  //
  // set-early-promote initializes (when call.earlyPromote is absent) or
  // merges onto Call.earlyPromote. The promote-pem-to-200 policy module
  // writes the SDP it sent to alice, the resync re-INVITE CSeq, and flips
  // windowOpen as alice's gate transitions.
  // clear-early-promote nulls Call.earlyPromote outright (final cleanup
  // once normal in-dialog flow resumes).
  | { readonly type: "set-early-promote"; readonly update: Partial<import("../../../call/CallModel.js").EarlyPromoteState> }
  | { readonly type: "clear-early-promote" }

  // ── Fire /call/refer; the result re-enters withCall as an internal-event ──
  | { readonly type: "refer-async-http"; readonly request: CallReferRequestType }

// ── Rule definition interface ──────────────────────────────────────────────

/** Result returned by a rule handler: a list of actions + updated state. */
export interface RuleHandleResult<TState> {
  /** Actions for the framework to execute. */
  readonly actions: ReadonlyArray<RuleAction>
  /** Updated rule state (will be serialized back into Call.ruleState). */
  readonly state: TState
}

/**
 * A rule declares its identity, what events it can intercept, and how it
 * processes them. Rules are registered once at startup; activated per-call
 * via the HTTP API response.
 *
 * TState — rule-specific state (serializable via stateSchema)
 * TParams — rule-specific configuration from HTTP response (decoded via paramsSchema)
 */
export interface RuleDefinition<TState = unknown, TParams = unknown> {
  /** Unique rule identifier (matches ActiveRule.id from HTTP response for per-call rules). */
  readonly id: string

  /**
   * If true, this rule runs on every call without per-call activation.
   * Built-in B2BUA rules (relay-bye, confirm-dialog, etc.) are always active.
   * Custom rules (REFER, MRF) are activated per-call via HTTP API.
   * Policy module rules are set to alwaysActive by createRuleRegistry.
   */
  readonly alwaysActive?: boolean

  /** Display name for logging and tracing. */
  readonly name: string

  /**
   * Shared state key for call.ruleState persistence.
   * Defaults to `id`. Rules with the same stateKey share state — used by
   * policy modules where multiple rules read/write the same typed state.
   */
  readonly stateKey?: string

  /**
   * Declarative composition — this rule runs BEFORE the named base rule.
   *
   * When handle() returns a result:
   *   1. Framework executes this rule's actions (updating working call state)
   *   2. Invokes the base rule's handle() with the modified state
   *   3. Appends the base rule's actions after this rule's actions
   *   4. The combined result claims the event (first-match-wins)
   *
   * When handle() returns undefined, the base rule runs alone.
   * The base rule is removed from the main chain to prevent double execution.
   *
   * IMPORTANT: composition only activates when this rule's guard passes AND
   * matches() returns true. When the guard fails (policy not active on this
   * call), the base rule runs normally — it is NOT consumed.
   *
   * Future: compositionMode "after" / "around" — only "before" implemented now.
   */
  readonly composesWith?: string

  /**
   * Declarative override — this rule replaces the named base rule in the
   * matcher's candidate set whenever its own match descriptor is satisfied
   * AND its policy-module guard (if any) is active. Used when a custom rule
   * has the identical match signature as a default rule (would otherwise
   * collide at registry build time) and needs to fully take over the slot.
   *
   * Example: suppress-18x overrides relay-provisional.
   */
  readonly overrides?: string

  /**
   * Declarative match descriptor. The Matcher uses this to pick the winning
   * rule by strict specificity. Required for every rule.
   */
  readonly match: Match

  /** Schema for validating/decoding rule-specific state. */
  readonly stateSchema: Schema.Schema<TState>

  /** Schema for validating/decoding rule params from HTTP response. */
  readonly paramsSchema: Schema.Schema<TParams>

  /**
   * Create initial state when the rule is first activated on a call.
   * Called once, after /call/new returns the rule in its response.
   */
  readonly init: (params: TParams, call: Call) => TState

  /**
   * Error policy when handle() throws.
   * - "passthrough": fall through to next rule / default (default)
   * - "terminate": terminate the call safely
   */
  readonly onError?: "passthrough" | "terminate"

  /**
   * Process an event. Returns:
   * - RuleHandleResult: rule consumed the event (actions + updated state)
   * - undefined: rule passes — event flows to next rule or default handler
   */
  readonly handle: (
    ctx: RuleContext,
    state: TState,
    params: TParams,
  ) => Effect.Effect<RuleHandleResult<TState> | undefined | void, never, never>
}

/**
 * Type-erased rule definition for use in collections and registries.
 * Individual rules are fully typed via RuleDefinition<TState, TParams>;
 * this alias is used when storing heterogeneous rules together.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRuleDefinition = RuleDefinition<any, any>

// ── Match-aware factory ────────────────────────────────────────────────────

/**
 * Define a rule with a `match`-narrowed handler context.
 *
 * `defineRule` infers `TMatch` from the literal `match` value, so the handler's
 * `ctx` is typed as `RuleContext<TMatch>` — narrowed event, message, direction,
 * call.transfer, sourceDialog all derived from the match-criteria. The result
 * is a plain `RuleDefinition<TState, TParams>` (handler context erased to the
 * wide form) which the dispatcher invokes via the same code path as legacy
 * rules; the cast is sound because the dispatcher only invokes the handler
 * after the matcher has verified `match` against the runtime event.
 *
 * Example:
 * ```ts
 * export const referInterceptRule = defineRule({
 *   id: "transfer-intercept-refer",
 *   name: "Transfer intercept REFER",
 *   match: {
 *     kind: "request", method: "REFER", direction: "from-b",
 *     callState: "bridged", transferPhase: null,
 *   },
 *   stateSchema: Schema.Undefined,
 *   paramsSchema: Schema.Undefined,
 *   init: () => undefined,
 *   handle: (ctx) => Effect.sync(() => {
 *     // ctx.event.message: InDialogMethodRequest<"REFER"> — to.tag, from.tag both string
 *     // ctx.sourceDialog: Dialog (non-undefined)
 *     // ctx.direction: "from-b"
 *     // ctx.call.transfer: null | undefined
 *     // ctx.call.state: "bridged"
 *     return undefined
 *   }),
 * })
 * ```
 */
export function defineRule<
  TMatch extends Match,
  TState = undefined,
  TParams = undefined,
>(
  def: {
    readonly id: string
    readonly name: string
    readonly match: TMatch
    /** Source of truth for `TState` — `init`/`handle` are NoInfer'd against this. */
    readonly stateSchema: Schema.Schema<TState>
    readonly paramsSchema: Schema.Schema<TParams>
    readonly init: (params: TParams, call: Call) => NoInfer<TState>
    readonly handle: (
      ctx: RuleContext<TMatch>,
      state: NoInfer<TState>,
      params: TParams,
    ) => Effect.Effect<RuleHandleResult<NoInfer<TState>> | undefined | void, never, never>
    readonly alwaysActive?: boolean
    readonly stateKey?: string
    readonly composesWith?: string
    readonly overrides?: string
    readonly onError?: "passthrough" | "terminate"
  },
): RuleDefinition<TState, TParams> {
  return def as unknown as RuleDefinition<TState, TParams>
}
