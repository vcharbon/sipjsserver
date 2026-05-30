/**
 * defineService — the callflow-service primitive (ADR-0016).
 *
 * A callflow service bundles cooperating rules that share typed per-call and
 * per-leg `ext` slices, keyed by the service id. Rules minted via `.rule(...)`
 * receive their decoded slices (the framework decodes `call.ext[id]` /
 * `leg.ext[id]` before matching) and either return an updated call-ext slice
 * or emit `set-leg-ext`; the minted closure owns encoding, so only the Encoded
 * (JSON-safe) form is ever persisted into `Call.ext` / `Leg.ext`.
 *
 * `.toPolicyModule()` reuses `createRuleRegistry`'s guard-composition and
 * shadow-validation. Activation is ext-presence (`call.ext[id]` set) or
 * `alwaysActive`, replacing the closed-`features` guard.
 */

import { Effect, Schema } from "effect"
import type {
  AnyRuleDefinition,
  BaseExt,
  Match,
  MatchFilter,
  RuleAction,
  RuleContext,
} from "./RuleDefinition.js"
import { defineRule } from "./RuleDefinition.js"
import type { PolicyModule, ServiceRuntime } from "./PolicyModule.js"

/** Result returned by a service rule handler. */
export interface ServiceHandleResult<TCallExt> {
  readonly actions: ReadonlyArray<RuleAction>
  /**
   * Updated call-ext slice. Omit it (or return the same object the handler was
   * given) to leave `call.ext[id]` unchanged — no spurious write/flush.
   */
  readonly callExt?: TCallExt
}

/** Rule context as seen by a service's rules — `ext` keyed by the service id. */
type ServiceRuleContext<Id extends string, TMatch extends Match, TCallExt, TLegExt> =
  RuleContext<TMatch, { readonly [K in Id]?: TCallExt }, { readonly [K in Id]?: TLegExt }>

export interface Service<Id extends string, TCallExt, TLegExt> {
  readonly id: Id
  /** Mint a rule bound to this service; filter/handle receive the decoded slices. */
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
    ) => Effect.Effect<ServiceHandleResult<TCallExt> | undefined | void, never, never>
    readonly alwaysActive?: boolean
    readonly stateKey?: string
    readonly composesWith?: string
    readonly overrides?: string
    readonly onError?: "passthrough" | "terminate"
  }): AnyRuleDefinition
  /** Build a typed `{ [id]: encoded }` descriptor entry for the decision response. */
  activate(descriptor: TCallExt): Record<Id, unknown>
  /** Produce a PolicyModule (ext-presence guard) for createRuleRegistry. */
  toPolicyModule(): PolicyModule
}

const readSlice = (ext: BaseExt, sid: string): unknown =>
  (ext as Record<string, unknown> | undefined)?.[sid]

export function defineService<Id extends string, TCallExt = never, TLegExt = never>(config: {
  readonly id: Id
  readonly callExt?: Schema.Codec<TCallExt, unknown>
  readonly legExt?: Schema.Codec<TLegExt, unknown>
  /** Active on every call regardless of ext-presence (e.g. core services). */
  readonly alwaysActive?: boolean
}): Service<Id, TCallExt, TLegExt> {
  const { id, callExt, legExt, alwaysActive } = config
  const minted: AnyRuleDefinition[] = []

  const service: Service<Id, TCallExt, TLegExt> = {
    id,

    rule(def) {
      const matchFilter: MatchFilter = (ctx) => {
        const slice = readSlice(ctx.call.ext, id)
        // Service inactive or skipped on decode defect → rule inert this event.
        if (callExt !== undefined && slice === undefined) return false
        if (def.filter === undefined) return true
        const legSlice = readSlice(ctx.sourceLeg.ext, id)
        return def.filter(ctx as never, slice as TCallExt, legSlice as TLegExt | undefined)
      }

      const wrappedHandle = (ctx: RuleContext) =>
        def
          .handle(
            ctx as never,
            readSlice(ctx.call.ext, id) as TCallExt,
            readSlice(ctx.sourceLeg.ext, id) as TLegExt | undefined,
          )
          .pipe(
            Effect.map((r) => {
              if (r == null) return r
              let actions: RuleAction[] = [...r.actions]
              // Encode any leg-ext writes this service emitted (value is decoded).
              if (legExt !== undefined) {
                actions = actions.map((a) =>
                  a.type === "set-leg-ext" && a.serviceId === id
                    ? { ...a, value: Schema.encodeSync(legExt)(a.value as TLegExt) }
                    : a,
                )
              }
              // Append a call-ext write only when the slice actually changed —
              // returning the same decoded object is a true no-op (no flush).
              const current = readSlice(ctx.call.ext, id)
              if (r.callExt !== undefined && r.callExt !== current && callExt !== undefined) {
                actions = [
                  ...actions,
                  { type: "set-call-ext", serviceId: id, value: Schema.encodeSync(callExt)(r.callExt) },
                ]
              }
              return { actions, state: undefined }
            }),
          )

      const ruleDef = defineRule({
        id: def.id,
        name: def.name,
        match: { ...def.match, filter: matchFilter as never },
        stateSchema: Schema.Undefined,
        paramsSchema: Schema.Undefined,
        init: () => undefined,
        handle: wrappedHandle as never,
        alwaysActive: def.alwaysActive ?? true,
        ...(def.stateKey !== undefined ? { stateKey: def.stateKey } : {}),
        ...(def.composesWith !== undefined ? { composesWith: def.composesWith } : {}),
        ...(def.overrides !== undefined ? { overrides: def.overrides } : {}),
        ...(def.onError !== undefined ? { onError: def.onError } : {}),
      })
      minted.push(ruleDef)
      return ruleDef
    },

    activate(descriptor) {
      if (callExt === undefined) {
        throw new Error(`Service ${id}: activate() requires a callExt schema`)
      }
      return { [id]: Schema.encodeSync(callExt)(descriptor) } as Record<Id, unknown>
    },

    toPolicyModule() {
      const runtime: ServiceRuntime = {
        id,
        ...(callExt !== undefined ? { callExtSchema: callExt as Schema.Codec<unknown, unknown> } : {}),
        ...(legExt !== undefined ? { legExtSchema: legExt as Schema.Codec<unknown, unknown> } : {}),
        ...(alwaysActive !== undefined ? { alwaysActive } : {}),
      }
      const guard = (ctx: RuleContext): boolean =>
        alwaysActive === true || readSlice(ctx.call.ext, id) !== undefined
      return { id, guard, rules: minted, __service: runtime }
    },
  }

  return service
}
