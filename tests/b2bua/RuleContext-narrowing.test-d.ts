/**
 * Compile-time type assertions for RuleContext narrowing.
 *
 * This file is type-checked by `tsc --noEmit` (it has the standard `.test-d.ts`
 * suffix and lives under `tests/`). It is not executed by vitest — every
 * assertion is a static `Equal<…>` / `Extends<…>` check that fails the
 * project typecheck if the narrowing regresses.
 *
 * If you change RuleContext, EventFor, DialogFor, CallFor, or the
 * `In*Request` / `SipResponseTagged` lattice, this file is the canary.
 */

import type {
  RuleContext,
  EventFor,
  DirectionFor,
  TransferFor,
  CallFor,
  DialogFor,
  Match,
} from "../../src/b2bua/rules/framework/RuleDefinition.js"
import type {
  SipRequest,
  SipResponseTagged,
  InDialogMethodRequest,
  MethodRequest,
} from "../../src/sip/types.js"
import type { Call, Dialog, TransferState } from "../../src/call/CallModel.js"
import type { CallEvent } from "../../src/sip/SipRouter.js"

/** Strict structural equality between two types. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
declare function assertEqual<A, B>(_: Equal<A, B>): void
declare function assertExtends<A extends B, B>(): void

// ── Wide form: RuleContext<Match> reduces to the legacy wide context ──

assertEqual<EventFor<Match>, CallEvent>(true)
assertEqual<DirectionFor<Match>, "from-a" | "from-b">(true)
assertEqual<CallFor<Match>, Call>(true)
assertEqual<DialogFor<Match>, Dialog | undefined>(true)
assertEqual<TransferFor<Match>, TransferState | null | undefined>(true)

// ── kind: "request" → event.message: SipRequest ─────────────────────────

type ReqMatch = { readonly kind: "request" }
type ReqEvent = EventFor<ReqMatch>
assertExtends<ReqEvent["type"], "sip">()
assertExtends<ReqEvent extends { readonly type: "sip" } ? ReqEvent["message"] : never, SipRequest>()

// ── kind: "response" → event.message: SipResponseTagged (to.tag: string) ──

type RespMatch = { readonly kind: "response" }
type RespEvent = EventFor<RespMatch>
assertExtends<RespEvent extends { readonly type: "sip" } ? RespEvent["message"] : never, SipResponseTagged>()

// ── kind: "request" + method literal narrows method ─────────────────────

type ReferMatch = { readonly kind: "request"; readonly method: "REFER" }
type ReferEvent = EventFor<ReferMatch>
type ReferMsg = ReferEvent extends { readonly type: "sip" } ? ReferEvent["message"] : never
assertExtends<ReferMsg, MethodRequest<"REFER">>()
assertExtends<ReferMsg["method"], "REFER">()

// ── In-dialog inference for requests ────────────────────────────────────

// transferPhase: <non-null phase> → InDialogMethodRequest, sourceDialog: Dialog
type CRingingMatch = {
  readonly kind: "request"
  readonly method: "INVITE"
  readonly transferPhase: "c-ringing"
}
type CRingingMsg = EventFor<CRingingMatch> extends { readonly type: "sip" } ? EventFor<CRingingMatch>["message"] : never
assertExtends<CRingingMsg, InDialogMethodRequest<"INVITE">>()
type CRingingDialog = DialogFor<CRingingMatch>
assertEqual<CRingingDialog, Dialog>(true)

// legState: "confirmed" → InDialogRequest, sourceDialog: Dialog
type ConfirmedMatch = { readonly kind: "request"; readonly legState: "confirmed" }
type ConfirmedMsg = EventFor<ConfirmedMatch> extends { readonly type: "sip" } ? EventFor<ConfirmedMatch>["message"] : never
// InDialogRequest guarantees tag-bearing from/to headers via overloaded getHeader.
assertExtends<ConfirmedMsg, import("../../src/sip/types.js").InDialogRequest>()

// callState: "active" → an active in-dialog scenario
type ActiveMatch = { readonly kind: "request"; readonly callState: "active"; readonly legState: "confirmed" }
type ActiveDialog = DialogFor<ActiveMatch>
assertEqual<ActiveDialog, Dialog>(true)

// transferPhase: null → call.transfer: null | undefined; sourceDialog stays Dialog | undefined
type NoTransferMatch = { readonly kind: "request"; readonly transferPhase: null }
assertEqual<TransferFor<NoTransferMatch>, null | undefined>(true)
assertEqual<DialogFor<NoTransferMatch>, Dialog | undefined>(true)

// ── direction narrowing ─────────────────────────────────────────────────

type FromBMatch = { readonly kind: "request"; readonly direction: "from-b" }
assertEqual<DirectionFor<FromBMatch>, "from-b">(true)

// ── cseqMethod narrows response cseq.method ─────────────────────────────

type Resp200InviteMatch = { readonly kind: "response"; readonly cseqMethod: "INVITE"; readonly statusClass: "2xx" }
type Resp200InviteEvent = EventFor<Resp200InviteMatch>
type Resp200InviteMsg = Resp200InviteEvent extends { readonly type: "sip" } ? Resp200InviteEvent["message"] : never
// The narrowed message is a SipResponseTagged whose CSeq method is literal "INVITE".
assertExtends<Resp200InviteMsg, SipResponseTagged>()

// ── transferPhase: "c-ringing" narrows call.transfer.phase ──────────────

type CRingingTransfer = TransferFor<CRingingMatch>
// Phase is the literal, not the wide TransferPhase union.
type CRingingPhase = CRingingTransfer extends { readonly phase: infer P } ? P : never
assertEqual<CRingingPhase, "c-ringing">(true)

// ── Sample full RuleContext on a transfer rule ──────────────────────────

type ReferRuleMatch = {
  readonly kind: "request"
  readonly method: "REFER"
  readonly direction: "from-b"
  readonly callState: "active"
  readonly legState: "confirmed"
  readonly transferPhase: null
}
type Ctx = RuleContext<ReferRuleMatch>
// Event narrows to a sip-request envelope carrying an in-dialog REFER.
assertExtends<Ctx["event"]["type"], "sip">()
type CtxMsg = Ctx["event"] extends { readonly type: "sip" } ? Ctx["event"]["message"] : never
assertExtends<CtxMsg, InDialogMethodRequest<"REFER">>()
// sourceDialog is non-undefined.
assertEqual<Ctx["sourceDialog"], Dialog>(true)
// direction is the literal.
assertEqual<Ctx["direction"], "from-b">(true)
// transfer is null|undefined (we asserted "no active transfer" via transferPhase: null).
assertEqual<Ctx["call"]["transfer"], null | undefined>(true)
// call.state narrows to the literal.
assertEqual<Ctx["call"]["state"], "active">(true)

// ── Sample timer rule context ──────────────────────────────────────────

type NoAnswerMatch = { readonly kind: "timer"; readonly timerType: "no_answer" }
type TimerCtx = RuleContext<NoAnswerMatch>
assertExtends<TimerCtx["event"]["type"], "timer">()

// ── Negative: a request rule cannot accidentally see a response message ──
// (Compile error if this ever weakens — kept commented; uncommenting must fail)
//
// type Bad = EventFor<ReqMatch> extends { readonly type: "sip" } ? EventFor<ReqMatch>["message"] : never
// const _badAssign: SipResponse = (null as unknown) as Bad // <- should be an error

// Silence "unused declare" warnings — these helpers are only called for
// their type-check side effects above.
void assertEqual
void assertExtends
