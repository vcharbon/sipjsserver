/**
 * RuleRegistry — holds all registered rule definitions.
 * Built at startup; immutable after construction.
 */

import type { AnyRuleDefinition, Match, RuleContext } from "./RuleDefinition.js"
import type { PolicyModule } from "./PolicyModule.js"
import { specificityScore } from "./Matcher.js"

export interface RuleRegistry {
  readonly definitions: ReadonlyMap<string, AnyRuleDefinition>
}

/**
 * Create a rule registry from built-in rules and optional policy modules.
 *
 * Built-in rules are registered as-is (they are alwaysActive by definition).
 * Policy module rules have their module's guard composed into each rule's
 * match.filter and are set to alwaysActive — the guard is the activation
 * mechanism.
 */
export function createRuleRegistry(
  builtinRules: ReadonlyArray<AnyRuleDefinition>,
  policyModules?: ReadonlyArray<PolicyModule>,
): RuleRegistry {
  const allRules: AnyRuleDefinition[] = [...builtinRules]

  // Flatten policy modules — compose the module's guard into each rule's
  // match.filter so the Matcher respects policy activation.
  for (const mod of (policyModules ?? [])) {
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

  return { definitions: map }
}

// ── Match schema validation (shadow / reachability) ───────────────────────

/** Do two column values share any concrete value? */
function valuesOverlap(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return true
  const arrA = Array.isArray(a) ? (a as ReadonlyArray<unknown>) : [a]
  const arrB = Array.isArray(b) ? (b as ReadonlyArray<unknown>) : [b]
  for (const va of arrA) if (arrB.includes(va)) return true
  return false
}

/** Return true if two same-kind match descriptors can match a common event. */
function matchesOverlap(a: Match, b: Match): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case "request": {
      const bb = b as typeof a
      return (
        valuesOverlap(a.method, bb.method) &&
        valuesOverlap(a.callState, bb.callState) &&
        valuesOverlap(a.legState, bb.legState) &&
        valuesOverlap(a.legDisposition, bb.legDisposition) &&
        valuesOverlap(a.direction, bb.direction) &&
        valuesOverlap(a.transferPhase, bb.transferPhase)
      )
    }
    case "response": {
      const bb = b as typeof a
      if (!valuesOverlap(a.cseqMethod, bb.cseqMethod)) return false
      // status vs statusClass — compare conservatively (assume overlap unless both are exact and differ)
      if (a.status !== undefined && bb.status !== undefined && a.status !== bb.status) return false
      if (a.status !== undefined && bb.statusClass !== undefined) {
        // exact a.status must fall into bb.statusClass range
        const cls = Math.floor(a.status / 100) + "xx"
        if (!valuesOverlap(bb.statusClass, cls)) return false
      }
      if (bb.status !== undefined && a.statusClass !== undefined) {
        const cls = Math.floor(bb.status / 100) + "xx"
        if (!valuesOverlap(a.statusClass, cls)) return false
      }
      if (a.statusClass !== undefined && bb.statusClass !== undefined &&
          !valuesOverlap(a.statusClass, bb.statusClass)) return false
      return (
        valuesOverlap(a.callState, bb.callState) &&
        valuesOverlap(a.legState, bb.legState) &&
        valuesOverlap(a.legDisposition, bb.legDisposition) &&
        valuesOverlap(a.direction, bb.direction) &&
        valuesOverlap(a.transferPhase, bb.transferPhase)
      )
    }
    case "timer": {
      const bb = b as typeof a
      return (
        valuesOverlap(a.timerType, bb.timerType) &&
        valuesOverlap(a.callState, bb.callState) &&
        valuesOverlap(a.transferPhase, bb.transferPhase)
      )
    }
    case "timeout": {
      const bb = b as typeof a
      return (
        valuesOverlap(a.method, bb.method) &&
        valuesOverlap(a.callState, bb.callState) &&
        valuesOverlap(a.transferPhase, bb.transferPhase)
      )
    }
    case "cancelled": {
      const bb = b as typeof a
      return (
        valuesOverlap(a.callState, bb.callState) &&
        valuesOverlap(a.transferPhase, bb.transferPhase)
      )
    }
    case "internal-event": {
      const bb = b as typeof a
      return (
        valuesOverlap(a.topic, bb.topic) &&
        valuesOverlap(a.outcome, bb.outcome) &&
        valuesOverlap(a.callState, bb.callState) &&
        valuesOverlap(a.transferPhase, bb.transferPhase)
      )
    }
  }
}

/**
 * Throw if any two rules have overlapping match sets at equal specificity
 * with no explicit ordering. Each such pair would have ambiguous winner
 * selection at runtime — the only deterministic resolutions are:
 *   - declare `overrides: <other-id>` on one rule
 *   - declare `composesWith: <other-id>` on one rule
 *   - narrow one rule's match descriptor to disambiguate
 */
function validateMatchSchemas(rules: ReadonlyArray<AnyRuleDefinition>): void {
  const byKind = new Map<string, AnyRuleDefinition[]>()
  for (const r of rules) {
    const bucket = byKind.get(r.match.kind) ?? []
    bucket.push(r)
    byKind.set(r.match.kind, bucket)
  }

  const conflicts: Array<readonly [AnyRuleDefinition, AnyRuleDefinition]> = []
  for (const bucket of byKind.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!, b = bucket[j]!
        if (!matchesOverlap(a.match, b.match)) continue
        if (specificityScore(a.match) !== specificityScore(b.match)) continue
        const overrideDeclared =
          a.overrides === b.id || b.overrides === a.id ||
          a.composesWith === b.id || b.composesWith === a.id
        if (overrideDeclared) continue
        conflicts.push([a, b])
      }
    }
  }

  if (conflicts.length > 0) {
    const lines = conflicts.map(([a, b]) =>
      `  - '${a.id}' and '${b.id}': overlapping match, equal specificity`
    ).join("\n")
    throw new Error(
      `RuleRegistry: ${conflicts.length} unresolved match shadow${conflicts.length === 1 ? "" : "s"} detected.\n` +
      `Each pair must declare overrides/composesWith or narrow its match descriptor:\n${lines}`
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
  return { definitions: map }
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
  return { definitions: map }
}
