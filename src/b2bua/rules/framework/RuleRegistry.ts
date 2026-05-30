/**
 * RuleRegistry — holds all registered rule definitions.
 * Built at startup; immutable after construction.
 */

import type { AnyRuleDefinition, Match, RuleContext, ResponseMatch, StatusClass } from "./RuleDefinition.js"
import { CORE_LAYER, SERVICE_LAYER } from "./RuleDefinition.js"
import type { PolicyModule, ServiceRuntime } from "./PolicyModule.js"

export interface RuleRegistry {
  readonly definitions: ReadonlyMap<string, AnyRuleDefinition>
  /**
   * Callflow services (ADR-0016) registered via `defineService(...)`, keyed by
   * service id. The RuleExecutor uses each entry's ext schemas to decode
   * `call.ext[id]` / `leg.ext[id]` before matching and re-encode on write.
   */
  readonly services: ReadonlyMap<string, ServiceRuntime>
}

/**
 * Create a rule registry from built-in rules and optional policy modules.
 *
 * Built-in rules are registered as-is in CORE_LAYER (they are alwaysActive by
 * definition). Policy module / service rules have their module's guard composed
 * into each rule's match.filter, are set to alwaysActive (the guard is the
 * activation mechanism), and are stamped into SERVICE_LAYER so an active
 * service automatically outranks core for the same event (see Matcher.pickRanked).
 */
export function createRuleRegistry(
  builtinRules: ReadonlyArray<AnyRuleDefinition>,
  policyModules?: ReadonlyArray<PolicyModule>,
): RuleRegistry {
  const allRules: AnyRuleDefinition[] = [...builtinRules]
  const services = new Map<string, ServiceRuntime>()

  // Flatten policy modules — compose the module's guard into each rule's
  // match.filter so the Matcher respects policy activation.
  for (const mod of (policyModules ?? [])) {
    if (mod.__service !== undefined) services.set(mod.__service.id, mod.__service)
    for (const rule of mod.rules) {
      const originalFilter = rule.match.filter as ((ctx: RuleContext) => boolean) | undefined
      const guardedFilter: (ctx: RuleContext) => boolean = originalFilter !== undefined
        ? (ctx) => mod.guard(ctx) && originalFilter(ctx)
        : mod.guard
      // Cast: per-shape MatchFilter<RequestMatch> | ... is contravariantly
      // incompatible with the wide-form `guardedFilter`, but this composer
      // operates at the framework boundary where the wide form is correct —
      // the matcher invokes filters only after the column kind matches.
      allRules.push({
        ...rule,
        alwaysActive: true,
        layer: SERVICE_LAYER,
        match: { ...rule.match, filter: guardedFilter as never },
      })
    }
  }

  const map = new Map<string, AnyRuleDefinition>()
  for (const rule of allRules) {
    if (map.has(rule.id)) {
      throw new Error(`Duplicate rule ID: ${rule.id}`)
    }
    map.set(rule.id, rule)
  }

  validateMatchSchemas(allRules)

  return { definitions: map, services }
}

// ── Intra-layer reachability validation ───────────────────────────────────
//
// Selection is first-match-wins by layer then registration order (no
// specificity scoring). The one authoring hazard this introduces is an
// UNREACHABLE rule: a later rule in the SAME layer whose every matchable
// event is already claimed by an earlier filterless rule in that layer. Such
// a rule can never fire. (Cross-layer shadowing is by design — a higher layer
// is meant to win — so this check is strictly intra-layer.)

/** Does column value `aCol` accept every concrete value `bCol` can take? */
function colSubsumes(aCol: unknown, bCol: unknown): boolean {
  if (aCol === undefined) return true   // a accepts anything in this column
  if (bCol === undefined) return false  // b is broader than a here
  const aArr = Array.isArray(aCol) ? (aCol as ReadonlyArray<unknown>) : [aCol]
  const bArr = Array.isArray(bCol) ? (bCol as ReadonlyArray<unknown>) : [bCol]
  return bArr.every((v) => aArr.includes(v))
}

/** Does response `a`'s status/statusClass dimension subsume `b`'s? */
function statusDimSubsumes(a: ResponseMatch, b: ResponseMatch): boolean {
  if (a.status === undefined && a.statusClass === undefined) return true // a: any status
  if (a.status !== undefined) return b.status === a.status               // a: one exact status
  const aClasses = (Array.isArray(a.statusClass) ? a.statusClass : [a.statusClass]) as ReadonlyArray<StatusClass>
  if (b.status !== undefined) {
    return aClasses.includes((Math.floor(b.status / 100) + "xx") as StatusClass)
  }
  if (b.statusClass !== undefined) {
    const bClasses = (Array.isArray(b.statusClass) ? b.statusClass : [b.statusClass]) as ReadonlyArray<StatusClass>
    return bClasses.every((c) => aClasses.includes(c))
  }
  return false // b: any status, a: a class → not subsumed
}

/** True when every event `b` matches is also matched by `a` (same kind). */
function matchSubsumes(a: Match, b: Match): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case "request": {
      const bb = b as typeof a
      return colSubsumes(a.method, bb.method) && colSubsumes(a.callState, bb.callState) &&
        colSubsumes(a.legState, bb.legState) && colSubsumes(a.legDisposition, bb.legDisposition) &&
        colSubsumes(a.direction, bb.direction)
    }
    case "response": {
      const bb = b as typeof a
      return colSubsumes(a.cseqMethod, bb.cseqMethod) && statusDimSubsumes(a, bb) &&
        colSubsumes(a.callState, bb.callState) && colSubsumes(a.legState, bb.legState) &&
        colSubsumes(a.legDisposition, bb.legDisposition) && colSubsumes(a.direction, bb.direction)
    }
    case "timer": {
      const bb = b as typeof a
      return colSubsumes(a.timerType, bb.timerType) && colSubsumes(a.callState, bb.callState)
    }
    case "timeout": {
      const bb = b as typeof a
      return colSubsumes(a.method, bb.method) && colSubsumes(a.callState, bb.callState)
    }
    case "cancelled": {
      const bb = b as typeof a
      return colSubsumes(a.callState, bb.callState)
    }
    case "internal-event": {
      const bb = b as typeof a
      return colSubsumes(a.topic, bb.topic) && colSubsumes(a.outcome, bb.outcome) &&
        colSubsumes(a.callState, bb.callState)
    }
  }
}

/** Is there an explicit override/compose relationship between the two rules? */
function relatedByDecl(a: AnyRuleDefinition, b: AnyRuleDefinition): boolean {
  const declares = (o: string | ReadonlyArray<string> | undefined, id: string): boolean =>
    o === id || (Array.isArray(o) && o.includes(id))
  return declares(a.overrides, b.id) || declares(b.overrides, a.id) ||
    a.composesWith === b.id || b.composesWith === a.id
}

/**
 * Throw if any rule is statically unreachable: an earlier same-layer rule with
 * no `filter` whose match subsumes it always wins first. The fix is to reorder
 * (put the specific rule first), narrow the earlier rule, or — when the
 * earlier rule should defer — give it a `filter`. Rules deliberately related
 * via `overrides`/`composesWith` are exempt.
 *
 * Note: a filter on the earlier rule means it may decline at runtime, so the
 * later rule stays reachable — those pairs are not flagged (sound, no false
 * positives from phase/role filters).
 */
function validateMatchSchemas(rules: ReadonlyArray<AnyRuleDefinition>): void {
  const conflicts: Array<readonly [AnyRuleDefinition, AnyRuleDefinition]> = []
  for (let j = 0; j < rules.length; j++) {
    const b = rules[j]!
    for (let i = 0; i < j; i++) {
      const a = rules[i]!
      if ((a.layer ?? CORE_LAYER) !== (b.layer ?? CORE_LAYER)) continue
      if (a.match.filter !== undefined) continue
      if (relatedByDecl(a, b)) continue
      if (matchSubsumes(a.match, b.match)) conflicts.push([a, b])
    }
  }

  if (conflicts.length > 0) {
    const lines = conflicts.map(([a, b]) =>
      `  - '${b.id}' is unreachable: earlier same-layer rule '${a.id}' (no filter) subsumes its match`
    ).join("\n")
    throw new Error(
      `RuleRegistry: ${conflicts.length} unreachable rule${conflicts.length === 1 ? "" : "s"} detected.\n` +
      `Reorder (specific rule first), narrow the earlier rule, or declare overrides/composesWith:\n${lines}`
    )
  }
}

// ---------------------------------------------------------------------------
// Registry transforms
// ---------------------------------------------------------------------------

/**
 * Composable wrappers over a registry's rule definitions. Used by the e2e
 * harness for coverage tracking (wrapHandle) and by the rule-kill script
 * for mutation testing (disableRule). Production code does not transform
 * the registry.
 */
export interface RegistryTransform {
  readonly wrapHandle?: (
    rule: AnyRuleDefinition,
    original: AnyRuleDefinition["handle"],
  ) => AnyRuleDefinition["handle"]
}

/**
 * Return a new registry with each rule's handle optionally wrapped.
 * The input registry is not mutated. Duplicate-id validation is not re-run
 * (input was already validated by createRuleRegistry).
 */
export function transformRegistry(
  registry: RuleRegistry,
  transform: RegistryTransform,
): RuleRegistry {
  const map = new Map<string, AnyRuleDefinition>()
  for (const [id, rule] of registry.definitions) {
    let wrapped = rule
    if (transform.wrapHandle !== undefined) {
      wrapped = { ...wrapped, handle: transform.wrapHandle(rule, rule.handle) }
    }
    map.set(id, wrapped)
  }
  return { definitions: map, services: registry.services }
}

/**
 * Return a new registry where the named rule is disabled — its match filter
 * is replaced with an always-false predicate so the Matcher never picks it.
 * Used by the rule-kill mutation harness. If the id is not registered,
 * the registry is returned unchanged.
 */
export function disableRule(registry: RuleRegistry, ruleId: string): RuleRegistry {
  const rule = registry.definitions.get(ruleId)
  if (rule === undefined) return registry
  const disabled: AnyRuleDefinition = {
    ...rule,
    match: { ...rule.match, filter: () => false },
  }
  const map = new Map<string, AnyRuleDefinition>(registry.definitions)
  map.set(ruleId, disabled)
  return { definitions: map, services: registry.services }
}
