/**
 * @vcharbon/sipjs/rules-sdk — the integrator rule-authoring SDK (ADR-0015 / ADR-0016).
 *
 * A curated, independently-versioned surface for authoring callflow services and
 * policy modules in your own worker binary. The public/internal boundary is the
 * stability promise: this entrypoint exposes only the {@link PublicRuleAction}
 * subset and a narrowed {@link RuleContext} (no `callControl`/`limiter` service
 * handles). Internal actions (`send-raw`, PRACK / transfer / tag-mapping
 * plumbing) are unreachable here — emitting one is a compile error.
 *
 * The framework owns the A-facing To-tag: there is no public `add-tag-mapping` /
 * `stamp-dialog-to-tag`, and a single, non-forking service does not need one —
 * the relay path auto-mints, maps, and stamps the a-facing tag on the first
 * relayed 18x, and `send-provisional-to-leg` (no `toTag`) reuses it. Pinning the
 * tag across B forking / failover means composing with {@link relayFirst18xTo180}.
 * See docs/b2bua-sip-headers.md §"Tag mapping".
 *
 * Quick start:
 *
 * ```ts
 * import { defineService, H, removeH } from "@vcharbon/sipjs/rules-sdk"
 * import { Effect, Schema } from "effect"
 *
 * const myService = defineService({
 *   id: "my-flow",
 *   callExt: Schema.Struct({ step: Schema.Number }),
 * })
 * const ringing = myService.rule({
 *   id: "my-flow-ringing",
 *   name: "ring",
 *   match: { kind: "response", cseqMethod: "INVITE", statusClass: "1xx", direction: "from-b" },
 *   handle: (ctx, callExt) =>
 *     Effect.succeed({ actions: [{ type: "relay-to-peer" as const }], callExt }),
 * })
 *
 * // Activate from /call/new by seeding the descriptor into the response's serviceExt:
 * //   { ...routeResponse, serviceExt: myService.activate({ step: 0 }) }
 * ```
 *
 * Build the worker's handler registry and hand it to `SipRouter.start`:
 *
 * ```ts
 * import { buildHandlers, createRuleRegistry, defaultRules } from "@vcharbon/sipjs/rules-sdk"
 * const handlers = buildHandlers(createRuleRegistry(defaultRules, [myService.toPolicyModule()]))
 * ```
 */

import type { Effect, Schema } from "effect"
import { defineRule as defineRuleCore } from "../b2bua/rules/framework/RuleDefinition.js"
import { defineService as defineServiceCore } from "../b2bua/rules/framework/Service.js"
import type {
  AnyRuleDefinition,
  BaseExt,
  Match,
  RuleContext as WideRuleContext,
  RuleDefinition,
} from "../b2bua/rules/framework/RuleDefinition.js"
import type { PolicyModule } from "../b2bua/rules/framework/PolicyModule.js"
import type { PublicRuleAction } from "../b2bua/rules/framework/actions/public.js"

// ── Narrowed public types (the only RuleContext / action surface integrators name) ──

/**
 * Rule context as integrators see it — the framework {@link WideRuleContext}
 * minus the `callControl` / `limiter` service handles. Rules emit *intents*; the
 * framework owns every side effect (ADR-0015). The two ext generics carry the
 * service's typed per-call / per-leg slices.
 */
export type RuleContext<
  TMatch extends Match = Match,
  TCallExt = BaseExt,
  TLegExt = BaseExt,
> = Omit<WideRuleContext<TMatch, TCallExt, TLegExt>, "callControl" | "limiter">

/** Handler result for a plain SDK rule — actions constrained to the public subset. */
export interface PublicRuleHandleResult {
  readonly actions: ReadonlyArray<PublicRuleAction>
}

/** Handler result for a service rule — actions constrained, plus the call-ext write channel. */
export interface PublicServiceHandleResult<TCallExt> {
  readonly actions: ReadonlyArray<PublicRuleAction>
  readonly callExt?: TCallExt
  readonly clearCallExt?: boolean
}

type ServiceRuleContext<Id extends string, TMatch extends Match, TCallExt, TLegExt> =
  RuleContext<TMatch, { readonly [K in Id]?: TCallExt }, { readonly [K in Id]?: TLegExt }>

/** A callflow service as seen through the SDK (action channel narrowed to {@link PublicRuleAction}). */
export interface Service<Id extends string, TCallExt, TLegExt> {
  readonly id: Id
  rule<TMatch extends Match>(def: {
    readonly id: string
    readonly name: string
    readonly match: TMatch
    readonly filter?: (
      ctx: ServiceRuleContext<Id, TMatch, TCallExt, TLegExt>,
      callExt: TCallExt,
      legExt: TLegExt | undefined,
    ) => boolean
    readonly handle: (
      ctx: ServiceRuleContext<Id, TMatch, TCallExt, TLegExt>,
      callExt: TCallExt,
      legExt: TLegExt | undefined,
    ) => Effect.Effect<PublicServiceHandleResult<TCallExt> | undefined | void, never, never>
    readonly alwaysActive?: boolean
    readonly composesWith?: string
    readonly overrides?: string | ReadonlyArray<string>
    readonly onError?: "passthrough" | "terminate"
  }): AnyRuleDefinition
  activate(descriptor: TCallExt): Record<Id, unknown>
  toPolicyModule(): PolicyModule
}

// ── Typed authoring wrappers (runtime-identical to the framework primitives) ──

/**
 * Define a standalone rule. `ctx` is the narrowed {@link RuleContext} and the
 * handler's actions are constrained to {@link PublicRuleAction}; the result is a
 * framework `RuleDefinition` ready for {@link definePolicyModule}.
 */
export function defineRule<TMatch extends Match>(def: {
  readonly id: string
  readonly name: string
  readonly match: TMatch
  readonly handle: (
    ctx: RuleContext<TMatch>,
  ) => Effect.Effect<PublicRuleHandleResult | undefined | void, never, never>
  readonly alwaysActive?: boolean
  readonly composesWith?: string
  readonly overrides?: string | ReadonlyArray<string>
  readonly onError?: "passthrough" | "terminate"
}): RuleDefinition {
  return defineRuleCore(def as never)
}

/**
 * Bundle cooperating rules sharing typed per-call / per-leg `ext` slices keyed by
 * the service id (ADR-0016). Activation is ext-presence (seed via
 * {@link Service.activate} in the `/call/new` response's `serviceExt`) or a
 * custom `isApplicable` predicate.
 */
export function defineService<Id extends string, TCallExt = never, TLegExt = never>(config: {
  readonly id: Id
  readonly callExt?: Schema.Codec<TCallExt, unknown>
  readonly legExt?: Schema.Codec<TLegExt, unknown>
  readonly alwaysActive?: boolean
  readonly isApplicable?: (ctx: RuleContext) => boolean
}): Service<Id, TCallExt, TLegExt> {
  return defineServiceCore(config as never) as unknown as Service<Id, TCallExt, TLegExt>
}

// ── Re-exports (runtime unchanged) ──────────────────────────────────────────

export { definePolicyModule } from "../b2bua/rules/framework/PolicyModule.js"
export { createRuleRegistry } from "../b2bua/rules/framework/RuleRegistry.js"
export type { RuleRegistry } from "../b2bua/rules/framework/RuleRegistry.js"
export { defaultRules } from "../b2bua/rules/defaults/index.js"
export { relayFirst18xTo180 } from "../b2bua/rules/custom/relayFirst18xTo180.js"
export { promote18xPemTo200 } from "../b2bua/rules/custom/promote18xPemTo200.js"
export { referTransfer } from "../b2bua/rules/custom/referTransfer.js"
export { buildHandlers } from "../b2bua/B2buaCore.js"

// Action factories — the typed header / URI constructors rule code builds with.
export {
  H,
  removeH,
  replaceH,
  custom,
  headerName,
  headerUpdatesFromRecord,
  toBareUri,
  toNameAddr,
  tagsOf,
} from "../b2bua/rules/framework/actions/factories.js"

// SIP helpers integrator rules commonly need.
export { getHeader, newTag } from "../sip/MessageHelpers.js"

// Types — the public action union is exported AS `RuleAction`.
export type { PublicRuleAction as RuleAction } from "../b2bua/rules/framework/actions/public.js"
export type {
  AnyRuleDefinition,
  RuleDefinition,
  Match,
  RequestMatch,
  ResponseMatch,
  TimerMatch,
  TimeoutMatch,
  CancelledMatch,
  InternalEventMatch,
  MessageTransform,
  LegDestination,
  BaseExt,
} from "../b2bua/rules/framework/RuleDefinition.js"
export type { PolicyModule } from "../b2bua/rules/framework/PolicyModule.js"
export type { HeaderName, HeaderUpdate, HeaderUpdates } from "../b2bua/rules/framework/actions/types.js"
export type { LegKind } from "../call/CallModel.js"
