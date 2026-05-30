/**
 * PolicyModule — type-safe module-level rule grouping.
 *
 * A PolicyModule groups rules that share a call-level activation guard.
 * The guard is applied uniformly to ALL rules in the module by
 * createRuleRegistry — individual rules never need to check it.
 *
 * This is the ONLY way to register policy-gated rules: individual
 * rule definitions are module-private and cannot be imported directly.
 *
 * TypeScript enforcement:
 * - Rules are NOT exported from the policy module file
 * - The module exports only the PolicyModule object
 * - createRuleRegistry accepts PolicyModule[] as a separate parameter
 * - The registry applies the guard when flattening modules into rules
 *
 * Pattern for creating a policy module:
 *   1. Define rules as module-private constants (no `export`)
 *   2. Export a single PolicyModule with `definePolicyModule()`
 *   3. Register via createRuleRegistry(builtinRules, [myModule])
 */

import type { Schema } from "effect"
import type { AnyRuleDefinition, RuleContext } from "./RuleDefinition.js"

/**
 * Runtime descriptor for a callflow service (ADR-0016). Carried on the
 * PolicyModule a `defineService(...).toPolicyModule()` produces so
 * `createRuleRegistry` can collect the per-service ext schemas the
 * RuleExecutor decode/encode bracket needs. Plain rule policy modules
 * (no service) leave `__service` absent.
 */
export interface ServiceRuntime {
  readonly id: string
  /** Schema for the call-level ext slice (`call.ext[id]`), if the service has one. */
  readonly callExtSchema?: Schema.Codec<unknown, unknown>
  /** Schema for the leg-level ext slice (`leg.ext[id]`), if the service has one. */
  readonly legExtSchema?: Schema.Codec<unknown, unknown>
  /** When true the service is active on every call regardless of ext-presence. */
  readonly alwaysActive?: boolean
}

export interface PolicyModule {
  /** Policy identifier (for logging/tracing). */
  readonly id: string
  /** Guard predicate — rules in this module only match when guard returns true. */
  readonly guard: (ctx: RuleContext) => boolean
  /** Rule definitions. Guard is NOT yet applied — createRuleRegistry does that. */
  readonly rules: ReadonlyArray<AnyRuleDefinition>
  /** Present when this module was produced by `defineService(...).toPolicyModule()`. */
  readonly __service?: ServiceRuntime
}

/**
 * Create a PolicyModule. The guard is not applied here — it is applied
 * by createRuleRegistry when the module is registered. This factory
 * bundles rules + guard into a single typed object.
 */
export function definePolicyModule(config: {
  readonly id: string
  readonly guard: (ctx: RuleContext) => boolean
  readonly rules: ReadonlyArray<AnyRuleDefinition>
}): PolicyModule {
  return config
}
