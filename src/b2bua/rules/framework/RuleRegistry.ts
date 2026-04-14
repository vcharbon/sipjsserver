/**
 * RuleRegistry — holds all registered rule definitions.
 * Built at startup; immutable after construction.
 */

import type { AnyRuleDefinition } from "./RuleDefinition.js"
import type { PolicyModule } from "./PolicyModule.js"

export interface RuleRegistry {
  readonly definitions: ReadonlyMap<string, AnyRuleDefinition>
}

/**
 * Create a rule registry from built-in rules and optional policy modules.
 *
 * Built-in rules are registered as-is (they are alwaysActive by definition).
 * Policy module rules have their module's guard applied to matches() and are
 * set to alwaysActive — the guard is the activation mechanism.
 */
export function createRuleRegistry(
  builtinRules: ReadonlyArray<AnyRuleDefinition>,
  policyModules?: ReadonlyArray<PolicyModule>,
): RuleRegistry {
  const allRules: AnyRuleDefinition[] = [...builtinRules]

  // Flatten policy modules — apply guard to each rule's matches()
  for (const mod of (policyModules ?? [])) {
    for (const rule of mod.rules) {
      const originalMatches = rule.matches
      allRules.push({
        ...rule,
        alwaysActive: true,
        matches: (ctx) => mod.guard(ctx) && originalMatches(ctx),
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

  // Warn on alwaysActive rules sharing a priority.
  // Same-priority rules are tie-broken by registration order, which is fragile
  // and has caused real bugs (e.g. retransmit-200 consuming re-INVITE responses).
  // This is a warning rather than fatal because some priority bands (e.g. 900)
  // contain many rules with non-overlapping match criteria where ordering is safe.
  const priorityToIds = new Map<number, string[]>()
  for (const rule of allRules) {
    if (!rule.alwaysActive) continue
    const p = rule.defaultPriority ?? 900
    const ids = priorityToIds.get(p)
    if (ids !== undefined) {
      ids.push(rule.id)
    } else {
      priorityToIds.set(p, [rule.id])
    }
  }
  for (const [priority, ids] of priorityToIds) {
    if (ids.length > 1) {
      console.warn(
        `[RuleRegistry] Priority collision: alwaysActive rules [${ids.join(", ")}] share priority ${priority}. ` +
        `If these rules can match the same event, assign distinct priorities.`
      )
    }
  }

  return { definitions: map }
}

// ---------------------------------------------------------------------------
// Registry transforms
// ---------------------------------------------------------------------------

/**
 * Composable wrappers over a registry's rule definitions. Used by the e2e
 * harness for coverage tracking (wrapHandle) and by the rule-kill script
 * for mutation testing (wrapMatches). Production code does not transform
 * the registry.
 */
export interface RegistryTransform {
  readonly wrapMatches?: (
    rule: AnyRuleDefinition,
    original: AnyRuleDefinition["matches"],
  ) => AnyRuleDefinition["matches"]
  readonly wrapHandle?: (
    rule: AnyRuleDefinition,
    original: AnyRuleDefinition["handle"],
  ) => AnyRuleDefinition["handle"]
}

/**
 * Return a new registry with each rule's matches/handle optionally wrapped.
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
    if (transform.wrapMatches !== undefined) {
      wrapped = { ...wrapped, matches: transform.wrapMatches(rule, rule.matches) }
    }
    if (transform.wrapHandle !== undefined) {
      wrapped = { ...wrapped, handle: transform.wrapHandle(rule, rule.handle) }
    }
    map.set(id, wrapped)
  }
  return { definitions: map }
}

/**
 * Return a new registry where the named rule's `matches()` is forced to
 * always return false — i.e. the rule is disabled for the whole run.
 * Used by the rule-kill mutation harness. If the id is not registered,
 * the registry is returned unchanged.
 */
export function disableRule(registry: RuleRegistry, ruleId: string): RuleRegistry {
  if (!registry.definitions.has(ruleId)) return registry
  return transformRegistry(registry, {
    wrapMatches: (rule, original) => rule.id === ruleId ? () => false : original,
  })
}
