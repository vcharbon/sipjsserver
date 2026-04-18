/**
 * Rule system type definitions for the INAP-inspired B2BUA framework.
 *
 * Rules are high-level event interceptors that express decisions
 * (relay, reject, create leg, merge, split) — not SIP message construction.
 * The ActionExecutor translates rule actions into SIP messages and call state updates.
 */

import type { Effect, Schema } from "effect"
import type { SipRequest, SipResponse, RemoteInfo } from "../../../sip/types.js"
import type { Call, CallModelState, Leg, LegState, LegDisposition, Dialog, CdrEventType, TimerType, TransferPhase, TransferState } from "../../../call/CallModel.js"
import type { AppConfigData } from "../../../config/AppConfig.js"
import type { CallEvent } from "../../../sip/SipRouter.js"
import type { CallControlClient } from "../../../http/CallControlClient.js"
import type { CallLimiter } from "../../../call/CallLimiter.js"
import type { CallReferRequest as CallReferRequestType } from "../../../http/CallControlSchemas.js"
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

/** Post-match corner-case predicate. Pure, sync, reads only RuleContext state. */
export type MatchFilter = (ctx: RuleContext) => boolean

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
  readonly filter?: MatchFilter
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
  readonly filter?: MatchFilter
}

/** Match descriptor for a background timer firing. */
export interface TimerMatch {
  readonly kind: "timer"
  /** Omitted = match any timer type. */
  readonly timerType?: OneOrMany<TimerType>
  readonly callState?: OneOrMany<CallModelState>
  readonly transferPhase?: TransferPhaseGate
  readonly filter?: MatchFilter
}

/** Match descriptor for transaction timeouts (Timer B/F expiry). */
export interface TimeoutMatch {
  readonly kind: "timeout"
  readonly method?: OneOrMany<SipMethod>
  readonly callState?: OneOrMany<CallModelState>
  readonly transferPhase?: TransferPhaseGate
  readonly filter?: MatchFilter
}

/** Match descriptor for CANCEL-of-initial-INVITE signal (from a-leg). */
export interface CancelledMatch {
  readonly kind: "cancelled"
  readonly callState?: OneOrMany<CallModelState>
  readonly transferPhase?: TransferPhaseGate
  readonly filter?: MatchFilter
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
  readonly filter?: MatchFilter
}

/** Declarative match descriptor. Replaces imperative matches(). */
export type Match =
  | RequestMatch
  | ResponseMatch
  | TimerMatch
  | TimeoutMatch
  | CancelledMatch
  | InternalEventMatch

// ── Rule context (what rules see) ──────────────────────────────────────────

/**
 * Read-only context passed to rule handlers.
 *
 * Peer resolution is intentionally NOT included here — it was removed because
 * `activePeer` is null during early dialog (before confirm-dialog/merge), making
 * any eagerly-resolved `peer` field unreliable. Rules that need the peer should
 * emit `relay-to-peer` and let ActionExecutor resolve the target with its richer
 * fallback logic (tagMap, single-b-leg fallback, etc.).
 */
export interface RuleContext {
  /** Full call state (legs, dialogs, peering, rule states). Read-only for rules. */
  readonly call: Call
  /** Deterministic call reference (callId|fromTag). */
  readonly callRef: string
  /** The event being processed. */
  readonly event: CallEvent
  /** Which leg the event came from. */
  readonly sourceLeg: Leg
  /** Dialog on the source leg (may be undefined for early state). */
  readonly sourceDialog: Dialog | undefined
  /** Direction from which the event arrived. */
  readonly direction: "from-a" | "from-b"
  /** App configuration. */
  readonly config: AppConfigData
  /** HTTP call control client for routing decisions. */
  readonly callControl: CallControlClient["Service"]
  /** Call limiter service. */
  readonly limiter: CallLimiter["Service"]
  /** Wall-clock-equivalent timestamp (from Effect Clock). */
  readonly nowMs: number
}

// ── Message transform ──────────────────────────────────────────────────────

/** Transform applied to a message during relay (e.g., 183→200 conversion). */
export interface MessageTransform {
  /** Override response status code (e.g., 183 → 200). */
  readonly status?: number
  /** Override reason phrase. */
  readonly reason?: string
  /** Add/modify/remove headers. null value = remove header. */
  readonly headers?: Record<string, string | null>
  /** Replace message body. null = remove body. */
  readonly body?: Uint8Array | null
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
      readonly headers?: Record<string, string | null> }
  | { readonly type: "ack-leg"; readonly legId: string }

  // ── Generate new request to a leg (keepalive OPTIONS, INFO, etc.) ──
  | { readonly type: "send-request-to-leg"; readonly legId: string; readonly method: string;
      readonly headers?: Record<string, string | null>; readonly body?: Uint8Array | null }

  // ── Synthesize a PRACK toward a leg in response to a reliable 1xx we
  // received but are not relaying to the peer (RFC 3262 §3-4). Uses the
  // leg's early dialog (toTag from the reliable 1xx) to build the PRACK. ──
  | { readonly type: "send-prack-to-leg"; readonly legId: string;
      readonly rseq: number; readonly inviteCSeq: number; readonly bTag: string }

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
       *   - legId === "a" → makeDialogFromIncoming(toTag, call.aLegInviteCSeq)
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
  // The three "slot" pairs below (body / headers / ruri) give the
  // create-leg action both a legacy shape (`updateBody` / `updateHeaders`
  // / `newRuri` — string-typed, tri-state) and a new ADT shape
  // (`bodyUpdate` / `headerUpdates` / `ruri` — see
  // `./actions/types.ts`). Per-slot XOR prevents both forms from being
  // set together on a single action.
  //
  // Legacy fields are deprecated and scheduled for removal in Slice F
  // of the rule-framework ADT refactor. New rules should emit the ADT
  // fields and read source values via `./actions/readers.ts`.
  | (
      {
        readonly type: "create-leg";
        readonly destination: LegDestination;
        /** "snapshot" = use aLegInviteSnapshot; or provide a specific SipRequest. */
        readonly fromInvite?: "snapshot" | SipRequest;
        readonly noAnswerTimeoutSec?: number;
        /** Propagate callback_context from failover response for subsequent failovers. */
        readonly callbackContext?: string;
      }
      & (
        | { readonly updateBody?: string | null; readonly bodyUpdate?: never }
        | { readonly bodyUpdate?: BodyUpdate; readonly updateBody?: never }
      )
      & (
        | { readonly updateHeaders?: Record<string, string | null>; readonly headerUpdates?: never }
        | { readonly headerUpdates?: HeaderUpdates; readonly updateHeaders?: never }
      )
      & (
        | {
            /** Legacy: override Request-URI for the outbound INVITE. */
            readonly newRuri?: string; readonly ruri?: never
          }
        | {
            /** New: typed Request-URI operation (inherit / set BareSipUri). */
            readonly ruri?: RuriOp; readonly newRuri?: never
          }
      )
    )
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
       */
      readonly type: "begin-termination"
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

  // ── REFER transfer state management ──
  // update-transfer merges onto Call.transfer (creating it if absent).
  // clear-transfer nulls Call.transfer outright (final cleanup).
  | { readonly type: "update-transfer"; readonly update: Partial<TransferState> }
  | { readonly type: "clear-transfer" }

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

  /** Default priority for always-active rules. Per-call rules use ActiveRule.priority. */
  readonly defaultPriority?: number

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
