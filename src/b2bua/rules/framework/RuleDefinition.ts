/**
 * Rule system type definitions for the INAP-inspired B2BUA framework.
 *
 * Rules are high-level event interceptors that express decisions
 * (relay, reject, create leg, merge, split) — not SIP message construction.
 * The ActionExecutor translates rule actions into SIP messages and call state updates.
 */

import type { Effect, Schema } from "effect"
import type { SipRequest, SipResponse, RemoteInfo } from "../../../sip/types.js"
import type { Call, Leg, Dialog, CdrEventType, TimerType } from "../../../call/CallModel.js"
import type { AppConfigData } from "../../../config/AppConfig.js"
import type { CallEvent } from "../../../sip/SipRouter.js"
import type { CallControlClient } from "../../../http/CallControlClient.js"
import type { CallLimiter } from "../../../call/CallLimiter.js"

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

  // ── Dialog lifecycle ──
  | {
      /**
       * Confirm the source leg's dialog on 200 OK INVITE from b-leg.
       * Sets source leg: state="confirmed", disposition="bridged", updates dialog contact.
       * Sets a-leg: state="confirmed".
       * Creates/updates tag mapping.
       * Must be placed BEFORE relay-to-peer and merge in the action sequence.
       */
      readonly type: "confirm-dialog"
    }

  // ── Leg lifecycle ──
  | { readonly type: "create-leg";
      readonly destination: LegDestination;
      /** "snapshot" = use aLegInviteSnapshot; or provide a specific SipRequest. */
      readonly fromInvite?: "snapshot" | SipRequest;
      readonly updateHeaders?: Record<string, string | null>;
      readonly updateBody?: string | null;
      readonly noAnswerTimeoutSec?: number;
      /** Override Request-URI for the outbound INVITE (e.g. failover new_ruri). */
      readonly newRuri?: string;
      /** Propagate callback_context from failover response for subsequent failovers. */
      readonly callbackContext?: string }
  | { readonly type: "destroy-leg"; readonly legId: string }

  // ── Peering (INAP split/merge) ──
  | { readonly type: "merge"; readonly legA: string; readonly legB: string }
  | { readonly type: "split"; readonly legId: string }

  // ── Timers ──
  | { readonly type: "schedule-timer"; readonly timerType: TimerType;
      readonly delaySec: number; readonly legId?: string }
  | { readonly type: "cancel-timer"; readonly timerId: string }
  | { readonly type: "cancel-all-timers" }

  // ── Call lifecycle ──
  | { readonly type: "terminate-call" }
  | {
      /**
       * Graceful call termination — sends BYE/CANCEL to all live legs, sets
       * byeDisposition: "bye_sent", transitions call to "terminating", and
       * schedules a 64s safety timer.
       *
       * All rules MUST use begin-termination (not terminate-call) for call-level
       * teardown. If all legs are already resolved when this fires (pre-dialog
       * failure), the framework immediately transitions to "terminated" via the
       * isFullyResolved() check — same code path, no special case.
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

  /** Schema for validating/decoding rule-specific state. */
  readonly stateSchema: Schema.Schema<TState>

  /** Schema for validating/decoding rule params from HTTP response. */
  readonly paramsSchema: Schema.Schema<TParams>

  /**
   * Fast synchronous filter — does this rule care about this event at all?
   * Returning false avoids the cost of state decoding and Effect execution.
   */
  readonly matches: (ctx: RuleContext) => boolean

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
